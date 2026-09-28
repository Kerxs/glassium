/**
 * 帧监测：stage 的帧循环每圈报一次（stage.onFrame），这里攒成半秒一个的窗口（quality.ts 的 FrameWindow）。
 *
 * - 刷新间隔：最近一段帧间隔的低分位数（p20）——60 / 120 / 144 / 240Hz 都能认出来；帧预算就是它。
 * - 掉帧：帧间隔超过刷新间隔的 1.5 倍。
 * - 不算的：两帧之间隔了 250ms 以上（页面隐藏、面板被节流、循环停过）—— 那不是渲染慢；没画的圈（静止时跳过）
 *   只推进时间、不进窗口。
 */

import type { FrameWindow } from './quality.ts'

export const WINDOW_MS = 500
const GAP_MS = 250
const HISTORY = 120

export class FrameMonitor {
  #last = -1
  #windowStart = -1
  #frames = 0
  #drops = 0
  #cpu = 0
  #gpu = 0
  #gpuFrames = 0
  readonly #intervals: number[] = []
  #refresh = 1000 / 60

  /** 刷新间隔的估计（ms）。 */
  get refreshMs(): number {
    return this.#refresh
  }

  /** 一圈。gpuMs 是后端量到的 GPU 时间（量不了是 null）。返回攒满的窗口（没满是 null）。 */
  frame(time: number, rendered: boolean, cpuMs: number, gpuMs: number | null = null): FrameWindow | null {
    const dt = this.#last < 0 ? 0 : time - this.#last
    this.#last = time
    if (dt > GAP_MS) {
      // 断过：从头攒
      this.#windowStart = time
      this.#frames = 0
      this.#drops = 0
      this.#cpu = 0
      this.#gpu = 0
      this.#gpuFrames = 0
      return null
    }
    if (dt > 0) {
      this.#intervals.push(dt)
      if (this.#intervals.length > HISTORY) this.#intervals.shift()
      this.#refresh = lowPercentile(this.#intervals, 0.2)
    }
    if (this.#windowStart < 0) this.#windowStart = time
    if (rendered && dt > 0) {
      this.#frames++
      this.#cpu += cpuMs
      if (gpuMs !== null && Number.isFinite(gpuMs)) {
        this.#gpu += gpuMs
        this.#gpuFrames++
      }
      if (dt > this.#refresh * 1.5) this.#drops++
    }
    if (time - this.#windowStart < WINDOW_MS) return null
    const w: FrameWindow = {
      frames: this.#frames,
      dropRatio: this.#frames > 0 ? this.#drops / this.#frames : 0,
      cpuRatio: this.#frames > 0 ? this.#cpu / this.#frames / this.#refresh : 0,
      gpuRatio: this.#gpuFrames > 0 ? this.#gpu / this.#gpuFrames / this.#refresh : null
    }
    this.#windowStart = time
    this.#frames = 0
    this.#drops = 0
    this.#cpu = 0
    this.#gpu = 0
    this.#gpuFrames = 0
    return w
  }
}

function lowPercentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}
