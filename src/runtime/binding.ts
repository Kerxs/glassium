/**
 * 一个元素与 stage 之间的绑定：`<glass-*>` 组件与 runtime 的 `glass()` / `<div glass>` 走的是这同一条路。
 *
 * 管：等 stage（createGlassStage() 是异步的，元素可以早于它）、在 stage 上注册成面板、stage 重建时跟过去、
 * 把当前材质与按压处的光推给面板、玻璃生效时挂 `data-glassium-active`（CSS 兜底表面只在没有它时出现）。
 * 不管：材质从哪里来（属性、预设、交互调制）—— 由 source 给。
 */

import type { GlassMaterial } from '../core/material.ts'
import type { GlassPanel, PanelLight } from '../renderer/panels.ts'
import { currentStage, onStageChange, type GlassStage } from '../renderer/stage.ts'

/**
 * 玻璃生效时元素带上这个属性。CSS 兜底表面只在**没有**它的时候出现 ——
 * upgrade 之前、stage 还没建好、没有 GPU、高对比度模式，统统落在「没有它」这一边。
 */
export const ACTIVE_ATTRIBUTE = 'data-glassium-active'

/** 绑定要的材质与光：每次推给面板时现取。 */
export interface GlassSource {
  /** 当前要画的材质（已经过交互调制）。 */
  material(): GlassMaterial
  /** 按压处的光，没有是 null。 */
  light(): PanelLight | null
}

export class GlassBinding {
  /** 已连接的绑定。stage 出现、消失或状态变化时逐个同步。 */
  static readonly #live = new Set<GlassBinding>()
  static #subscribed = false

  readonly element: HTMLElement
  readonly #source: GlassSource
  #stage: GlassStage | null = null
  #panel: GlassPanel | null = null

  constructor(element: HTMLElement, source: GlassSource) {
    this.element = element
    this.#source = source
  }

  /** 面板（没有 stage 时是 null）。 */
  get panel(): GlassPanel | null {
    return this.#panel
  }

  get connected(): boolean {
    return GlassBinding.#live.has(this)
  }

  /** 开始：有 stage 就注册，没有就等。 */
  connect(): void {
    GlassBinding.#live.add(this)
    GlassBinding.#subscribe()
    this.#sync(currentStage())
  }

  /** 结束：注销面板、摘掉生效标记。 */
  disconnect(): void {
    GlassBinding.#live.delete(this)
    this.#detach()
    this.element.removeAttribute(ACTIVE_ATTRIBUTE)
  }

  /** 材质或交互状态变了：把当前材质与光推给面板。还没注册（没有 stage）时什么都不做。 */
  refresh(): void {
    this.#panel?.setMaterial(this.#source.material())
    this.#panel?.setLight(this.#source.light())
  }

  /** 只有光变了（比如按住拖动）：不重推材质 —— 推材质会让面板重新降级。 */
  refreshLight(): void {
    this.#panel?.setLight(this.#source.light())
  }

  static #subscribe(): void {
    if (GlassBinding.#subscribed) return
    GlassBinding.#subscribed = true
    onStageChange((stage) => {
      for (const b of GlassBinding.#live) b.#sync(stage)
    })
  }

  #sync(stage: GlassStage | null): void {
    if (stage !== this.#stage) {
      this.#detach()
      if (stage) {
        this.#stage = stage
        this.#panel = stage.register(this.element, this.#source.material())
        this.#panel.setLight(this.#source.light())
      }
    }
    this.element.toggleAttribute(ACTIVE_ATTRIBUTE, stage?.active === true)
  }

  #detach(): void {
    this.#panel?.unregister()
    this.#panel = null
    this.#stage = null
  }
}
