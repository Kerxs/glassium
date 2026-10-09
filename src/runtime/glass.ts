/**
 * `glass(element, options?)`：让任意元素变成一块玻璃。`<div glass>` 走的也是它（auto.ts 读属性、调它）。
 *
 * ```js
 * const handle = glass(el)                                   // Default Glass
 * glass(el, { preset: 'tinted' })
 * glass(el, { material: { blur: 20, refraction: 0.3 }, interaction: { press: true } })
 * glass(el, { interaction: { jelly: true, glide: true } })   // 元素动起来玻璃拉长；跳到别处时玻璃飞过去
 * glass(el, { quality: 0.6 })                                // 这一块固定降一点（别的照旧自适应）
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

import { glass as mergeMaterial, MATERIAL_DEFAULTS, type GlassMaterial } from '../core/material.ts'
import { ElementMotion } from '../interaction/element-motion.ts'
import { PressInteraction } from '../interaction/press.ts'
import { factorsFor } from '../performance/quality.ts'
import type { GlassPanel } from '../renderer/panels.ts'
import { GlassBinding } from './binding.ts'
import { scheduleAbsorb } from './absorb.ts'
import { ensureStage } from './ensure-stage.ts'
import { cornerRadiusFromCss, isInteractiveElement, runtimePreset, runtimePresetNames, RUNTIME_PRESETS } from './presets.ts'
import { getConfig } from './config.ts'
import { dropRefraction, syncRefraction } from './refraction.ts'
import { GLASS_ID_ATTRIBUTE, installRuntimeStyles, removeGlassVars, setGlassVars } from './styles.ts'

export interface GlassInteractionOptions {
  /** 悬停变亮一点。 */
  readonly hover?: boolean
  /** 按下鼓起、按下的地方发光。 */
  readonly press?: boolean
  /** 键盘焦点（:focus-visible）与悬停一样的反馈。 */
  readonly focus?: boolean
  /** 元素动起来（拖动、过渡、动画）时玻璃顺着速度拉长，停下来圆回去（只动玻璃，内容不动）。默认关。 */
  readonly jelly?: boolean
  /** 元素一下子跳到别处（换了 class、布局变了）时，玻璃抬起、飞过去、落下，而不是瞬移。默认关。 */
  readonly glide?: boolean
}

