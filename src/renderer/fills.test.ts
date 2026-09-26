import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_GRADIENT_STOPS } from '../core/gradient.ts'
import { resolveViewport } from '../core/units.ts'
import { FILL_STRIDE, FILL_STRIDE_FLOATS, FILL_STRUCT_BYTES, FILL_WGSL } from '../shaders/fill.wgsl.ts'
import { CLIP_UNBOUNDED_PX } from './clipping.ts'
import {
  fillRadii,
  packFill,
  parseFillColor,
  sceneDest,
  sceneScissor,
  type FillStyle,
  type MeasuredFill
} from './fills.ts'
import { PanelRegistry } from './panels.ts'

/* ------------------------------------------------------------------ *
 * WGSL struct Fill 与 packFill 逐字节对齐（与 panels.test.ts 的面板同一个做法：从源里解析）
 * ------------------------------------------------------------------ */

function parseFillStruct(): { fields: Map<string, number>; size: number } {
  const m = /struct Fill \{([\s\S]*?)\n\}/.exec(FILL_WGSL)
  assert.ok(m, 'FILL_WGSL 里找不到 struct Fill')
  const fields = new Map<string, number>()
  let offset = 0
  for (const line of m[1]!.split('\n')) {
    const f = /^\s*(\w+)\s*:\s*(vec4f|array<vec4f,\s*(\d+)>)\s*,/.exec(line)
    if (!f) {
      assert.ok(!/^\s*\w+\s*:/.test(line), `struct Fill 只该有 vec4f 与 array<vec4f, N>：${line.trim()}`)
      continue
    }
    fields.set(f[1]!, offset)
    offset += 16 * (f[3] ? Number(f[3]) : 1)
  }
  return { fields, size: offset }
}

test('FILL_STRUCT_BYTES 等于 WGSL 里 struct Fill 的大小，放得进一个 256B 步长', () => {
  const { size } = parseFillStruct()
  assert.equal(FILL_STRUCT_BYTES, size)
  assert.ok(FILL_STRUCT_BYTES <= FILL_STRIDE)
  assert.equal(FILL_STRIDE % 256, 0)
})

