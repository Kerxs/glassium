/**
 * `<glass-slider>` —— 滑块：轨道与进度是填充（画进场景），旋钮是玻璃。
 *
 * ```html
 * <glass-slider name="volume" min="0" max="100" value="40" aria-label="音量"></glass-slider>
 * ```
 *
 * 与 `<glass-switch>` 同一套：平时旋钮是白的，拖动时鼓起来变成透明的透镜，透过它看得见底下的轨道与进度
 * （被折射、被放大）。轨道与进度必须是填充 —— DOM 的背景玻璃看不见（R2）。
 *
 * 行为与原生 `<input type="range">` 相同：
 * - 宿主就是滑块：`role="slider"`、`aria-valuenow/min/max`、可聚焦；方向键走一档，PageUp / PageDown 走十分之一，
 *   Home / End 到两头；
 * - 按在轨道上跳到那里并可以接着拖，按在旋钮上从原处拖（不跳）；
 * - 值变了就派发 `input`，松手（或一次键盘操作）之后值与按下时不同就派发 `change`；程序改 `value` 不派发；
 * - `min` / `max` / `step`（默认 0 / 100 / 1，`step="any"` 连续）；值落到最近的一档上，档从 min 起算；
 * - 表单关联：`name` 与当前值进表单数据；`value` 属性是初始值，表单重置回到它；`disabled` 与祖先
 *   `<fieldset disabled>` 都让它禁用。
 *
 * 颜色：`--glass-slider-fill`（进度，默认 #007aff）、`--glass-slider-track`（默认 rgba(120, 120, 128, 0.2)）。
 * 尺寸：默认 200×28，宽度可以改（`width: 100%` 之类）；轨道 6px 高，旋钮 38×24。
 */

import type { GlassPanel } from '../renderer/panels.ts'
import { HTMLElementBase, sharedSheet } from './base.ts'
import { StageLink } from './stage-link.ts'
import { PressTween, thumbMaterial } from './thumb.ts'

/** 旋钮的宽高，CSS 像素（与样式一致）。 */
const THUMB_W = 38
const THUMB_H = 24

/** 取值范围。step 为 0 表示连续（`step="any"`）。 */
export interface SliderRange {
  readonly min: number
  readonly max: number
  readonly step: number
}

/** 属性 → 取值范围，与原生 range 相同：min 默认 0、max 默认 100（小于 min 时当作 min）、step 默认 1。 */
export function parseRange(min: string | null, max: string | null, step: string | null): SliderRange {
  const num = (s: string | null, fallback: number): number => {
    const v = s === null ? NaN : Number(s)
    return Number.isFinite(v) ? v : fallback
  }
  const lo = num(min, 0)
  const hi = Math.max(lo, num(max, 100))
  if (step !== null && step.trim().toLowerCase() === 'any') return { min: lo, max: hi, step: 0 }
  const st = num(step, 1)
  return { min: lo, max: hi, step: st > 0 ? st : 1 } // 0 与负数与原生一样按默认的 1
}

/** 一个数的小数位数（`0.1` → 1，`2.5e-3` → 4）。档的倍数按它取整，免得出现 0.30000000000000004。 */
function decimals(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0
  const [mantissa, exp] = String(n).toLowerCase().split('e')
  const frac = mantissa!.split('.')[1]?.length ?? 0
  return Math.max(0, frac - Number(exp ?? 0))
}

/**
 * 规整一个值：钳到 [min, max]，落到最近的一档上（档从 min 起算）。max 本身不在档上时，
 * 最大的合法值是不超过 max 的那一档 —— 与原生 range 相同。
 */
export function snapValue(value: number, range: SliderRange): number {
  const { min, max, step } = range
  if (!(max > min)) return min
  const v = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min + (max - min) / 2
  if (!(step > 0)) return v
  const digits = Math.max(decimals(step), decimals(min))
  const round = (x: number): number => Number(x.toFixed(digits))
  let n = Math.round((v - min) / step)
  if (round(min + n * step) > max) n = Math.floor((max - min) / step)
  return round(min + n * step)
}

