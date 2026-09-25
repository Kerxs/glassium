/**
 * 裁剪：哪些祖先会把一块面板裁掉，玻璃就跟着裁到哪里。
 *
 * DOM 被 `overflow: hidden / clip / auto / scroll` 或 `contain: paint` 的祖先裁掉之后，
 * 玻璃（画在底下的画布上）不会自己跟着裁 —— 面板在滚动容器里被滚出可见区域、但还在视口里时，
 * 就会在容器外面留下一块玻璃。这里算出每块面板的「裁剪矩形」，与它的 scissor 求交。
 *
 * ## 按包含块链，而不是 DOM 祖先链
 *
 * 一个祖先裁不裁某个后代，取决于它在不在后代的**包含块链**上：
 *
 * - 常规流（static / relative / sticky）的元素：每个祖先都裁它
 * - absolute 的元素：只有定位了的祖先（它的包含块）以及更上面的才裁它 —— 夹在中间的
 *   不定位的 `overflow: hidden` 裁不到它
 * - fixed 的元素：只有建立了固定定位包含块的祖先（transform、filter、contain 等）才裁它，
 *   普通的滚动容器都裁不到
 *
 * 找到包含块之后，从包含块自己的定位方式继续往上找。
 *
 * ## clip-path
 *
 * `clip-path` 与 overflow 不同：它裁元素画出来的一切，包括 absolute、fixed 的后代，所以不看包含块链 ——
 * 面板自己与渲染树上的每个祖先都算。基本形状解算成带圆角的盒子（clip-path.ts）：inset 是圆角矩形，
 * circle / ellipse 是四角半径正好是半边长的盒子；polygon 按外接矩形近似，url() / path() 画不了（警告一次、不裁）。
 *
 * ## 圆角
 *
 * 裁剪区域是祖先 padding box（border box 减去四边边框）与 clip-path 形状的交集，再带上四个角的圆角：祖先有
 * border-radius 时，padding box 的内圆角 = 外圆角减去边框宽（CSS 的规则，两个轴各算各的 —— 可以是椭圆角）。
 * 交集的某个角正好是某个圆角区域的角时，用它的圆角。不是（被另一个裁剪从中间截断，或者是 clip-path 的圆、
 * 椭圆）又够得着交集的圆角区域，挑面积最小的一个整个交给着色器单独算（RoundClip.shape），覆盖率相乘。
 * 矩形部分由 scissor 裁，圆角与抗锯齿在着色器里按 SDF 裁（glass.wgsl.ts 的 clipCoverage）。
 *
 * ## 近似
 *
 * - 同时有两个以上「单独算」的圆角区域时只算面积最小的那个，其余的按矩形裁。
 * - 两个圆角区域的角落在同一处时取两个轴各自大的那个半径。
 * - 裁剪祖先自己的 transform：矩形按变换之后的包围盒，边框宽、px 写的 clip-path 长度不跟着缩放。
 * - 滚动条盖住的那条不管（滚动条画在内容之上）；mask 不管。
 */

import { parseClipPath, resolveClipPath, type ParsedClipPath } from './clip-path.ts'

/** 计算值里与裁剪有关的几项。拆出来是为了让判定逻辑能在 Node 里测。 */
export interface ClipStyle {
  readonly position: string
  readonly overflowX: string
  readonly overflowY: string
  readonly contain: string
  readonly transform: string
  readonly perspective: string
  readonly filter: string
  readonly backdropFilter: string
  readonly willChange: string
}

export interface ClipAxes {
  /** 在祖先链（由近到远）里的下标。 */
  readonly index: number
  readonly x: boolean
  readonly y: boolean
}

const containPaint = (contain: string): boolean => /\b(paint|strict|content)\b/.test(contain)

/** 这个元素在两个轴上各裁不裁它的后代。 */
export function clipAxesOf(s: ClipStyle): { readonly x: boolean; readonly y: boolean } {
  if (containPaint(s.contain)) return { x: true, y: true }
  return { x: s.overflowX !== 'visible', y: s.overflowY !== 'visible' }
}

