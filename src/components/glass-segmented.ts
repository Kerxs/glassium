/**
 * `<glass-segmented>` —— 分段控件：底是填充，选中的那一段下面垫一块玻璃旋钮。
 *
 * ```html
 * <glass-segmented name="period" value="week" aria-label="时间范围">
 *   <span value="day">日</span>
 *   <span value="week">周</span>
 *   <span value="month">月</span>
 * </glass-segmented>
 * ```
 *
 * 每个子元素是一段（值取它的 `value` 属性，没有就取文字）。选中的那一段下面是与开关、滑块同一个玻璃旋钮：
 * 平时是白色的胶囊，换选中时滑过去（宽度跟着变）；按住时变成透明的透镜，可以按住拖到别的段上再松手。
 * 底是一块填充（在场景里），旋钮的透镜看得见它。
 *
 * 语义是单选组：宿主 `role="radiogroup"`，每一段 `role="radio"` 与 `aria-checked`，只有选中的那段可以 Tab 到
 * （roving tabindex）；方向键在段之间移动并选中（到头回绕），Home / End 到两头。
 * 用户换选中时派发 `input` 与 `change`；程序改 `value` 不派发。表单关联：`name` 与选中的值进表单数据，
 * `value` 属性是初始值、表单重置回到它，`disabled` 与祖先 `<fieldset disabled>` 让它禁用。
 *
 * CSS：`--glass-segmented-track`（底色，默认 rgba(120, 120, 128, 0.24)）。高度默认 32px，段的宽度由内容决定
 * （给宿主定宽时各段平分）。选中的段带 `aria-checked="true"`，可以据此给它加粗之类。
 */

import type { GlassPanel } from '../renderer/panels.ts'
import { HTMLElementBase, sharedSheet } from './base.ts'
import { Segments, segmentValue } from './segments.ts'
import { StageLink } from './stage-link.ts'
import { PressTween, thumbMaterial } from './thumb.ts'

/** 旋钮与底边的间隙，CSS 像素。 */
const INSET = 2

const CSS = `
:host {
  display: inline-flex;
  position: relative;
  box-sizing: border-box;
  height: 32px;
  padding: ${INSET}px;
  vertical-align: middle;
  border-radius: 999px;
  cursor: pointer;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
:host([aria-disabled='true']) {
  opacity: 0.4;
  cursor: default;
}
[part='track'] {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  --glass-fill: var(--glass-segmented-track, rgba(120, 120, 128, 0.24));
}
/* 旋钮在选中的段下面：位置与宽度由脚本写成 --_x / --_w（写在旋钮自己身上） */
[part='thumb'] {
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
:host([data-pressed]) [part='thumb'] {
  scale: 1.15;
}
:host([data-dragging]) [part='thumb'] {
  transition: width 0.2s ease, scale 0.2s ease;
}
/* 段：内容在上面（DOM 在画布之上），宽度由内容决定，宿主定宽时平分 */
::slotted(*) {
  position: relative;
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 14px;
  white-space: nowrap;
  border-radius: 999px;
}
::slotted(:focus-visible) {
  outline: 2px solid currentColor;
  outline-offset: -2px;
}
:host(:not([data-glassium-active])) [part='track'],
[part='track'][data-glassium-overlay] {
  background-color: var(--glass-fill);
}
:host(:not([data-glassium-active])) [part='thumb'],
[part='thumb'][data-glassium-overlay] {
  background: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.06);
}
@media (prefers-reduced-motion: reduce) {
  [part='thumb'],
  :host([data-dragging]) [part='thumb'] {
    transition: none;
  }
}
@media (forced-colors: active) {
  :host(:not([data-glassium-active])) [part='track'] {
    forced-color-adjust: none;
    box-sizing: border-box;
    background-color: Canvas;
    border: 1px solid ButtonText;
  }
  :host(:not([data-glassium-active])) [part='thumb'] {
    forced-color-adjust: none;
    background: Highlight;
    box-shadow: none;
  }
}
`
const sheet = { sheet: null as CSSStyleSheet | null }