/** 值 → 0–1 的位置。 */
export function ratioOf(value: number, range: SliderRange): number {
  return range.max > range.min ? (value - range.min) / (range.max - range.min) : 0
}

/** 没写 value 属性时的初始值：与原生 range 相同，是范围的中点（再落到档上）。 */
export function defaultValue(range: SliderRange): number {
  return snapValue(range.min + (range.max - range.min) / 2, range)
}

const CSS = `
:host {
  display: inline-block;
  position: relative;
  width: 200px;
  height: 28px;
  vertical-align: middle;
  container-type: size;
  cursor: pointer;
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
:host(:focus-visible) {
  outline: 2px solid currentColor;
  outline-offset: 3px;
  border-radius: 999px;
}
:host([aria-disabled='true']) {
  opacity: 0.4;
  cursor: default;
}
[part='track'],
[part='progress'] {
  position: absolute;
  top: 50%;
  height: 6px;
  margin-top: -3px;
  border-radius: 999px;
}
[part='track'] {
  left: 0;
  right: 0;
  --glass-fill: var(--glass-slider-track, rgba(120, 120, 128, 0.2));
}
/* 进度从左端画到旋钮中心 */
[part='progress'] {
  left: 0;
  width: calc(var(--_ratio) * (100cqw - ${THUMB_W}px) + ${THUMB_W / 2}px);
  --glass-fill: var(--glass-slider-fill, #007aff);
}
[part='thumb'] {
  position: absolute;
  left: 0;
  top: 50%;
  width: ${THUMB_W}px;
  height: ${THUMB_H}px;
  margin-top: ${-THUMB_H / 2}px;
  border-radius: 999px;
  translate: calc(var(--_ratio) * (100cqw - ${THUMB_W}px)) 0;
  scale: 1;
  transition: scale 0.2s ease;
}
:host([data-pressed]) [part='thumb'] {
  scale: 1.25;
}
/* 没有玻璃时：CSS 画轨道、进度与白色旋钮 */
:host(:not([data-glassium-active])) [part='track'],
:host(:not([data-glassium-active])) [part='progress'] {
  background-color: var(--glass-fill);
}
:host(:not([data-glassium-active])) [part='thumb'] {
  background: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), 0 0 0 0.5px rgba(0, 0, 0, 0.06);
}
@media (prefers-reduced-motion: reduce) {
  [part='thumb'] {
    transition: none;
  }
}
@media (forced-colors: active) {
  :host(:not([data-glassium-active])) [part='track'] {
    forced-color-adjust: none;
    background-color: GrayText;
  }
  :host(:not([data-glassium-active])) [part='progress'] {
    forced-color-adjust: none;
    background-color: Highlight;
  }
  :host(:not([data-glassium-active])) [part='thumb'] {
    forced-color-adjust: none;
    box-sizing: border-box;
    background: Canvas;
    border: 2px solid ButtonText;
    box-shadow: none;
  }
}
`
const sheet = { sheet: null as CSSStyleSheet | null }

