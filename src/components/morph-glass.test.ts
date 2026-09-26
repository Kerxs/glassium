import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveCornerRadii, type GlassMaterial } from '../core/material.ts'
import { resolveViewport } from '../core/units.ts'
import { MAX_LEVELS } from '../renderer/blur.ts'
import { PANEL_STRUCT_FLOATS, PanelRegistry, packPanel } from '../renderer/panels.ts'
import { PANEL_STRIDE_FLOATS } from '../shaders/glass.wgsl.ts'
import { cubicBezier, morphEnd, morphFrame, MORPH_GLASS_EASE, type MorphBox, type MorphEnd } from './morph-glass.ts'

test('cubic-bezier：两头、线性、CSS 的 ease 在 0.5 处', () => {
  const linear = cubicBezier(0, 0, 1, 1)
  for (const t of [0, 0.1, 0.37, 0.5, 0.9, 1]) assert.ok(Math.abs(linear(t) - t) < 1e-6)
  const ease = cubicBezier(0.25, 0.1, 0.25, 1)
  assert.equal(ease(0), 0)
  assert.equal(ease(1), 1)
  // 浏览器里 cubic-bezier(0.25, 0.1, 0.25, 1) 在 0.5 处约 0.8024
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 1e-3, `ease(0.5) = ${ease(0.5)}`)
})

test('变形的形状缓动：两头精确、途中略微回弹（超过 1）、单调走到回弹顶点', () => {
  assert.equal(MORPH_GLASS_EASE(0), 0)
  assert.equal(MORPH_GLASS_EASE(1), 1)
  let peak = 0
  for (let i = 1; i < 100; i++) peak = Math.max(peak, MORPH_GLASS_EASE(i / 100))
  assert.ok(peak > 1 && peak < 1.1, `回弹顶点 ${peak}`)
})

test('cubic-bezier：x 的控制点贴边（导数接近 0）时二分兜底', () => {
  const f = cubicBezier(1, 0, 1, 1) // x'(0) = 3，x'(1) 接近 0
  let prev = -1
  for (let i = 0; i <= 50; i++) {
    const v = f(i / 50)
    assert.ok(v >= prev - 1e-9)
    prev = v
  }
})

/* ------------------------------------------------------------------ *
 * 两头在 transform: scale 里：过渡玻璃结束时与真正的面板对得上
 *
 * 不在这里重算「真正的面板的有效值」：两块玻璃都交给同一个注册表量、打包，比着色器实际拿到的数 ——
 * 圆角、模糊级别、亮边、投影 σ 与偏移都乘过视觉缩放，裁剪矩形里有投影够及的范围。
 * ------------------------------------------------------------------ */

const viewport = resolveViewport(1280, 800, 1.5)

/** 假元素：屏幕上的矩形（getBoundingClientRect）与布局尺寸（offsetWidth / offsetHeight 是取整过的）。 */
function element(box: MorphBox, layoutW: number, layoutH: number): HTMLElement {
  const { left, top, width, height } = box
  return {
    isConnected: true,
    offsetWidth: Math.round(layoutW),
    offsetHeight: Math.round(layoutH),
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) })
  } as unknown as HTMLElement
}

/** 布局 w × h、在 scale(k) 的祖先里、屏幕上左上角在 (left, top) 的元素。 */
const scaledElement = (left: number, top: number, w: number, h: number, k: number): HTMLElement =>
  element({ left, top, width: w * k, height: h * k }, w, h)

const endOf = (el: HTMLElement, material: GlassMaterial): MorphEnd => morphEnd(el, el.getBoundingClientRect(), material)

interface Drawn {
  /** 着色器拿到的 Panel 结构体。 */
  readonly uniforms: Float32Array
  /** 裁剪矩形：有投影时外扩到影子够得着的地方。 */
  readonly scissor: readonly number[]
  readonly visualScale: number
}

/** 注册表量一帧、打包。 */
function drawn(el: HTMLElement, material: GlassMaterial): Drawn {
  const registry = new PanelRegistry(() => {})
  registry.register(el, material)
  const [panel] = registry.measure(viewport).panels
  assert.ok(panel, '面板应该画出来')
  const data = new Float32Array(PANEL_STRIDE_FLOATS)
  packPanel(data, 0, panel, viewport, MAX_LEVELS, 'off')
  return { uniforms: data.subarray(0, PANEL_STRUCT_FLOATS), scissor: panel.scissor, visualScale: panel.visualScale }
}

/** 过渡玻璃在进度 p 处：照 morphGlass 设的样式（布局尺寸 = 屏幕尺寸 ÷ 缩放，缩放交给 transform）造出来再画。 */
function ghostAt(from: MorphEnd, to: MorphEnd, p: number): Drawn {
  const f = morphFrame(from, to, p)
  return drawn(element(f.box, f.box.width / f.scale, f.box.height / f.scale), f.material)
}

/** Panel 结构体里的位置（与 panels.ts 的 writePanel 一致），失败时说得出是哪一项。 */
const FIELDS: Readonly<Record<number, string>> = {
  0: '矩形 x',
  1: '矩形 y',
  2: '矩形宽',
  3: '矩形高',
  4: '圆角 TL',
  5: '圆角 TR',
  6: '圆角 BR',
  7: '圆角 BL',
  12: '折射带深度',
  13: '位移幅值',
  14: '模糊级别',
  22: '亮边宽度',
  37: '投影 σ',
  38: '投影偏移'
}
/** 投影的深浅：过渡玻璃的投影交叉淡出淡入（快结束时只剩一点点），不比。 */
const SHADOW_ALPHA = 36