/** 定位了的元素是 absolute 后代的包含块。 */
function isPositioned(s: ClipStyle): boolean {
  return s.position !== 'static'
}

/**
 * 建立固定定位包含块的属性（同时也是 absolute 后代的包含块）。
 * will-change 只有写了这些属性之一时才算。
 */
export function isFixedContainingBlock(s: ClipStyle): boolean {
  return (
    s.transform !== 'none' ||
    s.perspective !== 'none' ||
    s.filter !== 'none' ||
    s.backdropFilter !== 'none' ||
    /\b(transform|perspective|filter)\b/.test(s.willChange) ||
    /\b(paint|layout|strict|content)\b/.test(s.contain)
  )
}

/**
 * 沿祖先链（由近到远，不含面板自己，也不含 html / body）找出会裁剪面板的祖先。
 *
 * @param panelPosition 面板自己的 position
 */
export function clippingAncestors(panelPosition: string, chain: readonly ClipStyle[]): ClipAxes[] {
  const out: ClipAxes[] = []
  let escape = panelPosition // 当前这一段在找什么样的包含块
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i]!
    const onChain =
      escape === 'fixed'
        ? isFixedContainingBlock(s)
        : escape === 'absolute'
          ? isPositioned(s) || isFixedContainingBlock(s)
          : true
    if (!onChain) continue
    const axes = clipAxesOf(s)
    if (axes.x || axes.y) out.push({ index: i, x: axes.x, y: axes.y })
    escape = s.position
  }
  return out
}

/** 一个矩形，左上原点。没有裁剪的轴用 ±∞。 */
export interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export const UNBOUNDED: Box = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }

/** 空的区域：与任何矩形求交还是空的，求并不改变对方；写进 uniform 是 x0 = +65536、x1 = −65536，哪里都不覆盖。 */
export const EMPTY: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }

/**
 * 没有裁剪的方向写进 uniform 的值。不写 ±∞：着色器里 ∞ − ∞ 是 NaN。
 * 画布最大 16384 像素，±65536 离得足够远，f32 在这个量级上仍有 1/256 像素的精度。
 */
export const CLIP_UNBOUNDED_PX = 65536

/** 1 ÷ 半径；半径 0 写 0（那样的角着色器走圆角的算法，用不到倒数）。 */
const reciprocal = (r: number): number => (r > 0 ? 1 / r : 0)

/**
 * 裁剪区域在 uniform 里的后半截（面板、填充共用，偏移由调用方给，单位是 float）：
 * radiiYAt 起是 radiiY、1/rx、1/ry 三个 vec4；shapeAt 起是单独算的那个形状的矩形、rx、ry、1/rx、1/ry 五个 vec4。
 * 没有那个形状时写「不裁」：±65536 的矩形、半径 0 —— 着色器里它的覆盖率正好是 1，乘上去逐位不变。
 * 着色器里不除以 uniform：倒数在这里算（除以 uniform 在 NVIDIA + ANGLE 上帧与帧之间会差 1 ulp）。
 */
export function packClipExtras(
  data: Float32Array,
  radiiYAt: number,
  shapeAt: number,
  rx: Corners,
  ry: Corners,
  shape: RoundedBox | null
): void {
  for (let c = 0; c < 4; c++) {
    data[radiiYAt + c] = ry[c]!
    data[radiiYAt + 4 + c] = reciprocal(rx[c]!)
    data[radiiYAt + 8 + c] = reciprocal(ry[c]!)
  }
  const bound = (v: number): number => Math.max(-CLIP_UNBOUNDED_PX, Math.min(CLIP_UNBOUNDED_PX, v))
  const b = shape?.box ?? UNBOUNDED
  data[shapeAt + 0] = bound(b.x0)
  data[shapeAt + 1] = bound(b.y0)
  data[shapeAt + 2] = bound(b.x1)
  data[shapeAt + 3] = bound(b.y1)
  for (let c = 0; c < 4; c++) {
    const x = shape ? shape.rx[c]! : 0
    const y = shape ? shape.ry[c]! : 0
    data[shapeAt + 4 + c] = x
    data[shapeAt + 8 + c] = y
    data[shapeAt + 12 + c] = reciprocal(x)
    data[shapeAt + 16 + c] = reciprocal(y)
  }
}