export class GlassSlider extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return ['min', 'max', 'step', 'value', 'disabled']
  }

  static readonly formAssociated = true

  readonly #internals: ElementInternals | null
  readonly #track: HTMLElement
  readonly #progress: HTMLElement
  readonly #thumb: HTMLElement
  #panel: GlassPanel | null = null
  readonly #link = new StageLink(this, (stage) => {
    // 先注册的填充画在下面：轨道，再进度
    const track = stage.registerFill(this.#track)
    const progress = stage.registerFill(this.#progress)
    const panel = stage.register(this.#thumb, thumbMaterial(this.#tween.energy))
    this.#panel = panel
    return () => {
      panel.unregister()
      progress.unregister()
      track.unregister()
      this.#panel = null
    }
  })
  readonly #tween = new PressTween((energy) => this.#panel?.setMaterial(thumbMaterial(energy)))

  #range: SliderRange = { min: 0, max: 100, step: 1 }
  /** 当前值。没被用户或程序改过（dirty 为 false）时跟着 value 属性（初始值）走。 */
  #value = 50
  #dirty = false
  #formDisabled = false
  #ownsTabindex = false

  // 拖动
  #pointerId: number | null = null
  /** 按在旋钮上时，指针与旋钮中心的水平距离：拖的时候保持它，旋钮不跳到指针下面。 */
  #grab = 0
  #valueAtPress = 0

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sharedSheet(sheet, CSS)]
    const part = (name: string): HTMLElement => {
      const el = document.createElement('div')
      el.setAttribute('part', name)
      return el
    }
    this.#track = part('track')
    this.#progress = part('progress')
    this.#thumb = part('thumb')
    root.append(this.#track, this.#progress, this.#thumb)

    this.addEventListener('pointerdown', this.#onPointerDown)
    this.addEventListener('pointermove', this.#onPointerMove)
    this.addEventListener('pointerup', this.#onPointerUp)
    this.addEventListener('pointercancel', this.#onPointerUp)
    this.addEventListener('keydown', this.#onKeyDown)
    this.#internals = typeof this.attachInternals === 'function' ? this.attachInternals() : null
  }

  // —— 属性 ——

  /** 当前值（字符串，与原生 range 相同）。设置时规整到范围与档上，不派发事件。 */
  get value(): string {
    return String(this.#value)
  }

  set value(v: string | number) {
    this.#dirty = true
    this.#setValue(Number(v))
  }

  get valueAsNumber(): number {
    return this.#value
  }

  set valueAsNumber(v: number) {
    this.value = v
  }

  /** 初始值（value 属性）。表单重置回到它。 */
  get defaultValue(): string {
    return this.getAttribute('value') ?? String(defaultValue(this.#range))
  }

  set defaultValue(v: string) {
    this.setAttribute('value', v)
  }

  get min(): string {
    return String(this.#range.min)
  }

  set min(v: string) {
    this.setAttribute('min', v)
  }

  get max(): string {
    return String(this.#range.max)
  }

  set max(v: string) {
    this.setAttribute('max', v)
  }

  get step(): string {
    return this.#range.step > 0 ? String(this.#range.step) : 'any'
  }

  set step(v: string) {
    this.setAttribute('step', v)
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
    if (!this.hasAttribute('role')) this.setAttribute('role', 'slider')
    if (!this.hasAttribute('tabindex')) this.#ownsTabindex = true
    this.#readRange()
    this.#syncDisabled()
    this.#link.connect()
  }

  disconnectedCallback(): void {
    this.#link.disconnect()
    this.#tween.reset()
    this.toggleAttribute('data-pressed', false)
    this.#pointerId = null
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.isConnected) return
    if (name === 'disabled') this.#syncDisabled()
    else this.#readRange()
  }

  formDisabledCallback(disabled: boolean): void {
    this.#formDisabled = disabled
    if (this.isConnected) this.#syncDisabled()
  }

  formResetCallback(): void {
    this.#dirty = false
    this.#setValue(Number(this.defaultValue))
  }

  #isDisabled(): boolean {
    return this.disabled || this.#formDisabled
  }

  /** min / max / step / value 属性变了：重新规整当前值（没改过的值跟着 value 属性走）。 */
  #readRange(): void {
    this.#range = parseRange(this.getAttribute('min'), this.getAttribute('max'), this.getAttribute('step'))
    this.setAttribute('aria-valuemin', String(this.#range.min))
    this.setAttribute('aria-valuemax', String(this.#range.max))
    this.#setValue(this.#dirty ? this.#value : Number(this.defaultValue))
  }

  #setValue(v: number): boolean {
    const next = snapValue(v, this.#range)
    const changed = next !== this.#value
    this.#value = next
    // 位置写在影子树里的元素上，不写宿主的 style：那是作者（或框架）的，整个换掉时会把它一起冲掉
    const ratio = String(ratioOf(next, this.#range))
    this.#progress.style.setProperty('--_ratio', ratio)
    this.#thumb.style.setProperty('--_ratio', ratio)
    this.setAttribute('aria-valuenow', String(next))
    this.#internals?.setFormValue(String(next))
    return changed
  }

  #syncDisabled(): void {
    const disabled = this.#isDisabled()
    if (disabled) this.setAttribute('aria-disabled', 'true')
    else this.removeAttribute('aria-disabled')
    if (this.#ownsTabindex) {
      if (disabled) this.removeAttribute('tabindex')
      else this.tabIndex = 0
    }
    if (disabled && this.#pointerId !== null) {
      this.#pointerId = null
      this.#press(false)
    }
  }

  // —— 交互 ——

  /** 指针的水平位置 → 值（扣掉按下时的抓取偏移）。 */
  #valueAt(clientX: number): number {
    const r = this.getBoundingClientRect()
    const scale = this.offsetWidth > 0 ? r.width / this.offsetWidth : 1 // 自己或祖先有 transform: scale 时
    const usable = Math.max(1, this.offsetWidth - THUMB_W)
    const center = (clientX - r.left) / scale - this.#grab
    const ratio = Math.min(1, Math.max(0, (center - THUMB_W / 2) / usable))
    return this.#range.min + ratio * (this.#range.max - this.#range.min)
  }

  #onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.#isDisabled()) return
    this.#pointerId = e.pointerId
    this.#valueAtPress = this.#value
    // 按在旋钮上：从原处拖，不跳。按在轨道上：跳到那里
    const t = this.#thumb.getBoundingClientRect()
    const onThumb = e.clientX >= t.left && e.clientX <= t.right && e.clientY >= t.top && e.clientY <= t.bottom
    const r = this.getBoundingClientRect()
    const scale = this.offsetWidth > 0 ? r.width / this.offsetWidth : 1
    this.#grab = onThumb ? (e.clientX - (t.left + t.width / 2)) / scale : 0
    try {
      this.setPointerCapture(e.pointerId)
    } catch {
      // 合成的事件没有活的指针，捕获不了
    }
    this.focus({ preventScroll: true })
    e.preventDefault() // 不要开始选中文字
    this.#press(true)
    if (!onThumb) this.#userSet(this.#valueAt(e.clientX))
  }

  #onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    this.#userSet(this.#valueAt(e.clientX))
  }

  #onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    this.#pointerId = null
    this.#press(false)
    if (this.#value !== this.#valueAtPress) this.#emit('change')
  }

  #onKeyDown = (e: KeyboardEvent): void => {
    if (this.#isDisabled() || e.defaultPrevented) return
    const { min, max, step } = this.#range
    const unit = step > 0 ? step : (max - min) / 100
    const page = Math.max(unit, (max - min) / 10)
    let next: number
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = this.#value + unit
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        next = this.#value - unit
        break
      case 'PageUp':
        next = this.#value + page
        break
      case 'PageDown':
        next = this.#value - page
        break
      case 'Home':
        next = min
        break
      case 'End':
        next = max
        break
      default:
        return
    }
    e.preventDefault()
    if (this.#userSet(next)) this.#emit('change')
  }

  /** 用户改值：规整、变了就派发 input。返回变没变。 */
  #userSet(v: number): boolean {
    this.#dirty = true
    const changed = this.#setValue(v)
    if (changed) this.#emit('input')
    return changed
  }

  #emit(type: 'input' | 'change'): void {
    this.dispatchEvent(new Event(type, { bubbles: true, composed: type === 'input' }))
  }

  #press(pressed: boolean): void {
    this.toggleAttribute('data-pressed', pressed)
    this.#tween.press(pressed)
  }
}
