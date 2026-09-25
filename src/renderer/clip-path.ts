/**
 * `clip-path` 的基本形状：解析浏览器给的计算值，解算成一个带圆角（可以是椭圆角）的盒子。玻璃按它裁（clipping.ts）。
 *
 * 纯函数，没有 DOM。输入是计算值，不是作者写的原文 —— 实测 Chrome：长度都换成 px（em、vw 算好了），位置关键字换成
 * 百分比，`right 10px` 这类写成 `calc(100% - 10px)`；`rect()`、`xywh()` 换成 `inset()`；默认值（closest-side、
 * at 50% 50%、border-box）省略。别的浏览器可能保留原写法，所以关键字、`rect()`、`xywh()` 也认。
 *
 * 能画的：`inset()`（圆角、椭圆角）、`circle()`、`ellipse()`、只写盒子关键字（那个盒子带 border-radius 的形状）。
 * 近似的：`polygon()` 按外接矩形。画不了的：`url()`、`path()`、`shape()` —— 调用方警告一次、不裁。
 *
 * 几何按 CSS Shapes 1 §3.1（与 Chrome 的实现对过，见 docs/calibration.md）：
 * - 参考盒默认 border-box；百分比按参考盒算 —— inset 的圆角也是（不按 inset 出来的矩形），之后照 CSS 的规则缩放
 * - circle 的百分比半径按 √(w² + h²) / √2 算；closest-side / farthest-side 是圆心到参考盒四条边里最近 / 最远的
 * - ellipse 的两个半径分别按宽、高算，closest-side / farthest-side 只看各自那个轴
 */

import type { Box } from './clipping.ts'

/** px + 百分比（`calc(10% + 20px)` 这类）。百分比相对哪条边由用它的地方决定。 */
export interface LengthPct {
  readonly px: number
  readonly pct: number
}

export type ShapeRadius = LengthPct | 'closest-side' | 'farthest-side'

/** 参考盒。fill-box 按 content-box、stroke-box / view-box 按 border-box（CSS Masking：有 CSS 盒子的元素这样算）。 */
export type GeometryBox = 'border-box' | 'padding-box' | 'content-box' | 'margin-box'

export type ClipPathShape =
  | {
      readonly kind: 'inset'
      /** top, right, bottom, left */
      readonly insets: readonly [LengthPct, LengthPct, LengthPct, LengthPct]
      /** TL, TR, BR, BL，每个是 [水平, 竖直] */
      readonly radii: readonly (readonly [LengthPct, LengthPct])[]
    }
  | { readonly kind: 'circle'; readonly radius: ShapeRadius; readonly at: readonly [LengthPct, LengthPct] }
  | {
      readonly kind: 'ellipse'
      readonly rx: ShapeRadius
      readonly ry: ShapeRadius
      readonly at: readonly [LengthPct, LengthPct]
    }
  | { readonly kind: 'polygon'; readonly points: readonly (readonly [LengthPct, LengthPct])[] }
  /** 只写了盒子关键字：那个盒子带 border-radius 的形状。 */
  | { readonly kind: 'box' }

export interface ParsedClipPath {
  readonly shape: ClipPathShape
  readonly box: GeometryBox
}

export type ClipPathParse =
  | { readonly kind: 'none' }
  | { readonly kind: 'shape'; readonly value: ParsedClipPath; readonly approximate: string | null }
  | { readonly kind: 'unsupported'; readonly reason: string }

const ZERO: LengthPct = { px: 0, pct: 0 }
const HALF: LengthPct = { px: 0, pct: 50 }
const FULL: LengthPct = { px: 0, pct: 100 }

const GEOMETRY_BOXES: Readonly<Record<string, GeometryBox>> = {
  'border-box': 'border-box',
  'padding-box': 'padding-box',
  'content-box': 'content-box',
  'margin-box': 'margin-box',
  'fill-box': 'content-box',
  'stroke-box': 'border-box',
  'view-box': 'border-box'
}