/** 一个长度：px，或百分比（圆角的百分比按 border box 的宽 / 高算）。 */
export interface Length {
  readonly value: number
  readonly percent: boolean
}

/** 一个角的外圆角：水平与竖直两个半径（CSS 允许椭圆角）。 */
export type CornerSpec = readonly [Length, Length]

const ZERO_LENGTH: Length = { value: 0, percent: false }

/** 圆角的计算值（`12px`、`50%`、`12px 8px`）→ 两个长度。解析不了的当 0。 */
export function parseCornerRadius(css: string): CornerSpec {
  const parse = (token: string | undefined): Length => {
    if (!token) return ZERO_LENGTH
    const n = parseFloat(token)
    if (!Number.isFinite(n) || n < 0) return ZERO_LENGTH
    return { value: n, percent: token.trim().endsWith('%') }
  }
  const [a, b] = css.trim().split(/\s+/)
  const x = parse(a)
  return [x, b === undefined ? x : parse(b)]
}

/** 裁剪祖先在这一帧的样子（CSS px）：border box、四边边框宽、四角外圆角 [rx, ry]、裁哪几个轴。 */
export interface ClipShape {
  readonly border: Box
  /** top, right, bottom, left */
  readonly borderWidths: readonly [number, number, number, number]
  /** TL, TR, BR, BL，每个是 [rx, ry] */
  readonly radii: readonly (readonly [number, number])[]
  readonly x: boolean
  readonly y: boolean
}

/** 四个角：TL, TR, BR, BL。 */
export type Corners = readonly [number, number, number, number]

/** 带圆角（可以是椭圆角）的盒子：矩形与四角的水平、竖直半径。有一个半径是 0 的角是直角（两个都写 0）。 */
export interface RoundedBox {
  readonly box: Box
  readonly rx: Corners
  readonly ry: Corners
}

/**
 * 可见区域：各个裁剪区域的矩形之交（box），四角取正好落在那里的圆角（rx、ry）；再加至多一个整个单独算的
 * 圆角形状（shape）—— 它有圆角没落在交集的角上又够得着交集。覆盖率是两者之积。
 */
export interface RoundClip extends RoundedBox {
  readonly shape: RoundedBox | null
}

const SQUARE: Corners = [0, 0, 0, 0]

export const NO_CLIP: RoundClip = { box: UNBOUNDED, rx: SQUARE, ry: SQUARE, shape: null }
/** 什么都看不见（比如 circle(0%)，或者面板整个被滚出了容器）。 */
export const EMPTY_CLIP: RoundClip = { box: EMPTY, rx: SQUARE, ry: SQUARE, shape: null }

/**
 * CSS 的圆角缩放：同一条边上相邻两角的半径之和超过边长时，所有半径按同一个比例缩小
 * （CSS Backgrounds 3 §5.5）。`border-radius: 9999px` 的胶囊就是靠这一条变成半圆的。
 */
export function scaleRadii(
  radii: readonly (readonly [number, number])[],
  width: number,
  height: number
): [number, number][] {
  const [tl, tr, br, bl] = radii as readonly (readonly [number, number])[]
  let f = 1
  const limit = (length: number, a: number, b: number): void => {
    if (a + b > 0) f = Math.min(f, length / (a + b))
  }
  limit(width, tl![0], tr![0])
  limit(width, bl![0], br![0])
  limit(height, tl![1], bl![1])
  limit(height, tr![1], br![1])
  f = Math.max(0, f)
  return radii.map(([x, y]) => [x * f, y * f])
}

