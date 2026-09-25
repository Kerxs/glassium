/**
 * `<glass-switch>` —— 开关，iOS 26 的样子：轨道是填充（纯色，画进场景），旋钮是玻璃。
 *
 * ```html
 * <label><glass-switch name="wifi" checked></glass-switch> 无线局域网</label>
 * ```
 *
 * 平时旋钮是白的；按下时它鼓起来、变成一块透明的透镜，透过它看得见底下的轨道（被折射、被放大）；
 * 松开时切换，旋钮滑到另一头，变回白色。这件事只有「轨道在场景里」才做得到 —— DOM 的背景玻璃看不见（R2），
 * 所以轨道是一块填充（见 fills.ts），不是 CSS 背景。
 *
 * 行为与原生 `<input type="checkbox" switch>` 相同：
 * - 宿主就是开关：`role="switch"`、`aria-checked`、可聚焦；空格切换（Enter 也行）；
 * - 点一下切换，也可以按住拖动旋钮，松开时按旋钮停在哪一半决定开关；
 * - 用户切换时派发 `input` 与 `change`（冒泡）；click 里 `preventDefault()` 就不切换；程序改 `checked` 不派发；
 * - 表单关联：`name` / `value`（默认 "on"）只在打开时进表单数据；表单重置回到初始状态；
 *   `disabled` 属性与祖先 `<fieldset disabled>` 都让它禁用。
 *
 * 颜色：`--glass-switch-on`（默认 #34c759）、`--glass-switch-off`（默认 rgba(120, 120, 128, 0.32)），可以写在任何祖先上。
 * 尺寸：默认 64×28，可以用 CSS 改宽高：旋钮高度 = 宿主高度 − 4px，宽高比 13:8。
 */

import type { GlassPanel } from '../renderer/panels.ts'
import { HTMLElementBase, sharedSheet } from './base.ts'
import { StageLink } from './stage-link.ts'
import { PressTween, thumbMaterial } from './thumb.ts'

export { THUMB_PRESSED, THUMB_REST, thumbMaterial } from './thumb.ts'

/** 旋钮与轨道边缘的间隙，CSS 像素（与样式里的 2px 一致）。 */
const INSET = 2
/** 拖过这么多 CSS 像素才算拖动（否则是点击）。 */
const DRAG_THRESHOLD = 3

const CSS = `
:host {
  display: inline-block;
  position: relative;
  flex: none;
  width: 64px;
  height: 28px;
  vertical-align: middle;
  container-type: size;
  border-radius: 999px;
  cursor: pointer;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
:host(:focus-visible) {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}
/* 禁用：整个开关变淡。玻璃与填充都跟着 CSS 的 opacity 走 */
:host([aria-disabled='true']) {
  opacity: 0.4;
  cursor: default;
}
[part='track'] {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  --glass-fill: var(--glass-switch-off, rgba(120, 120, 128, 0.32));
  transition: --glass-fill 0.25s ease;
}
:host([checked]) [part='track'] {
  --glass-fill: var(--glass-switch-on, #34c759);
}
[part='thumb'] {
  position: absolute;
  top: ${INSET}px;
  left: ${INSET}px;
  height: calc(100% - ${2 * INSET}px);
  aspect-ratio: 13 / 8;
  border-radius: 999px;
  translate: 0 0;
  scale: 1;
  transition: translate 0.35s cubic-bezier(0.3, 1.3, 0.5, 1), scale 0.2s ease;
}
:host([checked]) [part='thumb'] {
  translate: calc(100cqw - 100% - ${2 * INSET}px) 0;
}
:host([data-pressed]) [part='thumb'] {
  scale: 1.25;
}
/* 拖动时旋钮直接跟着手指，不走过渡 */
:host([data-dragging]) [part='thumb'] {
  translate: var(--glass-switch-drag, 0px) 0;
  transition: scale 0.2s ease;
}
/* 没有玻璃时（stage 没建好、没有 GPU、高对比度），或者在对话框 / popover 里用 CSS 画（data-glassium-overlay）：
   CSS 画轨道与白色旋钮 */
:host(:not([data-glassium-active])) [part='track'],
[part='track'][data-glassium-overlay] {
  background: var(--glass-fill);
}
:host(:not([data-glassium-active])) [part='thumb'],
[part='thumb'][data-glassium-overlay] {
  background: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), 0 0 0 0.5px rgba(0, 0, 0, 0.06);
}
@media (prefers-reduced-motion: reduce) {
  [part='track'],
  [part='thumb'],
  :host([data-dragging]) [part='thumb'] {
    transition: none;
  }
}
/* 强制配色：stage 停用，用系统色画，开着时轨道是高亮色 */
@media (forced-colors: active) {
  :host(:not([data-glassium-active])) [part='track'] {
    forced-color-adjust: none;
    box-sizing: border-box;
    background-color: Canvas;
    border: 1px solid ButtonText;
  }
  :host([checked]:not([data-glassium-active])) [part='track'] {
    background-color: Highlight;
    border-color: Highlight;
  }
  :host(:not([data-glassium-active])) [part='thumb'] {
    forced-color-adjust: none;
    background: ButtonText;
    box-shadow: none;
  }
  :host([checked]:not([data-glassium-active])) [part='thumb'] {
    background: HighlightText;
  }
}
`
const sheet = { sheet: null as CSSStyleSheet | null }

