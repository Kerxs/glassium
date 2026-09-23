import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lowerMaterial } from '../core/material.ts'
import { resolveViewport } from '../core/units.ts'
import {
  GLASS_WGSL,
  PANEL_STRIDE,
  PANEL_STRIDE_FLOATS,
  PANEL_STRUCT_BYTES
} from '../shaders/glass.wgsl.ts'
import { levelForSigma } from './blur.ts'
import { PanelRegistry, RIM_WIDTH_DP, packPanel, type MeasuredPanel } from './panels.ts'
import { compareOptics, type OpticsProbe } from './verify.ts'
import {
  gradRadiusOf,
  radiusAt,
  refractionDirection,
  refractionProfile,
  sdRoundedRect,
  type Radii4,
  type Vec2
} from '../core/optics.ts'

/* ------------------------------------------------------------------ *
 * WGSL struct Panel 与 TS 打包必须逐字节对齐
 *
 * 这里写错一个偏移，WebGPU 不会报任何错 —— 你只会看到一块位置或形状微妙不对的玻璃，
 * 然后花半天怀疑光学。所以不靠注释里手写的偏移，而是**直接从 WGSL 源里解析 struct，
 * 按 WGSL 的对齐规则算出每个字段的偏移**，再去核对 packPanel 写的位置。
 * 两边任何一边改了而另一边没跟上，这条测试当场失败。
 * ------------------------------------------------------------------ */

/** WGSL uniform 布局规则（只覆盖 Panel 用到的类型）。 */
const LAYOUT: Record<string, { align: number; size: number }> = {
  f32: { align: 4, size: 4 },
  vec2f: { align: 8, size: 8 },
  vec4f: { align: 16, size: 16 }
}

function parsePanelStruct(): { fields: Map<string, number>; size: number } {
  const m = /struct Panel \{([\s\S]*?)\n\}/.exec(GLASS_WGSL)
  assert.ok(m, 'GLASS_WGSL 里找不到 struct Panel')
  const fields = new Map<string, number>()
  let offset = 0
  let maxAlign = 0
  for (const line of m[1]!.split('\n')) {
    const f = /^\s*(\w+)\s*:\s*(\w+)\s*,/.exec(line)
    if (!f) continue
    const layout = LAYOUT[f[2]!]
    assert.ok(layout, `struct Panel 里出现了测试不认识的类型 ${f[2]}，请补进 LAYOUT`)
    offset = Math.ceil(offset / layout.align) * layout.align
    fields.set(f[1]!, offset)
    offset += layout.size
    maxAlign = Math.max(maxAlign, layout.align)
  }
  return { fields, size: Math.ceil(offset / maxAlign) * maxAlign }
}

test('PANEL_STRUCT_BYTES 等于按 WGSL 规则算出的 struct 大小', () => {
  const { size } = parsePanelStruct()
  assert.equal(PANEL_STRUCT_BYTES, size)
  assert.ok(PANEL_STRUCT_BYTES <= PANEL_STRIDE, 'struct 必须放得进一个步长')
  assert.equal(PANEL_STRIDE % 256, 0, '步长必须满足 T5 实测的 256B 动态偏移对齐')
})

