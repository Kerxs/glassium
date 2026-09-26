/**
 * 两块不相干的玻璃之间的变形 —— SwiftUI `glassEffectID` 那种「这一块变成那一块」（按钮长成一张卡片、再缩回去）。
 *
 * ```js
 * menu.hidden = false                       // 先排好版：开始的那一刻它的不透明度就被设成 0
 * await morphGlass(button, menu).finished   // 按钮变成菜单
 * await morphGlass(menu, button).finished   // 再变回去
 * ```
 *
 * 一块「过渡用的玻璃」从 from 的矩形与材质出发，位置、大小、圆角、材质逐帧插值到 to 的；from 在开头 30% 的时间里
 * 淡出，to 在最后 30% 里淡入。进度正好是 0、1 时过渡玻璃不画，所以两头与只有 from、只有 to 时逐位相同；途中两块
 * 同样的玻璃叠在一起，只有抗锯齿的那一圈略厚一点。投影跟着交叉淡出淡入，不叠出双影。结束之后过渡玻璃拿掉，
 * from 停在不透明度 0（通常接着隐藏或移除它），to 回到原来的不透明度。
 *
 * 两头在 `transform: scale` 的祖先里（视觉缩放不是 1）时，按 dp 写的量要像真正的面板那样乘上缩放：两头的视觉缩放
 * 与 panels.ts 同一个算法（量到的盒子 ÷ offsetWidth / offsetHeight），数值与四个数的圆角、模糊按各自的缩放换成屏幕
 * 像素再插值；过渡玻璃自己带着两头之间插出来的缩放（`transform: scale`，布局尺寸 = 屏幕尺寸 ÷ 缩放），投影的 σ、
 * 偏移与够及的范围、亮边这些渲染器按 dp 定的形状跟着它缩。所以换成真正的面板的那一刻，圆角、模糊都不跳。
 *
 * 边界：过渡玻璃画在文档最外层（position: fixed，玻璃的第 0 层）—— from / to 写在别的玻璃里面时，途中看不见外面
 * 那块玻璃；起止的矩形在开始时量一次，途中页面滚动不跟；to 必须排了版（别用 display: none —— 量不到矩形时
 * 警告一句、直接换）。减少动效时直接换：from 不透明度 0、to 显示，没有过渡。
 */

import { MATERIAL_DEFAULTS, parseTint, resolveCornerRadii, type GlassMaterial } from '../core/material.ts'
import type { Radii4, Vec2 } from '../core/optics.ts'
import { describeElement } from '../renderer/layering.ts'
import { visualScaleOf } from '../renderer/panels.ts'
import { currentStage, prefersReducedMotion } from '../renderer/stage.ts'

/** 默认时长，毫秒。与 `<glass-container morph>` 的水滴一样。 */
export const MORPH_GLASS_MS = 450
/** from 淡出、to 淡入各占的比例。 */
export const MORPH_GLASS_FADE = 0.3

/**
 * CSS 的 cubic-bezier(x1, y1, x2, y2) 缓动：给定时间比例 t（0–1），先解 x(s) = t（牛顿法，不收敛时二分），
 * 再返回 y(s)。y1、y2 可以超出 0–1（回弹）。
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const x = (s: number): number => ((ax * s + bx) * s + cx) * s
  const dx = (s: number): number => (3 * ax * s + 2 * bx) * s + cx
  const y = (s: number): number => ((ay * s + by) * s + cy) * s
  return (t: number): number => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let s = t
    for (let i = 0; i < 8; i++) {
      const err = x(s) - t
      if (Math.abs(err) < 1e-7) return y(s)
      const d = dx(s)
      if (Math.abs(d) < 1e-6) break
      s -= err / d
    }
    let lo = 0
    let hi = 1
    s = t
    for (let i = 0; i < 40; i++) {
      if (x(s) < t) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return y(s)
  }
}

/** 形状（位置、大小）的缓动：略微回弹，与 `<glass-container morph>` 的 MORPH_EASING 相同。 */
export const MORPH_GLASS_EASE = cubicBezier(0.3, 1.2, 0.5, 1)

export interface MorphGlassOptions {
  /** 时长，毫秒。 */
  readonly duration?: number
  /** from / to 的材质。默认取元素的 `material`（`<glass-*>` 组件有；`stage.register` 注册的元素要自己传）。 */
  readonly fromMaterial?: GlassMaterial
  readonly toMaterial?: GlassMaterial
}

export interface GlassMorph {
  /** 走完（或 finish()）时 resolve；cancel() 时也 resolve。 */
  readonly finished: Promise<void>
  /** 停在某个进度（0–1）不再自己走：验证与自己驱动动画（比如跟着手指）用。 */
  seek(progress: number): void
  /** 直接跳到终点。 */
  finish(): void
  /** 放弃：过渡玻璃拿掉，from、to 回到开始之前的不透明度。 */
  cancel(): void
}