/** 四角 [rx, ry] → RoundedBox：有一个半径不大于 0 的角是直角（CSS 的规则）。不缩放。 */
function roundedOf(box: Box, radii: readonly (readonly [number, number])[]): RoundedBox {
  const rx = [0, 0, 0, 0]
  const ry = [0, 0, 0, 0]
  radii.forEach(([x, y], i) => {
    if (x > 0 && y > 0) {
      rx[i] = x
      ry[i] = y
    }
  })
  return { box, rx: rx as unknown as Corners, ry: ry as unknown as Corners }
}

/** 按 CSS 的规则把四角放进盒子（相邻两角之和不超过边长，一起按比例缩小）。clip-path 解算出来的形状用。 */
export function fitRoundedBox(box: Box, radii: readonly (readonly [number, number])[]): RoundedBox {
  const w = Math.max(0, box.x1 - box.x0)
  const h = Math.max(0, box.y1 - box.y0)
  return roundedOf(box, scaleRadii(radii, w, h))
}

/**
 * 每个角不超过半条边：着色器按象限取角，超过了会取错。圆角（两个半径相等）不超过短边的一半、仍是圆角；
 * 椭圆角两个轴各自不超过那条边的一半。
 */
function capCorners(box: Box, rx: readonly number[], ry: readonly number[]): { rx: Corners; ry: Corners } {
  const w = Math.max(0, box.x1 - box.x0)
  const h = Math.max(0, box.y1 - box.y0)
  const limit = Math.min(w, h) / 2
  const outX = [0, 0, 0, 0]
  const outY = [0, 0, 0, 0]
  for (let c = 0; c < 4; c++) {
    if (rx[c] === ry[c]) {
      outX[c] = outY[c] = Math.min(rx[c]!, limit)
    } else {
      outX[c] = Math.min(rx[c]!, w / 2)
      outY[c] = Math.min(ry[c]!, h / 2)
    }
  }
  return { rx: outX as unknown as Corners, ry: outY as unknown as Corners }
}

const cornersOf = (b: Box): [number, number][] => [
  [b.x0, b.y0],
  [b.x1, b.y0],
  [b.x1, b.y1],
  [b.x0, b.y1]
]

/** 第 c 个角的圆弧所在的那一小块（半径围出的矩形）。 */
function cornerPatch(s: RoundedBox, c: number): Box {
  const { box, rx, ry } = s
  const left = c === 0 || c === 3
  const top = c === 0 || c === 1
  return {
    x0: left ? box.x0 : box.x1 - rx[c]!,
    x1: left ? box.x0 + rx[c]! : box.x1,
    y0: top ? box.y0 : box.y1 - ry[c]!,
    y1: top ? box.y0 + ry[c]! : box.y1
  }
}

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
const area = (b: Box): number => (b.x1 - b.x0) * (b.y1 - b.y0)

/**
 * 一组裁剪区域围出的可见区域。纯函数：DOM 那边量好交进来 —— shapes 是 overflow 裁剪祖先（padding box 在这里算），
 * paths 是 clip-path 解算出来的形状（已按 CSS 的规则放好圆角，见 fitRoundedBox）。
 */
