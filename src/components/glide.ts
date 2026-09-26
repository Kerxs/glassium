/**
 * 切换时的飞行：选中块（气泡、开关的旋钮）先原地鼓起成透镜（抬起），再从旧位置飞到新位置，落地后缩回。
 *
 * 这里只管位置与宽度随时间怎么走：抬起的那一小段原地不动，之后按 ease-in-out 从旧值走到新值（起飞加速、
 * 中段最快、落地减速）—— 组件每帧把位置喂给果冻（jelly.ts），速度大的中段拉得最长，起落时圆回来。
 * 鼓起与缩回是组件的事（按下的材质与 scale），在 start 之前与 onDone 里做。减少动效时直接落到终点。
 */

import { prefersReducedMotion } from '../renderer/stage.ts'

/** 抬起：开始飞之前原地停这么久（ms），让透镜先鼓起来。 */
export const GLIDE_LIFT_MS = 70

/** 飞多久（ms）：远的久一点，300–560。 */
export function glideDuration(distance: number): number {
  return Math.min(560, Math.max(300, 280 + 0.5 * Math.abs(distance)))
}

/** ease-in-out（三次）：0 → 0、1 → 1，两头速度为 0。 */
export function glideEase(t: number): number {
  const u = Math.min(Math.max(t, 0), 1)
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
}

/** 位置与宽度（CSS 像素）。 */
export interface GlideBox {
  readonly x: number
  readonly w: number
}

/** 起飞之后 elapsed（ms）时的位置与宽度。 */
export function glideAt(from: GlideBox, to: GlideBox, elapsed: number): GlideBox {
  const p = glideEase((elapsed - GLIDE_LIFT_MS) / glideDuration(to.x - from.x))
  return { x: from.x + (to.x - from.x) * p, w: from.w + (to.w - from.w) * p }
}

export class Glide {
  readonly #onFrame: (box: GlideBox, now: number) => void
  readonly #onDone: () => void
  #from: GlideBox = { x: 0, w: 0 }
  #to: GlideBox = { x: 0, w: 0 }
  #current: GlideBox = { x: 0, w: 0 }
  #start = 0
  #raf = 0

  /**
   * @param onFrame 每帧的位置与宽度，与这一帧的时间（ms，喂给果冻）
   * @param onDone 落地（没被 cancel 时）
   */
  constructor(onFrame: (box: GlideBox, now: number) => void, onDone: () => void) {
    this.#onFrame = onFrame
    this.#onDone = onDone
  }

  get active(): boolean {
    return this.#raf !== 0
  }

  /** 从 from 飞到 to。正在飞时从当前位置接着飞。 */
  start(from: GlideBox, to: GlideBox): void {
    const origin = this.active ? this.#current : from
    this.stop()
    this.#from = origin
    this.#to = to
    this.#current = origin
    if (prefersReducedMotion()) {
      this.#current = to
      this.#onFrame(to, performance.now())
      this.#onDone()
      return
    }
    this.#start = performance.now()
    this.#onFrame(origin, this.#start)
    this.#raf = requestAnimationFrame(this.#tick)
  }

  /** 停在当前位置，不落地（不调 onDone）。返回停下时的位置；没在飞时是 null。 */
  cancel(): GlideBox | null {
    if (!this.active) return null
    this.stop()
    return this.#current
  }

  stop(): void {
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf)
    this.#raf = 0
  }

  #tick = (now: number): void => {
    const elapsed = now - this.#start
    const done = elapsed >= GLIDE_LIFT_MS + glideDuration(this.#to.x - this.#from.x)
    this.#current = done ? this.#to : glideAt(this.#from, this.#to, elapsed)
    this.#onFrame(this.#current, now)
    if (done) {
      this.#raf = 0
      this.#onDone()
      return
    }
    this.#raf = requestAnimationFrame(this.#tick)
  }
}
