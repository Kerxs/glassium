import { test } from 'node:test'
import assert from 'node:assert/strict'

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
    const f = /^\s*(\w+)\s*:\s*(\w+)\s*,/.exec(line)
    if (!f) continue
    assert.equal(f[2], 'vec4f', `struct Fill 只该有 vec4f，${f[1]} 是 ${f[2]}`)
    fields.set(f[1]!, offset)
    offset += 16
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
    radii: [5, 6, 7, 8],
    color: [0.1, 0.2, 0.3, 0.4]
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
  assert.ok(data.subarray(0, base).every((v) => v === 0), '写越界到了前一个槽位')
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

test('圆角：px 与百分比、胶囊（超长的半径按 CSS 的规则缩小）、椭圆角取短的、钳到短边一半', () => {
  assert.deepEqual(fillRadii(['12px', '12px', '12px', '12px'], 200, 100), [12, 12, 12, 12])
  assert.deepEqual(fillRadii(['999px', '999px', '999px', '999px'], 51, 31), [15.5, 15.5, 15.5, 15.5], '胶囊')
  assert.deepEqual(fillRadii(['50%', '50%', '50%', '50%'], 200, 100), [50, 50, 50, 50], '50%：椭圆取短半径')
  assert.deepEqual(fillRadii(['20px 8px', '0px', '0px', '0px'], 100, 100), [8, 0, 0, 0], '椭圆角 20×8 取 8')
  assert.deepEqual(fillRadii(['30px', '0px', '0px', '0px'], 100, 30), [15, 0, 0, 0], '单个角大于短边一半：钳住')
  assert.deepEqual(fillRadii(['0px', '0px', '0px', '0px'], 10, 10), [0, 0, 0, 0])
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
  assert.equal(again.record.color, f.record.color)
  // currentcolor：用元素的 color
  styles.set(track, { color: 'currentcolor', currentColor: 'rgb(255, 255, 255)', radii: ['0px', '0px', '0px', '0px'] })
  assert.deepEqual(registry.measure(viewport).fills[0]!.color, [1, 1, 1, 1])
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
