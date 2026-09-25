/**
 * `<glass-*>` 组件的公共基类。
 *
 * 组件只做三件事：把 HTML 属性翻译成材质、在 stage 上把自己注册成面板、在没有玻璃时
 * 挂上 CSS 兜底表面的钩子（`data-glassium-active` 属性，见 glassium.css）。
 * 渲染全在 stage 里，组件本身不碰 GPU。
 *
 * 内容是普通的 light DOM（影子树里只有一个 `<slot>`）：选中、聚焦、输入法、无障碍、
 * 命中测试全归浏览器，Glassium 一样都不接管。
 *
 * ## 组件可以早于 stage
 *
 * createGlassStage() 要等 GPU 设备，是异步的；而 customElements.define 一执行，页面上
 * 已有的元素就立即 upgrade。所以「先建 stage 再 upgrade」在实际页面里做不到。
 * 组件 upgrade 时没有 stage 就先等着，stage 建好时统一注册；stage 被 dispose 再重建，
 * 组件也跟过去。
 */

import type { GlassMaterial } from '../core/material.ts'
import { overlayHostRule } from '../core/overlay.ts'
import { describeElement } from '../renderer/layering.ts'
import type { GlassPanel, PanelLight } from '../renderer/panels.ts'
import { currentStage, onStageChange, type GlassStage } from '../renderer/stage.ts'
import { MATERIAL_ATTRIBUTES, parseMaterialAttributes } from './attributes.ts'
import { ScrollEdgeLayer } from './scroll-edge.ts'

/**
 * 玻璃生效时组件带上这个属性。glassium.css 里的兜底表面只在**没有**它的时候出现 ——
 * upgrade 之前、stage 还没建好、没有 GPU、高对比度模式，统统落在「没有它」这一边。
 */
export const ACTIVE_ATTRIBUTE = 'data-glassium-active'

/**
 * SSR / Node 里没有 HTMLElement。类声明在模块求值时就要用到基类，直接写
 * `extends HTMLElement` 会让服务端 import 这个包时当场 ReferenceError。
 * 真正的注册（customElements.define）只在 defineGlassElements() 里做，那里有环境判断。
 */
export const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement

export class GlassElement extends HTMLElementBase {
  /** 已连接到文档的组件。stage 出现、消失或状态变化时逐个同步。 */
  static readonly #live = new Set<GlassElement>()
  static #subscribed = false

  /** 材质属性，加上 `scroll-edge`（浮在正文上时的磨砂，scroll-edge.ts）。子类在它后面接自己的。 */
  static get observedAttributes(): string[] {
    return [...MATERIAL_ATTRIBUTES, 'scroll-edge']
  }

  #stage: GlassStage | null = null
  #panel: GlassPanel | null = null
  #base: GlassMaterial = {}
  readonly #reported = new Set<string>()
  /**
   * 这个元素自己的样式表：`:host { --glassium-* }`，把材质写成 CSS 变量（core/overlay.ts）。用 CSS 画的玻璃
   * （overlay、对话框与 popover 里）读它们。放在影子树里而不写宿主的 style：那是作者（或框架）的，
   * 改它还会惊动 stage 的 MutationObserver。材质变了才重写。
   */
  #vars: CSSStyleSheet | null = null
  #varsRule = ''
  /** 写了 scroll-edge 时影子树里的磨砂层。 */
  readonly #scrollEdge = new ScrollEdgeLayer(this)

  /** 解析后的基础材质：组件默认值 ⊕ preset ⊕ 显式属性。不含交互调制。 */
  get material(): GlassMaterial {
    return this.#base
  }

  /** 子类的默认材质，会被 preset 与显式属性覆盖。 */
  protected defaults(): GlassMaterial {
    return {}
  }

  /** 子类在交互时调整材质（`<glass-button>` 的按压）。默认原样返回。 */
  protected present(material: GlassMaterial): GlassMaterial {
    return material
  }

