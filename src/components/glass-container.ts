/**
 * `<glass-container>` —— 把里面的几块玻璃连成一个连续的形状。
 *
 * ```html
 * <glass-container smoothing="20">
 *   <glass-button>左</glass-button>
 *   <glass-button>右</glass-button>
 * </glass-container>
 * ```
 *
 * 这是 Apple GlassEffectContainer 的对应物，也是上游 issue #104 开着的缺口。
 * backdrop-filter 结构上做不到：每个元素各自过滤自己背后的那块，没有办法让两块玻璃
 * 共用一个形状。这里整组只画一次 draw，片元里用 smin 把成员的 SDF 连起来（见 core/merge.ts）。
 *
 * - 成员是容器里的 `<glass-card>` / `<glass-button>`，**任意层级**都算（按钮外面套一层
 *   flex 布局的 div 很常见）；嵌套的容器各管各的，一块玻璃归离它最近的那个容器。
 * - 成员的材质照旧各自生效，颈部按 smin 的权重在两边之间过渡 —— 悬停一个按钮，
 *   它提亮的高光会沿颈部渐变到另一个按钮上。
 * - 容器自己没有玻璃，只负责分组。
 * - `smoothing`（dp）：缝隙小于它的一半时两块玻璃连成一片；0 是硬并集。默认 20。
 * - 最多合并 4 块，多出来的单独绘制并警告一次。
 */

import { DEFAULT_SMOOTHING_DP, type GlassGroup } from '../renderer/panels.ts'
import { currentStage, onStageChange, type GlassStage } from '../renderer/stage.ts'
import { describeElement } from '../renderer/layering.ts'
import { strictNumber } from './attributes.ts'
import { sharedSheet } from './base.ts'

const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement

const CSS = ':host { display: block; }'
const sheet = { sheet: null as CSSStyleSheet | null }

/** 算成员的选择器。新的玻璃组件要加进来。 */
const MEMBER_SELECTOR = 'glass-card, glass-button'

export class GlassContainer extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return ['smoothing']
  }

  #stage: GlassStage | null = null
  #group: GlassGroup | null = null
  #unsubscribe: (() => void) | null = null
  #observer: MutationObserver | null = null
  #refreshQueued = false
  #warnedSmoothing: string | null = null

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sharedSheet(sheet, CSS)]
    root.append(document.createElement('slot'))
  }

  /** smin 的平滑半径，dp。写错的属性值报一次并按默认值处理。 */
  get smoothing(): number {
    const raw = this.getAttribute('smoothing')
    if (raw === null) return DEFAULT_SMOOTHING_DP
    const n = strictNumber(raw)
    if (n === null || n < 0) {
      if (this.#warnedSmoothing !== raw) {
        this.#warnedSmoothing = raw
        console.warn(
          `[Glassium] ${describeElement(this)} 的 smoothing="${raw}" 不是非负数（单位 dp，不要带 px），` +
            `按默认值 ${DEFAULT_SMOOTHING_DP} 处理`,
          this
        )
      }
      return DEFAULT_SMOOTHING_DP
    }
    return n
  }

  set smoothing(dp: number) {
    this.setAttribute('smoothing', String(dp))
  }

  /** 当前的成员：离它最近的容器是自己的那些玻璃组件，按文档顺序。 */
  get members(): HTMLElement[] {
    return [...this.querySelectorAll<HTMLElement>(MEMBER_SELECTOR)].filter(
      (el) => el.closest('glass-container') === this
    )
  }

  connectedCallback(): void {
    this.#unsubscribe = onStageChange((stage) => this.#sync(stage))
    // 成员增删（包括更深层级里的）要跟上。属性变化不影响分组，不监听。
    this.#observer = new MutationObserver(() => this.#queueRefresh())
    this.#observer.observe(this, { childList: true, subtree: true })
    this.#sync(currentStage())
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#observer?.disconnect()
    this.#observer = null
    this.#group?.dissolve()
    this.#group = null
    this.#stage = null
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'smoothing' || oldValue === newValue) return
    this.#group?.setSmoothing(this.smoothing)
  }

  #sync(stage: GlassStage | null): void {
    if (stage === this.#stage) return
    this.#group?.dissolve()
    this.#group = null
    this.#stage = stage
    if (!stage) return
    this.#group = stage.group({ smoothing: this.smoothing })
    this.#refresh()
  }

  /** 同一轮里的多次 DOM 变化只刷新一次。 */
  #queueRefresh(): void {
    if (this.#refreshQueued) return
    this.#refreshQueued = true
    queueMicrotask(() => {
      this.#refreshQueued = false
      this.#refresh()
    })
  }

  #refresh(): void {
    this.#group?.setMembers(this.members)
  }
}
