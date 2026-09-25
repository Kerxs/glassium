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
 * 边界：过渡玻璃画在文档最外层（position: fixed，玻璃的第 0 层）—— from / to 写在别的玻璃里面时，途中看不见外面
 * 那块玻璃；起止的矩形在开始时量一次，途中页面滚动不跟；to 必须排了版（别用 display: none —— 量不到矩形时
 * 警告一句、直接换）。减少动效时直接换：from 不透明度 0、to 显示，没有过渡。
 */

import { MATERIAL_DEFAULTS, parseTint, resolveCornerRadii, type GlassMaterial } from '../core/material.ts'
import type { Radii4 } from '../core/optics.ts'
import { describeElement } from '../renderer/layering.ts'
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

interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
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

/** 两套材质之间的第 t 处（t 钳在 0–1）。圆角按各自的尺寸解算成像素再插；shadowScale 乘在投影上（交叉淡出淡入）。 */
function materialBetween(
  from: Required<GlassMaterial>,
  to: Required<GlassMaterial>,
  fromRadii: Radii4,
  toRadii: Radii4,
  t: number,
  shadowScale: number
): GlassMaterial {
  const k = clamp01(t)
  const [r0, g0, b0, a0] = parseTint(from.tint)
  const [r1, g1, b1, a1] = parseTint(to.tint)
  const radii: Radii4 = [
    lerp(fromRadii[0], toRadii[0], k),
    lerp(fromRadii[1], toRadii[1], k),
    lerp(fromRadii[2], toRadii[2], k),
    lerp(fromRadii[3], toRadii[3], k)
  ]
  const n = (key: keyof typeof MATERIAL_DEFAULTS): number => lerp(from[key] as number, to[key] as number, k)
  return {
    cornerRadius: radii,
    blur: n('blur'),
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

  const a: Box = from.getBoundingClientRect()
  const b: Box = to.getBoundingClientRect()
  const empty = a.width <= 0 || a.height <= 0 ? from : b.width <= 0 || b.height <= 0 ? to : null
  if (empty) {
    // 量不到矩形（display: none、不在文档里）：不知道从哪里变到哪里，直接换
    console.warn(`[Glassium] morphGlass：${describeElement(empty)} 没有排版（display: none？），直接换、不做变形`, empty)
    return swap()
  }
  const fromMat = { ...MATERIAL_DEFAULTS, ...(options.fromMaterial ?? materialOf(from)) }
  const toMat = { ...MATERIAL_DEFAULTS, ...(options.toMaterial ?? materialOf(to)) }
  const fromRadii = resolveCornerRadii(fromMat.cornerRadius, [a.width, a.height])
  const toRadii = resolveCornerRadii(toMat.cornerRadius, [b.width, b.height])
  const duration = Math.max(1, options.duration ?? MORPH_GLASS_MS)

  const ghost = document.createElement('div')
  ghost.setAttribute('data-glassium-morph', '')
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, { position: 'fixed', margin: '0', padding: '0', border: '0', pointerEvents: 'none', opacity: '0' })
  document.body.append(ghost)
  const panel = stage.register(ghost, materialBetween(fromMat, toMat, fromRadii, toRadii, 0, 0))

  let rafId = 0
  let done = false
  const apply = (p: number): void => {
    const g = MORPH_GLASS_EASE(p) // 形状略微回弹
    Object.assign(ghost.style, {
      left: `${lerp(a.left, b.left, g)}px`,
      top: `${lerp(a.top, b.top, g)}px`,
      width: `${Math.max(0, lerp(a.width, b.width, g))}px`,
      height: `${Math.max(0, lerp(a.height, b.height, g))}px`,
      // 两头不画：与只有 from、只有 to 时逐位相同
      opacity: p > 0 && p < 1 ? '1' : '0'
    })
    const fromAlpha = clamp01(1 - p / MORPH_GLASS_FADE)
    const toAlpha = clamp01((p - (1 - MORPH_GLASS_FADE)) / MORPH_GLASS_FADE)
    from.style.opacity = String(fromAlpha)
    to.style.opacity = String(toAlpha)
    panel.setMaterial(materialBetween(fromMat, toMat, fromRadii, toRadii, g, (1 - fromAlpha) * (1 - toAlpha)))
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