export function roundClip(shapes: readonly ClipShape[], paths: readonly RoundedBox[] = []): RoundClip {
  let box = UNBOUNDED
  const rounded: RoundedBox[] = []
  for (const s of shapes) {
    const [bt, br, bb, bl] = s.borderWidths
    const pad: Box = {
      x0: s.x ? s.border.x0 + bl : -Infinity,
      y0: s.y ? s.border.y0 + bt : -Infinity,
      x1: s.x ? s.border.x1 - br : Infinity,
      y1: s.y ? s.border.y1 - bb : Infinity
    }
    box = intersect(box, pad)
    // 只有两个轴都裁时角才是圆的（只裁一个轴的祖先根本没有「角」）
    if (!s.x || !s.y) continue
    // 内圆角：外圆角减去边框宽，两个轴各算各的（CSS 的规则），所以边框左右、上下不一样宽时是椭圆角
    const outer = scaleRadii(s.radii, s.border.x1 - s.border.x0, s.border.y1 - s.border.y0)
    const inner = (i: number, bx: number, by: number): [number, number] => [
      Math.max(0, outer[i]![0] - bx),
      Math.max(0, outer[i]![1] - by)
    ]
    const r = roundedOf(pad, [inner(0, bl, bt), inner(1, br, bt), inner(2, br, bb), inner(3, bl, bb)])
    if (r.rx.some((v) => v > 0)) rounded.push(r)
  }
  for (const p of paths) {
    box = intersect(box, p.box)
    if (p.rx.some((v) => v > 0)) rounded.push(p)
  }
  if (!(box.x1 > box.x0 && box.y1 > box.y0)) return EMPTY_CLIP

  // 交集的每个角：哪个圆角区域的角正好也在这个角上，就用它的圆角（几个都在时两个轴各取大的）。
  // 有圆角落在别处、又够得着交集的区域要整个单独算：挑面积最小的那个
  const corners = cornersOf(box)
  const rx = [0, 0, 0, 0]
  const ry = [0, 0, 0, 0]
  let shape: RoundedBox | null = null
  for (const s of rounded) {
    const own = cornersOf(s.box)
    let loose = false
    for (let c = 0; c < 4; c++) {
      if (!(s.rx[c]! > 0)) continue
      const [x, y] = own[c]!
      const [cx, cy] = corners[c]!
      if (Math.abs(x - cx) <= 0.5 && Math.abs(y - cy) <= 0.5) {
        rx[c] = Math.max(rx[c]!, s.rx[c]!)
        ry[c] = Math.max(ry[c]!, s.ry[c]!)
      } else if (overlaps(cornerPatch(s, c), box)) {
        loose = true
      }
    }
    if (loose && (!shape || area(s.box) < area(shape.box))) shape = s
  }
  const own = capCorners(box, rx, ry)
  return { box, rx: own.rx, ry: own.ry, shape: shape ? { box: shape.box, ...capCorners(shape.box, shape.rx, shape.ry) } : null }
}

export function intersect(a: Box, b: Box): Box {
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }
}

export function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }
}

// —— DOM 侧 ——

/** 渲染树上的父元素：被 slot 分配的元素按 slot 的位置渲染，影子根的父是宿主。 */
export function flatParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot
  if (el.parentElement) return el.parentElement
  // 单元测试里的假元素没有 getRootNode；没有 ShadowRoot 的环境（Node）同理
  if (typeof el.getRootNode !== 'function' || typeof ShadowRoot === 'undefined') return null
  const root = el.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

function clipStyleOf(el: Element): ClipStyle {
  const s = getComputedStyle(el)
  return {
    position: s.position,
    overflowX: s.overflowX,
    overflowY: s.overflowY,
    contain: s.contain,
    transform: s.transform,
    perspective: s.perspective,
    filter: s.filter,
    backdropFilter: s.backdropFilter,
    willChange: s.willChange
  }
}

type Sides = readonly [number, number, number, number] // top, right, bottom, left

/** 一个 overflow 裁剪祖先：元素、裁哪几个轴、四边边框宽（padding box = border box 减边框）、四角外圆角。 */
export interface OverflowClipEntry {
  readonly kind: 'overflow'
  readonly element: Element
  readonly x: boolean
  readonly y: boolean
  readonly border: Sides
  /** TL, TR, BR, BL。百分比要等量到 border box 才能换算，所以存原样。 */
  readonly radii: readonly CornerSpec[]
}

/** 一个写了 clip-path 的元素（面板自己或祖先）：解析好的形状，与解算参考盒要用的边框、内外边距、外圆角。 */
export interface PathClipEntry {
  readonly kind: 'path'
  readonly element: Element
  readonly path: ParsedClipPath
  readonly border: Sides
  readonly padding: Sides
  readonly margin: Sides
  readonly radii: readonly CornerSpec[]
}

export type ClipEntry = OverflowClipEntry | PathClipEntry

