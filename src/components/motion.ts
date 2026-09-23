/**
 * `<glass-button>` 的交互动画。
 *
 * 一个标量「能量」在 0（静止）和 1（按下）之间缓动，材质参数全部由它派生。
 * 用一个标量而不是逐参数各自缓动，是为了让「悬停中途按下、按下中途移开」这类
 * 被打断的过渡始终落在同一条曲线上 —— 各参数分头缓动的话，中途改目标时它们会
 * 以不同的相位走，玻璃会短暂地出现静止与按下两态都不对应的组合。
 *
 * 动画只改材质的**数值**：折射带更深、位移更强、高光更亮，整块玻璃微微提亮。
 * 这些都是 uniform，不碰管线、不碰 bind group —— `stats().pipelineCreations` 在整个
 * 动画期间应当不变，T9 的验收就是看这个数。
 */

import { MATERIAL_DEFAULTS, parseTint, type GlassMaterial } from '../core/material.ts'

export interface InteractionState {
  readonly hover: boolean
  readonly pressed: boolean
  /** 键盘聚焦（:focus-visible）。鼠标点出来的焦点不算，否则点完之后按钮会一直亮着。 */
  readonly focusVisible: boolean
  readonly disabled: boolean
}

/** 各状态对应的能量。悬停与键盘聚焦给同样的反馈 —— 键盘用户也该看得见自己停在哪。 */
export const ENERGY = { rest: 0, hover: 0.4, pressed: 1 } as const

/** 缓动的时间常数。约 3τ（≈ 210ms）走完 95%，与系统控件的按压手感相当。 */
export const TAU_MS = 70

export function targetEnergy(s: InteractionState): number {
  if (s.disabled) return ENERGY.rest
  if (s.pressed) return ENERGY.pressed
  if (s.hover || s.focusVisible) return ENERGY.hover
  return ENERGY.rest
}

/**
 * 指数趋近：`target + (current − target)·e^(−dt/τ)`。
 *
 * 与帧率无关（两步各走 dt/2 等于一步走 dt），中途改 target 时也连续 ——
 * 这两条正是固定步长插值做不到的。
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (!(tauMs > 0)) return target
  // 没有时间流逝就原地不动。不单独判的话 target + (current − target)·1 会带出一个
  // 末位的舍入误差（1 + (0.3 − 1) = 0.30000000000000004）
  if (!(dtMs > 0)) return current
  return target + (current - target) * Math.exp(-dtMs / tauMs)
}

/** 距离目标小于它就直接落到目标上，停掉动画。低于 1/255 的高光差异看不出来。 */
export const SETTLE_EPSILON = 1e-3

/**
 * 按能量调制材质。
 *
 * 能量为 0 时**逐位**返回基础材质的取值（x·1 与 x + 0 在 IEEE 754 下都精确，tint 原样不动），
 * 所以静止的按钮和同材质的普通面板画出来的像素完全一样 —— 这一条有测试钉住。
 *
 * 系数是实测调出来的。只调折射与高光时，thick 预设（σ 16dp 的重模糊）上按下之后只有
 * 约 4% 的像素变化超过 4/255：位移落在一片已经模糊掉的背景上，几乎看不出差别。
 * 所以按下时还要让整块玻璃微微提亮 —— Apple 的交互玻璃按下时会「从内部发光」，
 * 这里用 tint 的 alpha 近似。按触点位置发光要改着色器，留到以后。
 */
export function modulate(base: GlassMaterial, energy: number): GlassMaterial {
  const e = Math.min(Math.max(energy, 0), 1)
  const refraction = base.refraction ?? MATERIAL_DEFAULTS.refraction
  const distortion = base.distortion ?? MATERIAL_DEFAULTS.distortion
  const highlight = base.highlight ?? MATERIAL_DEFAULTS.highlight
  const out: GlassMaterial = {
    ...base,
    // 按下时玻璃「鼓起来」：边缘带更深、透镜更强，受光边更亮
    refraction: refraction * (1 + 0.5 * e),
    distortion: distortion * (1 + 0.35 * e),
    highlight: highlight + (1 - highlight) * 0.6 * e
  }
  if (e === 0) return out

  const [r, g, b, a] = parseTint(base.tint ?? MATERIAL_DEFAULTS.tint)
  const lifted = a + (1 - a) * 0.1 * e
  return { ...out, tint: `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${lifted})` }
}

/** 禁用态：玻璃跟文字一起变淡。只动材质的 opacity，不动元素的 CSS opacity —— 后者玻璃跟不上。 */
export function dimmed(base: GlassMaterial): GlassMaterial {
  return { ...base, opacity: (base.opacity ?? MATERIAL_DEFAULTS.opacity) * 0.5 }
}