test('packFill 写入的每个字段都落在 WGSL struct 的对应偏移上', () => {
  const { fields } = parseFillStruct()
  const fill: MeasuredFill = {
    record: { element: {} as HTMLElement },
    x: 11,
    y: 22,
    w: 333,
    h: 44,
    rotation: [0.6, 0.8],
    scissor: [9, 20, 337, 48],
    clip: { x0: 5, y0: -Infinity, x1: 400, y1: Infinity },
    clipRadii: [1, 2, 3, 4],
    clipRadiiY: [1, 2, 6, 4],
    clipShape: { box: { x0: 0, y0: 0, x1: 80, y1: 40 }, rx: [40, 40, 40, 40], ry: [20, 20, 20, 20] },
    mask: { kind: 'radial', repeating: true, geometry: [40, 20, 50, 25], alphas: [1, 0], offsets: [0.2, 0.7] },
    radii: [5, 6, 7, 8],
    radiiY: [5, 3, 0, 8],
    color: [0.1, 0.2, 0.3, 0.4],
    gradient: null,
    layer: 0
  }
  const data = new Float32Array(FILL_STRIDE_FLOATS * 3)
  packFill(data, 2, fill)
  const base = 2 * FILL_STRIDE_FLOATS
  const at = (name: string, c: number): number => {
    const off = fields.get(name)
    assert.ok(off !== undefined, `struct Fill 里没有 ${name}`)
    return data[base + off / 4 + c]!
  }
  const near = (a: number, b: number, what: string): void => assert.ok(Math.abs(a - b) < 1e-6, `${what}：${a} ≠ ${b}`)
  near(at('rect', 0), 11, 'rect.x')
  near(at('rect', 3), 44, 'rect.h')
  near(at('radii', 0), 5, 'radii.TL')
  near(at('radii', 3), 8, 'radii.BL')
  near(at('color', 0), 0.1, 'color.r')
  near(at('color', 3), 0.4, 'color.a')
  near(at('clip', 0), 5, 'clip.x0')
  near(at('clip', 1), -CLIP_UNBOUNDED_PX, 'clip.y0（−∞ 写成有限值）')
  near(at('clip', 3), CLIP_UNBOUNDED_PX, 'clip.y1')
  near(at('clipRadii', 2), 3, 'clipRadii.BR')
  near(at('pose', 0), 0.6, 'pose.cos')
  near(at('pose', 1), 0.8, 'pose.sin')
  near(at('paint', 0), 0, '纯色：种类 0')
  near(at('radiiY', 1), 3, 'radiiY.TR')
  near(at('inv', 1), 1 / 6, '1 / 水平半径 TR')
  near(at('inv', 4 + 1), 1 / 3, '1 / 竖直半径 TR')
  near(at('inv', 4 + 2), 0, '半径 0 的角：倒数写 0')
  near(at('clipRadiiY', 2), 6, '裁剪的竖直半径 BR')
  near(at('clipInv', 4 + 2), 1 / 6, '1 / 裁剪的竖直半径 BR')
  near(at('shapeBox', 2), 80, '单独算的形状 x1')
  near(at('shapeRadiiY', 0), 20, '形状的竖直半径')
  near(at('shapeInv', 0), 1 / 40, '1 / 形状的水平半径')
  near(at('maskPaint', 0), 2, '遮罩：径向')
  near(at('maskPaint', 2), 1, '遮罩：重复')
  near(at('maskGeom', 2), 1 / 50, '遮罩 1/rx')
  near(at('maskAt', 4 + 1), 1 / 0.5, '遮罩周期的倒数')
  near(at('maskAt', 4 + 2), 0.5, '遮罩周期')
  assert.ok(data.subarray(0, base).every((v) => v === 0), '写越界到了前一个槽位')

  // 位图：种类 3，geom 是图集 uv 的原点与每个画布设备像素走多少 uv；色标那一段清零
  packFill(data, 2, { ...fill, bitmap: { geom: [0.25, 0.5, 1 / 1024, 1 / 2048], version: 3 } })
  near(at('paint', 0), 3, '位图：种类 3')
  near(at('geom', 0), 0.25, '图集 u 原点')
  near(at('geom', 1), 0.5, '图集 v 原点')
  near(at('geom', 2), 1 / 1024, '每像素的 u')
  near(at('geom', 3), 1 / 2048, '每像素的 v')
  near(at('stops', 0), 0, '色标清零')
  near(at('maskPaint', 0), 2, '位图照样有遮罩')

  // 渐变：线性（方向除以长度²）、位置、重复的周期、相邻两个位置之差的倒数（重合的是 0）
  const linear: MeasuredFill = {
    ...fill,
    color: [0, 0, 0, 0.5],
    gradient: {
      kind: 'linear',
      repeating: true,
      geometry: [10, 20, 50, 20],
      colors: [
        [1, 0, 0, 1],
        [0, 1, 0, 0.5],
        [0, 1, 0, 0.5],
        [0, 0, 1, 1]
      ],
      offsets: [0.1, 0.4, 0.4, 0.9]
    }
  }
  data.fill(7) // 上一帧的残留：纯色的槽位要把渐变那几项清掉
  packFill(data, 1, linear)
  const g = (name: string, c: number): number => data[FILL_STRIDE_FLOATS + fields.get(name)! / 4 + c]!
  near(g('paint', 0), 1, '种类：线性')
  near(g('paint', 1), 4, '色标数')
  near(g('paint', 2), 1, '重复')
  near(g('geom', 0), 10, '起点 x')
  near(g('geom', 2), 40 / 1600, '方向 ÷ 长度²')
  near(g('geom', 3), 0, '方向 y')
  near(g('stops', 1 * 4 + 1), 1, '第 1 个色标的 g')
  near(g('stops', 1 * 4 + 3), 0.5, '第 1 个色标的 a')
  near(g('stops', 4 * 4 + 0), 0, '第 4 个色标（没有）清零')
  near(g('at', 0), 0.1, '位置 0')
  near(g('at', 3), 0.9, '位置 3')
  near(g('at', 5), 1 / 0.8, '重复：周期的倒数')
  near(g('at', 6), 0.8, '重复：周期')
  near(g('span', 0), 1 / 0.3, '第 0 段')
  near(g('span', 1), 0, '重合的一段：硬边')
  near(g('span', 2), 2, '第 2 段')
  near(g('span', 3), 0, '没有第 3 段')
  near(g('maskPaint', 0), 2, '遮罩跟着填充走（换成渐变的那一次也写了）')
  assert.equal(fields.get('maskSpan')! + 16, FILL_STRUCT_BYTES, 'maskSpan 是最后一项')
  assert.equal(fields.get('maskPaint'), 432, '遮罩接在裁剪后面')
  assert.equal(fields.get('radiiY'), 256, '椭圆角接在渐变后面：前面的布局没挪')
  assert.equal(fields.get('clipRadiiY'), 304, '裁剪的后半截接在椭圆角后面')
  assert.equal(fields.get('at')! - fields.get('stops')!, MAX_GRADIENT_STOPS * 16, '色标的颜色正好 MAX_GRADIENT_STOPS 个')

  // 径向：中心、半径的倒数
  packFill(data, 1, { ...linear, gradient: { ...linear.gradient!, kind: 'radial', repeating: false, geometry: [30, 40, 20, 10] } })
  near(g('paint', 0), 2, '种类：径向')
  near(g('geom', 1), 40, '中心 y')
  near(g('geom', 2), 1 / 20, '1/rx')
  near(g('geom', 3), 1 / 10, '1/ry')
  near(g('at', 5), 0, '不重复：周期写 0')
})

