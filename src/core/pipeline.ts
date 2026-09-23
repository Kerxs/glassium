/**
 * 有序效果管线 —— Glassium 的内核。
 *
 * 为什么是有序命令式管线而不是一个扁平属性包：上游 Kyant0/AndroidLiquidGlass 的 v1
 * 正是后者（`GlassStyle` / `GlassMaterial`），作者在 1.0.0-alpha14 把它整块删掉了。
 * 原因有两条，都是扁平属性包结构上表达不了的：
 *
 *   1. **效果顺序有语义。** 先调色再模糊，和先模糊再调色，出来的不是一个东西。
 *   2. **效果要向渲染器报告采样余量。** 模糊要读到面板边界之外 3σ 的像素，
 *      按元素录制图层的渲染器（上游、以及将来的 Android 渲染器）得据此把图层外扩。
 *      一个属性包里没有地方放这个信息。目前只有模糊需要余量，折射不需要——见下。
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
      /** 位移幅值，dp。决定把采样点往面板**内部**拉多远。 */
      readonly amountDp: number
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
  /**
   * 面板形状：四角半径，TL/TR/BR/BL，dp。
   *
   * **形状属于面板，不属于任何一个效果。** 它曾经挂在 lens 效果上，那是个建模错误：
   * refraction 为 0 时 lens 会被省略，于是一块只有模糊、没有折射的玻璃连圆角都没了。
   * 上游也是这样分的 —— shape 是 drawBackdrop 的独立参数，不在 effects 里。
   */
  readonly cornerRadiiDp: Radii4
  /** 有序。降级保证顺序恒为 colorFilter → blur → lens，且无操作的效果会被省略。 */
  readonly effects: readonly GlassEffect[]
  /** 整条链需要的采样余量，dp。图层要按这个值向外扩张，否则边缘硬裁切。 */
  readonly paddingDp: number
  /** 面板整体不透明度，0–1。不是效果，它作用在合成阶段。 */
  readonly opacity: number
  /** 自适应强度，0–1（见 GlassMaterial.adaptive）。也不是效果：它看的是整块玻璃最后的样子。 */
  readonly adaptive: number
}

/**
 * 单个效果需要读到面板边界之外多远，dp。
 *
 * **lens 是 0。** 折射只向面板内部采样：上游在 Lens.kt 里把 refractionAmount
 * 取负后才传给着色器，而 SDF 梯度指向外侧，于是 `coord + d·grad` 是往里走的 ——
 * 这也正是凸透镜在边缘放大的物理行为（视线在倾斜的表面上向法线偏折，落点比
 * 入射点更靠近中心）。Glassium 保持同样的方向，所以折射读到的永远是面板内部的像素。
 *
 * （这里曾经写的是 amountDp，理由是「上游按 height 编排余量、欠补 2 倍」。
 * 那是规划阶段的推断，从没渲染验证过，而且和上面这个采样方向矛盾 —— 已撤回，
 * 见 docs/porting-notes.md。）
 *
 * 将来若加一个向外采样的折射模式（边缘「包住」外侧内容的那种观感），它的余量才是
 * amountDp。
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
      return 0
  }
}

/**
 * 整条链需要的采样余量，dp。
 *
 * 组合规则是**累加**：每个效果的输入必须在其下游所有效果会读到的范围内都有效，
 * 所以向外的读取距离逐级叠加。
 *
 * 老实说，在当前的效果集合里这条规则**观察不到**：只有模糊需要余量，累加和取最大值
 * 给出同一个数。保留它是因为它才是正确的组合方式 —— 一旦出现第二个向外读取的效果
 * （向外折射、投影），取 max 就会欠补。
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
