/**
 * `<glass-button>` —— 带悬停与按压反馈的玻璃按钮。
 *
 * ```html
 * <glass-button preset="thick">确定</glass-button>
 * ```
 *
 * 反馈只改材质的**数值**（折射带更深、位移更强、高光更亮，见 motion.ts）。都是 uniform：
 * 不建管线、不建 bind group，每帧只重写这一块面板的 256 字节。
 *
 * ## 为什么不在影子树里放一个原生 `<button>`
 *
 * 那样焦点和键盘确实白送，但宿主上写的 `aria-label` 到不了里面那个按钮
 * （可访问名称要逐个属性转发），焦点落在影子树里，`:focus` 在宿主上也不成立。
 * 这里改为宿主自己就是按钮：宿主带 `role="button"` 并且可聚焦，
 * Enter / 空格的激活语义照原生按钮手写。
 *
 * role、tabindex、aria-disabled 都直接写成宿主上的属性（作者自己写了的不动），
 * 而不是经 ElementInternals 给出。后者是规范推荐的写法，但只存在于浏览器内部的
 * 无障碍树里：按 DOM 属性推断角色的工具看不到它（实测 Claude 浏览器面板的页面树就把它
 * 报成 generic），我们自己也就没法验证它。属性则在哪里都看得见。
 *
 * ## 表单
 *
 * 与原生 `<button>` 相同：在表单里默认 `type="submit"`，还有 `reset` 与 `button`；
 * `name` / `value` 只在它被按下时进表单数据；`formaction` 一类的覆盖属性照样生效；
 * 祖先 `<fieldset disabled>` 会让它禁用。激活发生在 click 事件派发完之后，
 * 作者在 click 里 `preventDefault()` 就不提交 —— 也与原生按钮相同。
 *
 * 提交借一个临时的原生提交按钮当 submitter：规范的 `requestSubmit(submitter)` 只认原生提交按钮，
 * 传自定义元素会抛 TypeError。所以 submit 事件的 `submitter` 是那个临时按钮（带着同样的
 * name / value），不是宿主。另外，表单里回车的隐式提交只认原生提交按钮，不会「按下」它。
 */

import type { GlassMaterial } from '../core/material.ts'
import { OVERLAY_HOST_CSS } from '../core/overlay.ts'
import { GlassElement, sharedSheet } from './base.ts'
import type { PanelLight } from '../renderer/panels.ts'
import { PressInteraction } from '../interaction/press.ts'

/**
 * 影子样式。圆角只影响焦点框与 CSS 兜底表面的形状，玻璃的形状由 corner-radius 属性决定 ——
 * CSS 算不出「短边的比例」这种圆角，两边只能各写各的。按钮默认是胶囊，这里给 999px 与之对应。
 */
const CSS = `
:host {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
:host(:focus-visible) {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}
:host([disabled]) {
  cursor: default;
}
/* 禁用态让文字变淡，玻璃那边由材质的 opacity 同步变淡（motion.ts 的 dimmed()）。
   写这段时玻璃还跟不上 CSS 的 opacity，所以没用宿主的 opacity；现在跟得上了（<glass-switch> 的禁用态就是
   宿主 opacity），这里保持原样，免得禁用按钮的样子（文字 0.45、玻璃 0.5）悄悄变掉。 */
:host([disabled]) [part='label'] {
  opacity: 0.45;
}
${OVERLAY_HOST_CSS}`
const sheet = { sheet: null as CSSStyleSheet | null }

/** 按钮的表单行为，与原生 `<button>` 的 type 相同。非法值按 submit 算（原生也是）。 */
export type GlassButtonType = 'submit' | 'reset' | 'button'

/** 提交时从宿主抄到临时提交按钮上的属性：它们决定进表单数据的内容与提交方式。 */
const SUBMITTER_ATTRIBUTES = ['name', 'value', 'formaction', 'formenctype', 'formmethod', 'formnovalidate', 'formtarget']

/**
 * 用一个临时的原生提交按钮提交表单。它带着宿主的 name / value 与覆盖属性，
 * 于是表单数据、校验、submit 事件都按原生的规则走。提交（含 submit 事件）是同步的，完了就拿掉。
 */
function submitWith(form: HTMLFormElement, host: HTMLElement): void {
  const proxy = document.createElement('button')
  proxy.type = 'submit'
  proxy.hidden = true
  for (const name of SUBMITTER_ATTRIBUTES) {
    const value = host.getAttribute(name)
    if (value !== null) proxy.setAttribute(name, value)
  }
  form.append(proxy)
  try {
    form.requestSubmit(proxy)
  } finally {
    proxy.remove()
  }
}

export class GlassButton extends GlassElement {
  static override get observedAttributes(): string[] {
    return [...super.observedAttributes, 'disabled']
  }

  /** 表单关联的自定义元素：有表单归属、响应 fieldset 的禁用、参与表单重置。 */
  static readonly formAssociated = true