/** 按顶层的分隔符拆开（括号里的不算）。空白分隔时连续的空白算一个。 */
function splitTop(text: string, separator: ',' | ' ' | '/'): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    const hit = separator === ' ' ? /\s/.test(ch) : ch === separator
    if (depth === 0 && hit) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  out.push(current.trim())
  return separator === ' ' ? out.filter((s) => s !== '') : out
}

const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?'
const TERM = new RegExp(`^(${NUMBER})(px|%)?$`, 'i')

/** 一项：`10px`、`-5%`、`0`。 */
function parseTerm(token: string): LengthPct | null {
  const m = TERM.exec(token)
  if (!m) return null
  const value = Number(m[1])
  if (m[2] === '%') return { px: 0, pct: value }
  if (m[2] || value === 0) return { px: value, pct: 0 }
  return null // 没有单位的非零数不是长度
}

/** 长度或百分比，也认 `calc(a% ± bpx)` 这种只有加减的（计算值里的 calc 都是这样）。 */
export function parseLengthPct(token: string): LengthPct | null {
  const t = token.trim()
  const calc = /^calc\((.*)\)$/i.exec(t)
  if (!calc) return parseTerm(t)
  const inner = calc[1]!
  if (/[()*/]/.test(inner)) return null // 嵌套、乘除：计算值里不该出现，出现了就不认
  const parts = inner.trim().split(/\s+/)
  let px = 0
  let pct = 0
  let sign = 1
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (i % 2 === 1) {
      if (p === '+') sign = 1
      else if (p === '-') sign = -1
      else return null
      continue
    }
    const term = parseTerm(p)
    if (!term) return null
    px += sign * term.px
    pct += sign * term.pct
  }
  if (parts.length % 2 === 0) return null // 以运算符结尾
  return { px, pct }
}

const sub = (a: LengthPct, b: LengthPct): LengthPct => ({ px: a.px - b.px, pct: a.pct - b.pct })

const POSITION_KEYWORDS: Readonly<Record<string, { readonly axis: 'x' | 'y' | 'either'; readonly value: LengthPct }>> = {
  left: { axis: 'x', value: ZERO },
  right: { axis: 'x', value: FULL },
  top: { axis: 'y', value: ZERO },
  bottom: { axis: 'y', value: FULL },
  center: { axis: 'either', value: HALF }
}

/** `at` 后面的位置：一到两个分量（关键字或长度，关键字可以先写 y），或者四个（`right 10px bottom 20px`）。 */
function parsePosition(words: readonly string[]): readonly [LengthPct, LengthPct] | null {
  if (words.length === 4) {
    let x: LengthPct | null = null
    let y: LengthPct | null = null
    for (let i = 0; i < 4; i += 2) {
      const k = POSITION_KEYWORDS[words[i]!]
      const offset = parseLengthPct(words[i + 1]!)
      if (!k || k.axis === 'either' || !offset) return null
      // 从右、下量的偏移：100% − offset
      const v = k.value.pct === 100 ? sub(FULL, offset) : offset
      if (k.axis === 'x') {
        if (x) return null
        x = v
      } else {
        if (y) return null
        y = v
      }
    }
    return x && y ? [x, y] : null
  }
  if (words.length === 0 || words.length > 2) return null
  let x: LengthPct | null = null
  let y: LengthPct | null = null
  const pending: LengthPct[] = []
  for (const w of words) {
    const k = POSITION_KEYWORDS[w]
    if (k) {
      if (k.axis === 'x') {
        if (x) return null
        x = k.value
      } else if (k.axis === 'y') {
        if (y) return null
        y = k.value
      } else {
        pending.push(k.value)
      }
      continue
    }
    const l = parseLengthPct(w)
    if (!l) return null
    pending.push(l)
  }
  for (const l of pending) {
    if (!x) x = l
    else if (!y) y = l
    else return null
  }
  return [x ?? HALF, y ?? HALF]
}

