/**
 * 遮罩：面板自己或祖先写了 `mask-image`（渐变）时，玻璃跟着淡。
 *
 * 常见的是滚动容器两头的淡出（`mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent)`）：
 * DOM 内容跟着淡了，画布上的 GPU 玻璃管不到。这里把遮罩的渐变解算到画布设备像素，着色器按它算出每个像素的
 * 不透明度，乘进裁剪的覆盖率（玻璃、投影、合并组、填充都乘）。
 *
 * 认得的：一层 `linear-gradient()` / `radial-gradient()`（含 `repeating-`，几何与 `--glass-fill` 的渐变同一套，
 * core/gradient.ts）；`mask-mode` 是 alpha / match-source（按颜色的 alpha）或 luminance（亮度 × alpha）；
 * `mask-origin` 是 border-box / padding-box / content-box。`mask-size`、`mask-position` 只认默认的（铺满元素），
 * 别的警告一次、按铺满近似。画不了的：`url()`（图片、SVG 遮罩）、多层 —— 警告一次、不管。
 * `mask-clip`（默认 border-box）：那个盒子以外整个被遮住，这一条并进裁剪（clipping.ts）。
 *
 * 只算一层：面板自己与祖先里有几个写了遮罩时，只算最近的那个（警告一次）。
 */

import { MAX_GRADIENT_STOPS, parseFillPaint, resolvePaint, splitTopLevel, type FillPaint } from '../core/gradient.ts'
import type { Box } from './clipping.ts'

/** 遮罩的参考盒（mask-origin、mask-clip）。fill-box 按 content-box、stroke-box / view-box 按 border-box。 */
export type MaskBox = 'border-box' | 'padding-box' | 'content-box'

export interface ParsedMask {
  readonly paint: Exclude<FillPaint, { readonly kind: 'solid' }>
  /** mask-mode: luminance —— 不透明度 = 亮度 × alpha。 */
  readonly luminance: boolean
  readonly origin: MaskBox
  /** mask-clip：这个盒子以外整个被遮住；no-clip 时是 null。 */
  readonly clip: MaskBox | null
}

export type MaskParse =
  | { readonly kind: 'none' }
  | { readonly kind: 'mask'; readonly value: ParsedMask; readonly warnings: readonly string[] }
  | { readonly kind: 'unsupported'; readonly reason: string }

/** 与遮罩有关的几项计算值（多层时是逗号分隔的列表）。拆出来是为了能在 Node 里测。 */
export interface MaskStyle {
  readonly image: string
  readonly mode: string
  readonly size: string
  readonly position: string
  readonly origin: string
  readonly clip: string
}

const BOXES: Readonly<Record<string, MaskBox>> = {
  'border-box': 'border-box',
  'padding-box': 'padding-box',
  'content-box': 'content-box',
  'fill-box': 'content-box',
  'stroke-box': 'border-box',
  'view-box': 'border-box'
}

const first = (list: string): string => splitTopLevel(list, ',')[0]?.trim() ?? ''

/**
 * 解析遮罩的计算值。colors 解析渐变里的颜色（渲染器里是 fills.ts 的 parseFillColor；计算值里都是 rgb() / rgba()）。
 */