export class GlassSegmented extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return ['value', 'disabled']
  }

  static readonly formAssociated = true

  readonly #internals: ElementInternals | null
  readonly #track: HTMLElement
  readonly #thumb: HTMLElement
  readonly #slot: HTMLSlotElement
  #panel: GlassPanel | null = null
  readonly #link = new StageLink(this, (stage) => {
    const track = stage.registerFill(this.#track)
    const panel = stage.register(this.#thumb, thumbMaterial(this.#tween.energy))
    this.#panel = panel
    return () => {
      panel.unregister()
      track.unregister()
      this.#panel = null
    }
  })
  readonly #tween = new PressTween((energy) => this.#panel?.setMaterial(thumbMaterial(energy)))
  readonly #resize: ResizeObserver | null
  readonly #segments: Segments

  /** 用户或程序改过选中（dirty）之后，value 属性（初始值）就不再带着它走。 */
  #dirty = false
  #formDisabled = false

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sharedSheet(sheet, CSS)]
    this.#track = document.createElement('div')
    this.#track.setAttribute('part', 'track')
    this.#thumb = document.createElement('div')
    this.#thumb.setAttribute('part', 'thumb')
    this.#slot = document.createElement('slot')
    root.append(this.#track, this.#thumb, this.#slot)
    this.#slot.addEventListener('slotchange', () => this.#syncSegments())

    this.#internals = typeof this.attachInternals === 'function' ? this.attachInternals() : null
    this.#segments = new Segments({
      host: this,
      thumb: this.#thumb,
      role: 'radio',
      selectedAttribute: 'aria-checked',
      inset: INSET,
      isDisabled: () => this.#isDisabled(),
      onPress: (pressed) => {
        this.toggleAttribute('data-pressed', pressed)
        this.#tween.press(pressed)
      },
      onUserSelect: () => {
        this.#dirty = true
        this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
      },
      onSelectionChange: (value) => this.#internals?.setFormValue(value)
    })
    // 段的宽度变了（字体加载、宿主定宽变化）旋钮要跟上
    this.#resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.#segments.place()) : null
  }

  // —— 属性 ——

  /** 各段（宿主的子元素）。 */
  get segments(): HTMLElement[] {
    return this.#segments.items
  }

  /** 选中的值；一个都没选时是空串。设置时选中值相同的那一段（没有就都不选），不派发事件。 */
  get value(): string {
    const s = this.segments[this.#segments.selected]
    return s ? segmentValue(s) : ''
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
    this.#segments.select(Number.isInteger(i) && i >= 0 && i < this.segments.length ? i : -1)
  }

  get defaultValue(): string {
    return this.getAttribute('value') ?? ''
  }

  set defaultValue(v: string) {
    this.setAttribute('value', v)
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled')
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', Boolean(value))
  }

  get name(): string {
    return this.getAttribute('name') ?? ''
  }

  set name(value: string) {
    this.setAttribute('name', value)
  }

  get form(): HTMLFormElement | null {
    return this.#internals?.form ?? null
  }

  get labels(): NodeList | null {
    return this.#internals?.labels ?? null
  }

  // —— 生命周期 ——

  connectedCallback(): void {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'radiogroup')
    this.#resize?.observe(this)
    this.#syncSegments()
    this.#syncDisabled()
    this.#link.connect()
  }

  disconnectedCallback(): void {
    this.#link.disconnect()
    this.#resize?.disconnect()
    this.#tween.reset()
    this.toggleAttribute('data-pressed', false)
    this.#segments.release()
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.isConnected) return
    if (name === 'disabled') this.#syncDisabled()
    else if (!this.#dirty) this.#segments.select(this.#indexOfDefault())
  }

  formDisabledCallback(disabled: boolean): void {
    this.#formDisabled = disabled
    if (this.isConnected) this.#syncDisabled()
  }

  formResetCallback(): void {
    this.#dirty = false
    this.#segments.select(this.#indexOfDefault())
  }

  #isDisabled(): boolean {
    return this.disabled || this.#formDisabled
  }

  /** value 属性对应的段；没写或对不上时选第一段（与单选组「总有一个选中」的习惯一致）。 */
  #indexOfDefault(): number {
    if (this.segments.length === 0) return -1
    const i = this.#segments.indexOf(this.defaultValue)
    return i >= 0 ? i : 0
  }

  /** 子元素变了：改过选中的按值把它找回来（找不到就都不选），没改过的回到初始值。 */
  #syncSegments(): void {
    const keep = this.#segments.selected >= 0 ? this.#segments.lastValue : null
    const byValue = keep !== null ? this.#segments.indexOf(keep) : -1
    this.#segments.select(this.#dirty ? byValue : this.#indexOfDefault())
  }

  #syncDisabled(): void {
    const disabled = this.#isDisabled()
    if (disabled) this.setAttribute('aria-disabled', 'true')
    else this.removeAttribute('aria-disabled')
    if (disabled) this.#segments.release()
    this.#segments.select(this.#segments.selected) // 刷新各段的 tabindex
  }
}