function parseRadius(word: string): ShapeRadius | null {
  if (word === 'closest-side' || word === 'farthest-side') return word
  const l = parseLengthPct(word)
  return l && l.px >= 0 && l.pct >= 0 ? l : null
}

/** 一到四个值按 margin 的规则展开成 top, right, bottom, left（圆角是 TL, TR, BR, BL，同一个规则）。 */
function expandFour<T>(values: readonly T[]): [T, T, T, T] | null {
  const [a, b, c, d] = values
  if (a === undefined || values.length > 4) return null
  return [a, b ?? a, c ?? a, d ?? b ?? a]
}

/** `round` 后面的圆角：border-radius 的简写（`10px 20px / 5px`）。 */
function parseRoundRadii(text: string): (readonly [LengthPct, LengthPct])[] | null {
  const halves = splitTop(text, '/')
  if (halves.length > 2) return null
  const side = (s: string): [LengthPct, LengthPct, LengthPct, LengthPct] | null => {
    const values = splitTop(s, ' ').map(parseLengthPct)
    if (values.some((v) => v === null || v.px < 0 || v.pct < 0)) return null
    return expandFour(values as LengthPct[])
  }
  const h = side(halves[0]!)
  const v = halves.length === 2 ? side(halves[1]!) : h
  if (!h || !v) return null
  return [0, 1, 2, 3].map((i) => [h[i]!, v[i]!] as const)
}

const SQUARE: readonly (readonly [LengthPct, LengthPct])[] = [
  [ZERO, ZERO],
  [ZERO, ZERO],
  [ZERO, ZERO],
  [ZERO, ZERO]
]

/** `inset(…)` / `rect(…)` / `xywh(…)` 的参数（都化成 inset）。 */
function parseInsetLike(name: string, args: string): ClipPathShape | null {
  const at = splitTop(args, ' ')
  const roundIndex = at.indexOf('round')
  const head = roundIndex >= 0 ? at.slice(0, roundIndex) : at
  const radii = roundIndex >= 0 ? parseRoundRadii(at.slice(roundIndex + 1).join(' ')) : SQUARE
  if (!radii) return null
  const values = head.map((w) => (w === 'auto' && name === 'rect' ? null : parseLengthPct(w)))
  if (name === 'inset') {
    if (values.some((v) => v === null)) return null
    const insets = expandFour(values as LengthPct[])
    return insets ? { kind: 'inset', insets, radii } : null
  }
  if (name === 'rect') {
    // rect(top right bottom left)：四个都从左 / 上边量；auto 是那条边本身
    if (head.length !== 4) return null
    const [t, r, b, l] = head.map((w, i) => (w === 'auto' ? (i === 1 || i === 2 ? FULL : ZERO) : parseLengthPct(w)))
    if (!t || !r || !b || !l) return null
    return { kind: 'inset', insets: [t, sub(FULL, r), sub(FULL, b), l], radii }
  }
  // xywh(x y w h)
  if (values.length !== 4 || values.some((v) => v === null)) return null
  const [x, y, w, h] = values as LengthPct[]
  if (w!.px < 0 || w!.pct < 0 || h!.px < 0 || h!.pct < 0) return null
  const right = sub(sub(FULL, x!), w!)
  const bottom = sub(sub(FULL, y!), h!)
  return { kind: 'inset', insets: [y!, right, bottom, x!], radii }
}