  /** 没有 attachInternals 的环境（很老的浏览器）照常当普通按钮用，只是不关联表单。 */
  readonly #internals: ElementInternals | null
  /** 浏览器报来的禁用状态（disabled 属性或祖先 fieldset 的禁用），见 formDisabledCallback。 */
  #formDisabled = false
  /** 悬停、按压、键盘焦点的反馈（interaction/press.ts，与 runtime 的 glass() 共用）。键盘激活在这里。 */
  readonly #press: PressInteraction
  /** 空格按下了还没松开（松开时激活）。 */
  #spaceDown = false
  /** tabindex 是不是我们加的。作者自己写了 tabindex 的话，禁用时不去动它。 */
  #ownsTabindex = false

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sharedSheet(sheet, CSS)]
    const label = document.createElement('span')
    label.setAttribute('part', 'label')
    label.append(document.createElement('slot'))
    root.append(label)

    this.#press = new PressInteraction(
      this,
      { hover: true, press: true, focus: true, keys: false, isDisabled: () => this.#isDisabled() },
      () => this.refresh(),
      () => this.refreshLight()
    )
    this.addEventListener('keydown', this.#onKeyDown)
    this.addEventListener('keyup', this.#onKeyUp)
    this.addEventListener('blur', this.#onBlur)
    // 捕获阶段：禁用时在作者挂在按钮上的监听器之前拦下点击
    this.addEventListener('click', this.#onClickCapture, { capture: true })
    this.addEventListener('click', this.#onClick)
    this.#internals = typeof this.attachInternals === 'function' ? this.attachInternals() : null
  }

  /** 反映 disabled 属性（与原生按钮一样，不含 fieldset 的禁用）。 */
  get disabled(): boolean {
    return this.hasAttribute('disabled')
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', value)
  }

  /** 表单归属：祖先 `<form>`，或 form 属性指定的那个。 */
  get form(): HTMLFormElement | null {
    return this.#internals?.form ?? null
  }

  get type(): GlassButtonType {
    const t = (this.getAttribute('type') ?? '').toLowerCase()
    return t === 'reset' || t === 'button' ? t : 'submit'
  }

  set type(value: string) {
    this.setAttribute('type', value)
  }

  get name(): string {
    return this.getAttribute('name') ?? ''
  }

  set name(value: string) {
    this.setAttribute('name', value)
  }

  get value(): string {
    return this.getAttribute('value') ?? ''
  }

  set value(value: string) {
    this.setAttribute('value', value)
  }

  /** 浏览器在禁用状态（disabled 属性或祖先 fieldset）变化时调用。 */
  formDisabledCallback(disabled: boolean): void {
    this.#formDisabled = disabled
    if (this.isConnected) this.#syncDisabled()
  }

  /** 实际是否禁用：自己的 disabled 属性，或者被祖先 fieldset 禁用。 */
  #isDisabled(): boolean {
    return this.disabled || this.#formDisabled
  }

  /** 按钮默认是胶囊（Apple 的玻璃按钮就是胶囊）。 */
  protected override defaults(): GlassMaterial {
    return { cornerRadius: '1frac' }
  }

  protected override present(material: GlassMaterial): GlassMaterial {
    return this.#press.present(material)
  }

  /** 按压处的光（interaction/press.ts）。 */
  protected override light(): PanelLight | null {
    return this.#press.light()
  }

  override connectedCallback(): void {
    super.connectedCallback()
    if (!this.hasAttribute('role')) this.setAttribute('role', 'button')
    if (!this.hasAttribute('tabindex')) this.#ownsTabindex = true
    this.#syncDisabled()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.#press.reset()
    this.#spaceDown = false
  }

  override attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'disabled') {
      if (oldValue !== newValue && this.isConnected) this.#syncDisabled()
      return
    }
    super.attributeChangedCallback(name, oldValue, newValue)
  }

  #syncDisabled(): void {
    const disabled = this.#isDisabled()
    if (disabled) this.setAttribute('aria-disabled', 'true')
    else this.removeAttribute('aria-disabled')
    // 原生禁用按钮连点击聚焦都不行，所以是去掉 tabindex，而不是设成 -1
    if (this.#ownsTabindex) {
      if (disabled) this.removeAttribute('tabindex')
      else this.tabIndex = 0
    }
    if (disabled) this.#spaceDown = false
    this.#press.syncDisabled()
  }

  // —— 键盘激活（原生按钮的语义） ——

  #onKeyDown = (e: KeyboardEvent): void => {
    if (this.#isDisabled() || e.defaultPrevented) return
    if (e.key === 'Enter') {
      // 原生按钮：Enter 在按下时激活
      e.preventDefault()
      this.click()
    } else if (e.key === ' ') {
      // 原生按钮：空格按下时只显示按下态、并阻止页面滚动，松开时才激活
      e.preventDefault()
      this.#spaceDown = true
      this.#press.setKeyPressed(true) // 键盘按下：光打在中间
    }
  }

  #onKeyUp = (e: KeyboardEvent): void => {
    if (e.key !== ' ' || !this.#spaceDown) return
    this.#spaceDown = false
    this.#press.setKeyPressed(false)
    if (!this.#isDisabled()) this.click()
  }

  #onBlur = (): void => {
    this.#spaceDown = false
  }

  #onClickCapture = (e: MouseEvent): void => {
    if (!this.#isDisabled()) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  /**
   * 激活：提交或重置表单。与原生按钮一样放在 click 派发完之后，作者在 click 里 preventDefault()
   * 就不做。用下一个任务而不是微任务 —— 浏览器发起的派发里，微任务在两个监听器之间就执行了，
   * 那时后面的监听器还没来得及 preventDefault。
   */
  #onClick = (e: MouseEvent): void => {
    const form = this.form
    if (!form || this.type === 'button' || this.#isDisabled()) return
    setTimeout(() => {
      if (e.defaultPrevented || this.#isDisabled() || this.form !== form) return
      if (this.type === 'reset') form.reset()
      else submitWith(form, this)
    }, 0)
  }
}
