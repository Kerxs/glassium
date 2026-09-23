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
 * ## 近似
 *
 * 裁剪矩形取祖先的 padding box（border box 减去四边边框），是**矩形**：祖先带 border-radius 时
 * 圆角外那一小块不会被裁掉；clip-path 不管；滚动条盖住的那条也不管（滚动条画在内容之上）。
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

/** 一个裁剪祖先：元素、裁哪几个轴、四边边框宽（padding box = border box 减边框）。 */
export interface ClipEntry {
  readonly element: Element
  readonly x: boolean
  readonly y: boolean
  readonly border: readonly [number, number, number, number] // top, right, bottom, left
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
      ]
    }
  })
}

/**
 * 按缓存的裁剪祖先算出这一帧的裁剪矩形（视口 CSS 像素）。
 * rects 是这一帧里量过的祖先矩形，多块面板共用一个祖先时只量一次。
 */
export function clipBoxOf(entries: readonly ClipEntry[], rects: Map<Element, DOMRect>): Box {
  let box = UNBOUNDED
  for (const c of entries) {
    let r = rects.get(c.element)
    if (!r) {
      r = c.element.getBoundingClientRect()
      rects.set(c.element, r)
    }
    const [bt, br, bb, bl] = c.border
    box = intersect(box, {
      x0: c.x ? r.left + bl : -Infinity,
      y0: c.y ? r.top + bt : -Infinity,
      x1: c.x ? r.right - br : Infinity,
      y1: c.y ? r.bottom - bb : Infinity
    })
  }
  return box
}
