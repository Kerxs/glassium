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
 */

import type { GlassMaterial } from '../core/material.ts'
import { OVERLAY_HOST_CSS } from '../core/overlay.ts'
import type { GlassPanel } from '../renderer/panels.ts'
import { MATERIAL_ATTRIBUTES } from './attributes.ts'
import { GlassElement, sharedSheet } from './base.ts'
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
  transition: translate 0.35s cubic-bezier(0.3, 1.2, 0.5, 1), width 0.35s cubic-bezier(0.3, 1.2, 0.5, 1), scale 0.2s ease;
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
/* 没有玻璃时（或在对话框 / popover 里用 CSS 画时）：栏的表面来自 glassium.css，气泡画成一块浅色 */
:host(:not([data-glassium-active])) [part='bubble'],
[part='bubble'][data-glassium-overlay] {
  background: rgba(255, 255, 255, 0.22);
}
@media (prefers-reduced-motion: reduce) {
  [part='bubble'],
  :host([data-dragging]) [part='bubble'] {
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
    return [...MATERIAL_ATTRIBUTES, 'value']
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
    // 各格的宽度变了（字体加载、栏定宽变化）气泡要跟上
    this.#resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.#segments.place()) : null
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
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.#link.disconnect()
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
    super.attributeChangedCallback(name, oldValue, newValue)
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