export interface GlassOptions {
  /** 预设名：default / clear / tinted / frosted（以及 ultraThin / thin / regular / thick）。 */
  readonly preset?: string
  /** 覆盖预设的材质参数。 */
  readonly material?: GlassMaterial
  /** 交互反馈。不写按元素是否可交互决定（果冻、飞行默认关）；true 全开、false 全关。 */
  readonly interaction?: GlassInteractionOptions | boolean
  /**
   * 这一块的质量：0–1 固定降到这一档（色散、高级折射、折射、模糊、投影按 factorsFor(q) 乘在全局的上面；
   * 分辨率是整页共用的，不单独降）。'auto'（默认）交给自适应质量：整页吃紧时先降最贵的那几块。
   */
  readonly quality?: 'auto' | number
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
/** 活着的 runtime 玻璃（自适应质量的局部目标从这里取）。 */
const live = new Set<RuntimeGlass>()
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
  live.add(g)
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
  #motion: ElementMotion | null = null
  #pinned = false
  #wasPinned = false
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
    this.#syncQuality()
    if (element.isConnected) this.#binding.connect()
    void ensureStage()
    scheduleAbsorb(true)
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
    this.#syncQuality()
    this.#binding.refresh()
  }

  /** 整个换掉选项（属性驱动的玻璃：属性删了的那一项要回到预设值，不能与旧的合并）。 */
  replace(options: GlassOptions): void {
    if (this.destroyed) return
    this.#options = options
    this.#resolve()
    this.#syncInteraction()
    this.#syncQuality()
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
    syncRefraction(this.element, this.#id, this.#material, connected)
    if (connected && !this.#binding.connected) this.#binding.connect()
    else if (!connected && this.#binding.connected) {
      this.#binding.disconnect()
      this.#press?.reset()
      this.#motion?.reset()
    }
    scheduleAbsorb(true)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    live.delete(this)
    this.#binding.disconnect()
    this.#press?.dispose()
    this.#press = null
    this.#motion?.dispose()
    this.#motion = null
    dropRefraction(this.#id)
    removeGlassVars(this.#id)
    this.element.removeAttribute(GLASS_ID_ATTRIBUTE)
    if (handles.get(this.element) === this) handles.delete(this.element)
    scheduleAbsorb(true)
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
    syncRefraction(this.element, this.#id, this.#material, this.element.isConnected)
  }

  /** 固定的单块质量；'auto' 时由自适应质量（performance/adaptive.ts）通过 binding 设。 */
  #syncQuality(): void {
    const fixed = localFactors(this.#options.quality)
    this.#pinned = fixed !== null
    if (fixed) this.#binding.setQuality(fixed)
    else if (this.#wasPinned) this.#binding.setQuality(null)
    this.#wasPinned = this.#pinned
  }

  /** 这一块的质量是写死的（自适应质量不碰它）。 */
  get pinnedQuality(): boolean {
    return this.#pinned
  }

  /** 自适应质量设的单块系数（写死的不理）。 */
  setLocalQuality(factors: Parameters<GlassBinding['setQuality']>[0]): void {
    if (!this.#pinned && !this.destroyed) this.#binding.setQuality(factors)
  }

  /**
   * 成本估计（相对值）：视口里看得见的面积 × 模糊（σ 越大模糊链越深）× 色散（三次采样）。
   * 没有 GPU 计时，这只是估计；看不见的是 0。
   */
  cost(): number {
    if (!this.element.isConnected || !this.#binding.connected) return 0
    const r = this.element.getBoundingClientRect()
    const vw = typeof innerWidth === 'number' ? innerWidth : r.right
    const vh = typeof innerHeight === 'number' ? innerHeight : r.bottom
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0))
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
    const m = this.#material
    const blur = m.blur ?? MATERIAL_DEFAULTS.blur
    const dispersion = m.dispersion ?? MATERIAL_DEFAULTS.dispersion
    return w * h * (1 + blur / 16) * (dispersion > 0 ? 1.3 : 1)
  }

  #syncInteraction(): void {
    const i = this.#options.interaction
    const auto = isInteractiveElement(this.element)
    // 果冻、飞行：跟着元素的位置走（element-motion.ts），与按压各管各的
    const motion = i === true ? { jelly: true, glide: true } : i === false ? { jelly: false, glide: false } : { jelly: i?.jelly ?? false, glide: i?.glide ?? false }
    // CSS 画的玻璃（backend: 'css'）没有 GPU 面板可推变换：不跑。它每帧都要量一次元素的位置，白量
    if ((motion.jelly || motion.glide) && getConfig().backend !== 'css') {
      if (this.#motion) this.#motion.setOptions(motion)
      else this.#motion = ElementMotion.forElement(this.element, (p) => this.#binding.setPresentation(p), motion)
    } else if (this.#motion) {
      this.#motion.dispose()
      this.#motion = null
    }
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

/** 固定的单块质量（'auto' 与不写时交给自适应质量，这里不管）。 */
function localFactors(quality: GlassOptions['quality']): ReturnType<typeof factorsFor> | null {
  if (typeof quality !== 'number' || !Number.isFinite(quality)) return null
  const { resolution: _whole, ...rest } = factorsFor(Math.min(1, Math.max(0, quality)))
  return { resolution: 1, ...rest }
}

function cornerRadiusOf(el: HTMLElement): NonNullable<GlassMaterial['cornerRadius']> {
  const s = getComputedStyle(el)
  return cornerRadiusFromCss([s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius])
}

/** 能单独降质量的 runtime 玻璃（没写死 quality 的）。 */
export function adaptiveTargets(): RuntimeGlass[] {
  return [...live].filter((g) => !g.destroyed && !g.pinnedQuality)
}

/** auto.ts 用：内部的类型（replace / restyle / setConnected）。 */
export function runtimeGlassOf(
  element: HTMLElement
): { replace(o: GlassOptions): void; restyle(): void; setConnected(c: boolean): void; destroy(): void } | null {
  const g = handles.get(element)
  return g && !g.destroyed ? g : null
}
