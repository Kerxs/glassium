/**
 * 浮在正文上的玻璃（`scroll-edge` 属性）：正文滚到它底下时淡入一层 CSS 磨砂。
 *
 * GPU 玻璃画在最底下的画布上，DOM 内容都在它上面 —— 一块浮在页面上的玻璃（底部的标签栏、右下角的浮动按钮、
 * 顶上的工具条），正文滚过它时文字会盖在玻璃上。组件写了 `scroll-edge` 时，影子树里多一层磨砂（backdrop-filter
 * 模糊下面的一切，文字也在内），按「底下压着多少正文」淡入：
 *
 * - `scroll-edge="bottom"`（浮在视口底边）：下面还有没滚到的内容时，那些内容正从它底下经过。离文档末尾不到
 *   SCROLL_EDGE_RAMP 时开始淡出，滚到底时是 0 —— 页面底下要给它留出位置（demo 的 padding-bottom），
 *   否则滚到底时最后几行照样压在它上面。
 * - `scroll-edge="top"`（浮在视口顶边）：往下滚了之后，上面的内容从它底下经过；回到顶上时是 0。
 *
 * 淡入跟着滚动的距离走（不是定时的动画）。看的是整个文档的滚动（window）。
 * `<glass-nav-bar>` 有自己的一套（按栏有没有贴住算，更准），不用这个。
 */

/** 磨砂从无到满要滚的距离，CSS 像素。 */
export const SCROLL_EDGE_RAMP = 16

export type ScrollEdge = 'top' | 'bottom'

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0)

/**
 * 磨砂的程度，0–1。
 *
 * @param edge 浮在哪条边上
 * @param scrollY 文档滚了多远
 * @param scrollHeight 文档的总高
 * @param viewportHeight 视口的高
 */
export function scrollEdgeProgress(edge: ScrollEdge, scrollY: number, scrollHeight: number, viewportHeight: number): number {
  if (edge === 'top') return clamp01(scrollY / SCROLL_EDGE_RAMP)
  return clamp01((scrollHeight - viewportHeight - scrollY) / SCROLL_EDGE_RAMP)
}

/** 属性值 → 哪条边；没写或写错是 null。 */
export function parseScrollEdge(value: string | null): ScrollEdge | null {
  return value === 'top' || value === 'bottom' ? value : null
}

/**
 * 磨砂层的样式（组件影子树里的 `[part='frost']`，导航栏胶囊上的 `.frost` 同一套）：盖满宿主、跟着圆角、不接收指针
 * （不挡按钮，层级检查也不会把它当成遮挡）。`--_frost` 是程度。完全没有时 visibility: hidden，backdrop-filter 也不算。
 */
export const FROST_CSS = `
position: absolute;
inset: 0;
border-radius: inherit;
pointer-events: none;
opacity: var(--_frost, 0);
background-color: rgba(255, 255, 255, 0.16);
box-shadow: inset 1px 1px 1px -0.5px rgba(255, 255, 255, 0.4), inset -1px -1px 1px -0.5px rgba(0, 0, 0, 0.12);
-webkit-backdrop-filter: blur(12px) saturate(1.4);
backdrop-filter: blur(12px) saturate(1.4);`

const SHEET_CSS = `
:host([scroll-edge]) {
  position: relative;
}
[part='frost'] {${FROST_CSS}
}
[part='frost'][data-off] {
  visibility: hidden;
}
@media (forced-colors: active) {
  [part='frost'] {
    display: none;
  }
}`
let sheet: CSSStyleSheet | null = null

/** 所有写了 scroll-edge、在文档里的组件共用一个滚动监听。 */
const live = new Set<ScrollEdgeLayer>()
const onScroll = (): void => {
  if (live.size === 0) return
  // 先读（一次），再写（各自影子树里的样式，stage 的 MutationObserver 看不到）
  const doc = document.scrollingElement ?? document.documentElement
  const y = window.scrollY
  const h = doc.scrollHeight
  const vh = window.innerHeight
  for (const layer of live) layer.apply(y, h, vh)
}

/** 一个组件的磨砂层：属性变了、进出文档时调 sync()。 */
export class ScrollEdgeLayer {
  readonly #host: HTMLElement
  #frost: HTMLElement | null = null
  #edge: ScrollEdge | null = null
  #value = -1

  constructor(host: HTMLElement) {
    this.#host = host
  }

  /** 按宿主现在的 scroll-edge 属性与是否在文档里，挂上或摘掉磨砂层与滚动监听。 */
  sync(): void {
    const edge = this.#host.isConnected ? parseScrollEdge(this.#host.getAttribute('scroll-edge')) : null
    this.#edge = edge
    if (!edge) {
      if (live.delete(this) && live.size === 0) {
        window.removeEventListener('scroll', onScroll)
        window.removeEventListener('resize', onScroll)
      }
      this.#frost?.remove()
      this.#frost = null
      this.#value = -1
      return
    }
    const root = this.#host.shadowRoot
    if (!root) return
    if (!this.#frost) {
      if (!sheet) {
        sheet = new CSSStyleSheet()
        sheet.replaceSync(SHEET_CSS)
      }
      if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
      this.#frost = document.createElement('div')
      this.#frost.setAttribute('part', 'frost')
      this.#frost.setAttribute('aria-hidden', 'true')
      this.#frost.setAttribute('data-off', '')
      root.prepend(this.#frost) // 最底下：影子树里的其它东西、slot 进来的内容都在它上面
    }
    if (live.size === 0) {
      window.addEventListener('scroll', onScroll, { passive: true })
      window.addEventListener('resize', onScroll)
    }
    live.add(this)
    const doc = document.scrollingElement ?? document.documentElement
    this.apply(window.scrollY, doc.scrollHeight, window.innerHeight)
  }

  apply(scrollY: number, scrollHeight: number, viewportHeight: number): void {
    if (!this.#edge || !this.#frost) return
    const p = scrollEdgeProgress(this.#edge, scrollY, scrollHeight, viewportHeight)
    if (p === this.#value) return
    this.#value = p
    this.#frost.style.setProperty('--_frost', String(p))
    this.#frost.toggleAttribute('data-off', p === 0)
  }
}