/** 屏幕上的矩形，CSS 像素（getBoundingClientRect 的那几项）。 */
export interface MorphBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** 变形的一头，换算到屏幕上。 */
export interface MorphEnd {
  readonly box: MorphBox
  /** 视觉缩放：屏幕上的尺寸 ÷ 布局尺寸（见 panels.ts 的 visualScaleOf）。 */
  readonly scale: number
  readonly material: Required<GlassMaterial>
  /** 圆角，屏幕像素。 */
  readonly radii: Radii4
  /** 模糊 σ，屏幕像素。 */
  readonly blur: number
}

/** 过渡玻璃在某个进度上的样子。 */
export interface MorphFrame {
  readonly box: MorphBox
  /** 过渡玻璃自己的视觉缩放（它的 transform: scale）：两头的缩放之间插值。 */
  readonly scale: number
  /** 材质，按过渡玻璃自己的 dp —— 渲染器画它时乘上 scale。 */
  readonly material: GlassMaterial
  /** from、to 此刻的不透明度。 */
  readonly fromAlpha: number
  readonly toAlpha: number
}

/** 被变形碰过的元素原来的内联不透明度 —— 连着变形（变过去再变回来）时认得出「是变形设的 0」。 */
const originalOpacity = new WeakMap<HTMLElement, string>()

function rememberOpacity(el: HTMLElement): string {
  if (!originalOpacity.has(el)) originalOpacity.set(el, el.style.opacity)
  return originalOpacity.get(el)!
}

function materialOf(el: HTMLElement): GlassMaterial {
  const m = (el as { material?: unknown }).material
  return m && typeof m === 'object' ? (m as GlassMaterial) : {}
}

const lerp = (a: number, b: number, t: number): number => a * (1 - t) + b * t
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/**
 * 一头换算到屏幕上：与 panels.ts 量真正的面板时一样，没有缩放时按量到的尺寸解算圆角，有缩放时按布局尺寸（dp）
 * 解算、再乘缩放。按 dp 写的圆角（数值、四个数）与模糊跟着缩；'frac' 圆角按短边的比例，本来就跟着缩。
 */
export function morphEnd(el: HTMLElement, box: MorphBox, material: GlassMaterial): MorphEnd {
  const m = { ...MATERIAL_DEFAULTS, ...material }
  const scale = visualScaleOf(box.width, box.height, el.offsetWidth, el.offsetHeight)
  const size: Vec2 = scale === 1 ? [box.width, box.height] : [el.offsetWidth, el.offsetHeight]
  const [r0, r1, r2, r3] = resolveCornerRadii(m.cornerRadius, size)
  return { box, scale, material: m, radii: [r0 * scale, r1 * scale, r2 * scale, r3 * scale], blur: m.blur * scale }
}

/**
 * 两头之间的第 k 处（k 在 0–1）的材质，按过渡玻璃自己的 dp：圆角与模糊在屏幕像素里插、再除以过渡玻璃的缩放 scale
 * （渲染器画它时乘回去）；shadowScale 乘在投影上（交叉淡出淡入）。
 */
function materialBetween(from: MorphEnd, to: MorphEnd, k: number, scale: number, shadowScale: number): GlassMaterial {
  const [r0, g0, b0, a0] = parseTint(from.material.tint)
  const [r1, g1, b1, a1] = parseTint(to.material.tint)
  const radius = (i: 0 | 1 | 2 | 3): number => lerp(from.radii[i], to.radii[i], k) / scale
  const n = (key: keyof typeof MATERIAL_DEFAULTS): number =>
    lerp(from.material[key] as number, to.material[key] as number, k)
  return {
    cornerRadius: [radius(0), radius(1), radius(2), radius(3)],
    blur: lerp(from.blur, to.blur, k) / scale,
    refraction: n('refraction'),
    distortion: n('distortion'),
    highlight: n('highlight'),
    dispersion: n('dispersion'),
    saturation: n('saturation'),
    opacity: n('opacity'),
    squircle: n('squircle'),
    depthEffect: n('depthEffect'),
    adaptive: n('adaptive'),
    shadow: n('shadow') * shadowScale,
    tint: `rgba(${lerp(r0, r1, k) * 255}, ${lerp(g0, g1, k) * 255}, ${lerp(b0, b1, k) * 255}, ${lerp(a0, a1, k)})`
  }
}

/**
 * 过渡玻璃在进度 p（0–1）处：矩形按略微回弹的缓动插值；缩放与材质按同一个缓动、钳在 0–1 插值（两头缩放相同时
 * 就是它，一点不差）。from 在开头的 MORPH_GLASS_FADE 里淡出，to 在最后的 MORPH_GLASS_FADE 里淡入。
 */
