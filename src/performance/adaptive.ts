/**
 * 自适应质量：把帧监测（monitor.ts）、质量控制（quality.ts）、上次的结果（profile.ts）接到一个 stage 上 ——
 * stage 每圈报帧，攒满一个窗口就喂给控制器，q 变了就 `stage.setQuality(factorsFor(q))`。
 *
 * runtime 自己建的 stage 默认挂一个（configure({ quality: 'auto' })）；固定档（high / medium / low / 数）直接定死系数、
 * 不监测。自己调 createGlassStage 的页面不受影响（验证页、性能测试页都是满质量）。
 *
 * 后端不因为掉帧切换：掉帧只降质量；后端只在初始化失败、设备丢失重建失败时才换（stage 自己的逻辑）。
 */

import type { GlassStage, StageFrame } from '../renderer/stage.ts'
import { FrameMonitor } from './monitor.ts'
import { loadProfile, profileKey, saveProfile } from './profile.ts'
import type { QualityFactors } from '../renderer/quality.ts'
import { allocateQuality, factorsFor, QualityController, type FrameWindow } from './quality.ts'

/** 能单独降质量的一块玻璃（runtime 的 `glass()`；见 allocateQuality）。 */
export interface LocalQualityTarget {
  /** 成本估计（相对值）。 */
  cost(): number
  /** 这一块自己的系数（null 是不单独降）。 */
  setLocalQuality(factors: Partial<QualityFactors> | null): void
}

export interface AdaptiveOptions {
  /** 固定的质量值（0–1）：不监测、直接定死。null 是自适应。 */
  readonly fixed?: number | null
  /** 从 localStorage 读上次的结果、变了就存。 */
  readonly remember?: boolean
  /** profile 的键里的版本号。 */
  readonly version?: string
  /** 起步的质量（没有记下的结果时）。 */
  readonly initial?: number
  /** 自己订阅 stage.onFrame（默认 true）；测试时关掉、用 feed() 喂。 */
  readonly listen?: boolean
  /** 能单独降的玻璃（局部质量）。不给就只有整页的质量。 */
  readonly locals?: () => readonly LocalQualityTarget[]
}

export class AdaptiveQuality {
  readonly #stage: GlassStage
  readonly #monitor = new FrameMonitor()
  #controller: QualityController
  #fixed: number | null
  readonly #remember: boolean
  readonly #key: string | null
  #unsubscribe: (() => void) | null = null
  #lastWindow: FrameWindow | null = null
  readonly #locals: (() => readonly LocalQualityTarget[]) | null
  /** 上一次单独降了的那几块（下一次不在里面的要放回去）。 */
  #lowered = new Set<LocalQualityTarget>()
  #global = 1

  constructor(stage: GlassStage, options: AdaptiveOptions = {}) {
    this.#stage = stage
    this.#fixed = options.fixed ?? null
    this.#remember = options.remember ?? false
    this.#locals = options.locals ?? null
    const vp = stage.debug.stats().viewport
    this.#key =
      this.#remember && typeof window !== 'undefined'
        ? profileKey(options.version ?? '0', stage.backend, vp?.cssWidth ?? window.innerWidth, vp?.cssHeight ?? window.innerHeight, window.devicePixelRatio || 1)
        : null
    const saved = this.#key ? loadProfile(this.#key) : null
    // 有记下的结果就从它起步、不再探测
    this.#controller = new QualityController(saved?.q ?? options.initial ?? 1, !saved)
    if (options.listen ?? true) this.#unsubscribe = stage.onFrame((f) => this.feed(f))
    this.#apply()
  }

  /** 当前的质量值。 */
  get quality(): number {
    return this.#fixed ?? this.#controller.quality
  }

  get fixed(): number | null {
    return this.#fixed
  }

  get probing(): boolean {
    return this.#fixed === null && this.#controller.probing
  }

  /** 刷新间隔的估计（ms）。 */
  get budgetMs(): number {
    return this.#monitor.refreshMs
  }

  /** 整页那一档（局部质量先降贵的那几块时，它比 quality 高）。 */
  get globalQuality(): number {
    return this.#global
  }

  /** 正在单独降的块数（调试面板读）。 */
  get loweredCount(): number {
    return this.#lowered.size
  }

  /** 最近一个窗口（调试面板读）。 */
  get lastWindow(): FrameWindow | null {
    return this.#lastWindow
  }

  /** 定死质量（null 回到自适应）。 */
  setFixed(q: number | null): void {
    this.#fixed = q === null ? null : Math.min(1, Math.max(0, q))
    this.#apply()
  }

  /** 喂一圈（stage.onFrame 的回调；测试直接调）。 */
  feed(frame: StageFrame): void {
    if (this.#fixed !== null) return
    const w = this.#monitor.frame(frame.time, frame.rendered, frame.cpuMs)
    if (!w) return
    this.#lastWindow = w
    const before = this.#controller.quality
    const after = this.#controller.sample(w)
    // 质量没变也重分一次：玻璃挪了、多了少了，谁贵谁便宜会变
    if (after !== before || (after < 1 && this.#locals)) this.#apply()
    if (after !== before) {
      if (this.#key) {
        saveProfile(this.#key, { q: after, frameMs: this.#monitor.refreshMs, resolution: factorsFor(after).resolution, at: Date.now() })
      }
    }
  }

  dispose(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#stage.setQuality(null)
    for (const t of this.#lowered) t.setLocalQuality(null)
    this.#lowered.clear()
  }

  /** 按当前的 q 重新分配（整页 + 贵的那几块）。 */
  #apply(): void {
    const q = this.quality
    const targets = this.#locals && this.#fixed === null ? this.#locals() : []
    const alloc = allocateQuality(q, targets.map((t) => t.cost()))
    this.#global = alloc.global
    this.#stage.setQuality(alloc.global >= 1 ? null : factorsFor(alloc.global))
    const lowered = new Set<LocalQualityTarget>()
    targets.forEach((t, i) => {
      const lq = alloc.local[i]
      if (lq === null || lq === undefined) return
      const { resolution: _shared, ...rest } = factorsFor(lq)
      t.setLocalQuality(rest)
      lowered.add(t)
    })
    for (const t of this.#lowered) if (!lowered.has(t)) t.setLocalQuality(null)
    this.#lowered = lowered
  }
}