function assertSameGlass(ghost: Drawn, real: Drawn, tol: number, what: string): void {
  for (let i = 0; i < real.uniforms.length; i++) {
    if (i === SHADOW_ALPHA) continue
    const got = ghost.uniforms[i]!
    const want = real.uniforms[i]!
    assert.ok(Math.abs(got - want) <= tol, `${what}：${FIELDS[i] ?? `第 ${i} 个数`}，过渡玻璃 ${got}，真正的面板 ${want}`)
  }
}

test('两头在 scale(0.5) 里：过渡玻璃结束时的圆角、模糊、亮边、投影与真正的面板相同', () => {
  const k = 0.5
  // 按钮写四个数的圆角；面板 corner-radius="26" —— 屏幕上真正的圆角是 13
  const buttonMat: GlassMaterial = { cornerRadius: [12, 12, 6, 6], blur: 6, shadow: 0.3 }
  const cardMat: GlassMaterial = { cornerRadius: 26, blur: 8, shadow: 0.3, tint: 'rgba(255, 60, 60, 0.45)' }
  const button = scaledElement(600, 20, 36, 24, k)
  const card = scaledElement(440, 32, 326, 400, k)
  const from = endOf(button, buttonMat)
  const to = endOf(card, cardMat)

  const real = drawn(card, cardMat)
  assert.equal(real.visualScale, k)
  const s = viewport.compositeWidth / viewport.cssWidth
  assert.equal(real.uniforms[4], 26 * k * s, '真正的面板：圆角 26dp × 0.5（画布设备像素再乘 DPR）')

  // 快结束（seek(0.999)）：过渡玻璃还画着，投影还剩一点点；矩形差回弹剩下的那一丝
  const end = ghostAt(from, to, 0.999)
  assertSameGlass(end, real, 1e-3, '结束之前')
  assert.deepEqual(end.scissor, real.scissor, '投影够及的范围（裁剪矩形）')
  // 起点对称：过渡玻璃是按钮的样子
  assertSameGlass(ghostAt(from, to, 0), drawn(button, buttonMat), 1e-4, '起点')
  assert.equal(morphFrame(from, to, 0.5).scale, k, '途中过渡玻璃也缩 0.5')
})

test('两头缩放不同（1 → 0.5）：过渡玻璃的缩放与屏幕上的圆角都在两头之间，两头各自对得上', () => {
  const buttonMat: GlassMaterial = { cornerRadius: 28, blur: 10 }
  const cardMat: GlassMaterial = { cornerRadius: 26, blur: 8 }
  const button = element({ left: 40, top: 40, width: 56, height: 56 }, 56, 56)
  const card = scaledElement(300, 200, 326, 400, 0.5)
  const from = endOf(button, buttonMat)
  const to = endOf(card, cardMat)
  assertSameGlass(ghostAt(from, to, 0), drawn(button, buttonMat), 1e-4, '起点')
  assertSameGlass(ghostAt(from, to, 0.999), drawn(card, cardMat), 1e-3, '结束之前')
  for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const f = morphFrame(from, to, p)
    const k = Math.min(1, Math.max(0, MORPH_GLASS_EASE(p)))
    assert.ok(Math.abs(f.scale - (1 - 0.5 * k)) < 1e-12, `p = ${p}：缩放 ${f.scale}`)
    // 屏幕上的圆角（渲染器乘上过渡玻璃的缩放）在屏幕像素里插：28 → 13
    const radius = (f.material.cornerRadius as readonly number[])[0]! * f.scale
    assert.ok(Math.abs(radius - (28 * (1 - k) + 13 * k)) < 1e-9, `p = ${p}：屏幕上的圆角 ${radius}`)
  }
})

test('两头没有缩放：过渡玻璃不带缩放，圆角按量到的尺寸解算（与改之前一样）', () => {
  const buttonMat: GlassMaterial = { cornerRadius: '1frac' }
  const cardMat: GlassMaterial = { cornerRadius: 24, tint: 'rgba(255, 60, 60, 0.45)' }
  const button = element({ left: 440, top: 200, width: 56, height: 56 }, 56, 56)
  // 带小数的宽：offsetWidth 取整成 220，差不到 1% —— 当作没有缩放，按量到的 220.4 解算
  const card = element({ left: 500, top: 320, width: 220.4, height: 140 }, 220.4, 140)
  const from = endOf(button, buttonMat)
  const to = endOf(card, cardMat)
  assert.equal(from.scale, 1)
  assert.equal(to.scale, 1)
  for (const p of [0, 0.5, 1]) assert.equal(morphFrame(from, to, p).scale, 1)
  assert.deepEqual(morphFrame(from, to, 1).material.cornerRadius, resolveCornerRadii(24, [220.4, 140]))
  assert.deepEqual(morphFrame(from, to, 0).material.cornerRadius, resolveCornerRadii('1frac', [56, 56]))
  assertSameGlass(ghostAt(from, to, 0.999), drawn(card, cardMat), 1e-3, '结束之前')
})