test('packPanel 写入的每个字段都落在 WGSL struct 的对应偏移上', () => {
  const { fields } = parsePanelStruct()
  const viewport = resolveViewport(1000, 800, 1.5)
  const scale = viewport.compositeWidth / viewport.cssWidth
  const chain = lowerMaterial(
    {
      blur: 6,
      refraction: 0.3,
      distortion: 0.25,
      saturation: 1.3,
      tint: 'rgba(51, 102, 153, 0.4)',
      cornerRadius: [3, 7, 11, 13],
      squircle: 3,
      depthEffect: 0.7,
      dispersion: 0.2,
      highlight: 0.55,
      opacity: 0.9
    },
    [240, 160]
  )
  const panel: MeasuredPanel = {
    record: { element: {} as HTMLElement, material: {}, cached: null },
    x: 11,
    y: 22,
    w: 333,
    h: 222,
    scissor: [9, 20, 337, 226],
    chain
  }

  // 放在第 2 个槽位，顺带验证步长
  const data = new Float32Array(PANEL_STRIDE_FLOATS * 3)
  packPanel(data, 2, panel, viewport, 6, 'grad')
  const base = 2 * PANEL_STRIDE_FLOATS
  const at = (name: string, component = 0): number => {
    const off = fields.get(name)
    assert.ok(off !== undefined, `WGSL struct Panel 里没有字段 ${name}`)
    return data[base + off / 4 + component]!
  }
  const near = (a: number, b: number, what: string): void =>
    assert.ok(Math.abs(a - b) < 1e-5, `${what}：写入 ${a}，期望 ${b}`)

  const lens = chain.effects.find((e) => e.kind === 'lens')
  assert.ok(lens && lens.kind === 'lens')

  near(at('rect', 0), 11, 'rect.x')
  near(at('rect', 1), 22, 'rect.y')
  near(at('rect', 2), 333, 'rect.w')
  near(at('rect', 3), 222, 'rect.h')
  near(at('radii', 0), 3 * scale, 'radii.TL')
  near(at('radii', 1), 7 * scale, 'radii.TR')
  near(at('radii', 2), 11 * scale, 'radii.BR')
  near(at('radii', 3), 13 * scale, 'radii.BL')
  near(at('tint', 0), 0.2, 'tint.r')
  near(at('tint', 1), 0.4, 'tint.g')
  near(at('tint', 2), 0.6, 'tint.b')
  near(at('tint', 3), 0.4, 'tint.a')
  near(at('heightPx'), lens.heightDp * scale, 'heightPx')
  near(at('amountPx'), lens.amountDp * scale, 'amountPx')
  near(at('blurLevel'), levelForSigma(6 * viewport.sceneScale, 6), 'blurLevel')
  near(at('saturation'), 1.3, 'saturation')
  near(at('squircle'), 3, 'squircle')
  near(at('depthEffect'), 0.7, 'depthEffect')
  near(at('dispersion'), 0.2, 'dispersion')
  near(at('highlight'), 0.55, 'highlight')
  near(at('opacity'), 0.9, 'opacity')
  near(at('debugMode'), 3, 'debugMode（grad 在 DEBUG_MODES 里排第 3）')
  near(at('rimPx'), RIM_WIDTH_DP * scale, 'rimPx')

  // 相邻槽位不能被写脏
  assert.ok(data.subarray(0, base).every((v) => v === 0), '写越界到了前一个槽位')
})

/* ------------------------------------------------------------------ *
 * 测量：画布原点、缩放、裁剪、屏外剔除
 * ------------------------------------------------------------------ */

function fakeElement(left: number, top: number, width: number, height: number): HTMLElement {
  return {
    isConnected: true,
    getBoundingClientRect: () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({})
    })
  } as unknown as HTMLElement
}

test('measure 按画布自身尺寸换算，并减去画布原点', () => {
  // 画布 CSS 宽 1008.67（滚动条已除外），DPR 1.5 → 1513 个设备像素。
  // 换算必须用 1513 / 1008.67 而不是 dpr，这正是 T7 修掉的那个滚动条错位。
  const viewport = resolveViewport(1008.6666870117188, 768, 1.5)
  const registry = new PanelRegistry(() => {})
  registry.register(fakeElement(110, 60, 200, 100), {})
  const [m] = registry.measure(viewport, 10, 20).panels
  assert.ok(m)
  const s = viewport.compositeWidth / viewport.cssWidth
  assert.ok(Math.abs(m.x - 100 * s) < 1e-9, '应减去画布原点 x=10')
  assert.ok(Math.abs(m.y - 40 * (viewport.compositeHeight / viewport.cssHeight)) < 1e-9)
  assert.ok(Math.abs(m.w - 200 * s) < 1e-9)
})

test('measure 的裁剪矩形外扩 2px 抗锯齿余量，并与画布求交', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  registry.register(fakeElement(-50, 580, 200, 100), {}) // 左边与下边都越出画布
  const [m] = registry.measure(viewport).panels
  assert.ok(m)
  const [x, y, w, h] = m.scissor
  assert.equal(x, 0, '左侧被画布钳住')
  assert.equal(y, 578, '上边外扩 2px')
  assert.equal(x + w, 152, '右边 = -50 + 200 + 2')
  assert.equal(y + h, 600, '下侧被画布钳住')
})

test('完全在屏外的面板被剔除，不占 draw call', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  registry.register(fakeElement(-500, 100, 200, 100), {})
  registry.register(fakeElement(100, 900, 200, 100), {})
  registry.register(fakeElement(100, 100, 200, 100), {})
  assert.equal(registry.measure(viewport).panels.length, 1)
})