export function morphFrame(from: MorphEnd, to: MorphEnd, p: number): MorphFrame {
  const g = MORPH_GLASS_EASE(p) // 形状略微回弹
  const k = clamp01(g)
  const a = from.box
  const b = to.box
  const scale = from.scale === to.scale ? to.scale : lerp(from.scale, to.scale, k)
  const fromAlpha = clamp01(1 - p / MORPH_GLASS_FADE)
  const toAlpha = clamp01((p - (1 - MORPH_GLASS_FADE)) / MORPH_GLASS_FADE)
  return {
    box: {
      left: lerp(a.left, b.left, g),
      top: lerp(a.top, b.top, g),
      width: Math.max(0, lerp(a.width, b.width, g)),
      height: Math.max(0, lerp(a.height, b.height, g))
    },
    scale,
    material: materialBetween(from, to, k, scale, (1 - fromAlpha) * (1 - toAlpha)),
    fromAlpha,
    toAlpha
  }
}

/** from 变成 to。见文件头。 */
export function morphGlass(from: HTMLElement, to: HTMLElement, options: MorphGlassOptions = {}): GlassMorph {
  const fromBase = rememberOpacity(from)
  const toBase = rememberOpacity(to)
  let settle = (): void => {}
  const finished = new Promise<void>((resolve) => (settle = resolve))

  // 终点：from 藏起来，to 回到原来的不透明度（变形之前那个，不是上一次变形设的 0）
  const land = (): void => {
    from.style.opacity = '0'
    to.style.opacity = toBase
    originalOpacity.delete(to)
  }

  const swap = (): GlassMorph => {
    land()
    settle()
    return { finished, seek(): void {}, finish(): void {}, cancel(): void {} }
  }

  const stage = currentStage()
  if (prefersReducedMotion() || !stage || !stage.active) return swap()

  const a = from.getBoundingClientRect()
  const b = to.getBoundingClientRect()
  const empty = a.width <= 0 || a.height <= 0 ? from : b.width <= 0 || b.height <= 0 ? to : null
  if (empty) {
    // 量不到矩形（display: none、不在文档里）：不知道从哪里变到哪里，直接换
    console.warn(`[Glassium] morphGlass：${describeElement(empty)} 没有排版（display: none？），直接换、不做变形`, empty)
    return swap()
  }
  const fromEnd = morphEnd(from, a, options.fromMaterial ?? materialOf(from))
  const toEnd = morphEnd(to, b, options.toMaterial ?? materialOf(to))
  const duration = Math.max(1, options.duration ?? MORPH_GLASS_MS)

  const ghost = document.createElement('div')
  ghost.setAttribute('data-glassium-morph', '')
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, {
    position: 'fixed',
    margin: '0',
    padding: '0',
    border: '0',
    pointerEvents: 'none',
    opacity: '0',
    transformOrigin: '0 0'
  })
  document.body.append(ghost)
  const panel = stage.register(ghost, morphFrame(fromEnd, toEnd, 0).material)

  let rafId = 0
  let done = false
  const apply = (p: number): void => {
    const f = morphFrame(fromEnd, toEnd, p)
    Object.assign(ghost.style, {
      left: `${f.box.left}px`,
      top: `${f.box.top}px`,
      // 缩放交给 transform：布局尺寸 = 屏幕上的尺寸 ÷ 缩放，渲染器量它的视觉缩放，与量两头时一样
      width: `${f.box.width / f.scale}px`,
      height: `${f.box.height / f.scale}px`,
      transform: f.scale === 1 ? '' : `scale(${f.scale})`,
      // 两头不画：与只有 from、只有 to 时逐位相同
      opacity: p > 0 && p < 1 ? '1' : '0'
    })
    from.style.opacity = String(f.fromAlpha)
    to.style.opacity = String(f.toAlpha)
    panel.setMaterial(f.material)
  }
  const teardown = (): void => {
    if (rafId !== 0) cancelAnimationFrame(rafId)
    rafId = 0
    panel.unregister()
    ghost.remove()
    done = true
  }
  const complete = (): void => {
    if (done) return
    teardown()
    land()
    settle()
  }

  apply(0)
  const start = performance.now()
  const tick = (now: number): void => {
    rafId = 0
    const p = Math.min(1, (now - start) / duration)
    apply(p)
    if (p >= 1) complete()
    else rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)

  return {
    finished,
    seek(progress: number): void {
      if (done) return
      if (rafId !== 0) cancelAnimationFrame(rafId)
      rafId = 0
      apply(clamp01(progress))
    },
    finish(): void {
      complete()
    },
    cancel(): void {
      if (done) return
      teardown()
      from.style.opacity = fromBase
      to.style.opacity = toBase
      settle()
    }
  }
}
