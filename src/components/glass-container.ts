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
 * - `morph`：成员像水滴一样分出来、融回去（GlassEffectContainer 的第三项能力）。新加进来的成员从离它最近的
 *   成员边上、以一滴的大小出现，一边长大一边移到自己的位置 —— 离得近时 smin 把它和邻居连着，颈部拉长、
 *   断开；`dismiss(member)` 反过来缩回最近的成员再移除。动的是 `translate` 与 `scale`（玻璃跟得上）；
 *   成员自己别再写这两个属性。减少动效时直接出现、直接移除。
 */

import { DEFAULT_SMOOTHING_DP, type GlassGroup } from '../renderer/panels.ts'
import { currentStage, onStageChange, prefersReducedMotion, type GlassStage } from '../renderer/stage.ts'
import { describeElement } from '../renderer/layering.ts'
import { strictNumber } from './attributes.ts'
import { sharedSheet } from './base.ts'

const HTMLElementBase: typeof HTMLElement =
  typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement

const CSS = ':host { display: block; }'
const sheet = { sheet: null as CSSStyleSheet | null }

/** 算成员的选择器。新的玻璃组件要加进来。 */
const MEMBER_SELECTOR = 'glass-card, glass-button, glass-tab-bar'

/** 一滴的大小（相对成员自己）与变形的时长、缓动（略微过冲，像液体）。 */
export const MORPH_DROPLET = 0.2
export const MORPH_MS = 450
export const MORPH_EASING = 'cubic-bezier(0.3, 1.2, 0.5, 1)'

/**
 * 一滴从哪里出来：`from` 这块玻璃的边上离 `to` 的中心最近的那一点（`to` 的中心就在 `from` 里面时是那个中心）。
 * 返回让 `to` 的中心挪到那里要的平移（CSS 像素）。纯函数，矩形都是视口坐标。
 */
export function dropletOffset(
  from: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  to: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
): [number, number] {
  const cx = (to.left + to.right) / 2
  const cy = (to.top + to.bottom) / 2
  const px = Math.min(from.right, Math.max(from.left, cx))
  const py = Math.min(from.bottom, Math.max(from.top, cy))
  return [px - cx, py - cy]
}

/** 离 el 的中心最近的那一个（按中心距离）。 */
function nearest(el: Element, others: readonly Element[]): Element | null {
  const r = el.getBoundingClientRect()
  const cx = (r.left + r.right) / 2
  const cy = (r.top + r.bottom) / 2
  let best: Element | null = null
  let bestD = Infinity
  for (const o of others) {
    const q = o.getBoundingClientRect()
    const d = Math.hypot((q.left + q.right) / 2 - cx, (q.top + q.bottom) / 2 - cy)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
}

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
  /** 上一次刷新时的成员：多出来的就是新加进来的（morph 时让它们像水滴一样分出来）。 */
  #known = new Set<HTMLElement>()

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
    this.#known = new Set() // 再进文档时，已有的成员不算新加进来的
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
    const members = this.members
    const added = this.#known.size > 0 ? members.filter((m) => !this.#known.has(m)) : []
    const old = members.filter((m) => this.#known.has(m))
    this.#known = new Set(members)
    this.#group?.setMembers(members)
    if (added.length > 0 && old.length > 0 && this.hasAttribute('morph') && !prefersReducedMotion()) {
      for (const m of added) this.#emerge(m, old)
    }
  }

  /** 新成员从最近的老成员边上、以一滴的大小出现，长大、移到自己的位置。 */
  #emerge(member: HTMLElement, from: readonly HTMLElement[]): void {
    const source = nearest(member, from)
    if (!source) return
    const [dx, dy] = dropletOffset(source.getBoundingClientRect(), member.getBoundingClientRect())
    member.animate(
      [
        { translate: `${dx}px ${dy}px`, scale: `${MORPH_DROPLET}` },
        { translate: '0px 0px', scale: '1' }
      ],
      { duration: MORPH_MS, easing: MORPH_EASING }
    )
  }

  /**
   * 把一个成员融回离它最近的成员里，再把它从文档里拿掉。返回的 Promise 在拿掉之后 resolve。
   * 没有 morph 属性、没有别的成员、减少动效时直接拿掉。
   */
  dismiss(member: HTMLElement): Promise<void> {
    const others = this.members.filter((m) => m !== member)
    const target = this.hasAttribute('morph') && !prefersReducedMotion() ? nearest(member, others) : null
    if (!target || !member.isConnected) {
      member.remove()
      return Promise.resolve()
    }
    const [dx, dy] = dropletOffset(target.getBoundingClientRect(), member.getBoundingClientRect())
    const animation = member.animate(
      [
        { translate: '0px 0px', scale: '1' },
        { translate: `${dx}px ${dy}px`, scale: `${MORPH_DROPLET}` }
      ],
      { duration: MORPH_MS, easing: 'cubic-bezier(0.5, 0, 0.7, 0.4)', fill: 'forwards' }
    )
    return animation.finished.then(
      () => {
        member.remove()
        animation.cancel()
      },
      () => member.remove()
    )
  }
}
