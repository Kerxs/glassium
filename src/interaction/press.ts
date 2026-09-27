/**
 * 悬停、按压、键盘焦点的反馈：一个能量标量（motion.ts）在静止、悬停、按下之间缓动，材质由它调制，按下的地方亮一块。
 *
 * `<glass-button>` 与 runtime 的 `glass(el, { interaction: { press: true } })` 共用这一份：元素本身的语义（按钮的激活、
 * 表单提交）不归这里管，这里只管看得见的反馈。反馈只改材质的数值，都是 uniform，不建管线。
 *
 * 监听挂在元素上；dispose() 摘掉。键盘：`keys` 打开时空格 / Enter 按下显示按下态（不阻止默认行为 —— 原生按钮自己
 * 会激活）；`<glass-button>` 自己处理键盘激活，通过 setKeyPressed() 告诉这里。
 */

import type { GlassMaterial } from '../core/material.ts'
import type { PanelLight } from '../renderer/panels.ts'
import { prefersReducedMotion } from '../renderer/stage.ts'
import { approach, dimmed, ENERGY, modulate, SETTLE_EPSILON, targetEnergy, TAU_MS } from './motion.ts'

export interface PressOptions {
  /** 悬停变亮一点（触屏没有悬停）。 */
  readonly hover: boolean
  /** 按下鼓起、按下的地方发光。 */
  readonly press: boolean
  /** 键盘焦点（:focus-visible）与悬停一样的反馈。 */
  readonly focus: boolean
  /** 空格 / Enter 按下时显示按下态（不阻止默认行为）。 */
  readonly keys: boolean
  /** 禁用时不响应、玻璃变淡。 */
  readonly isDisabled: () => boolean
}

export class PressInteraction {
  readonly #element: HTMLElement
  readonly #onChange: () => void
  readonly #onLightChange: () => void
  #options: PressOptions
  #hover = false
  #pressed = false
  #keyPressed = false
  #focusVisible = false
  #energy = 0
  #target = 0
  #raf = 0
  #lastTick = 0
  /** 按下的位置（相对元素左上角的 CSS 像素）；键盘按下时为 null，光打在中间。 */
  #pressAt: { x: number; y: number } | null = null

