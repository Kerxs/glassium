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
 * 不参与表单提交（没有 `type="submit"`）。需要的话用它包一个原生按钮的点击，
 * 或者等以后加 formAssociated。
 */

import type { GlassMaterial } from '../core/material.ts'
import { prefersReducedMotion } from '../renderer/stage.ts'
import { MATERIAL_ATTRIBUTES } from './attributes.ts'
import { GlassElement, sharedSheet } from './base.ts'
import {
  approach,
  dimmed,
  modulate,
  SETTLE_EPSILON,
  targetEnergy,
  TAU_MS
} from './motion.ts'

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
/* 禁用态让文字变淡。不用宿主的 opacity —— 玻璃跟不上 CSS 的 opacity（它画在画布上），
   玻璃那边由材质的 opacity 同步变淡，见 motion.ts 的 dimmed()。 */
:host([disabled]) [part='label'] {
  opacity: 0.45;
}
`
const sheet = { sheet: null as CSSStyleSheet | null }

export class GlassButton extends GlassElement {
  static override get observedAttributes(): string[] {
    return [...MATERIAL_ATTRIBUTES, 'disabled']
  }

  #hover = false
  #pressed = false
  #focusVisible = false
  /** 当前能量与目标能量，见 motion.ts。 */
  #energy = 0
  #target = 0
  #raf = 0
  #lastTick = 0
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

    this.addEventListener('pointerenter', this.#onPointerEnter)
    this.addEventListener('pointerleave', this.#onPointerLeave)
    this.addEventListener('pointerdown', this.#onPointerDown)
    this.addEventListener('pointerup', this.#onPointerUp)
    this.addEventListener('pointercancel', this.#onPointerUp)
    this.addEventListener('keydown', this.#onKeyDown)
    this.addEventListener('keyup', this.#onKeyUp)
    this.addEventListener('focus', this.#onFocus)
    this.addEventListener('blur', this.#onBlur)
    // 捕获阶段：禁用时在作者挂在按钮上的监听器之前拦下点击
    this.addEventListener('click', this.#onClickCapture, { capture: true })
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled')
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', value)
  }

  /** 按钮默认是胶囊（Apple 的玻璃按钮就是胶囊）。 */
  protected override defaults(): GlassMaterial {
    return { cornerRadius: '1frac' }
  }

  protected override present(material: GlassMaterial): GlassMaterial {
    const modulated = modulate(material, this.#energy)
    return this.disabled ? dimmed(modulated) : modulated
  }

  override connectedCallback(): void {
    super.connectedCallback()
    if (!this.hasAttribute('role')) this.setAttribute('role', 'button')
    if (!this.hasAttribute('tabindex')) this.#ownsTabindex = true
    this.#syncDisabled()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf)
    this.#raf = 0
    this.#hover = false
    this.#pressed = false
    this.#focusVisible = false
    this.#energy = 0
    this.#target = 0
  }

  override attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'disabled') {
      if (oldValue !== newValue && this.isConnected) this.#syncDisabled()
      return
    }
    super.attributeChangedCallback(name, oldValue, newValue)
  }

  #syncDisabled(): void {
    const disabled = this.disabled
    if (disabled) this.setAttribute('aria-disabled', 'true')
    else this.removeAttribute('aria-disabled')
    // 原生禁用按钮连点击聚焦都不行，所以是去掉 tabindex，而不是设成 -1
    if (this.#ownsTabindex) {
      if (disabled) this.removeAttribute('tabindex')
      else this.tabIndex = 0
    }
    if (disabled) {
      this.#pressed = false
      this.#hover = false
    }
    this.#retarget()
  }

  // —— 交互 ——

  #onPointerEnter = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return // 触屏没有悬停；按下由 pointerdown 负责
    this.#hover = true
    this.#retarget()
  }

  #onPointerLeave = (): void => {
    this.#hover = false
    this.#pressed = false
    this.#retarget()
  }

  #onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.disabled) return
    this.#pressed = true
    this.#retarget()
  }

  #onPointerUp = (): void => {
    this.#pressed = false
    this.#retarget()
  }

  #onKeyDown = (e: KeyboardEvent): void => {
    if (this.disabled || e.defaultPrevented) return
    if (e.key === 'Enter') {
      // 原生按钮：Enter 在按下时激活
      e.preventDefault()
      this.click()
    } else if (e.key === ' ') {
      // 原生按钮：空格按下时只显示按下态、并阻止页面滚动，松开时才激活
      e.preventDefault()
      this.#pressed = true
      this.#retarget()
    }
  }

  #onKeyUp = (e: KeyboardEvent): void => {
    if (e.key !== ' ' || !this.#pressed) return
    this.#pressed = false
    this.#retarget()
    if (!this.disabled) this.click()
  }

  #onFocus = (): void => {
    // 鼠标点出来的焦点不给悬停态，否则点完之后按钮会一直亮着
    this.#focusVisible = this.matches(':focus-visible')
    this.#retarget()
  }

  #onBlur = (): void => {
    this.#focusVisible = false
    this.#pressed = false
    this.#retarget()
  }

  #onClickCapture = (e: MouseEvent): void => {
    if (!this.disabled) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  // —— 动画 ——

  #retarget(): void {
    this.#target = targetEnergy({
      hover: this.#hover,
      pressed: this.#pressed,
      focusVisible: this.#focusVisible,
      disabled: this.disabled
    })
    if (prefersReducedMotion()) {
      // 不做过渡，直接落到目标态 —— 状态变化本身仍然可见，只是没有动画
      if (this.#raf !== 0) cancelAnimationFrame(this.#raf)
      this.#raf = 0
      this.#energy = this.#target
      this.refresh()
      return
    }
    if (this.#energy === this.#target) {
      this.refresh() // 能量没变，但 disabled 之类的状态可能变了
      return
    }
    if (this.#raf === 0) {
      this.#lastTick = performance.now()
      this.#raf = requestAnimationFrame(this.#tick)
    }
  }

  #tick = (now: number): void => {
    const dt = now - this.#lastTick
    this.#lastTick = now
    this.#energy = approach(this.#energy, this.#target, dt, TAU_MS)
    if (Math.abs(this.#energy - this.#target) < SETTLE_EPSILON) this.#energy = this.#target
    this.refresh()
    this.#raf = this.#energy === this.#target ? 0 : requestAnimationFrame(this.#tick)
  }
}
