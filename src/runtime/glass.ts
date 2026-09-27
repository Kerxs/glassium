/**
 * `glass(element, options?)`：让任意元素变成一块玻璃。`<div glass>` 走的也是它（auto.ts 读属性、调它）。
 *
 * ```js
 * const handle = glass(el)                                   // Default Glass
 * glass(el, { preset: 'tinted' })
 * glass(el, { material: { blur: 20, refraction: 0.3 }, interaction: { press: true } })
 * handle.update({ preset: 'clear' })
 * handle.destroy()
 * ```
 *
 * 材质 = 预设（默认 default）⊕ 按元素算的圆角（CSS 的 border-radius，material 里写了 cornerRadius 就用它）⊕ material。
 * 交互默认按元素是否可交互（presets.ts 的 isInteractiveElement）；`interaction: false` 全关，`true` 全开。
 * 元素本身不被改写：语义、焦点、键盘、无障碍都照旧是它自己的 —— 玻璃只是画在它后面。
 *
 * 每个元素最多一块玻璃：再调一次等于 update。元素离开文档时玻璃跟着注销，回来时再注册（MutationObserver，见 auto.ts）。
 */

import { glass as mergeMaterial, type GlassMaterial } from '../core/material.ts'
import { PressInteraction } from '../interaction/press.ts'
import type { GlassPanel } from '../renderer/panels.ts'
import { GlassBinding } from './binding.ts'
import { ensureStage } from './ensure-stage.ts'
import { cornerRadiusFromCss, isInteractiveElement, runtimePreset, runtimePresetNames, RUNTIME_PRESETS } from './presets.ts'
import { GLASS_ID_ATTRIBUTE, installRuntimeStyles, removeGlassVars, setGlassVars } from './styles.ts'

export interface GlassInteractionOptions {
  /** 悬停变亮一点。 */
  readonly hover?: boolean
  /** 按下鼓起、按下的地方发光。 */
  readonly press?: boolean
  /** 键盘焦点（:focus-visible）与悬停一样的反馈。 */
  readonly focus?: boolean
}

export interface GlassOptions {
  /** 预设名：default / clear / tinted / frosted（以及 ultraThin / thin / regular / thick）。 */
  readonly preset?: string
  /** 覆盖预设的材质参数。 */
  readonly material?: GlassMaterial
  /** 交互反馈。不写按元素是否可交互决定；true 全开、false 全关。 */
  readonly interaction?: GlassInteractionOptions | boolean
}

export interface GlassHandle {
  readonly element: HTMLElement
  /** 面板（stage 还没建好时是 null）。 */
  readonly panel: GlassPanel | null
  /** 当前的基础材质（不含交互调制）。 */
  readonly material: GlassMaterial
  /** 换选项：与原来的合并（material 逐项覆盖）。 */
  update(options: GlassOptions): void
  /** 注销玻璃、摘掉交互，元素恢复原样。 */
  destroy(): void
}

const handles = new WeakMap<HTMLElement, RuntimeGlass>()
let nextId = 1

/** 让元素变成一块玻璃；已经是了就 update。 */
export function glass(element: HTMLElement, options?: GlassOptions): GlassHandle
/**
 * 旧的写法（0.2 之前）：取预设并覆盖若干字段，返回材质。`glass(GlassPresets.thick, { tint: '#0af3' })`。
 * @deprecated 直接写 `{ ...GlassPresets.thick, tint: '#0af3' }`；`glass()` 现在是让元素变成玻璃的入口。
 */
export function glass(preset: GlassMaterial, overrides?: GlassMaterial): GlassMaterial
export function glass(target: HTMLElement | GlassMaterial, options: GlassOptions | GlassMaterial = {}): GlassHandle | GlassMaterial {
  if (!isElement(target)) return mergeMaterial(target, options as GlassMaterial)
  const element = target
  options = options as GlassOptions
  const existing = handles.get(element)
  if (existing && !existing.destroyed) {
    existing.update(options)
    return existing
  }
  const g = new RuntimeGlass(element, options)
  handles.set(element, g)
  return g
}

function isElement(x: unknown): x is HTMLElement {
  return typeof x === 'object' && x !== null && (x as { nodeType?: unknown }).nodeType === 1
}

/** 元素上的玻璃（没有是 null）。 */
export function glassOf(element: HTMLElement): GlassHandle | null {
  const g = handles.get(element)
  return g && !g.destroyed ? g : null
}