export class GlassSwitch extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return ['checked', 'disabled']
  }

  /** 表单关联的自定义元素：有表单归属、响应 fieldset 的禁用、参与表单重置。 */
  static readonly formAssociated = true

  readonly #internals: ElementInternals | null
  readonly #track: HTMLElement
  readonly #thumb: HTMLElement
  #panel: GlassPanel | null = null
  readonly #link = new StageLink(this, (stage) => {
    const panel = stage.register(this.#thumb, thumbMaterial(this.#tween.energy))
    const fill = stage.registerFill(this.#track)
    this.#panel = panel
    return () => {
      panel.unregister()
      fill.unregister()
      this.#panel = null
    }
  })

  /** 初始状态：表单重置时回到它。第一次进文档时从 checked 属性读。 */
  #defaultChecked: boolean | null = null
  #formDisabled = false
  #ownsTabindex = false

  /** 按压能量（0 静止、1 按下）的缓动：每一步把旋钮的材质推给面板。 */
  readonly #tween = new PressTween((energy) => this.#panel?.setMaterial(thumbMaterial(energy)))

  /** 指针按下时的状态：拖动与点击的区分。 */
  #pointerId: number | null = null
  #startX = 0
  #startOffset = 0
  #travel = 0
  #offset = 0
  #dragging = false
  /** 拖动结束后浏览器还会派发一次 click：那一次不切换。 */
  #suppressClick = false
  #keyPressed = false

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sharedSheet(sheet, CSS)]
    this.#track = document.createElement('div')
    this.#track.setAttribute('part', 'track')
    this.#thumb = document.createElement('div')
    this.#thumb.setAttribute('part', 'thumb')
    root.append(this.#track, this.#thumb)

    this.addEventListener('pointerdown', this.#onPointerDown)
    this.addEventListener('pointermove', this.#onPointerMove)
    this.addEventListener('pointerup', this.#onPointerUp)
    this.addEventListener('pointercancel', this.#onPointerCancel)
    this.addEventListener('keydown', this.#onKeyDown)
    this.addEventListener('keyup', this.#onKeyUp)
    this.addEventListener('blur', this.#onBlur)
    // 捕获阶段：禁用时在作者挂在开关上的监听器之前拦下点击
    this.addEventListener('click', this.#onClickCapture, { capture: true })
    this.addEventListener('click', this.#onClick)
    this.#internals = typeof this.attachInternals === 'function' ? this.attachInternals() : null
  }

  // —— 属性 ——

  get checked(): boolean {
    return this.hasAttribute('checked')
  }

  set checked(value: boolean) {
    this.toggleAttribute('checked', Boolean(value))
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

  /** 打开时进表单数据的值。与 checkbox 一样默认 "on"。 */
  get value(): string {
    return this.getAttribute('value') ?? 'on'
  }

  set value(value: string) {
    this.setAttribute('value', value)
    this.#syncForm()
  }

  get form(): HTMLFormElement | null {
    return this.#internals?.form ?? null
  }

  /** 关联的 `<label>`（包着它的，或 for 指向它的）。 */
  get labels(): NodeList | null {
    return this.#internals?.labels ?? null
  }

  // —— 生命周期 ——

  connectedCallback(): void {
    this.#defaultChecked ??= this.checked
    if (!this.hasAttribute('role')) this.setAttribute('role', 'switch')
    if (!this.hasAttribute('tabindex')) this.#ownsTabindex = true
    this.#syncChecked()
    this.#syncDisabled()
    this.#link.connect()
  }

  disconnectedCallback(): void {
    this.#link.disconnect()
    this.#tween.reset()
    this.toggleAttribute('data-pressed', false)
    this.#endPointer()
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.isConnected) return
    if (name === 'checked') this.#syncChecked()
    else if (name === 'disabled') this.#syncDisabled()
  }

  formDisabledCallback(disabled: boolean): void {
    this.#formDisabled = disabled
    if (this.isConnected) this.#syncDisabled()
  }

  formResetCallback(): void {
    this.checked = this.#defaultChecked ?? false
  }

  #isDisabled(): boolean {
    return this.disabled || this.#formDisabled
  }

  #syncChecked(): void {
    this.setAttribute('aria-checked', String(this.checked))
    this.#syncForm()
  }

  #syncForm(): void {
    this.#internals?.setFormValue(this.checked ? this.value : null)
  }

  #syncDisabled(): void {
    const disabled = this.#isDisabled()
    if (disabled) this.setAttribute('aria-disabled', 'true')
    else this.removeAttribute('aria-disabled')
    if (this.#ownsTabindex) {
      if (disabled) this.removeAttribute('tabindex')
      else this.tabIndex = 0
    }
    if (disabled) {
      this.#endPointer()
      this.#press(false)
    }
  }

  // —— 交互 ——

  #onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.#isDisabled()) return
    this.#suppressClick = false
    this.#pointerId = e.pointerId
    this.#startX = e.clientX
    // 旋钮能走多远：宿主宽 − 旋钮宽 − 两边的间隙（布局尺寸，不受按压时的 scale 影响）
    this.#travel = Math.max(0, this.clientWidth - this.#thumb.offsetWidth - 2 * INSET)
    this.#startOffset = this.checked ? this.#travel : 0
    this.#offset = this.#startOffset
    this.#dragging = false
    try {
      this.setPointerCapture(e.pointerId)
    } catch {
      // 合成的事件没有活的指针，捕获不了：照样当点击处理
    }
    this.#press(true)
  }

  #onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    const dx = e.clientX - this.#startX
    if (!this.#dragging && Math.abs(dx) < DRAG_THRESHOLD) return
    this.#dragging = true
    this.#offset = Math.min(this.#travel, Math.max(0, this.#startOffset + dx))
    this.toggleAttribute('data-dragging', true)
    // 写在旋钮上而不是宿主的 style 上：宿主的 style 是作者（或框架）的
    this.#thumb.style.setProperty('--glass-switch-drag', `${this.#offset}px`)
  }

  #onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    const dragged = this.#dragging
    const next = this.#offset > this.#travel / 2
    this.#endPointer()
    this.#press(false)
    if (!dragged) return // 点击：交给随后的 click
    // 拖动：按旋钮停在哪一半决定，随后那次 click 不再切换
    this.#suppressClick = true
    if (next !== this.checked) {
      this.checked = next
      this.#emit()
    }
  }

  #onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    this.#endPointer()
    this.#press(false)
  }

  #endPointer(): void {
    this.#pointerId = null
    this.#dragging = false
    this.removeAttribute('data-dragging')
    this.#thumb.style.removeProperty('--glass-switch-drag')
  }

  #onKeyDown = (e: KeyboardEvent): void => {
    if (this.#isDisabled() || e.defaultPrevented) return
    if (e.key === ' ') {
      // 与 checkbox 一样：空格按下时显示按下态、阻止页面滚动，松开时切换
      e.preventDefault()
      if (!e.repeat) {
        this.#keyPressed = true
        this.#press(true)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      this.click()
    }
  }

  #onKeyUp = (e: KeyboardEvent): void => {
    if (e.key !== ' ' || !this.#keyPressed) return
    this.#keyPressed = false
    this.#press(false)
    if (!this.#isDisabled()) this.click()
  }

  #onBlur = (): void => {
    if (this.#keyPressed) {
      this.#keyPressed = false
      this.#press(false)
    }
  }

  #onClickCapture = (e: MouseEvent): void => {
    if (!this.#isDisabled()) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  /**
   * 切换。与原生 checkbox 一样先切过去，click 派发完之后再看：被 preventDefault() 了就切回来、不派发事件，
   * 否则派发 input 与 change。用下一个任务而不是微任务 —— 浏览器发起的派发里，微任务在两个监听器之间就执行了。
   */
  #onClick = (e: MouseEvent): void => {
    if (this.#suppressClick) {
      this.#suppressClick = false
      return
    }
    if (e.defaultPrevented) return
    const was = this.checked
    this.checked = !was
    setTimeout(() => {
      if (e.defaultPrevented) {
        this.checked = was
        return
      }
      this.#emit()
    }, 0)
  }

  #emit(): void {
    this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    this.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // —— 按压：旋钮的大小交给 CSS（data-pressed），材质交给缓动 ——

  #press(pressed: boolean): void {
    this.toggleAttribute('data-pressed', pressed)
    this.#tween.press(pressed)
  }
}
