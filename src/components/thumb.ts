/**
 * 旋钮的玻璃：`<glass-switch>` 与 `<glass-slider>` 共用。
 *
 * 平时是白色、几乎不透明的玻璃（Apple 的开关与滑块旋钮平时就是白的）；按下时变成透明的透镜 ——
 * 折射带深、位移强、带一点色散，透过它看得见底下的轨道（轨道是填充，在场景里）。
 * 按压能量 0–1 在两头之间插值，由组件缓动。
 */

import type { GlassMaterial } from '../core/material.ts'
import { prefersReducedMotion } from '../renderer/stage.ts'
import { approach, SETTLE_EPSILON, TAU_MS } from './motion.ts'

/** 旋钮材质里随按压变化的那几项。 */
export interface ThumbParams {
  readonly blur: number
  readonly refraction: number
  readonly distortion: number
  readonly saturation: number
  readonly highlight: number
  readonly dispersion: number
  readonly shadow: number
  /** 白色 tint 的 alpha：静止时几乎不透明（白旋钮），按下时几乎透明（透镜）。 */
  readonly whiteness: number
}

/** 静止：白色、几乎不透明的玻璃，带一圈亮边和影子。 */
export const THUMB_REST: ThumbParams = {
  blur: 3,
  refraction: 0.25,
  distortion: 0.2,
  saturation: 1,
  highlight: 0.5,
  dispersion: 0,
  shadow: 0.35,
  whiteness: 0.96
}

/** 按下：透明的透镜 —— 折射带深、位移强、带一点色散，透过它看得见底下的轨道。 */
export const THUMB_PRESSED: ThumbParams = {
  blur: 0,
  refraction: 0.7,
  distortion: 0.4,
  saturation: 1.3,
  highlight: 1,
  dispersion: 0.2,
  shadow: 0.2,
  whiteness: 0.04
}

/** 按压能量 0–1 时旋钮的材质：各项在静止与按下之间线性插值。 */
export function thumbMaterial(energy: number): GlassMaterial {
  const e = Math.min(Math.max(energy, 0), 1)
  // a·(1 − e) + b·e 而不是 a + (b − a)·e：两头都精确落在端点上（后者在 e = 1 时带出末位误差）
  const mix = (a: number, b: number): number => a * (1 - e) + b * e
  const r = THUMB_REST
  const p = THUMB_PRESSED
  return {
    cornerRadius: '1frac',
    blur: mix(r.blur, p.blur),
    refraction: mix(r.refraction, p.refraction),
    distortion: mix(r.distortion, p.distortion),
    saturation: mix(r.saturation, p.saturation),
    highlight: mix(r.highlight, p.highlight),
    dispersion: mix(r.dispersion, p.dispersion),
    shadow: mix(r.shadow, p.shadow),
    tint: `rgba(255, 255, 255, ${mix(r.whiteness, p.whiteness)})`,
    adaptive: 0,
    depthEffect: 1
  }
}

/**
 * 按压能量的缓动：指数趋近（motion.ts 的 approach，与 `<glass-button>` 同一个时间常数），
 * 减少动效时直接落到终点。每走一步回调一次新的能量。
 */
export class PressTween {
  readonly #onChange: (energy: number) => void
  #energy = 0
  #target = 0
  #raf = 0
  #lastTick = 0

  constructor(onChange: (energy: number) => void) {
    this.#onChange = onChange
  }

  get energy(): number {
    return this.#energy
  }

  /** 按下（目标 1）或松开（目标 0）。 */
  press(pressed: boolean): void {
    this.#target = pressed ? 1 : 0
    if (prefersReducedMotion()) {
      this.stop()
      if (this.#energy !== this.#target) {
        this.#energy = this.#target
        this.#onChange(this.#energy)
      }
      return
    }
    if (this.#energy !== this.#target && this.#raf === 0) {
      this.#lastTick = performance.now()
      this.#raf = requestAnimationFrame(this.#tick)
    }
  }

  /** 停在当前能量（元素离开文档时）。 */
  stop(): void {
    if (this.#raf !== 0) cancelAnimationFrame(this.#raf)
    this.#raf = 0
  }

  /** 回到静止，不动画、不回调（元素离开文档时：下次进来从头开始）。 */
  reset(): void {
    this.stop()
    this.#energy = 0
    this.#target = 0
  }

  #tick = (now: number): void => {
    const dt = now - this.#lastTick
    this.#lastTick = now
    this.#energy = approach(this.#energy, this.#target, dt, TAU_MS)
    if (Math.abs(this.#energy - this.#target) < SETTLE_EPSILON) this.#energy = this.#target
    this.#onChange(this.#energy)
    this.#raf = this.#energy === this.#target ? 0 : requestAnimationFrame(this.#tick)
  }
}