test('尺寸为 0 的面板与已脱离文档的面板都被跳过', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  registry.register(fakeElement(10, 10, 0, 50), {})
  const detached = fakeElement(10, 10, 100, 50)
  ;(detached as unknown as { isConnected: boolean }).isConnected = false
  registry.register(detached, {})
  assert.equal(registry.measure(viewport).panels.length, 0)
})

test('降级结果按尺寸缓存，尺寸不变就不重算', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  registry.register(fakeElement(10, 10, 200, 100), { blur: 4 })
  const a = registry.measure(viewport).panels[0]!.chain
  const b = registry.measure(viewport).panels[0]!.chain
  assert.equal(a, b, '同尺寸两帧应复用同一个 chain 对象')
})

test('重复注册同一个元素会更新材质而不是多出一块面板', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  const el = fakeElement(10, 10, 200, 100)
  registry.register(el, { blur: 4 })
  const warn = console.warn
  console.warn = () => {}
  try {
    registry.register(el, { blur: 12 })
  } finally {
    console.warn = warn
  }
  const measured = registry.measure(viewport).panels
  assert.equal(measured.length, 1)
  const blur = measured[0]!.chain.effects.find((e) => e.kind === 'blur')
  assert.ok(blur && blur.kind === 'blur' && blur.sigmaDp === 12, '材质应被更新')
})

/* ------------------------------------------------------------------ *
 * compareOptics 本身也得验：一个永远报「没问题」的比对器比没有更糟
 * ------------------------------------------------------------------ */

function syntheticProbe(): OpticsProbe {
  const width = 40
  const height = 30
  const origin: Vec2 = [100, 50]
  const panel = {
    rect: [102, 52, 36, 26] as const,
    radii: [4, 9, 6, 12] as Radii4,
    heightPx: 6,
    amountPx: 10,
    squircle: 2,
    depthEffect: 1
  }
  const halfSize: Vec2 = [panel.rect[2] / 2, panel.rect[3] / 2]
  const center: Vec2 = [panel.rect[0] + halfSize[0], panel.rect[1] + halfSize[1]]
  const data = new Float32Array(width * height * 4)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const c: Vec2 = [origin[0] + i + 0.5 - center[0], origin[1] + j + 0.5 - center[1]]
      const r = radiusAt(c, panel.radii)
      const sd = sdRoundedRect(c, halfSize, r)
      const dir = refractionDirection(c, halfSize, gradRadiusOf(r, halfSize), panel.depthEffect)
      const disp = refractionProfile(sd, panel.heightPx, panel.amountPx, panel.squircle)
      data.set([sd, dir[0], dir[1], disp], (j * width + i) * 4)
    }
  }
  return { width, height, origin, data, panel }
}

test('compareOptics：GPU 输出与 CPU 一致时误差为 f32 量级', () => {
  const c = compareOptics(syntheticProbe())
  assert.equal(c.gpuNonFinite, 0)
  // 合成探针存进 Float32Array 时已经过一次 f32 舍入，所以不是精确的 0
  assert.ok(c.maxErr.sd < 1e-5, `sd ${c.maxErr.sd}`)
  assert.ok(c.maxErr.offset < 1e-4, `offset ${c.maxErr.offset}`)
})

test('compareOptics：能数出 NaN', () => {
  const probe = syntheticProbe()
  probe.data[4 * 17 + 2] = Number.NaN
  assert.equal(compareOptics(probe).gpuNonFinite, 1)
})

test('compareOptics：能抓到真正错了的偏移', () => {
  // 把一个位于折射带内的纹素的位移改大 3 个像素 —— 比对器必须看见。
  const probe = syntheticProbe()
  let hit = -1
  for (let t = 0; t < probe.width * probe.height; t++) {
    if (probe.data[t * 4 + 3]! > 1) {
      hit = t
      break
    }
  }
  assert.ok(hit >= 0, '合成面板里应当有位移非零的纹素')
  probe.data[hit * 4 + 3] = probe.data[hit * 4 + 3]! + 3
  const c = compareOptics(probe)
  assert.ok(c.maxErr.offset > 2.5, `应当报出约 3px 的偏移误差，实得 ${c.maxErr.offset}`)
})
