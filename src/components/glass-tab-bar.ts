/**
 * `<glass-tab-bar>` —— 标签栏：一条玻璃胶囊，选中的那一格下面垫一个玻璃气泡。
 *
 * ```html
 * <glass-tab-bar value="home" aria-label="主导航">
 *   <button value="home">🏠<span>首页</span></button>
 *   <button value="search">🔍<span>搜索</span></button>
 *   <button value="me">👤<span>我的</span></button>
 * </glass-tab-bar>
 * ```
 *
 * 栏本身是一块玻璃（材质属性与 `<glass-card>` 相同，默认胶囊）。选中那一格下面的气泡是写在栏**里面**的玻璃 ——
 * 在栏的上面一层（layers.ts），看得见栏，不在栏上开洞。换选中时气泡滑过去、宽度跟着变；按住时它鼓起来变成透明的
 * 透镜，可以按住拖到别的格上再松手（iOS 26 的标签栏就是这样）。各格是普通的 DOM（图标、文字），画在最上面 ——
 * 透镜放大不了它们，只放大底下的玻璃。
 *
 * 语义是标签页：宿主 `role="tablist"`，每一格 `role="tab"` 与 `aria-selected`，roving tabindex；方向键在格之间
 * 移动并选中（到头回绕），Home / End。用户换选中时派发 `input` 与 `change`；`value` 是选中那一格的值（它的 `value`
 * 属性，没有就是文字），`value` 属性是初始值。不是表单控件。
 *
 * CSS：`--glass-tab-bar-selected`（选中那一格的文字颜色，默认 #0a84ff）。各格的 `aria-controls` 之类由你写。
 *
 * `minimize="scroll"`：页面往下滚时缩起来 —— 没选中的格收成 0 宽、淡出，只留选中的那一格，栏跟着变短，气泡淡出；
 * 往上滚或回到顶部时展开（iOS 26 的 `tabBarMinimizeBehavior(.onScrollDown)`，判断在 minimize.ts）。缩着的时候
 * 点一下、或者键盘焦点移进来，先展开。`minimized` 属性可读可写。宽度的过渡靠 CSS 的 `interpolate-size`，
 * 不支持它的浏览器直接切换。看的是整个文档的滚动（window），不是某个滚动容器。
 */

import type { GlassMaterial } from '../core/material.ts'
import { OVERLAY_HOST_CSS } from '../core/overlay.ts'
import type { GlassPanel } from '../renderer/panels.ts'
import { MATERIAL_ATTRIBUTES } from './attributes.ts'
import { GlassElement, sharedSheet } from './base.ts'
import { initialMinimize, nextMinimize, type MinimizeState } from './minimize.ts'
import { Segments, segmentValue } from './segments.ts'
import { StageLink } from './stage-link.ts'
import { PressTween } from './thumb.ts'

/** 气泡与栏边缘的间隙（栏的内边距），CSS 像素。 */
const INSET = 4

/**
 * 气泡的材质：静止时是一块比栏亮一点的玻璃（它看得见栏，所以自己不用再模糊）；按下时变成透明的透镜 ——
 * 与开关、滑块的旋钮按下时同一套数（thumb.ts）。按压能量 0–1 之间线性插值，两头精确落在端点上。
 */
export function bubbleMaterial(energy: number): GlassMaterial {
  const e = Math.min(Math.max(energy, 0), 1)
  const mix = (a: number, b: number): number => a * (1 - e) + b * e
  return {
    cornerRadius: '1frac',
    blur: 0,
    refraction: mix(0.15, 0.7),
    distortion: mix(0.1, 0.4),
    saturation: mix(1, 1.3),
    highlight: mix(0.35, 1),
    dispersion: mix(0, 0.2),
    shadow: mix(0, 0.15),
    tint: `rgba(255, 255, 255, ${mix(0.3, 0.04)})`,
    adaptive: 0,
    depthEffect: 1
  }
}

