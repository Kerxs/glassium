/**
 * 自适应质量的控制：一个质量值 q ∈ [QUALITY_MIN, 1]，按实测的帧窗口升降；q 再按优先级映射成各项效果的系数。
 *
 * 优先级（先降的在前）：色散 → 高级折射（depthEffect）与果冻 → 场景分辨率 → 投影 → 折射 → 模糊。
 * 基础的透明、亮边、底色不动 —— 降到底仍然「像 Glassium」。
 *
 * 滞回：
 * - 连续 DEGRADE_WINDOWS 个窗口超预算 → 降 DEGRADE_STEP（快）；
 * - 连续 RECOVER_WINDOWS 个窗口都很宽裕（掉帧少、CPU 在预算的 COMFORT 以内）→ 升 RECOVER_STEP（慢）；
 * - 升的条件比降的严，中间那一段什么都不做 —— 不会来回抖。
 * 起步（probe）：前 PROBE_FRAMES 帧就是真实的玻璃管线，掉帧多就直接从 PROBE_FALLBACK 起步，不跑单独的基准。
 */

import type { QualityFactors } from '../renderer/quality.ts'

export const QUALITY_MIN = 0.35
export const DEGRADE_WINDOWS = 3
export const RECOVER_WINDOWS = 8
export const DEGRADE_STEP = 0.1
export const RECOVER_STEP = 0.05
export const PROBE_FRAMES = 30
export const PROBE_FALLBACK = 0.7
/** 超预算：掉帧比例超过它，或者 CPU 超过预算的 OVER_CPU。 */
export const OVER_DROPS = 0.2
export const OVER_CPU = 0.6
/** 宽裕：掉帧比例低于它，并且 CPU 在预算的 COMFORT 以内。 */
export const COMFORT_DROPS = 0.02
export const COMFORT = 0.35
/**
 * GPU 时间（timestamp-query，有的时候）：超过预算的 OVER_GPU 算超预算；宽裕还要求在 COMFORT_GPU 以内。
 * GPU 与 CPU 并行，一帧的 GPU 时间可以比 CPU 的长；到了预算的七成五，再多一点就要掉帧了。
 */
export const OVER_GPU = 0.75
export const COMFORT_GPU = 0.45

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
/** q 在 [lo, hi] 之间时从 0 线性走到 1。 */
const ramp = (q: number, lo: number, hi: number): number => clamp01((q - lo) / (hi - lo))

/** q → 各项系数。q = 1 时逐项正好是 1（与不开自适应逐位相同）。 */
export function factorsFor(q: number): QualityFactors {
  const x = Math.min(1, Math.max(QUALITY_MIN, q))
  return {
    dispersion: ramp(x, 0.75, 1),
    depth: ramp(x, 0.6, 0.8),
    resolution: 0.6 + 0.4 * ramp(x, QUALITY_MIN, 0.75),
    shadow: 0.5 + 0.5 * ramp(x, 0.45, 0.7),
    refraction: 0.6 + 0.4 * ramp(x, QUALITY_MIN, 0.6),
    blur: 0.7 + 0.3 * ramp(x, QUALITY_MIN, 0.5)
  }
}

/** 一块玻璃占总成本的比例到这么多算「贵的」（页面上至少两块时）。 */
export const HEAVY_SHARE = 0.25
/** q 从 1 降到 1 − LOCAL_SPAN 的这一段只降贵的那几块，整页不动。 */
export const LOCAL_SPAN = 0.3

/** 分配的结果：整页的质量，与每一块自己的质量（null 是不单独降）。 */
export interface QualityAllocation {
  readonly global: number
  readonly local: readonly (number | null)[]
}

/**
 * 局部质量：整体要降到 q 时先降贵的那几块（成本占总数 ≥ HEAVY_SHARE），不拖累整页 ——
 * q 从 1 到 0.7，贵的从 1 降到 QUALITY_MIN，别的不动；再往下整页从 1 降到 QUALITY_MIN（贵的在它上面再乘自己的那一档）。
 * 没有贵的（成本差不多、或者只有一块）时就是原来的整页降。costs 是每块的成本估计（面积 × 模糊 × 色散，见 runtime）。
 */