/* ------------------------------------------------------------------ *
 * 颜色、圆角、场景目标的换算
 * ------------------------------------------------------------------ */

test('颜色：rgb() / rgba() / hex 直接解析；透明与空串是透明；Node 里别的写法解析不了', () => {
  assert.deepEqual(parseFillColor('rgb(52, 199, 89)'), [52 / 255, 199 / 255, 89 / 255, 1])
  assert.deepEqual(parseFillColor('rgba(255, 0, 0, 0.5)'), [1, 0, 0, 0.5])
  assert.deepEqual(parseFillColor('#34c759'), [52 / 255, 199 / 255, 89 / 255, 1])
  assert.deepEqual(parseFillColor('transparent'), [0, 0, 0, 0])
  assert.deepEqual(parseFillColor(''), [0, 0, 0, 0], '没注册、也没设：空串')
  // oklch() 这类交给浏览器换算；Node 里没有 CSS / 画布，只能说解析不了
  assert.equal(parseFillColor('oklch(0.7 0.2 150)'), null)
})

test('圆角：px 与百分比、胶囊（超长的半径按 CSS 的规则缩小）、椭圆角、各轴钳到一半', () => {
  const same = (r: number): { x: number[]; y: number[] } => ({ x: [r, r, r, r], y: [r, r, r, r] })
  assert.deepEqual(fillRadii(['12px', '12px', '12px', '12px'], 200, 100), same(12))
  assert.deepEqual(fillRadii(['999px', '999px', '999px', '999px'], 51, 31), same(15.5), '胶囊：两个轴一起缩小，还是圆角')
  assert.deepEqual(fillRadii(['50%', '50%', '50%', '50%'], 200, 100), { x: [100, 100, 100, 100], y: [50, 50, 50, 50] }, '50%：椭圆')
  assert.deepEqual(fillRadii(['20px 8px', '0px', '0px', '0px'], 100, 100), { x: [20, 0, 0, 0], y: [8, 0, 0, 0] }, '椭圆角 20×8')
  assert.deepEqual(fillRadii(['30px', '0px', '0px', '0px'], 100, 30), { x: [30, 0, 0, 0], y: [15, 0, 0, 0] }, '竖直的钳到高的一半')
  assert.deepEqual(fillRadii(['0px', '0px', '0px', '0px'], 10, 10), same(0))
})

test('场景目标：scissor 往外取整并钳到目标；Dest 是画布 ÷ 场景', () => {
  // 画布 1200×900，场景 900×675（0.75）
  assert.deepEqual(sceneScissor([100, 50, 41, 21], 900, 675, 1200, 900), [75, 37, 31, 17])
  assert.deepEqual(sceneScissor([1190, 890, 10, 10], 900, 675, 1200, 900), [892, 667, 8, 8])
  assert.equal(sceneScissor([0, 0, 0, 10], 900, 675, 1200, 900), null)
  const d = sceneDest(900, 675, 1200, 900)
  assert.ok(Math.abs(d[0] - 4 / 3) < 1e-12 && Math.abs(d[1] - 4 / 3) < 1e-12 && Math.abs(d[2] - 4 / 3) < 1e-12)
})

/* ------------------------------------------------------------------ *
 * 测量：与面板共用一段几何
 * ------------------------------------------------------------------ */

function fakeElement(left: number, top: number, width: number, height: number): HTMLElement {
  return {
    isConnected: true,
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })
  } as unknown as HTMLElement
}