const CSS = `
:host {
  display: inline-flex;
  position: relative;
  box-sizing: border-box;
  padding: ${INSET}px;
  border-radius: 999px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: pan-y;
}
[part='bubble'] {
  position: absolute;
  top: ${INSET}px;
  bottom: ${INSET}px;
  left: 0;
  width: var(--_w, 0px);
  border-radius: 999px;
  translate: var(--_x, 0px) 0;
  scale: 1;
  transition: translate 0.35s cubic-bezier(0.3, 1.2, 0.5, 1), width 0.35s cubic-bezier(0.3, 1.2, 0.5, 1), scale 0.2s ease,
    opacity 0.2s ease;
}
:host([data-pressed]) [part='bubble'] {
  scale: 1.12;
}
:host([data-dragging]) [part='bubble'] {
  transition: width 0.2s ease, scale 0.2s ease;
}
/* 各格：内容在上面（DOM 在画布之上）。按钮的默认外观去掉 */
::slotted(*) {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 64px;
  padding: 6px 14px;
  box-sizing: border-box;
  border-radius: 999px;
  cursor: pointer;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}
::slotted(button) {
  background: none;
  border: 0;
  margin: 0;
  color: inherit;
  font-family: inherit;
}
::slotted([aria-selected='true']) {
  color: var(--glass-tab-bar-selected, #0a84ff);
}
::slotted(:focus-visible) {
  outline: 2px solid currentColor;
  outline-offset: -2px;
}
/* 滚动时缩起来（minimize="scroll"）：没选中的格收成 0 宽、淡出，栏跟着变短；气泡淡出（只剩一格，不用指了）。
   宽度在 max-content 与 0 之间过渡要 interpolate-size；没有它的浏览器直接切换。只作用在写了 minimize 的栏上 */
:host([minimize]) {
  interpolate-size: allow-keywords;
}
:host([minimize]) ::slotted(*) {
  width: max-content;
  overflow: hidden;
  transition: width 0.35s cubic-bezier(0.25, 0.8, 0.3, 1), min-width 0.35s cubic-bezier(0.25, 0.8, 0.3, 1),
    padding 0.35s cubic-bezier(0.25, 0.8, 0.3, 1), opacity 0.2s ease;
}
:host([data-minimized]) ::slotted(:not([aria-selected='true'])) {
  width: 0;
  min-width: 0;
  padding-inline: 0;
  opacity: 0;
}
:host([data-minimized]) [part='bubble'] {
  opacity: 0;
}
/* 没有玻璃时（或在对话框 / popover 里用 CSS 画时）：栏的表面来自 glassium.css，气泡画成一块浅色 */
:host(:not([data-glassium-active])) [part='bubble'],
[part='bubble'][data-glassium-overlay] {
  background: rgba(255, 255, 255, 0.22);
}
@media (prefers-reduced-motion: reduce) {
  [part='bubble'],
  :host([data-dragging]) [part='bubble'],
  :host([minimize]) ::slotted(*) {
    transition: none;
  }
}
@media (forced-colors: active) {
  :host(:not([data-glassium-active])) [part='bubble'] {
    forced-color-adjust: none;
    background: Highlight;
  }
}
${OVERLAY_HOST_CSS}`
const sheet = { sheet: null as CSSStyleSheet | null }

export class GlassTabBar extends GlassElement {
  static override get observedAttributes(): string[] {
    return [...MATERIAL_ATTRIBUTES, 'value', 'minimize']
  }