  /** 子类的按压处的光（`<glass-button>`）。默认没有。 */
  protected light(): PanelLight | null {
    return null
  }

  connectedCallback(): void {
    GlassElement.#live.add(this)
    GlassElement.#subscribe()
    this.#readAttributes()
    this.#sync(currentStage())
    this.#scrollEdge.sync()
  }

  disconnectedCallback(): void {
    GlassElement.#live.delete(this)
    this.#detach()
    this.removeAttribute(ACTIVE_ATTRIBUTE)
    this.#scrollEdge.sync()
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return
    if (name === 'scroll-edge') {
      this.#scrollEdge.sync()
      return
    }
    if (!(MATERIAL_ATTRIBUTES as readonly string[]).includes(name)) return
    this.#readAttributes()
    this.refresh()
  }

  /** 材质或交互状态变了：把当前材质与光推给面板。还没注册（没有 stage）时什么都不做。 */
  protected refresh(): void {
    this.#panel?.setMaterial(this.present(this.#base))
    this.#panel?.setLight(this.light())
  }

  /** 只有光变了（比如按住拖动）：不重推材质 —— 推材质会让面板重新降级。 */
  protected refreshLight(): void {
    this.#panel?.setLight(this.light())
  }

  static #subscribe(): void {
    if (GlassElement.#subscribed) return
    GlassElement.#subscribed = true
    onStageChange((stage) => {
      for (const el of GlassElement.#live) el.#sync(stage)
    })
  }

  #sync(stage: GlassStage | null): void {
    if (stage !== this.#stage) {
      this.#detach()
      if (stage) {
        this.#stage = stage
        this.#panel = stage.register(this, this.present(this.#base))
        this.#panel.setLight(this.light())
      }
    }
    this.toggleAttribute(ACTIVE_ATTRIBUTE, stage?.active === true)
  }

  #detach(): void {
    this.#panel?.unregister()
    this.#panel = null
    this.#stage = null
  }

  #writeOverlayVars(): void {
    const root = this.shadowRoot
    if (!root || typeof CSSStyleSheet === 'undefined') return
    const rule = overlayHostRule(this.#base)
    if (rule === this.#varsRule) return
    if (!this.#vars) {
      this.#vars = new CSSStyleSheet()
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.#vars]
    }
    this.#vars.replaceSync(rule)
    this.#varsRule = rule
  }

  #readAttributes(): void {
    const { material, problems } = parseMaterialAttributes((name) => this.getAttribute(name))
    this.#base = { ...this.defaults(), ...material }
    this.#writeOverlayVars()
    for (const problem of problems) {
      // 同一个错只报一次：改别的属性会重新解析全部属性，不去重的话同一条会反复出现
      if (this.#reported.has(problem)) continue
      this.#reported.add(problem)
      console.warn(`[Glassium] ${describeElement(this)} 的属性有误，已忽略：${problem}`, this)
    }
  }
}

/**
 * 没打开的 popover 不显示。浏览器默认样式里的 `[popover]:not(:popover-open) { display: none }` 是 UA 样式，
 * 组件自己的 `:host { display: … }` 是作者样式、压过它 —— 不补这一条，`<glass-card popover>` 没打开也显示着
 * （还画着 GPU 玻璃）。验证页的 overlay 一项多数出一块面板才发现。
 */
export const POPOVER_HOST_CSS = ':host([popover]:not(:popover-open)) { display: none; }'

/**
 * 所有实例共用的一张影子样式表。惰性创建：模块顶层 `new CSSStyleSheet()` 在 SSR 里会抛。
 * 每个组件的样式后面都补上 POPOVER_HOST_CSS。
 */
export function sharedSheet(cache: { sheet: CSSStyleSheet | null }, css: string): CSSStyleSheet {
  if (!cache.sheet) {
    cache.sheet = new CSSStyleSheet()
    cache.sheet.replaceSync(`${css}\n${POPOVER_HOST_CSS}`)
  }
  return cache.sheet
}
