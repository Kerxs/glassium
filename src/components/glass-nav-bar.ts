/**
 * `<glass-nav-bar>` —— 导航栏：两侧各一个玻璃胶囊装按钮，中间是标题。`large-title` 时标题大字写在栏下面，
 * 往上滚进栏底下时，栏中间淡入一行小标题（iOS 的 large title）。
 *
 * ```html
 * <glass-nav-bar large-title>
 *   <button slot="leading" aria-label="返回">‹</button>
 *   <h1>设置</h1>
 *   <button slot="trailing" aria-label="搜索">⌕</button>
 *   <button slot="trailing" aria-label="更多">⋯</button>
 * </glass-nav-bar>
 * ```
 *
 * 宿主是 `display: contents`：栏那一行（`position: sticky; top: 0`）与大标题都排在宿主的父元素里 —— 滚动时栏贴在
 * 视口顶上，大标题跟着正文滚走。同一侧的按钮共用一个胶囊（iOS 26 的分组）；胶囊是玻璃，材质属性写在栏上、两个胶囊
 * 一起用（默认胶囊形）。某一侧没有按钮时那个胶囊不画。
 *
 * **正文滚到栏底下时**：GPU 玻璃画在最底下的画布上，滚上来的 DOM 文字会盖在它上面（docs/limitations.md「盖在 DOM
 * 上的玻璃」）。所以栏按「底下压了多少正文」淡入两层 CSS：栏后面一条模糊渐隐（iOS 的 scroll edge effect）、胶囊上
 * 一层磨砂 —— 浏览器的 backdrop-filter 模糊下面的一切，文字也在内。滚回原处时它们淡出，胶囊又是有折射的 GPU 玻璃。
 * 淡入跟着滚动的距离走（NAV_EDGE_RAMP 像素走完），不是定时的动画，所以减少动效时也一样。
 *
 * 看的是整个文档的滚动（window）；栏放在别的滚动容器里时 sticky 照样生效，淡入淡出不跟。宿主上的 `data-scrolled`
 * （底下压着正文）与 `data-collapsed`（大标题整个滚进了栏底下）给你写样式用。
 *
 * CSS：`--glass-nav-bar-height`（栏那一行的高，默认 52px）、`--glass-nav-bar-edge`（模糊渐隐往下多出来的一截，默认 24px）。
 *
 * `<glass-toolbar>` 是同一个东西贴在底边：放在正文**后面**，`position: sticky; bottom: 0` —— 下面还有正文时贴在视口
 * 底边、正文从它底下经过（模糊渐隐往上），滚到底时停在它本来的位置。没有大标题；中间一格是状态文字（13px）。
 */

import { MATERIAL_ATTRIBUTES } from './attributes.ts'
import { HTMLElementBase, sharedSheet } from './base.ts'
import { FROST_CSS, SCROLL_EDGE_RAMP } from './scroll-edge.ts'

/** 模糊渐隐与磨砂从无到满要滚的距离，CSS 像素（与 scroll-edge 的磨砂相同）。 */
export const NAV_EDGE_RAMP = SCROLL_EDGE_RAMP

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0)

/**
 * 栏底下压着正文的程度，0–1：栏那一行比它本来的位置（没有 sticky 时该在的地方）往下多出来的距离 ——
 * 只有贴住之后、正文接着往上滚时才有 —— 走 NAV_EDGE_RAMP 像素到 1。
 */
export function edgeProgress(barTop: number, naturalTop: number): number {
  return clamp01((barTop - naturalTop) / NAV_EDGE_RAMP)
}

/** 大标题滚进栏底下的比例：0 = 整个还在栏下沿之下，1 = 整个过了栏的下沿。 */
export function largeTitleProgress(barBottom: number, titleTop: number, titleHeight: number): number {
  if (!(titleHeight > 0)) return barBottom > titleTop ? 1 : 0
  return clamp01((barBottom - titleTop) / titleHeight)
}

/** 栏中间那行小标题的不透明度：大标题过了一半之后开始淡入，整个过去时是 1。 */
export function inlineTitleOpacity(progress: number): number {
  return clamp01((progress - 0.5) / 0.5)
}

