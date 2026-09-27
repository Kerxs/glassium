/**
 * 元素的 CSS 背景 → 能不能画进场景、怎么画（absorb.ts 用）。纯函数，Node 里测。
 *
 * 认得的（只看第一层）：
 * - 纯色：`background-color`；
 * - 一层 `linear-gradient()` / `radial-gradient()`（含 repeating-）：交给填充的渐变（core/gradient.ts），有背景色时
 *   渐变的色标全不透明才算得准，否则按渐变近似（背景色丢掉，警告）；
 * - 一层同源的 `url()`：位图填充，背景色垫在底下；`background-size` 认 cover / contain / auto / 长度 / 百分比，
 *   `background-position` 认长度与百分比，`background-repeat` 认 repeat / no-repeat（分轴）。
 * 画不了的：多层背景、`background-attachment: fixed`、跨源图片、conic-gradient、image-set() —— 不收，照旧警告。
 */

import { splitTopLevel } from '../core/gradient.ts'

export interface BackgroundStyle {
  readonly color: string
  readonly image: string
  readonly size: string
  readonly position: string
  readonly repeat: string
  readonly attachment: string
}

export type BackgroundPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'color'; readonly paint: string }
  | { readonly kind: 'gradient'; readonly paint: string; readonly droppedColor: boolean }
  | { readonly kind: 'image'; readonly url: string; readonly color: string | null }
  | { readonly kind: 'unsupported'; readonly reason: string }

/** 颜色的 alpha（计算值是 rgb() / rgba() / transparent）；看不懂按不透明。 */
export function cssAlpha(color: string): number {
  const c = color.trim().toLowerCase()
  if (c === 'transparent' || c === '') return 0
  const m = /^rgba?\(([^)]*)\)$/.exec(c)
  if (!m) return 1
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 4) return 1
  const a = parts[3]!.endsWith('%') ? parseFloat(parts[3]!) / 100 : parseFloat(parts[3]!)
  return Number.isFinite(a) ? a : 1
}

/** 背景画的是什么、怎么画。 */
export function planBackground(s: BackgroundStyle): BackgroundPlan {
  const hasColor = cssAlpha(s.color) > 0
  const image = s.image.trim()
  if (image === '' || image === 'none') return hasColor ? { kind: 'color', paint: s.color } : { kind: 'none' }
  const layers = splitTopLevel(image, ',')
  if (layers.length > 1) return { kind: 'unsupported', reason: `多层背景（${layers.length} 层）` }
  if (s.attachment.split(',')[0]!.trim() === 'fixed') return { kind: 'unsupported', reason: 'background-attachment: fixed' }
  const layer = layers[0]!.trim()
  const url = /^url\(\s*(['"]?)(.*?)\1\s*\)$/i.exec(layer)
  if (url) return { kind: 'image', url: url[2]!, color: hasColor ? s.color : null }
  if (/^(repeating-)?(linear|radial)-gradient\(/i.test(layer)) {
    return { kind: 'gradient', paint: layer, droppedColor: hasColor && !opaqueStops(layer) }
  }
  return { kind: 'unsupported', reason: `背景图 ${layer.slice(0, 40)}` }
}

/** 渐变里的颜色是不是全不透明（粗查：有 transparent 或 alpha < 1 的 rgba 就不是）。 */
function opaqueStops(gradient: string): boolean {
  if (/transparent/i.test(gradient)) return false
  for (const m of gradient.matchAll(/rgba?\([^)]*\)/gi)) if (cssAlpha(m[0]) < 1) return false
  return true
}

export interface ImagePlacement {
  /** 第一张图的位置与大小（CSS 像素，盒子左上角为原点）。 */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly repeatX: boolean
  readonly repeatY: boolean
}

/**
 * 一张图在盒子里的位置（`background-size`、`background-position`、`background-repeat` 的计算值，只看第一层）。
 * 盒子按 border-box 算（`background-origin` 不管，写进 limitations）。
 */
export function placeImage(
  boxW: number,
  boxH: number,
  imgW: number,
  imgH: number,
  size: string,
  position: string,
  repeat: string
): ImagePlacement {
  const first = (v: string): string => splitTopLevel(v, ',')[0]?.trim() ?? ''
  const sz = first(size).toLowerCase()
  const ratio = imgW > 0 && imgH > 0 ? imgW / imgH : 1
  let w = imgW
  let h = imgH
  if (sz === 'cover' || sz === 'contain') {
    const k = sz === 'cover' ? Math.max(boxW / imgW, boxH / imgH) : Math.min(boxW / imgW, boxH / imgH)
    w = imgW * k
    h = imgH * k
  } else if (sz !== '' && sz !== 'auto' && sz !== 'auto auto') {
    const [a, b] = sz.split(/\s+/)
    const len = (v: string | undefined, ref: number): number | null => {
      if (!v || v === 'auto') return null
      if (v.endsWith('%')) return (parseFloat(v) / 100) * ref
      const n = parseFloat(v)
      return Number.isFinite(n) ? n : null
    }
    const lw = len(a, boxW)
    const lh = len(b, boxH)
    if (lw !== null && lh !== null) {
      w = lw
      h = lh
    } else if (lw !== null) {
      w = lw
      h = lw / ratio
    } else if (lh !== null) {
      h = lh
      w = lh * ratio
    }
  }
  const [px = '0%', py = '0%'] = first(position).split(/\s+/)
  const pos = (v: string, free: number): number => (v.endsWith('%') ? (parseFloat(v) / 100) * free : parseFloat(v) || 0)
  // 一个值（repeat-x / repeat-y 是两轴的简写）或两个值（横、竖）；round / space 按 repeat 近似
  const parts = (first(repeat).toLowerCase() || 'repeat').split(/\s+/)
  let rx = parts[0]!
  let ry = parts[1] ?? rx
  if (parts.length === 1 && rx === 'repeat-x') [rx, ry] = ['repeat', 'no-repeat']
  else if (parts.length === 1 && rx === 'repeat-y') [rx, ry] = ['no-repeat', 'repeat']
  return {
    x: pos(px, boxW - w),
    y: pos(py, boxH - h),
    w,
    h,
    repeatX: rx !== 'no-repeat',
    repeatY: ry !== 'no-repeat'
  }
}
