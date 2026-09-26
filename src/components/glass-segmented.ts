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
 * 平时是白色的胶囊；用户换选中时鼓起成透镜、拉长着飞过去再落下（segments.ts），程序换选中时滑过去（宽度跟着变）；
 * 按住时变成透明的透镜，可以按住拖到别的段上再松手。
 * 底是一块填充（在场景里），旋钮的透镜看得见它。
 *
 * 按住时各段的文字（与图标）画进场景（scene-label.ts），透镜把它们放大、在边缘扭弯 —— iOS 26 拖动选中块时就是
 * 这样；透镜下面还垫一块白（`--glass-segmented-lens`），所以透镜里是亮的、字照样鲜艳。平时照旧是 DOM 的字。
 *
 * 语义是单选组：宿主 `role="radiogroup"`，每一段 `role="radio"` 与 `aria-checked`，只有选中的那段可以 Tab 到
 * （roving tabindex）；方向键在段之间移动并选中（到头回绕），Home / End 到两头。
 * 用户换选中时派发 `input` 与 `change`；程序改 `value` 不派发。表单关联：`name` 与选中的值进表单数据，
 * `value` 属性是初始值、表单重置回到它，`disabled` 与祖先 `<fieldset disabled>` 让它禁用。
 *
 * CSS：`--glass-segmented-track`（底色，默认 rgba(120, 120, 128, 0.24)）、`--glass-segmented-lens`（按住时透镜下面
 * 垫的那块，默认 rgba(255, 255, 255, 0.7)；深色主题可以换暗一点）。高度默认 32px，段的宽度由内容决定
 * （给宿主定宽时各段平分）。选中的段带 `aria-checked="true"`，可以据此给它加粗之类。
 */

