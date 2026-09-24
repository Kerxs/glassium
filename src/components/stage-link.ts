/**
 * 组件与 stage 的连接：stage 出现、消失、换了、状态变了（active）时自动同步。
 *
 * 组件可以早于 stage upgrade（createGlassStage 要等 GPU 设备），stage 也可能被 dispose 再重建 ——
 * 组件在 stage 上注册的东西（玻璃面板、填充）要跟着 stage 走。`<glass-fill>`、`<glass-switch>`、
 * `<glass-slider>` 都用它；`GlassElement` 是同一个模式的早期写法（base.ts）。
 *
 * 宿主上的 `data-glassium-active` 由这里维护：玻璃真的在画时才有，CSS 兜底样式据此开关。
 */

import { currentStage, onStageChange, type GlassStage } from '../renderer/stage.ts'
import { ACTIVE_ATTRIBUTE } from './base.ts'

export class StageLink {
  /** 已连接的链接。stage 变化时逐个同步。 */
  static readonly #live = new Set<StageLink>()
  static #subscribed = false

  readonly #host: HTMLElement
  readonly #attach: (stage: GlassStage) => () => void
  #stage: GlassStage | null = null
  #release: (() => void) | null = null

  /**
   * @param attach 在 stage 上注册需要的东西，返回注销它们的函数。每换一个 stage 调一次。
   */
  constructor(host: HTMLElement, attach: (stage: GlassStage) => () => void) {
    this.#host = host
    this.#attach = attach
  }

  /** 当前连着的 stage（没有时为 null）。 */
  get stage(): GlassStage | null {
    return this.#stage
  }

  /** 宿主进文档时调（connectedCallback）。 */
  connect(): void {
    StageLink.#live.add(this)
    StageLink.#subscribe()
    this.#sync(currentStage())
  }

  /** 宿主离开文档时调（disconnectedCallback）。 */
  disconnect(): void {
    StageLink.#live.delete(this)
    this.#detach()
    this.#host.removeAttribute(ACTIVE_ATTRIBUTE)
  }

  static #subscribe(): void {
    if (StageLink.#subscribed) return
    StageLink.#subscribed = true
    onStageChange((stage) => {
      for (const link of StageLink.#live) link.#sync(stage)
    })
  }

  #sync(stage: GlassStage | null): void {
    if (stage !== this.#stage) {
      this.#detach()
      if (stage) {
        this.#stage = stage
        this.#release = this.#attach(stage)
      }
    }
    this.#host.toggleAttribute(ACTIVE_ATTRIBUTE, stage?.active === true)
  }

  #detach(): void {
    this.#release?.()
    this.#release = null
    this.#stage = null
  }
}