export function allocateQuality(q: number, costs: readonly number[]): QualityAllocation {
  const none = costs.map(() => null)
  if (!(q < 1)) return { global: 1, local: none }
  const total = costs.reduce((a, c) => a + Math.max(0, c), 0)
  const heavy = costs.length >= 2 && total > 0 ? costs.map((c) => c / total >= HEAVY_SHARE) : costs.map(() => false)
  if (!heavy.some(Boolean)) return { global: q, local: none }
  const t = clamp01((1 - q) / LOCAL_SPAN)
  const heavyQ = 1 - t * (1 - QUALITY_MIN)
  const floor = 1 - LOCAL_SPAN
  const global = q >= floor ? 1 : QUALITY_MIN + ((Math.max(q, QUALITY_MIN) - QUALITY_MIN) * (1 - QUALITY_MIN)) / (floor - QUALITY_MIN)
  return { global, local: heavy.map((h) => (h ? heavyQ : null)) }
}

/** 果冻的系数（组件的拉长上限乘它）：与高级折射一起降。 */
export function jellyFactor(q: number): number {
  return ramp(Math.min(1, Math.max(QUALITY_MIN, q)), 0.6, 0.8)
}

/** 一个统计窗口（monitor.ts 给）。 */
export interface FrameWindow {
  /** 窗口里画了的帧数。 */
  readonly frames: number
  /** 掉帧的比例（帧间隔超过刷新间隔的 1.5 倍）。 */
  readonly dropRatio: number
  /** 平均 CPU 时间 ÷ 帧预算。 */
  readonly cpuRatio: number
  /** 平均 GPU 时间 ÷ 帧预算（后端量不了是 null / 不写）。 */
  readonly gpuRatio?: number | null
}

export class QualityController {
  #q: number
  #over = 0
  #comfort = 0
  #probing: boolean
  #probeFrames = 0
  #probeDrops = 0

  constructor(initial = 1, probe = true) {
    this.#q = Math.min(1, Math.max(QUALITY_MIN, initial))
    this.#probing = probe
  }

  get quality(): number {
    return this.#q
  }

  get probing(): boolean {
    return this.#probing
  }

  /** 喂一个窗口，返回新的 q（变了才有意义，调用方自己比）。 */
  sample(w: FrameWindow): number {
    if (w.frames <= 0) return this.#q
    if (this.#probing) {
      this.#probeFrames += w.frames
      this.#probeDrops += w.dropRatio * w.frames
      if (this.#probeFrames >= PROBE_FRAMES) {
        this.#probing = false
        if (this.#probeDrops / this.#probeFrames > OVER_DROPS * 1.5) this.#q = Math.min(this.#q, PROBE_FALLBACK)
      }
      return this.#q
    }
    const gpu = w.gpuRatio ?? null
    const over = w.dropRatio > OVER_DROPS || w.cpuRatio > OVER_CPU || (gpu !== null && gpu > OVER_GPU)
    const comfortable = w.dropRatio < COMFORT_DROPS && w.cpuRatio < COMFORT && (gpu === null || gpu < COMFORT_GPU)
    if (over) {
      this.#comfort = 0
      if (++this.#over >= DEGRADE_WINDOWS) {
        this.#over = 0
        this.#q = Math.max(QUALITY_MIN, round2(this.#q - DEGRADE_STEP))
      }
    } else if (comfortable) {
      this.#over = 0
      if (++this.#comfort >= RECOVER_WINDOWS) {
        this.#comfort = 0
        this.#q = Math.min(1, round2(this.#q + RECOVER_STEP))
      }
    } else {
      // 中间那一段：不升不降，两边的计数都清掉
      this.#over = 0
      this.#comfort = 0
    }
    return this.#q
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}