import type { GlassPanel } from '../renderer/panels.ts'
import { HTMLElementBase, sharedSheet } from './base.ts'
import { SceneLabels } from './scene-label.ts'
import { Segments, segmentValue } from './segments.ts'
import { StageLink } from './stage-link.ts'
import { PressTween, SEGMENT_THUMB_PRESSED, thumbMaterial } from './thumb.ts'

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
  scale: var(--_jx, 1) var(--_jy, 1);
  transition: translate 0.35s cubic-bezier(0.3, 1.2, 0.5, 1), width 0.35s cubic-bezier(0.3, 1.2, 0.5, 1), scale 0.2s ease;
}
:host([data-pressed]) [part='thumb'] {
  scale: calc(var(--glass-press-scale, 1.6) * var(--_jx, 1)) calc(var(--glass-press-scale, 1.6) * var(--_jy, 1));
}
:host([data-dragging]) [part='thumb'] {
  transition: width 0.2s ease, scale 0.06s linear;
}
/* 用户换选中时飞过去（segments.ts）：位置与宽度逐帧由脚本写，不走过渡；鼓起、缩回与果冻走短的 scale 过渡 */
:host([data-flying]) [part='thumb'] {
  transition: scale 0.12s ease-out;
}
/* 按住时透镜下面垫的那块白：与旋钮同一个位置、宽度、缩放（同样的过渡），画在字的下面 */
[part='lens'],
[part='lens-labels'] {
  position: absolute;
  top: ${INSET}px;
  bottom: ${INSET}px;
  left: 0;
  width: var(--_w, 0px);
  border-radius: 999px;
  translate: var(--_x, 0px) 0;
  scale: var(--_jx, 1) var(--_jy, 1);
  opacity: 0;
  pointer-events: none;
  --glass-fill: var(--glass-segmented-lens, rgba(255, 255, 255, 0.7));
  transition: translate 0.35s cubic-bezier(0.3, 1.2, 0.5, 1), width 0.35s cubic-bezier(0.3, 1.2, 0.5, 1), scale 0.2s ease,
    opacity 0.12s ease;
}
:host([data-pressed]) [part='lens'],
:host([data-pressed]) [part='lens-labels'] {
  scale: calc(var(--glass-press-scale, 1.6) * var(--_jx, 1)) calc(var(--glass-press-scale, 1.6) * var(--_jy, 1));
}
:host([data-dragging]) [part='lens'],
:host([data-dragging]) [part='lens-labels'] {
  transition: width 0.2s ease, scale 0.06s linear, opacity 0.12s ease;
}
:host([data-flying]) [part='lens'],
:host([data-flying]) [part='lens-labels'] {
  transition: scale 0.12s ease-out, opacity 0.12s ease;
}
/* 各段的字画进场景的那一份（scene-label.ts）：平时透明（不画），按住时换上、DOM 的字淡出 */
[part='labels'] {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
:host([data-lensing]) [part='lens'],
:host([data-lensing]) [part='lens-labels'],
:host([data-lensing]) [part='labels'] {
  opacity: 1;
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
  transition: opacity 0.12s ease;
}
:host([data-lensing]) ::slotted(*) {
  opacity: 0;
}
::slotted(:focus-visible) {
  outline: 2px solid currentColor;
  outline-offset: -2px;
}
:host(:not([data-glassium-active])) [part='track'],
[part='track'][data-glassium-overlay] {
  background: var(--glass-fill);
}
:host(:not([data-glassium-active])) [part='thumb'],
[part='thumb'][data-glassium-overlay] {
  background: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.06);
}
@media (prefers-reduced-motion: reduce) {
  [part='thumb'],
  [part='lens'],
  [part='lens-labels'],
  [part='labels'],
  ::slotted(*),
  :host([data-dragging]) [part='thumb'],
  :host([data-dragging]) [part='lens'],
:host([data-dragging]) [part='lens-labels'] {
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
  readonly #lens: HTMLElement
  readonly #lensLabels: HTMLElement
  readonly #thumb: HTMLElement
  readonly #slot: HTMLSlotElement
  readonly #labels: SceneLabels
  #panel: GlassPanel | null = null
  // 填充按注册的顺序画：底、透镜下面的白、字；旋钮的玻璃看得见这三样
  readonly #link = new StageLink(this, (stage) => {
    const track = stage.registerFill(this.#track)
    const lens = stage.registerFill(this.#lens)
    const detachLabels = this.#labels.attach(stage)
    const panel = stage.register(this.#thumb, thumbMaterial(this.#tween.energy, SEGMENT_THUMB_PRESSED))
    this.#panel = panel
    return () => {
      panel.unregister()
      detachLabels()
      lens.unregister()
      track.unregister()
      this.#panel = null
    }
  })
  readonly #tween = new PressTween((energy) => this.#panel?.setMaterial(thumbMaterial(energy, SEGMENT_THUMB_PRESSED)))
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
    this.#lens = document.createElement('div')
    this.#lens.setAttribute('part', 'lens')
    const labels = document.createElement('div')
    labels.setAttribute('part', 'labels')
    // 透镜里的那一份：各段的字统一换成选中那一段的颜色（iOS 27 截图：拖动时透镜下的字都是选中色）
    this.#lensLabels = document.createElement('div')
    this.#lensLabels.setAttribute('part', 'lens-labels')
    this.#labels = new SceneLabels(this, labels, () => this.segments.map((element) => ({ element })), {
      element: this.#lensLabels,
      color: () => {
        const s = this.segments[this.#segments.selected]
        return s ? getComputedStyle(s).color : undefined
      }
    })
    this.#thumb = document.createElement('div')
    this.#thumb.setAttribute('part', 'thumb')
    this.#slot = document.createElement('slot')
    root.append(this.#track, this.#lens, labels, this.#lensLabels, this.#thumb, this.#slot)
    this.#slot.addEventListener('slotchange', () => {
      this.#syncSegments()
      this.#labels.invalidate()
    })

    this.#internals = typeof this.attachInternals === 'function' ? this.attachInternals() : null
    this.#segments = new Segments({
      host: this,
      thumb: this.#thumb,
      followers: [this.#lens, this.#lensLabels],
      role: 'radio',
      selectedAttribute: 'aria-checked',
      inset: INSET,
      isDisabled: () => this.#isDisabled(),
      onPress: (pressed) => {
        this.toggleAttribute('data-pressed', pressed)
        // 字画进场景（透镜放大它们）只在镜像能用时：没有 GPU、在对话框里用 CSS 画时照旧是 DOM 的字
        this.toggleAttribute('data-lensing', pressed && this.#labels.ready)
        this.#tween.press(pressed)
      },
      onUserSelect: () => {
        this.#dirty = true
        this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
      },
      onSelectionChange: (value) => {
        this.#internals?.setFormValue(value)
        this.#labels.invalidate() // 选中的段换了颜色
      }
    })
    // 段的宽度变了（字体加载、宿主定宽变化）旋钮要跟上，画进场景的字也要重画
    this.#resize =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            this.#segments.place()
            this.#labels.invalidate()
          })
        : null
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
    this.#labels.connect()
    this.#link.connect()
  }

  disconnectedCallback(): void {
    this.#link.disconnect()
    this.#labels.disconnect()
    this.#resize?.disconnect()
    this.#tween.reset()
    this.toggleAttribute('data-pressed', false)
    this.toggleAttribute('data-lensing', false)
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