class RuntimeGlass implements GlassHandle {
  readonly element: HTMLElement
  readonly #id = String(nextId++)
  #options: GlassOptions
  #material: GlassMaterial = {}
  readonly #binding: GlassBinding
  #press: PressInteraction | null = null
  destroyed = false

  constructor(element: HTMLElement, options: GlassOptions) {
    this.element = element
    this.#options = options
    installRuntimeStyles()
    element.setAttribute(GLASS_ID_ATTRIBUTE, this.#id)
    this.#binding = new GlassBinding(element, {
      material: () => (this.#press ? this.#press.present(this.#material) : this.#material),
      light: () => this.#press?.light() ?? null
    })
    this.#resolve()
    this.#syncInteraction()
    if (element.isConnected) this.#binding.connect()
    void ensureStage()
  }

  get panel(): GlassPanel | null {
    return this.#binding.panel
  }

  get material(): GlassMaterial {
    return this.#material
  }

  update(options: GlassOptions): void {
    if (this.destroyed) return
    const material = options.material ? { ...this.#options.material, ...options.material } : this.#options.material
    this.#options = { ...this.#options, ...options, ...(material ? { material } : {}) }
    this.#resolve()
    this.#syncInteraction()
    this.#binding.refresh()
  }

  /** 整个换掉选项（属性驱动的玻璃：属性删了的那一项要回到预设值，不能与旧的合并）。 */
  replace(options: GlassOptions): void {
    if (this.destroyed) return
    this.#options = options
    this.#resolve()
    this.#syncInteraction()
    this.#binding.refresh()
  }

  /** 元素的样式可能变了（class、style、border-radius）：重算按元素的默认值。 */
  restyle(): void {
    if (this.destroyed) return
    const before = JSON.stringify(this.#material.cornerRadius)
    this.#resolve()
    if (JSON.stringify(this.#material.cornerRadius) !== before) this.#binding.refresh()
  }

  /** 元素进 / 出文档（auto.ts 的 MutationObserver 告诉）。 */
  setConnected(connected: boolean): void {
    if (this.destroyed) return
    if (connected && !this.#binding.connected) this.#binding.connect()
    else if (!connected && this.#binding.connected) {
      this.#binding.disconnect()
      this.#press?.reset()
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.#binding.disconnect()
    this.#press?.dispose()
    this.#press = null
    removeGlassVars(this.#id)
    this.element.removeAttribute(GLASS_ID_ATTRIBUTE)
    if (handles.get(this.element) === this) handles.delete(this.element)
  }

  #resolve(): void {
    const o = this.#options
    let base = RUNTIME_PRESETS.default as GlassMaterial
    if (o.preset !== undefined) {
      const p = runtimePreset(o.preset)
      if (p) base = p
      else console.warn(`[Glassium] preset "${o.preset}" 不认识，可用：${runtimePresetNames().join(' / ')}；按 default`)
    }
    const radius =
      o.material?.cornerRadius === undefined && typeof getComputedStyle === 'function'
        ? { cornerRadius: cornerRadiusOf(this.element) }
        : {}
    this.#material = { ...base, ...radius, ...o.material }
    setGlassVars(this.#id, this.#material)
  }

  #syncInteraction(): void {
    const i = this.#options.interaction
    const auto = isInteractiveElement(this.element)
    const want =
      i === false
        ? null
        : i === true
          ? { hover: true, press: true, focus: true }
          : {
              hover: i?.hover ?? auto,
              press: i?.press ?? auto,
              focus: i?.focus ?? auto
            }
    const on = want !== null && (want.hover || want.press || want.focus)
    if (!on) {
      this.#press?.dispose()
      this.#press = null
      return
    }
    const options = {
      hover: want!.hover,
      press: want!.press,
      focus: want!.focus,
      keys: true,
      isDisabled: () => this.element.matches(':disabled') || this.element.getAttribute('aria-disabled') === 'true'
    }
    if (this.#press) this.#press.setOptions(options)
    else this.#press = new PressInteraction(this.element, options, () => this.#binding.refresh(), () => this.#binding.refreshLight())
  }
}

function cornerRadiusOf(el: HTMLElement): NonNullable<GlassMaterial['cornerRadius']> {
  const s = getComputedStyle(el)
  return cornerRadiusFromCss([s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius])
}

/** auto.ts 用：内部的类型（replace / restyle / setConnected）。 */
export function runtimeGlassOf(
  element: HTMLElement
): { replace(o: GlassOptions): void; restyle(): void; setConnected(c: boolean): void; destroy(): void } | null {
  const g = handles.get(element)
  return g && !g.destroyed ? g : null
}