const sidesOf = (s: CSSStyleDeclaration, prefix: 'border' | 'padding' | 'margin'): Sides => {
  const suffix = prefix === 'border' ? 'Width' : ''
  const read = (side: string): number => parseFloat(s[`${prefix}${side}${suffix}` as keyof CSSStyleDeclaration] as string) || 0
  return [read('Top'), read('Right'), read('Bottom'), read('Left')]
}

const radiiOf = (s: CSSStyleDeclaration): CornerSpec[] => [
  parseCornerRadius(s.borderTopLeftRadius),
  parseCornerRadius(s.borderTopRightRadius),
  parseCornerRadius(s.borderBottomRightRadius),
  parseCornerRadius(s.borderBottomLeftRadius)
]

/** 画不了、只能近似的 clip-path 每个元素的每个值只警告一次。 */
const warnedClipPath = new WeakMap<Element, string>()

/** 找出一块面板的全部裁剪祖先与 clip-path。要读计算样式，所以结果应当缓存（见 PanelRegistry）。 */
export function findClipEntries(panel: Element): ClipEntry[] {
  // 没有 DOM（Node 里的单元测试用的是假元素）：当作没有裁剪
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return []
  const chain: Element[] = []
  const root = document.documentElement
  const body = document.body
  for (let e = flatParent(panel); e && e !== body && e !== root; e = flatParent(e)) chain.push(e)
  const styles = chain.map(clipStyleOf)
  const panelPosition = getComputedStyle(panel).position
  const out: ClipEntry[] = clippingAncestors(panelPosition, styles).map(({ index, x, y }): OverflowClipEntry => {
    const el = chain[index]!
    const s = getComputedStyle(el)
    return { kind: 'overflow', element: el, x, y, border: sidesOf(s, 'border'), radii: radiiOf(s) }
  })
  // clip-path：自己与渲染树上的每个祖先（不看包含块 —— 它裁元素画出来的一切，fixed 的后代也裁）
  for (const el of [panel, ...chain]) {
    const s = getComputedStyle(el)
    const text = s.clipPath
    if (!text || text === 'none' || s.display === 'contents') continue
    const parsed = parseClipPath(text)
    if (parsed.kind === 'none') continue
    const problem = parsed.kind === 'unsupported' ? `${parsed.reason}，玻璃不跟着裁` : parsed.approximate
    if (problem && warnedClipPath.get(el) !== text) {
      warnedClipPath.set(el, text)
      console.warn(`[Glassium] clip-path：${problem}：`, el)
    }
    if (parsed.kind !== 'shape') continue
    out.push({
      kind: 'path',
      element: el,
      path: parsed.value,
      border: sidesOf(s, 'border'),
      padding: sidesOf(s, 'padding'),
      margin: sidesOf(s, 'margin'),
      radii: radiiOf(s)
    })
  }
  return out
}

/**
 * 按缓存的裁剪祖先算出这一帧的可见区域（视口 CSS 像素）。
 * rects 是这一帧里量过的祖先矩形，多块面板共用一个祖先时只量一次。
 */
export function roundClipOf(entries: readonly ClipEntry[], rects: Map<Element, DOMRect>): RoundClip {
  const shapes: ClipShape[] = []
  const paths: RoundedBox[] = []
  for (const c of entries) {
    let r = rects.get(c.element)
    if (!r) {
      r = c.element.getBoundingClientRect()
      rects.set(c.element, r)
    }
    const resolve = (len: Length, basis: number): number => (len.percent ? (len.value / 100) * basis : len.value)
    const border: Box = { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }
    const radii = c.radii.map(([x, y]) => [resolve(x, r.width), resolve(y, r.height)] as const)
    if (c.kind === 'overflow') {
      shapes.push({ border, borderWidths: c.border, radii, x: c.x, y: c.y })
      continue
    }
    const g = resolveClipPath(c.path, {
      border,
      borderWidths: c.border,
      padding: c.padding,
      margin: c.margin,
      radii: scaleRadii(radii, r.width, r.height)
    })
    paths.push(fitRoundedBox(g.box, g.radii))
  }
  return roundClip(shapes, paths)
}
