/**
 * 移动时的果冻：透镜顺着移动的速度横向拉长、纵向收一点，停下来平滑地回到原样 —— **不晃**（iOS 27 的样子：
 * 拖得快就扁长，手一停就慢慢圆回去，没有来回的弹跳）。拖动时喂手指的位置，点击切换时喂飞行的位置（glide.ts）。
 *
 * 速度先做指数平滑（手指的采样有抖动），形变再一阶趋近按速度算出的目标（motion.ts 的 approach）。一阶趋近
 * 只会单调地走向目标，所以回到原样的路上不会过冲。结果交给回调（组件把它写成旋钮与跟随者上的
 * `--_jx` / `--_jy`，CSS 的 scale 乘上它们）。减少动效时不动。
 */

import { prefersReducedMotion } from '../renderer/stage.ts'
import { approach } from './motion.ts'
import { cancelFrame, nextFrame } from '../animation/timeline.ts'

/**
 * 横向最多拉长这么多（+45%）；速度到 JELLY_V0（CSS px/ms）时拉长到上限的 63%。拉长量随速度平滑地饱和：
 * 慢拖只长一点（0.3 px/ms ≈ +14%），快甩接近上限 —— 不像线性再封顶那样一般的拖动全都顶在上限上、看不出快慢。
 */
export const JELLY_MAX = 0.45
export const JELLY_V0 = 0.8
/** 速度的平滑、形变的趋近，时间常数（ms）。 */
export const JELLY_VELOCITY_TAU = 50
export const JELLY_SHAPE_TAU = 80
/** 纵向跟着收：sy = sx^−JELLY_SQUASH（0.5 是保面积，大一点压扁得更明显）。 */
export const JELLY_SQUASH = 0.7

/** 一次移动的响应：速度的平滑与形变的趋近，时间常数（ms）。 */
export interface JellyResponse {
  readonly velocityTau: number
  readonly shapeTau: number
  /** 速度乘几倍再算拉长（默认 1）。行程很短的旋钮（开关）飞得慢，放大一点才看得出果冻。 */
  readonly velocityScale?: number
}

/** 手指拖动：采样有抖动，速度平滑一下，形变跟得柔一点。 */
export const DRAG_JELLY: JellyResponse = { velocityTau: JELLY_VELOCITY_TAU, shapeTau: JELLY_SHAPE_TAU }
/**
 * 切换时的飞行（glide.ts）：位置是算出来的、没有抖动，速度不平滑；形变跟得紧 —— 拉得最长的时候在中段，
 * 不拖到落地。
 */
export const FLY_JELLY: JellyResponse = { velocityTau: 0, shapeTau: 35 }
/** 形变小于它、速度也几乎为零时停下，落回 (1, 1)。 */
const SETTLE = 1e-3

/** 拉长量（sx − 1）→ 横向、纵向的缩放：纵向按 sx^−JELLY_SQUASH 收（比保面积再扁一点，拉长压扁看得清）。 */
export function jellyScale(stretch: number): readonly [number, number] {
  const sx = 1 + Math.max(0, stretch)
  return [sx, Math.pow(sx, -JELLY_SQUASH)]
}

/** 速度（CSS px/ms）对应的拉长量：JELLY_MAX·(1 − e^(−|v| / JELLY_V0))。 */
export function jellyTarget(velocity: number): number {
  return JELLY_MAX * (1 - Math.exp(-Math.abs(velocity) / JELLY_V0))
}

export class Jelly {
  readonly #apply: (sx: number, sy: number) => void
  #velocity = 0
  #stretch = 0
  #lastX = 0
  #lastT = -1
  #raf = 0
  #tickT = 0
  #shapeTau = JELLY_SHAPE_TAU

  /** @param apply 写出这一刻的横向、纵向缩放（静止时是 1, 1） */
  constructor(apply: (sx: number, sy: number) => void) {
    this.#apply = apply
  }

  /**
   * 一次移动：x 是 CSS 像素，t 是毫秒（事件的 timeStamp，或者飞行那一帧的时间）。response 是速度的平滑与形变的趋近：
   * 拖动用 DRAG_JELLY（默认），飞行用 FLY_JELLY。松开之后按最后一次的 shapeTau 回落。
   */
  move(x: number, t: number, response: JellyResponse = DRAG_JELLY): void {
    if (prefersReducedMotion()) return
    this.#shapeTau = response.shapeTau
    if (this.#lastT >= 0 && t > this.#lastT) {
      const dt = t - this.#lastT
      const v = ((x - this.#lastX) / dt) * (response.velocityScale ?? 1)
      this.#velocity = approach(this.#velocity, v, dt, response.velocityTau)
    }
    this.#lastX = x
    this.#lastT = t
    this.#start()
  }

  /** 松手：不再有新的移动，速度与形变自己回落。 */
  release(): void {
    this.#lastT = -1
  }

  /** 立刻回到原样、停掉（离开文档时）。 */
  reset(): void {
    if (this.#raf !== 0) cancelFrame(this.#raf)
    this.#raf = 0
    this.#velocity = 0
    this.#stretch = 0
    this.#lastT = -1
    this.#apply(1, 1)
  }

  #start(): void {
    if (this.#raf !== 0) return
    this.#tickT = performance.now()
    this.#raf = nextFrame(this.#tick)
  }

  #tick = (now: number): void => {
    const dt = Math.max(0, now - this.#tickT)
    this.#tickT = now
    // 手没在动（松手，或者按着停住了）：速度往 0 走
    if (this.#lastT < 0 || now - this.#lastT > 2 * JELLY_VELOCITY_TAU) {
      this.#velocity = approach(this.#velocity, 0, dt, JELLY_VELOCITY_TAU)
    }
    this.#stretch = approach(this.#stretch, jellyTarget(this.#velocity), dt, this.#shapeTau)
    if (this.#stretch < SETTLE && Math.abs(this.#velocity) < SETTLE) {
      this.#stretch = 0
      this.#velocity = 0
      this.#raf = 0
      this.#apply(1, 1)
      return
    }
    const [sx, sy] = jellyScale(this.#stretch)
    this.#apply(sx, sy)
    this.#raf = nextFrame(this.#tick)
  }
}
