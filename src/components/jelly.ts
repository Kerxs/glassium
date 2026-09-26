/**
 * 拖动时的果冻：透镜顺着拖动的速度横向拉长、纵向收一点，停下来平滑地回到原样 —— **不晃**（iOS 27 的样子：
 * 拖得快就扁长，手一停就慢慢圆回去，没有来回的弹跳）。
 *
 * 速度先做指数平滑（手指的采样有抖动），形变再一阶趋近按速度算出的目标（motion.ts 的 approach）。一阶趋近
 * 只会单调地走向目标，所以回到原样的路上不会过冲。结果交给回调（组件把它写成旋钮与跟随者上的
 * `--_jx` / `--_jy`，CSS 的 scale 乘上它们）。减少动效时不动。
 */

import { prefersReducedMotion } from '../renderer/stage.ts'
import { approach } from './motion.ts'

/** 横向最多拉长这么多（+22%）；每 CSS px/ms 的速度拉长这么多。 */
export const JELLY_MAX = 0.22
export const JELLY_GAIN = 0.2
/** 速度的平滑、形变的趋近，时间常数（ms）。 */
export const JELLY_VELOCITY_TAU = 50
export const JELLY_SHAPE_TAU = 80
/** 形变小于它、速度也几乎为零时停下，落回 (1, 1)。 */
const SETTLE = 1e-3

/** 拉长量（sx − 1）→ 横向、纵向的缩放：纵向按 1/√sx 收一点（看起来大致保面积）。 */
export function jellyScale(stretch: number): readonly [number, number] {
  const sx = 1 + Math.max(0, stretch)
  return [sx, 1 / Math.sqrt(sx)]
}

/** 速度（CSS px/ms）对应的拉长量。 */
export function jellyTarget(velocity: number): number {
  return Math.min(Math.abs(velocity) * JELLY_GAIN, JELLY_MAX)
}

export class Jelly {
  readonly #apply: (sx: number, sy: number) => void
  #velocity = 0
  #stretch = 0
  #lastX = 0
  #lastT = -1
  #raf = 0
  #tickT = 0

  /** @param apply 写出这一刻的横向、纵向缩放（静止时是 1, 1） */
  constructor(apply: (sx: number, sy: number) => void) {
    this.#apply = apply
  }

  /** 拖动中的一次移动：x 是 CSS 像素，t 是毫秒（事件的 timeStamp）。 */
  move(x: number, t: number): void {
    if (prefersReducedMotion()) return
    if (this.#lastT >= 0 && t > this.#lastT) {
      const dt = t - this.#lastT
      this.#velocity = approach(this.#velocity, (x - this.#lastX) / dt, dt, JELLY_VELOCITY_TAU)
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
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf)
    this.#raf = 0
    this.#velocity = 0
    this.#stretch = 0
    this.#lastT = -1
    this.#apply(1, 1)
  }

  #start(): void {
    if (this.#raf !== 0) return
    this.#tickT = performance.now()
    this.#raf = requestAnimationFrame(this.#tick)
  }

  #tick = (now: number): void => {
    const dt = Math.max(0, now - this.#tickT)
    this.#tickT = now
    // 手没在动（松手，或者按着停住了）：速度往 0 走
    if (this.#lastT < 0 || now - this.#lastT > 2 * JELLY_VELOCITY_TAU) {
      this.#velocity = approach(this.#velocity, 0, dt, JELLY_VELOCITY_TAU)
    }
    this.#stretch = approach(this.#stretch, jellyTarget(this.#velocity), dt, JELLY_SHAPE_TAU)
    if (this.#stretch < SETTLE && Math.abs(this.#velocity) < SETTLE) {
      this.#stretch = 0
      this.#velocity = 0
      this.#raf = 0
      this.#apply(1, 1)
      return
    }
    const [sx, sy] = jellyScale(this.#stretch)
    this.#apply(sx, sy)
    this.#raf = requestAnimationFrame(this.#tick)
  }
}
