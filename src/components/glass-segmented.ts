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
import { StageLink } from './stage-link.ts'
import { PressTween, thumbMaterial } from './thumb.ts'

/** 旋钮与底边的间隙，CSS 像素。 */
const INSET = 2
const DRAG_THRESHOLD = 3

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
:host(:not([data-glassium-active])) [part='track'] {
  background-color: var(--glass-fill);
}
:host(:not([data-glassium-active])) [part='thumb'] {
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

/** 一段的值：`value` 属性，没有就取文字。 */
function valueOf(segment: Element): string {
  return segment.getAttribute('value') ?? segment.textContent?.trim() ?? ''
}

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

  /** 选中的段的下标；-1 是一个都没选。 */
  #selected = -1
  /** 选中的段的值：子元素变了之后按它把选中的找回来。 */
  #lastValue: string | null = null
  #dirty = false
  #formDisabled = false

  #pointerId: number | null = null
  #startX = 0
  #dragging = false
  #grab = 0

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

    this.addEventListener('pointerdown', this.#onPointerDown)
    this.addEventListener('pointermove', this.#onPointerMove)
    this.addEventListener('pointerup', this.#onPointerUp)
    this.addEventListener('pointercancel', this.#onPointerCancel)
    this.addEventListener('keydown', this.#onKeyDown)
    this.#internals = typeof this.attachInternals === 'function' ? this.attachInternals() : null
    // 段的宽度变了（字体加载、宿主定宽变化）旋钮要跟上
    this.#resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.#placeThumb()) : null
  }

  // —— 属性 ——

  /** 各段（宿主的子元素）。 */
  get segments(): HTMLElement[] {
    return Array.from(this.children) as HTMLElement[]
  }

  /** 选中的值；一个都没选时是空串。设置时选中值相同的那一段（没有就都不选），不派发事件。 */
  get value(): string {
    const s = this.segments[this.#selected]
    return s ? valueOf(s) : ''
  }

  set value(v: string) {
    this.#dirty = true
    this.#select(this.segments.findIndex((s) => valueOf(s) === String(v)))
  }

  get selectedIndex(): number {
    return this.#selected
  }

  set selectedIndex(i: number) {
    this.#dirty = true
    this.#select(Number.isInteger(i) && i >= 0 && i < this.segments.length ? i : -1)
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
    this.#endPointer()
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.isConnected) return
    if (name === 'disabled') this.#syncDisabled()
    else if (!this.#dirty) this.#select(this.#indexOfDefault())
  }

  formDisabledCallback(disabled: boolean): void {
    this.#formDisabled = disabled
    if (this.isConnected) this.#syncDisabled()
  }

  formResetCallback(): void {
    this.#dirty = false
    this.#select(this.#indexOfDefault())
  }

  #isDisabled(): boolean {
    return this.disabled || this.#formDisabled
  }

  /** value 属性对应的段；没写或对不上时选第一段（与单选组「总有一个选中」的习惯一致）。 */
  #indexOfDefault(): number {
    const segments = this.segments
    if (segments.length === 0) return -1
    const i = segments.findIndex((s) => valueOf(s) === this.defaultValue)
    return i >= 0 ? i : 0
  }

  /** 子元素变了：给每段挂上角色，选中的仍按值找回来。 */
  #syncSegments(): void {
    const segments = this.segments
    const keep = this.#selected >= 0 ? this.#lastValue : null
    for (const s of segments) {
      if (!s.hasAttribute('role')) s.setAttribute('role', 'radio')
    }
    const byValue = keep !== null ? segments.findIndex((s) => valueOf(s) === keep) : -1
    this.#select(this.#dirty && byValue >= 0 ? byValue : this.#dirty ? -1 : this.#indexOfDefault())
  }

  #select(index: number): boolean {
    const segments = this.segments
    const i = index >= 0 && index < segments.length ? index : -1
    const changed = i !== this.#selected
    this.#selected = i
    this.#lastValue = i >= 0 ? valueOf(segments[i]!) : null
    const disabled = this.#isDisabled()
    segments.forEach((s, k) => {
      s.setAttribute('aria-checked', String(k === i))
      // roving tabindex：只有选中的那段（都没选时是第一段）可以 Tab 到
      const focusable = !disabled && (k === i || (i < 0 && k === 0))
      s.tabIndex = focusable ? 0 : -1
    })
    this.#internals?.setFormValue(i >= 0 ? this.#lastValue : null)
    this.#placeThumb()
    return changed
  }

  /** 旋钮放到选中的段下面（拖动时由指针决定，不在这里）。 */
  #placeThumb(): void {
    if (this.#dragging) return
    const s = this.segments[this.#selected]
    if (!s) {
      this.#thumb.style.setProperty('--_w', '0px')
      return
    }
    this.#thumb.style.setProperty('--_x', `${s.offsetLeft}px`)
    this.#thumb.style.setProperty('--_w', `${s.offsetWidth}px`)
  }

  #syncDisabled(): void {
    const disabled = this.#isDisabled()
    if (disabled) this.setAttribute('aria-disabled', 'true')
    else this.removeAttribute('aria-disabled')
    if (disabled) {
      this.#endPointer()
      this.#press(false)
    }
    this.#select(this.#selected) // 刷新各段的 tabindex
  }

  // —— 交互 ——

  /** 指针下面是第几段（按水平位置，落在两段之间的缝里算离得近的那段）。 */
  #segmentAt(clientX: number): number {
    const segments = this.segments
    let best = -1
    let bestDistance = Infinity
    segments.forEach((s, k) => {
      const r = s.getBoundingClientRect()
      const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
      if (d < bestDistance) {
        bestDistance = d
        best = k
      }
    })
    return best
  }

  #onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.#isDisabled() || this.segments.length === 0) return
    this.#pointerId = e.pointerId
    this.#startX = e.clientX
    this.#dragging = false
    const t = this.#thumb.getBoundingClientRect()
    this.#grab = e.clientX - (t.left + t.width / 2)
    try {
      this.setPointerCapture(e.pointerId)
    } catch {
      // 合成的事件没有活的指针
    }
    this.#press(true)
  }

  #onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    if (!this.#dragging && Math.abs(e.clientX - this.#startX) < DRAG_THRESHOLD) return
    // 只有按在选中的那段（旋钮）上才拖得动旋钮；按在别的段上移动不算拖
    const current = this.segments[this.#selected]
    if (!this.#dragging) {
      if (!current || this.#segmentAt(this.#startX) !== this.#selected) return
      this.#dragging = true
      this.toggleAttribute('data-dragging', true)
    }
    // 旋钮中心跟着指针（扣掉按下时的偏移），钳在宿主的内容区里
    const host = this.getBoundingClientRect()
    const w = current ? current.offsetWidth : 0
    const scale = this.offsetWidth > 0 ? host.width / this.offsetWidth : 1
    const center = (e.clientX - this.#grab - host.left) / scale
    const x = Math.min(this.offsetWidth - INSET - w, Math.max(INSET, center - w / 2))
    this.#thumb.style.setProperty('--_x', `${x}px`)
  }

  #onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    const dragged = this.#dragging
    const t = this.#thumb.getBoundingClientRect()
    const target = dragged ? this.#segmentAt(t.left + t.width / 2) : this.#segmentAt(e.clientX)
    this.#endPointer()
    this.#press(false)
    if (target >= 0) this.#userSelect(target)
    else this.#placeThumb()
  }

  #onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    this.#endPointer()
    this.#press(false)
    this.#placeThumb()
  }

  #endPointer(): void {
    this.#pointerId = null
    this.#dragging = false
    this.removeAttribute('data-dragging')
  }

  #onKeyDown = (e: KeyboardEvent): void => {
    if (this.#isDisabled() || e.defaultPrevented) return
    const n = this.segments.length
    if (n === 0) return
    const from = this.#selected >= 0 ? this.#selected : 0
    let next: number
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (from + 1) % n
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (from - 1 + n) % n
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = n - 1
        break
      case ' ':
        next = from
        break
      default:
        return
    }
    e.preventDefault()
    this.#userSelect(next)
    this.segments[next]?.focus()
  }

  #userSelect(index: number): void {
    this.#dirty = true
    if (this.#select(index)) {
      this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
      this.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  #press(pressed: boolean): void {
    this.toggleAttribute('data-pressed', pressed)
    this.#tween.press(pressed)
  }
}
