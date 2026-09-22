/**
 * 有序效果管线 —— Glassium 的内核。
 *
 * 为什么是有序命令式管线而不是一个扁平属性包：上游 Kyant0/AndroidLiquidGlass 的 v1
 * 正是后者（`GlassStyle` / `GlassMaterial`），作者在 1.0.0-alpha14 把它整块删掉了。
 * 原因有两条，都是扁平属性包结构上表达不了的：
 *
 *   1. **效果顺序有语义。** 先调色再模糊，和先模糊再调色，出来的不是一个东西。
 *   2. **各效果必须协商采样边距。** 折射要采到面板边界之外，模糊也要；两者叠加时
 *      需要的余量是累加的，而一个属性包里没有地方放这个协商结果。
 *
 * 声明式的那层没有消失，它在 material.ts 里，作为立面降级到这个管线。
 * 简单场景写一行，复杂场景可以下探 —— 两者都要。
 */

import type { Radii4 } from './optics.ts'

/**
 * 一个效果。顺序在 EffectChain.effects 里是**语义的一部分**，不要重排。
 *
 * 所有长度单位都是 dp（= CSS px，见 units.ts 里为什么是 1:1）。
 */
export type GlassEffect =
  | {
      readonly kind: 'colorFilter'
      /** 1 为原样，>1 提饱和。Apple 的 vibrancy 大约在 1.2–1.5。 */
      readonly saturation: number
      /** 叠加色，预乘前的 [r, g, b, a]，各分量 0–1。a 是叠加强度不是面板透明度。 */
      readonly tint: readonly [number, number, number, number]
    }
  | {
      readonly kind: 'blur'
      /** 高斯 σ，dp。 */
      readonly sigmaDp: number
    }
  | {
      readonly kind: 'lens'
      /** 边缘折射带的深度，dp。比这更深的内部直通不折射。 */
      readonly heightDp: number
      /** 位移幅值，dp。决定把采样点推出去多远 —— **采样余量由它推导，不是由 height**。 */
      readonly amountDp: number
      /** 四角半径，TL/TR/BR/BL，dp。 */
      readonly cornerRadiiDp: Radii4
      /** 倒角剖面的超椭圆指数。2 = 圆形倒角；更大 = 中心更平、过渡更柔。 */
      readonly squircle: number
      /** 色散强度，0 关闭。关闭时与无色散路径逐位相同。 */
      readonly dispersion: number
      /** 边缘高光强度，0 关闭。 */
      readonly highlight: number
      /** 把 SDF 梯度与径向量混合的程度：0 像倒角薄板，1 像整块厚透镜。 */
      readonly depthEffect: number
    }

export interface EffectChain {
  /** 有序。降级保证顺序恒为 colorFilter → blur → lens，且无操作的效果会被省略。 */
  readonly effects: readonly GlassEffect[]
  /** 整条链需要的采样余量，dp。图层要按这个值向外扩张，否则边缘硬裁切。 */
  readonly paddingDp: number
  /** 面板整体不透明度，0–1。不是效果，它作用在合成阶段。 */
  readonly opacity: number
}

/**
 * 单个效果需要的采样余量，dp。
 *
 * 注意 lens 用的是 **amountDp 而不是 heightDp** —— 这是上游的一个欠补 bug。
 * `amount` 是把采样点推出去的距离，`height` 只决定衰减到零的深度，两者无关。
 * 上游按 height 编排预算，而在它自己 playground 的默认值下
 * （amount = 0.2·minDim，height = 0.2·minDim·0.5）amount 恰是 height 的 2 倍，
 * 于是余量欠补一半，折射图像最外圈采到被 clamp 或透明的纹素 ——
 * 表现为紧贴面板边缘的一道硬亮缝。
 *
 * 不需要 size 参数：降级时已经把分数参数解算成 dp 了，到这里全是绝对值。
 */
export function sampleMargin(effect: GlassEffect): number {
  switch (effect.kind) {
    case 'colorFilter':
      return 0
    case 'blur':
      // 高斯在 3σ 外的贡献低于 0.3%，按 3σ 截断是标准做法。
      return Math.ceil(3 * Math.max(effect.sigmaDp, 0))
    case 'lens':
      return Math.ceil(Math.max(effect.amountDp, 0))
  }
}

/**
 * 整条链需要的采样余量，dp。
 *
 * 边距是**累加**的，不是取最大值。每个效果的输入必须在其**下游所有效果会采到的
 * 范围内**都有效：模糊的输出要供折射去采，而折射最远会采到 amountDp 之外，
 * 所以模糊自己的输入就需要 `lensMargin + blurMargin` 那么宽。取 max 会欠补。
 *
 * 写成从右向左折叠，是为了将来出现改变尺度的效果（比如在半分辨率上跑的 pass）时
 * 能正确复合 —— 那时候方向就有意义了。对当前这套纯加法而言方向无差别。
 */
export function resolveMargins(effects: readonly GlassEffect[]): number {
  return effects.reduceRight((downstream, effect) => sampleMargin(effect) + downstream, 0)
}

/** 管线的合法顺序。降级产出的链必须是它的子序列。 */
const CANONICAL_ORDER: readonly GlassEffect['kind'][] = ['colorFilter', 'blur', 'lens']

/**
 * 校验一条链的顺序合法。
 *
 * 手写 EffectChain 是允许的（这就是「可以下探」的意思），但顺序不能乱 ——
 * 先折射再模糊会把折射出来的边缘一起糊掉，那不是玻璃是毛玻璃贴纸。
 * 与其让它默默出一个难看的结果，不如在这里抛。
 */
export function assertCanonicalOrder(effects: readonly GlassEffect[]): void {
  let cursor = 0
  for (const effect of effects) {
    const at = CANONICAL_ORDER.indexOf(effect.kind, cursor)
    if (at < 0) {
      throw new Error(
        `[Glassium] 效果顺序非法：${effects.map((e) => e.kind).join(' → ')}。` +
          `合法顺序是 ${CANONICAL_ORDER.join(' → ')} 的子序列。`
      )
    }
    cursor = at + 1
  }
}