export function parseMask(
  style: MaskStyle,
  parseColor: (css: string) => readonly [number, number, number, number] | null
): MaskParse {
  const image = style.image.trim()
  if (image === '' || image === 'none') return { kind: 'none' }
  const layers = splitTopLevel(image, ',')
  if (layers.length > 1) return { kind: 'unsupported', reason: `只认一层遮罩，这里有 ${layers.length} 层` }
  if (/^url\(/i.test(image)) return { kind: 'unsupported', reason: 'url() 的遮罩（图片、SVG）画不了' }
  const parsed = parseFillPaint(image, parseColor)
  if (!parsed || parsed.paint.kind === 'solid') return { kind: 'unsupported', reason: `解析不了（${image}）` }
  const warnings = [...parsed.warnings]
  const size = first(style.size).replace(/\s+/g, ' ')
  if (size !== '' && size !== 'auto' && size !== 'auto auto' && size !== '100% 100%') {
    warnings.push(`mask-size 只认铺满元素（auto / 100% 100%），${size} 按铺满近似`)
  }
  const position = first(style.position).replace(/\s+/g, ' ')
  if (position !== '' && position !== '0% 0%' && position !== '0px 0px' && position !== 'left top') {
    warnings.push(`mask-position 只认 0% 0%，${position} 按 0% 0% 近似`)
  }
  const clip = first(style.clip)
  return {
    kind: 'mask',
    value: {
      paint: parsed.paint,
      luminance: first(style.mode) === 'luminance',
      origin: BOXES[first(style.origin)] ?? 'border-box',
      clip: clip === 'no-clip' ? null : (BOXES[clip] ?? 'border-box')
    },
    warnings
  }
}

type Sides = readonly [number, number, number, number] // top, right, bottom, left

/** 元素的 border box（视口 CSS px）按边框、内边距缩成 mask-origin / mask-clip 要的那个盒子。 */
export function maskBox(which: MaskBox, border: Box, borderWidths: Sides, padding: Sides): Box {
  if (which === 'border-box') return border
  const [bt, br, bb, bl] = borderWidths
  const pad = { x0: border.x0 + bl, y0: border.y0 + bt, x1: border.x1 - br, y1: border.y1 - bb }
  if (which === 'padding-box') return pad
  const [pt, pr, pb, pl] = padding
  return { x0: pad.x0 + pl, y0: pad.y0 + pt, x1: pad.x1 - pr, y1: pad.y1 - pb }
}

/** 解算到画布设备像素的遮罩：着色器直接用的量。 */
export interface DeviceMask {
  readonly kind: 'linear' | 'radial'
  readonly repeating: boolean
  /** 线性：起点与终点；径向：中心与两个半径。画布设备像素、绝对坐标（不是相对盒子）。 */
  readonly geometry: readonly [number, number, number, number]
  /** 每个色标的不透明度（luminance 时已乘上亮度），最多 MAX_GRADIENT_STOPS 个。 */
  readonly alphas: readonly number[]
  /** 每个色标在渐变线上的位置（0–1 是 0%–100%）。 */
  readonly offsets: readonly number[]
}

/** 亮度（Rec. 709 的权重，直接用 sRGB 编码值 —— 近似）。 */
const luma = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!

/**
 * 解算：origin 是 mask-origin 那个盒子（视口 CSS px），toDevice 把视口 CSS px 的一点换到画布设备像素，
 * sx、sy 是两个方向的缩放（径向的半径用）。盒子是空的时返回 null（什么都遮住 —— 由 mask-clip 的裁剪负责）。
 */
export function resolveMask(
  mask: ParsedMask,
  origin: Box,
  toDevice: (x: number, y: number) => readonly [number, number],
  sx: number,
  sy: number
): DeviceMask | null {
  const w = origin.x1 - origin.x0
  const h = origin.y1 - origin.y0
  if (!(w > 0 && h > 0)) return null
  const r = resolvePaint(mask.paint, w, h)
  if (!r) return null
  const [a, b, c, d] = r.geometry
  let geometry: [number, number, number, number]
  if (r.kind === 'linear') {
    const [x0, y0] = toDevice(origin.x0 + a, origin.y0 + b)
    const [x1, y1] = toDevice(origin.x0 + c, origin.y0 + d)
    geometry = [x0, y0, x1, y1]
  } else {
    const [cx, cy] = toDevice(origin.x0 + a, origin.y0 + b)
    geometry = [cx, cy, c * sx, d * sy]
  }
  const n = Math.min(r.colors.length, MAX_GRADIENT_STOPS)
  const alphas = r.colors.slice(0, n).map((col) => Math.min(1, Math.max(0, col[3] * (mask.luminance ? luma(col) : 1))))
  return { kind: r.kind, repeating: r.repeating, geometry, alphas, offsets: r.offsets.slice(0, n) }
}

/** 遮罩在 uniform 里占几个 float（7 个 vec4）。 */
export const MASK_FLOATS = 28

/**
 * 把遮罩写进 uniform（面板、填充共用，at 是起始的 float 偏移）：
 * paint（种类 0 没有 · 1 线性 · 2 径向、色标数、重复、空）、geom（线性：起点、(终点 − 起点) ÷ 长度²；径向：中心、
 * 1/rx、1/ry）、alpha[2]（5 个不透明度）、at[2]（5 个位置；at[1].y、z 是重复的周期的倒数与周期）、span（相邻两个
 * 位置之差的倒数，重合的写 0）。着色器里不除以 uniform：倒数都在这里算。没有遮罩时整段清零（种类 0：不透明度正好 1）。
 */
export function packMask(data: Float32Array, at: number, mask: DeviceMask | null): void {
  data.fill(0, at, at + MASK_FLOATS)
  if (!mask) return
  const n = mask.alphas.length
  data[at + 0] = mask.kind === 'linear' ? 1 : 2
  data[at + 1] = n
  data[at + 2] = mask.repeating ? 1 : 0
  const [a, b, c, d] = mask.geometry
  data[at + 4] = a
  data[at + 5] = b
  if (mask.kind === 'linear') {
    const dx = c - a
    const dy = d - b
    const len2 = dx * dx + dy * dy
    data[at + 6] = len2 > 0 ? dx / len2 : 0
    data[at + 7] = len2 > 0 ? dy / len2 : 0
  } else {
    data[at + 6] = 1 / Math.max(c, 1e-3)
    data[at + 7] = 1 / Math.max(d, 1e-3)
  }
  for (let i = 0; i < n; i++) {
    data[at + 8 + i] = mask.alphas[i]!
    data[at + 16 + i] = mask.offsets[i]!
  }
  const period = mask.offsets[n - 1]! - mask.offsets[0]!
  data[at + 21] = mask.repeating && period > 0 ? 1 / period : 0
  data[at + 22] = mask.repeating && period > 0 ? period : 0
  for (let i = 0; i + 1 < n; i++) {
    const gap = mask.offsets[i + 1]! - mask.offsets[i]!
    data[at + 24 + i] = gap > 0 ? 1 / gap : 0
  }
}

/** 两个遮罩相同吗（按值；每帧重新解算，比引用没用）。 */
export function sameMask(a: DeviceMask | null, b: DeviceMask | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind || a.repeating !== b.repeating || a.alphas.length !== b.alphas.length) return false
  for (let i = 0; i < 4; i++) if (a.geometry[i] !== b.geometry[i]) return false
  for (let i = 0; i < a.alphas.length; i++) if (a.alphas[i] !== b.alphas[i] || a.offsets[i] !== b.offsets[i]) return false
  return true
}
