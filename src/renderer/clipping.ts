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
 * ## 圆角
 *
 * 裁剪区域是祖先 padding box（border box 减去四边边框）的交集，再带上四个角的圆角：祖先有
 * border-radius 时，padding box 的内圆角 = 外圆角减去边框宽（CSS 的规则）。交集的某个角正好
 * 是某个带圆角的祖先的角时，用它的圆角；不是任何祖先的角（被另一个祖先从中间截断）时是直角。
 * 矩形部分由 scissor 裁，圆角与抗锯齿在着色器里按这个区域的 SDF 裁（glass.wgsl.ts 的 clipCoverage）。
 *
 * ## 近似
 *
 * - 椭圆角（水平、竖直半径不同）按短的那个半径画成圆角：着色器只画圆角。
 * - clip-path 不管；滚动条盖住的那条也不管（滚动条画在内容之上）。
 */

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

/** 可见区域：矩形与四角的圆角（TL, TR, BR, BL）。 */
export interface RoundClip {
  readonly box: Box
  readonly radii: readonly [number, number, number, number]
}

export const NO_CLIP: RoundClip = { box: UNBOUNDED, radii: [0, 0, 0, 0] }

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

/** 一组裁剪祖先围出的可见区域。纯函数：DOM 那边量好 ClipShape 交进来。 */
export function roundClip(shapes: readonly ClipShape[]): RoundClip {
  let box = UNBOUNDED
  const rounded: { readonly box: Box; readonly radii: readonly number[] }[] = []
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
    const outer = scaleRadii(s.radii, s.border.x1 - s.border.x0, s.border.y1 - s.border.y0)
    const inner = (i: number, bx: number, by: number): number =>
      Math.min(Math.max(0, outer[i]![0] - bx), Math.max(0, outer[i]![1] - by))
    const radii = [inner(0, bl, bt), inner(1, br, bt), inner(2, br, bb), inner(3, bl, bb)]
    if (radii.some((r) => r > 0)) rounded.push({ box: pad, radii })
  }

  // 交集的每个角：哪个带圆角的祖先的 padding box 正好也在这个角上，就用它的圆角
  const cornersOf = (b: Box): [number, number][] => [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x1, b.y1],
    [b.x0, b.y1]
  ]
  const corners = cornersOf(box)
  const radii: [number, number, number, number] = [0, 0, 0, 0]
  for (const s of rounded) {
    const own = cornersOf(s.box)
    for (let c = 0; c < 4; c++) {
      const [x, y] = own[c]!
      const [cx, cy] = corners[c]!
      if (Math.abs(x - cx) <= 0.5 && Math.abs(y - cy) <= 0.5) radii[c] = Math.max(radii[c]!, s.radii[c]!)
    }
  }
  const limit = Math.max(0, Math.min(box.x1 - box.x0, box.y1 - box.y0) / 2)
  return { box, radii: [Math.min(radii[0], limit), Math.min(radii[1], limit), Math.min(radii[2], limit), Math.min(radii[3], limit)] }
}

export function intersect(a: Box, b: Box): Box {
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }
}

export function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }
}

// —— DOM 侧 ——

/** 渲染树上的父元素：被 slot 分配的元素按 slot 的位置渲染，影子根的父是宿主。 */
function flatParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot
  if (el.parentElement) return el.parentElement
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

/** 一个裁剪祖先：元素、裁哪几个轴、四边边框宽（padding box = border box 减边框）、四角外圆角。 */
export interface ClipEntry {
  readonly element: Element
  readonly x: boolean
  readonly y: boolean
  readonly border: readonly [number, number, number, number] // top, right, bottom, left
  /** TL, TR, BR, BL。百分比要等量到 border box 才能换算，所以存原样。 */
  readonly radii: readonly CornerSpec[]
}

/** 找出一块面板的全部裁剪祖先。要读计算样式，所以结果应当缓存（见 PanelRegistry）。 */
export function findClipEntries(panel: Element): ClipEntry[] {
  // 没有 DOM（Node 里的单元测试用的是假元素）：当作没有裁剪
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return []
  const chain: Element[] = []
  const root = document.documentElement
  const body = document.body
  for (let e = flatParent(panel); e && e !== body && e !== root; e = flatParent(e)) chain.push(e)
  const styles = chain.map(clipStyleOf)
  const panelPosition = getComputedStyle(panel).position
  return clippingAncestors(panelPosition, styles).map(({ index, x, y }) => {
    const el = chain[index]!
    const s = getComputedStyle(el)
    return {
      element: el,
      x,
      y,
      border: [
        parseFloat(s.borderTopWidth) || 0,
        parseFloat(s.borderRightWidth) || 0,
        parseFloat(s.borderBottomWidth) || 0,
        parseFloat(s.borderLeftWidth) || 0
      ],
      radii: [
        parseCornerRadius(s.borderTopLeftRadius),
        parseCornerRadius(s.borderTopRightRadius),
        parseCornerRadius(s.borderBottomRightRadius),
        parseCornerRadius(s.borderBottomLeftRadius)
      ]
    }
  })
}

/**
 * 按缓存的裁剪祖先算出这一帧的可见区域（视口 CSS 像素）。
 * rects 是这一帧里量过的祖先矩形，多块面板共用一个祖先时只量一次。
 */
export function roundClipOf(entries: readonly ClipEntry[], rects: Map<Element, DOMRect>): RoundClip {
  const shapes = entries.map((c): ClipShape => {
    let r = rects.get(c.element)
    if (!r) {
      r = c.element.getBoundingClientRect()
      rects.set(c.element, r)
    }
    const resolve = (len: Length, basis: number): number => (len.percent ? (len.value / 100) * basis : len.value)
    return {
      border: { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom },
      borderWidths: c.border,
      radii: c.radii.map(([x, y]) => [resolve(x, r.width), resolve(y, r.height)] as const),
      x: c.x,
      y: c.y
    }
  })
  return roundClip(shapes)
}