function parseShapeFunction(token: string): ClipPathShape | 'unsupported' | null {
  const m = /^([a-z-]+)\((.*)\)$/is.exec(token)
  if (!m) return null
  const name = m[1]!.toLowerCase()
  const args = m[2]!.trim()
  if (name === 'inset' || name === 'rect' || name === 'xywh') return parseInsetLike(name, args)
  if (name === 'circle' || name === 'ellipse') {
    const words = splitTop(args, ' ')
    const atIndex = words.indexOf('at')
    const head = atIndex >= 0 ? words.slice(0, atIndex) : words
    const at = atIndex >= 0 ? parsePosition(words.slice(atIndex + 1)) : ([HALF, HALF] as const)
    if (!at) return null
    if (name === 'circle') {
      if (head.length > 1) return null
      const radius = head.length === 1 ? parseRadius(head[0]!) : 'closest-side'
      return radius ? { kind: 'circle', radius, at } : null
    }
    if (head.length !== 0 && head.length !== 2) return null
    const rx = head.length === 2 ? parseRadius(head[0]!) : 'closest-side'
    const ry = head.length === 2 ? parseRadius(head[1]!) : 'closest-side'
    return rx && ry ? { kind: 'ellipse', rx, ry, at } : null
  }
  if (name === 'polygon') {
    const items = splitTop(args, ',')
    if (items.length > 0 && /^(nonzero|evenodd)$/i.test(items[0]!)) items.shift()
    const points: (readonly [LengthPct, LengthPct])[] = []
    for (const item of items) {
      const xy = splitTop(item, ' ').map(parseLengthPct)
      if (xy.length !== 2 || !xy[0] || !xy[1]) return null
      points.push([xy[0], xy[1]])
    }
    return points.length > 0 ? { kind: 'polygon', points } : null
  }
  return 'unsupported'
}