  /**
   * @param onChange 能量或禁用状态变了：重推材质与光
   * @param onLightChange 只有光的位置变了（按住拖动）：只推光
   */
  constructor(element: HTMLElement, options: PressOptions, onChange: () => void, onLightChange: () => void = onChange) {
    this.#element = element
    this.#options = options
    this.#onChange = onChange
    this.#onLightChange = onLightChange
    element.addEventListener('pointerenter', this.#onPointerEnter)
    element.addEventListener('pointerleave', this.#onPointerLeave)
    element.addEventListener('pointerdown', this.#onPointerDown)
    element.addEventListener('pointermove', this.#onPointerMove)
    element.addEventListener('pointerup', this.#onPointerUp)
    element.addEventListener('pointercancel', this.#onPointerUp)
    element.addEventListener('keydown', this.#onKeyDown)
    element.addEventListener('keyup', this.#onKeyUp)
    element.addEventListener('focus', this.#onFocus)
    element.addEventListener('blur', this.#onBlur)
  }

  get energy(): number {
    return this.#energy
  }

  /** 改选项（glass() 的 update）。 */
  setOptions(options: PressOptions): void {
    this.#options = options
    this.retarget()
  }

  /** 按能量调制材质；禁用时变淡。 */
  present(material: GlassMaterial): GlassMaterial {
    const modulated = modulate(material, this.#energy)
    return this.#options.isDisabled() ? dimmed(modulated) : modulated
  }

  /**
   * 按压处的光：强度跟着能量里「按下」的那一段走（悬停那一段不亮），位置是按下的点、按住拖动时跟着走；
   * 松开后随能量的补间淡掉。键盘按下时打在中间。
   */
  light(): PanelLight | null {
    const strength = (this.#energy - ENERGY.hover) / (ENERGY.pressed - ENERGY.hover)
    if (!(strength > 0)) return null
    const at = this.#pressAt ?? { x: this.#element.clientWidth / 2, y: this.#element.clientHeight / 2 }
    return { x: at.x, y: at.y, strength: Math.min(1, strength) }
  }

  /** 键盘按下 / 松开（`<glass-button>` 自己处理键盘激活时用）。 */
  setKeyPressed(pressed: boolean): void {
    this.#keyPressed = pressed
    if (pressed) this.#pressAt = null
    this.retarget()
  }

  /** 禁用状态变了：禁用时清掉悬停与按下。 */
  syncDisabled(): void {
    if (this.#options.isDisabled()) {
      this.#pressed = false
      this.#keyPressed = false
      this.#hover = false
    }
    this.retarget()
  }

  /** 回到静止、停掉动画（元素离开文档时），不回调。 */
  reset(): void {
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf)
    this.#raf = 0
    this.#hover = false
    this.#pressed = false
    this.#keyPressed = false
    this.#focusVisible = false
    this.#energy = 0
    this.#target = 0
  }

  dispose(): void {
    this.reset()
    const el = this.#element
    el.removeEventListener('pointerenter', this.#onPointerEnter)
    el.removeEventListener('pointerleave', this.#onPointerLeave)
    el.removeEventListener('pointerdown', this.#onPointerDown)
    el.removeEventListener('pointermove', this.#onPointerMove)
    el.removeEventListener('pointerup', this.#onPointerUp)
    el.removeEventListener('pointercancel', this.#onPointerUp)
    el.removeEventListener('keydown', this.#onKeyDown)
    el.removeEventListener('keyup', this.#onKeyUp)
    el.removeEventListener('focus', this.#onFocus)
    el.removeEventListener('blur', this.#onBlur)
  }

  // —— 事件 ——

  #onPointerEnter = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || !this.#options.hover) return // 触屏没有悬停；按下由 pointerdown 负责
    this.#hover = true
    this.retarget()
  }

  #onPointerLeave = (): void => {
    this.#hover = false
    this.#pressed = false
    this.retarget()
  }

  #onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.#options.press || this.#options.isDisabled()) return
    this.#pressed = true
    this.#pressAt = this.#local(e)
    this.retarget()
  }

  /** 按住拖动时光跟着手指走。只在按下时跟 —— 悬停时不亮，也就不用跟。 */
  #onPointerMove = (e: PointerEvent): void => {
    if (!this.#pressed || !this.#pressAt) return
    this.#pressAt = this.#local(e)
    this.#onLightChange()
  }

  #local(e: PointerEvent): { x: number; y: number } {
    const r = this.#element.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  #onPointerUp = (): void => {
    this.#pressed = false
    this.retarget()
  }

  #onKeyDown = (e: KeyboardEvent): void => {
    if (!this.#options.keys || !this.#options.press || this.#options.isDisabled() || e.repeat) return
    if (e.key === ' ' || e.key === 'Enter') this.setKeyPressed(true)
  }

  #onKeyUp = (e: KeyboardEvent): void => {
    if (!this.#options.keys || !this.#keyPressed) return
    if (e.key === ' ' || e.key === 'Enter') this.setKeyPressed(false)
  }

  #onFocus = (): void => {
    // 鼠标点出来的焦点不给悬停态，否则点完之后一直亮着
    this.#focusVisible = this.#options.focus && this.#element.matches(':focus-visible')
    this.retarget()
  }

  #onBlur = (): void => {
    this.#focusVisible = false
    this.#pressed = false
    this.#keyPressed = false
    this.retarget()
  }

  // —— 动画 ——

  /** 按当前状态重算目标能量并缓动过去（减少动效时直接落到目标）。 */
  retarget(): void {
    this.#target = targetEnergy({
      hover: this.#hover,
      pressed: this.#pressed || this.#keyPressed,
      focusVisible: this.#focusVisible,
      disabled: this.#options.isDisabled()
    })
    if (prefersReducedMotion()) {
      // 不做过渡，直接落到目标态 —— 状态变化本身仍然可见，只是没有动画
      if (this.#raf !== 0) cancelAnimationFrame(this.#raf)
      this.#raf = 0
      this.#energy = this.#target
      this.#onChange()
      return
    }
    if (this.#energy === this.#target) {
      this.#onChange() // 能量没变，但禁用之类的状态可能变了
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
    this.#onChange()
    this.#raf = this.#energy === this.#target ? 0 : requestAnimationFrame(this.#tick)
  }
}