test('measure：填充按画布设备像素量、圆角乘 DPR；屏外的、透明的不画；颜色文本不变就不重新解析', () => {
  const styles = new Map<HTMLElement, FillStyle>()
  const registry = new PanelRegistry(() => {}, { readFillStyle: (r) => styles.get(r.element) ?? null })
  const viewport = resolveViewport(800, 600, 2)
  const track = fakeElement(100, 50, 51, 31)
  const hidden = fakeElement(10, 10, 40, 40)
  const offscreen = fakeElement(900, 10, 40, 40)
  styles.set(track, { color: 'rgb(52, 199, 89)', currentColor: 'rgb(0, 0, 0)', radii: ['999px', '999px', '999px', '999px'] })
  styles.set(hidden, { color: 'rgba(0, 0, 0, 0)', currentColor: 'rgb(0, 0, 0)', radii: ['0px', '0px', '0px', '0px'] })
  styles.set(offscreen, { color: 'rgb(255, 0, 0)', currentColor: 'rgb(0, 0, 0)', radii: ['0px', '0px', '0px', '0px'] })
  registry.registerFill(track)
  registry.registerFill(hidden)
  registry.registerFill(offscreen)

  const { fills, panels } = registry.measure(viewport)
  assert.equal(panels.length, 0, '填充不是面板')
  assert.equal(fills.length, 1, '透明的与屏外的都不画')
  const f = fills[0]!
  assert.deepEqual([f.x, f.y, f.w, f.h], [200, 100, 102, 62])
  assert.deepEqual(f.radii, [31, 31, 31, 31], '胶囊的半径 15.5 CSS px × DPR 2')
  assert.deepEqual(f.color, [52 / 255, 199 / 255, 89 / 255, 1])
  assert.deepEqual(f.scissor, [198, 98, 106, 66], '外扩 2px 抗锯齿余量')

  // 颜色文本没变：同一个解析结果（不重新解析）
  const again = registry.measure(viewport).fills[0]!
  assert.equal(again.record.paint, f.record.paint)
  // currentcolor：用元素的 color
  styles.set(track, { color: 'currentcolor', currentColor: 'rgb(255, 255, 255)', radii: ['0px', '0px', '0px', '0px'] })
  assert.deepEqual(registry.measure(viewport).fills[0]!.color, [1, 1, 1, 1])
})

test('registerBitmapFill：没有 2D 画布（Node）时不画、不抛；invalidate 请求一帧；unregister 之后不再量', () => {
  const style: FillStyle = { color: '', currentColor: 'rgb(0, 0, 0)', radii: ['0px', '0px', '0px', '0px'] }
  let changes = 0
  const registry = new PanelRegistry(() => changes++, { readFillStyle: () => style })
  const viewport = resolveViewport(800, 600, 1)
  const el = fakeElement(10, 10, 50, 20)
  let painted = 0
  const fill = registry.registerBitmapFill(el, () => painted++)
  assert.equal(registry.fillCount, 1)
  const { fills } = registry.measure(viewport)
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') {
    assert.equal(fills.length, 0, '拿不到图集就不画')
    assert.equal(painted, 0)
    assert.equal(registry.atlas, null)
  }
  const before = changes
  fill.invalidate()
  fill.invalidate()
  assert.ok(changes >= before, 'invalidate 请求重画')
  fill.unregister()
  assert.equal(registry.fillCount, 0)
})

test('registerFill：同一个元素重复注册是同一块；unregister 之后不再画', () => {
  const style: FillStyle = { color: 'rgb(1, 2, 3)', currentColor: 'rgb(0, 0, 0)', radii: ['0px', '0px', '0px', '0px'] }
  const registry = new PanelRegistry(() => {}, { readFillStyle: () => style })
  const viewport = resolveViewport(800, 600, 1)
  const el = fakeElement(10, 10, 50, 50)
  const a = registry.registerFill(el)
  registry.registerFill(el)
  assert.equal(registry.fillCount, 1)
  assert.equal(registry.measure(viewport).fills.length, 1)
  a.unregister()
  assert.equal(registry.measure(viewport).fills.length, 0)
})

test('解析不了的颜色按透明处理，只警告一次', () => {
  const registry = new PanelRegistry(() => {}, {
    readFillStyle: () => ({ color: 'not-a-color', currentColor: 'rgb(0, 0, 0)', radii: ['0px', '0px', '0px', '0px'] })
  })
  registry.registerFill(fakeElement(10, 10, 50, 50))
  const warn = console.warn
  let warned = 0
  console.warn = () => {
    warned++
  }
  try {
    const viewport = resolveViewport(800, 600, 1)
    assert.equal(registry.measure(viewport).fills.length, 0)
    registry.measure(viewport)
  } finally {
    console.warn = warn
  }
  assert.equal(warned, 1)
})