const CSS = `
:host {
  display: contents;
}
[part='sentinel'] {
  height: 0;
}
[part='bar'] {
  position: sticky;
  top: 0;
  z-index: 10;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  height: var(--glass-nav-bar-height, 52px);
  padding: 0 16px;
}
/* 滚动边缘：栏后面一条模糊，往下渐隐到透明。不接收指针（也就不挡按钮、不被层级检查当成遮挡） */
[part='edge'] {
  position: absolute;
  inset: 0 0 calc(-1 * var(--glass-nav-bar-edge, 24px)) 0;
  pointer-events: none;
  opacity: var(--_edge, 0);
  -webkit-backdrop-filter: blur(10px) saturate(1.2);
  backdrop-filter: blur(10px) saturate(1.2);
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - var(--glass-nav-bar-edge, 24px)), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - var(--glass-nav-bar-edge, 24px)), transparent);
}
[part='edge'][data-off] {
  visibility: hidden;
}
.capsule {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  box-sizing: border-box;
  min-height: 44px;
  padding: 4px;
  border-radius: 999px;
}
.capsule[hidden] {
  display: none;
}
[part='leading'] {
  grid-column: 1;
  justify-self: start;
}
[part='trailing'] {
  grid-column: 3;
  justify-self: end;
}
/* 胶囊上的磨砂：正文压在底下时淡入（backdrop-filter 模糊下面的一切，GPU 玻璃与滚上来的文字都在内）。
   与 scroll-edge 的磨砂同一套样式 */
.frost {${FROST_CSS}
  --_frost: var(--_edge, 0);
}
.frost[data-off] {
  visibility: hidden;
}
::slotted([slot='leading']),
::slotted([slot='trailing']) {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 36px;
  height: 36px;
  padding: 0 10px;
  box-sizing: border-box;
  border-radius: 999px;
  cursor: pointer;
  font-size: 17px;
  line-height: 1;
  white-space: nowrap;
}
::slotted(button[slot]) {
  background: none;
  border: 0;
  margin: 0;
  color: inherit;
  font-family: inherit;
}
::slotted([slot]:focus-visible) {
  outline: 2px solid currentColor;
  outline-offset: -2px;
}
[part='title'] {
  grid-column: 2;
  position: relative;
  min-width: 0;
  text-align: center;
  font-size: 17px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[part='title'] ::slotted(*) {
  margin: 0;
  font: inherit;
}
[part='inline-title'] {
  opacity: var(--_inline, 0);
}
:host(:not([large-title])) [part='inline-title'],
:host(:not([large-title])) [part='large-title'] {
  display: none;
}
[part='large-title'] {
  box-sizing: border-box;
  padding: 2px 20px 10px;
  font-size: 34px;
  font-weight: 700;
  line-height: 1.15;
}
[part='large-title'] ::slotted(*) {
  margin: 0;
  font: inherit;
}
/* 没有玻璃时胶囊画一层可读的底：glassium.css 进不了影子树，这里照它写一遍 */
.capsule:not([data-glassium-active]) {
  background-color: rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
  backdrop-filter: blur(20px) saturate(1.5);
}
@media (forced-colors: active) {
  .capsule {
    forced-color-adjust: none;
    background: Canvas;
    color: CanvasText;
    border: 1px solid CanvasText;
  }
  [part='edge'],
  .frost {
    display: none;
  }
}`
const sheet = { sheet: null as CSSStyleSheet | null }

/** 贴在底边的栏（`<glass-toolbar>`）多出来的几条：贴底、渐隐往上、中间是小一号的状态文字。 */
const BOTTOM_CSS = `
[part='bar'] {
  top: auto;
  bottom: 0;
}
[part='edge'] {
  inset: calc(-1 * var(--glass-nav-bar-edge, 24px)) 0 0 0;
  -webkit-mask-image: linear-gradient(to top, #000 calc(100% - var(--glass-nav-bar-edge, 24px)), transparent);
  mask-image: linear-gradient(to top, #000 calc(100% - var(--glass-nav-bar-edge, 24px)), transparent);
}
[part='title'] {
  font-size: 13px;
  font-weight: 500;
}`
const bottomSheet = { sheet: null as CSSStyleSheet | null }