/** 解析 `clip-path` 的计算值。 */
export function parseClipPath(text: string): ClipPathParse {
  const value = text.trim()
  if (value === '' || value.toLowerCase() === 'none') return { kind: 'none' }
  if (/^url\(/i.test(value)) return { kind: 'unsupported', reason: 'url() 引用的 SVG 裁剪路径画不了' }
  let shape: ClipPathShape | null = null
  let box: GeometryBox | null = null
  for (const token of splitTop(value, ' ')) {
    const keyword = GEOMETRY_BOXES[token.toLowerCase()]
    if (keyword) {
      if (box) return { kind: 'unsupported', reason: `解析不了（${value}）` }
      box = keyword
      continue
    }
    if (shape) return { kind: 'unsupported', reason: `解析不了（${value}）` }
    const parsed = parseShapeFunction(token)
    if (parsed === 'unsupported') {
      const name = /^([a-z-]+)\(/i.exec(token)?.[1] ?? token
      return { kind: 'unsupported', reason: `${name}() 画不了（只认 inset、circle、ellipse、rect、xywh、polygon 与盒子关键字）` }
    }
    if (!parsed) return { kind: 'unsupported', reason: `解析不了（${value}）` }
    shape = parsed
  }
  if (!shape && !box) return { kind: 'unsupported', reason: `解析不了（${value}）` }
  const approximate = shape?.kind === 'polygon' ? 'polygon() 按外接矩形近似' : null
  return { kind: 'shape', value: { shape: shape ?? { kind: 'box' }, box: box ?? 'border-box' }, approximate }
}

/** 元素的几何：border box（视口 CSS px）、四边的边框、内边距、外边距（top, right, bottom, left），四角外圆角 [rx, ry]。 */
export interface ReferenceBoxes {
  readonly border: Box
  readonly borderWidths: readonly [number, number, number, number]
  readonly padding: readonly [number, number, number, number]
  readonly margin: readonly [number, number, number, number]
  /** TL, TR, BR, BL，已按 CSS 的规则缩放到 border box 里。 */
  readonly radii: readonly (readonly [number, number])[]
}

/** 解算出来的形状（视口 CSS px）：矩形与四角的 [水平, 竖直] 半径（还没按 CSS 的规则缩放，调用方缩）。 */
export interface ClipPathGeometry {
  readonly box: Box
  readonly radii: readonly (readonly [number, number])[]
}

const inset = (b: Box, [t, r, bottom, l]: readonly [number, number, number, number]): Box => ({
  x0: b.x0 + l,
  y0: b.y0 + t,
  x1: b.x1 - r,
  y1: b.y1 - bottom
})

/** 解算到视口 CSS px。 */
export function resolveClipPath(parsed: ParsedClipPath, ref: ReferenceBoxes): ClipPathGeometry {
  const neg = (v: readonly [number, number, number, number]): [number, number, number, number] => [-v[0], -v[1], -v[2], -v[3]]
  const paddingBox = inset(ref.border, ref.borderWidths)
  const contentBox = inset(paddingBox, ref.padding)
  const marginBox = inset(ref.border, neg(ref.margin))
  const reference =
    parsed.box === 'padding-box'
      ? paddingBox
      : parsed.box === 'content-box'
        ? contentBox
        : parsed.box === 'margin-box'
          ? marginBox
          : ref.border
  const w = reference.x1 - reference.x0
  const h = reference.y1 - reference.y0
  const len = (l: LengthPct, basis: number): number => l.px + (l.pct / 100) * basis
  const shape = parsed.shape

  if (shape.kind === 'box') {
    // 那个盒子带 border-radius 的形状：内边的圆角是外圆角减去中间那几层（两个轴各算各的，不小于 0）；
    // margin-box 的圆角是外圆角加外边距（CSS Shapes 的简化：只加在不为 0 的角上）
    const [bt, br, bb, bl] = ref.borderWidths
    const [pt, pr, pb, pl] = ref.padding
    const [mt, mr, mb, ml] = ref.margin
    const shrink =
      parsed.box === 'padding-box'
        ? [bl, bt, br, bb]
        : parsed.box === 'content-box'
          ? [bl + pl, bt + pt, br + pr, bb + pb]
          : parsed.box === 'margin-box'
            ? [-ml, -mt, -mr, -mb]
            : [0, 0, 0, 0]
    const [left, top, right, bottom] = shrink as [number, number, number, number]
    const corner = (i: number, dx: number, dy: number): readonly [number, number] => {
      const [rx, ry] = ref.radii[i]!
      if (!(rx > 0 && ry > 0)) return [0, 0]
      return [Math.max(0, rx - dx), Math.max(0, ry - dy)]
    }
    return {
      box: reference,
      radii: [corner(0, left, top), corner(1, right, top), corner(2, right, bottom), corner(3, left, bottom)]
    }
  }

  if (shape.kind === 'inset') {
    const [t, r, b, l] = shape.insets
    const x0 = reference.x0 + len(l, w)
    const y0 = reference.y0 + len(t, h)
    // 左右（上下）加起来超过宽（高）时宽（高）是 0，左（上）边不动
    const x1 = Math.max(x0, reference.x1 - len(r, w))
    const y1 = Math.max(y0, reference.y1 - len(b, h))
    return {
      box: { x0, y0, x1, y1 },
      radii: shape.radii.map(([rx, ry]) => [Math.max(0, len(rx, w)), Math.max(0, len(ry, h))] as const)
    }
  }

  if (shape.kind === 'polygon') {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [px, py] of shape.points) {
      const x = reference.x0 + len(px, w)
      const y = reference.y0 + len(py, h)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    return { box: { x0, y0, x1, y1 }, radii: [[0, 0], [0, 0], [0, 0], [0, 0]] }
  }

  const cx = reference.x0 + len(shape.at[0], w)
  const cy = reference.y0 + len(shape.at[1], h)
  const dx = [Math.abs(cx - reference.x0), Math.abs(reference.x1 - cx)]
  const dy = [Math.abs(cy - reference.y0), Math.abs(reference.y1 - cy)]
  const extent = (r: ShapeRadius, sides: readonly number[], basis: number): number =>
    r === 'closest-side' ? Math.min(...sides) : r === 'farthest-side' ? Math.max(...sides) : Math.max(0, len(r, basis))
  let rx: number
  let ry: number
  if (shape.kind === 'circle') {
    rx = ry = extent(shape.radius, [...dx, ...dy], Math.hypot(w, h) / Math.SQRT2)
  } else {
    rx = extent(shape.rx, dx, w)
    ry = extent(shape.ry, dy, h)
  }
  const corner = [rx, ry] as const
  return { box: { x0: cx - rx, y0: cy - ry, x1: cx + rx, y1: cy + ry }, radii: [corner, corner, corner, corner] }
}