  readonly #bubble: HTMLElement
  #bubblePanel: GlassPanel | null = null
  readonly #tween = new PressTween((energy) => this.#bubblePanel?.setMaterial(bubbleMaterial(energy)))
  // 气泡单独注册（栏本身由 GlassElement 注册）：它写在栏里面，自然就在栏的上面一层
  readonly #link = new StageLink(this, (stage) => {
    const panel = stage.register(this.#bubble, bubbleMaterial(this.#tween.energy))
    this.#bubblePanel = panel
    return () => {
      panel.unregister()
      this.#bubblePanel = null
    }
  })
  readonly #segments: Segments
  readonly #resize: ResizeObserver | null
  /** 用户或程序改过选中之后，value 属性（初始值）就不再带着它走。 */
  #dirty = false
  /** minimize="scroll" 且在文档里时的滚动状态；否则是 null（没有挂滚动监听）。 */
  #minimize: MinimizeState | null = null
  readonly #onScroll = (): void => {
    const s = this.#minimize
    if (!s) return
    const next = nextMinimize(s, scrollTop())
    if (next === s) return
    this.#minimize = next
    this.#setMinimized(next.minimized)
  }

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sharedSheet(sheet, CSS)]
    this.#bubble = document.createElement('div')
    this.#bubble.setAttribute('part', 'bubble')
    const slot = document.createElement('slot')
    slot.addEventListener('slotchange', () => this.#syncTabs())
    root.append(this.#bubble, slot)

    this.#segments = new Segments({
      host: this,
      thumb: this.#bubble,
      role: 'tab',
      selectedAttribute: 'aria-selected',
      inset: INSET,
      isDisabled: () => false,
      onPress: (pressed) => {
        this.toggleAttribute('data-pressed', pressed)
        this.#tween.press(pressed)
      },
      onUserSelect: () => {
        this.#dirty = true
        this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
      },
      onSelectionChange: () => {}
    })
    // 各格的宽度变了（字体加载、栏定宽变化、缩起与展开的过渡）气泡要跟上
    this.#resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.#segments.place()) : null

    // 缩着的时候点一下：先展开，这一下不算按压（捕获阶段截住，Segments 收不到，不会选到别的格）。
    // 键盘焦点移进来也展开 —— 焦点不该停在一格看不见的上面
    this.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.minimized) return
        e.stopImmediatePropagation()
        this.minimized = false
      },
      { capture: true }
    )
    this.addEventListener('focusin', () => {
      if (this.minimized) this.minimized = false
    })
  }

  /** 栏默认是胶囊。其余材质与 `<glass-card>` 相同，写在属性上。 */
  protected override defaults(): GlassMaterial {
    return { cornerRadius: '1frac' }
  }

  // —— 属性 ——

  /** 各格（宿主的子元素）。 */
  get tabs(): HTMLElement[] {
    return this.#segments.items
  }

  /** 选中那一格的值；一个都没选时是空串。设置时选中值相同的那一格，不派发事件。 */
  get value(): string {
    const t = this.tabs[this.#segments.selected]
    return t ? segmentValue(t) : ''
  }

  set value(v: string) {
    this.#dirty = true
    this.#segments.select(this.#segments.indexOf(String(v)))
  }

  /**
   * 缩起来了吗。minimize="scroll" 时跟着滚动变；也可以直接设，之后的滚动照常接管（从现在的位置重新累计）。
   * 没写 minimize 时也能设 —— 只是不会自己变。
   */
  get minimized(): boolean {
    return this.hasAttribute('data-minimized')
  }

  set minimized(on: boolean) {
    if (this.#minimize) this.#minimize = { minimized: Boolean(on), anchor: scrollTop() }
    this.#setMinimized(Boolean(on))
  }

  get selectedIndex(): number {
    return this.#segments.selected
  }

  set selectedIndex(i: number) {
    this.#dirty = true
    this.#segments.select(Number.isInteger(i) && i >= 0 && i < this.tabs.length ? i : -1)
  }

  // —— 生命周期 ——

  override connectedCallback(): void {
    super.connectedCallback()
    if (!this.hasAttribute('role')) this.setAttribute('role', 'tablist')
    this.#resize?.observe(this)
    this.#syncTabs()
    this.#link.connect()
    this.#syncMinimize()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.#link.disconnect()
    this.#syncMinimize()
    this.#resize?.disconnect()
    this.#tween.reset()
    this.toggleAttribute('data-pressed', false)
    this.#segments.release()
  }

  override attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'value') {
      if (oldValue !== newValue && this.isConnected && !this.#dirty) this.#segments.select(this.#indexOfDefault())
      return
    }
    if (name === 'minimize') {
      this.#syncMinimize()
      return
    }
    super.attributeChangedCallback(name, oldValue, newValue)
  }

  /** 按 minimize 属性与是否在文档里挂上 / 摘掉滚动监听。摘掉时展开。 */
  #syncMinimize(): void {
    const on = this.isConnected && this.getAttribute('minimize') === 'scroll'
    if (on && !this.#minimize) {
      this.#minimize = initialMinimize(scrollTop())
      window.addEventListener('scroll', this.#onScroll, { passive: true })
    } else if (!on && this.#minimize) {
      window.removeEventListener('scroll', this.#onScroll)
      this.#minimize = null
      this.#setMinimized(false)
    }
  }

  #setMinimized(on: boolean): void {
    if (this.hasAttribute('data-minimized') !== on) this.toggleAttribute('data-minimized', on)
  }

  /** value 属性对应的那一格；没写或对不上时选第一格。 */
  #indexOfDefault(): number {
    if (this.tabs.length === 0) return -1
    const i = this.#segments.indexOf(this.getAttribute('value') ?? '')
    return i >= 0 ? i : 0
  }

  /** 子元素变了：改过选中的按值把它找回来（找不到就选第一格），没改过的回到初始值。 */
  #syncTabs(): void {
    const keep = this.#segments.selected >= 0 ? this.#segments.lastValue : null
    const byValue = keep !== null ? this.#segments.indexOf(keep) : -1
    this.#segments.select(this.#dirty && byValue >= 0 ? byValue : this.#indexOfDefault())
  }
}

/** 文档滚了多远（CSS 像素）。 */
function scrollTop(): number {
  return typeof window === 'undefined' ? 0 : window.scrollY
}