/** 两侧的胶囊：影子树里的 `<glass-card>`，按钮经它的 slot 排进去。 */
function capsule(side: 'leading' | 'trailing'): { readonly card: HTMLElement; readonly frost: HTMLElement; readonly slot: HTMLSlotElement } {
  const card = document.createElement('glass-card')
  card.className = 'capsule'
  card.setAttribute('part', side)
  card.setAttribute('corner-radius', '1frac')
  card.hidden = true // 等 slotchange：有按钮才画
  const frost = document.createElement('div')
  frost.className = 'frost'
  frost.setAttribute('data-off', '')
  const slot = document.createElement('slot')
  slot.name = side
  card.append(frost, slot)
  return { card, frost, slot }
}

/** 栏贴在哪条边上。 */
export type BarPlacement = 'top' | 'bottom'

/** `<glass-nav-bar>`（顶）与 `<glass-toolbar>`（底）共用的实现。不单独注册。 */
export class GlassBar extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return [...MATERIAL_ATTRIBUTES, 'large-title']
  }

  /** 贴在哪条边上。子类覆盖；构造时就要用（决定影子树的顺序与样式），所以不能依赖子类的字段。 */
  get placement(): BarPlacement {
    return 'top'
  }

  readonly #sentinel: HTMLElement
  readonly #bar: HTMLElement
  readonly #edge: HTMLElement
  readonly #titleCell: HTMLElement
  readonly #inline: HTMLElement
  readonly #large: HTMLElement
  readonly #titleSlot: HTMLSlotElement
  readonly #sides: readonly ReturnType<typeof capsule>[]
  /** 标题文字变了（改了 h1 里的字）：栏中间那行跟着换。slotchange 管不到子树里的变化。 */
  readonly #text: MutationObserver | null
  #edgeValue = -1
  #inlineValue = -1
  readonly #onScroll = (): void => this.#update()

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const bottom = this.placement === 'bottom'
    root.adoptedStyleSheets = bottom ? [sharedSheet(sheet, CSS), sharedSheet(bottomSheet, BOTTOM_CSS)] : [sharedSheet(sheet, CSS)]
    this.#sentinel = document.createElement('div')
    this.#sentinel.setAttribute('part', 'sentinel')
    this.#bar = document.createElement('div')
    this.#bar.setAttribute('part', 'bar')
    this.#edge = document.createElement('div')
    this.#edge.setAttribute('part', 'edge')
    this.#edge.setAttribute('data-off', '')
    this.#titleCell = document.createElement('div')
    this.#titleCell.setAttribute('part', 'title')
    this.#inline = document.createElement('span')
    this.#inline.setAttribute('part', 'inline-title')
    this.#inline.setAttribute('aria-hidden', 'true')
    this.#titleSlot = document.createElement('slot')
    this.#titleCell.append(this.#inline, this.#titleSlot)
    this.#large = document.createElement('div')
    this.#large.setAttribute('part', 'large-title')
    this.#sides = [capsule('leading'), capsule('trailing')]
    this.#bar.append(this.#edge, this.#sides[0]!.card, this.#titleCell, this.#sides[1]!.card)
    // 哨兵标出栏本来的位置：顶上的栏看它前面的（栏的上沿），底下的栏看它后面的（栏的下沿）。底下的栏没有大标题
    if (bottom) root.append(this.#bar, this.#sentinel)
    else root.append(this.#sentinel, this.#bar, this.#large)

    for (const side of this.#sides) {
      side.slot.addEventListener('slotchange', () => {
        side.card.hidden = side.slot.assignedElements().length === 0
      })
    }
    this.#titleSlot.addEventListener('slotchange', () => this.#syncTitle())
    this.#text = typeof MutationObserver === 'function' ? new MutationObserver(() => this.#syncTitle()) : null
  }

  /** 底下压着正文吗（模糊渐隐与磨砂开始淡入）。 */
  get scrolled(): boolean {
    return this.hasAttribute('data-scrolled')
  }

  /** 大标题整个滚进了栏底下吗（`large-title` 时）。 */
  get collapsed(): boolean {
    return this.hasAttribute('data-collapsed')
  }

  connectedCallback(): void {
    window.addEventListener('scroll', this.#onScroll, { passive: true })
    window.addEventListener('resize', this.#onScroll)
    this.#text?.observe(this, { subtree: true, childList: true, characterData: true })
    this.#placeTitle()
    this.#syncTitle()
    this.#update()
  }

  disconnectedCallback(): void {
    window.removeEventListener('scroll', this.#onScroll)
    window.removeEventListener('resize', this.#onScroll)
    this.#text?.disconnect()
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return
    if (name === 'large-title') {
      this.#placeTitle()
      this.#update()
      return
    }
    // 材质属性原样转给两个胶囊；corner-radius 没写时是胶囊形
    for (const { card } of this.#sides) {
      if (newValue !== null) card.setAttribute(name, newValue)
      else if (name === 'corner-radius') card.setAttribute(name, '1frac')
      else card.removeAttribute(name)
    }
  }

  /** 按滚动位置重算两层 CSS 的淡入与小标题。滚动、改尺寸时调；也可以在你自己挪了布局之后调。 */
  update(): void {
    this.#update()
  }

  /** 大标题：只有贴在顶上的栏写了 large-title 时才有。 */
  #hasLargeTitle(): boolean {
    return this.placement === 'top' && this.hasAttribute('large-title')
  }

  /** 标题（默认 slot）放在哪：有大标题时在栏下面的大字里，否则在栏中间。 */
  #placeTitle(): void {
    const into = this.#hasLargeTitle() ? this.#large : this.#titleCell
    if (this.#titleSlot.parentNode !== into) into.append(this.#titleSlot)
  }

  #syncTitle(): void {
    const text = this.#titleSlot
      .assignedNodes({ flatten: true })
      .map((n) => n.textContent ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (this.#inline.textContent !== text) this.#inline.textContent = text
  }

  #update(): void {
    if (!this.isConnected) return
    // 先读完（几个 getBoundingClientRect），再写（影子树里的样式，stage 的 MutationObserver 看不到，不惊动它）
    const bar = this.#bar.getBoundingClientRect()
    const mark = this.#sentinel.getBoundingClientRect().top
    // 顶上的栏：贴住之后本来的位置（哨兵）继续往上走；底下的栏：本来的位置（哨兵 − 栏高）还在视口下面
    const edge = this.placement === 'bottom' ? edgeProgress(mark - bar.height, bar.top) : edgeProgress(bar.top, mark)
    const large = this.#hasLargeTitle()
    let progress = 0
    if (large) {
      const t = this.#large.getBoundingClientRect()
      progress = largeTitleProgress(bar.bottom, t.top, t.height)
    }
    const inline = large ? inlineTitleOpacity(progress) : 0
    if (edge !== this.#edgeValue) {
      this.#edgeValue = edge
      this.#bar.style.setProperty('--_edge', String(edge))
      // 完全没有时连 backdrop-filter 也不算：visibility: hidden
      this.#edge.toggleAttribute('data-off', edge === 0)
      for (const side of this.#sides) side.frost.toggleAttribute('data-off', edge === 0)
    }
    if (inline !== this.#inlineValue) {
      this.#inlineValue = inline
      this.#bar.style.setProperty('--_inline', String(inline))
    }
    if (this.hasAttribute('data-scrolled') !== edge > 0) this.toggleAttribute('data-scrolled', edge > 0)
    const collapsed = large && progress >= 1
    if (this.hasAttribute('data-collapsed') !== collapsed) this.toggleAttribute('data-collapsed', collapsed)
  }
}

/** `<glass-nav-bar>`：贴在顶上的栏，可以有大标题。见文件头。 */
export class GlassNavBar extends GlassBar {}

/** `<glass-toolbar>`：贴在底边的栏，放在正文后面。见文件头。 */
export class GlassToolbar extends GlassBar {
  override get placement(): BarPlacement {
    return 'bottom'
  }
}
