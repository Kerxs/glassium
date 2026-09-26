/**
 * 旋钮的玻璃：`<glass-switch>`、`<glass-slider>`、`<glass-segmented>` 共用。
 *
 * 平时是白色、几乎不透明的玻璃（Apple 的开关与滑块旋钮平时就是白的）；按下时变成透明的透镜 ——
 * 边缘位移强、带一点色散，里面上暗下亮（体光），透过它看得见底下的轨道（轨道是填充，在场景里）。
 * 分段控件的选中块按下时还把底下的字放大（SEGMENT_THUMB_PRESSED）；滑块的不放大 —— 截图上旋钮里的轨道
 * 与外面一样粗。按压能量 0–1 在两头之间插值，由组件缓动。
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
  /** 白色 tint 的 alpha：静止时几乎不透明（白旋钮），按下时一层薄白（透镜，但体还是亮的）。 */
  readonly whiteness: number
  /** 放大：按下时底下的文字被放大（iOS 26 拖动分段控件的选中块时就是这样）。 */
  readonly magnify: number
  /** 体光：按下时里面上暗下亮（见 GlassMaterial.bodyLight）。 */
  readonly bodyLight: number
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
  whiteness: 0.96,
  magnify: 0,
  bodyLight: 0
}

/**
 * 按下（开关、滑块）：透镜 —— 倒角窄、最边上位移大（比旋钮自己的半高还大：左右两头把轨道拉弯上来）、带一点色散；
 * 不放大；里面上暗下亮（体光），几乎没有白色。按 iOS 26 截图的实测定（docs/calibration.md「质感对照」）。
 */
export const THUMB_PRESSED: ThumbParams = {
  blur: 0,
  refraction: 0.3,
  distortion: 0.55,
  saturation: 1.15,
  highlight: 1,
  dispersion: 0.12,
  shadow: 0.2,
  whiteness: 0.03,
  magnify: 0,
  bodyLight: 1
}

/**
 * 按下（分段控件的选中块）：倒角更宽（截图上两头的字母被扭成一大团），底下的字放大 1.2 倍（「Month」比「Week」
 * 大一圈）。最边上的位移只到半高的 0.35：加上放大本身往中心挪的 m / (1 + m) ≈ 0.17，上下两条边采不到正中间的字
 （字的上沿离边约半高的一半）—— 截图上那里是干净的白；两头的圆弧离字近，照样把字母扭弯。
 */
export const SEGMENT_THUMB_PRESSED: ThumbParams = {
  ...THUMB_PRESSED,
  refraction: 0.5,
  distortion: 0.35,
  magnify: 0.2
}

/** 按压能量 0–1 时旋钮的材质：各项在静止与按下（默认 THUMB_PRESSED）之间线性插值。 */
export function thumbMaterial(energy: number, pressed: ThumbParams = THUMB_PRESSED): GlassMaterial {
  const e = Math.min(Math.max(energy, 0), 1)
  // a·(1 − e) + b·e 而不是 a + (b − a)·e：两头都精确落在端点上（后者在 e = 1 时带出末位误差）
  const mix = (a: number, b: number): number => a * (1 - e) + b * e
  const r = THUMB_REST
  const p = pressed
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
    magnify: mix(r.magnify, p.magnify),
    bodyLight: mix(r.bodyLight, p.bodyLight),
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
