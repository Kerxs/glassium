/**
 * 多块玻璃合并成一个连续形状 —— `<glass-container>` 的光学。
 *
 * 这是 backdrop-filter 结构上做不到的事，也是上游 issue #104 开着的缺口
 * （报告者原话是「Apple 用的是 GlassEffectContainer」）。
 *
 * ## 做法
 *
 * 每个成员各算自己的 sd、折射方向与高光法线（与单块面板完全相同的那几行），
 * 再用 smin 从第一个成员开始逐个折叠：
 *
 *   (sd, h) = smin(成员.sd, 累积.sd, k)
 *   方向、法线、逐成员参数 = 累积 · (1 − h) + 成员 · h
 *
 * 复用同一个 h 混合方向不是近似：对多项式 smin 而言 sminGradient 就是精确梯度
 * （optics.test.ts 用有限差分钉住）。材质参数也用同一个 h 混合，于是按钮悬停时提亮的
 * 高光会沿着颈部平滑地过渡到另一个成员上，不会出现一条参数的分界线。
 *
 * ## 颈部的方向
 *
 * 两块玻璃之间的颈部，两侧成员的折射方向是**相对**的（各自指向自己外侧，也就是指向对方）。
 * 混合之后的向量长度正好反映两边方向的一致程度：同向时约为 1，相对时趋近 0。
 * 位移乘上这个长度 —— 颈部方向打架的地方折射自然变弱，而不是在中线上硬翻转出一道接缝。
 * 这也符合真实的玻璃：鞍形的颈部中间那条线上，表面法线正对视线，没有横向偏折。
 *
 * ## 没有发生混合的像素逐位不变
 *
 * 一个像素上只要每一步折叠的 h 都恰好是 0 或 1（两个 sd 相差超过 k），它的全部量都**原样**
 * 取自最近的那个成员：sd、方向、法线不归一化也不乘长度。所以相距足够远的成员，
 * 画出来与各自单独绘制逐位相同 —— 这是验证合并路径没有改动别处的最强判据。
 *
 * WGSL 侧（src/shaders/glass-group.wgsl.ts）逐行对应这里，探针回读与这个函数逐像素比对。
 */

import {
  gradRadiusOf,
  gradSdRoundedRect,
  radiusAt,
  refractionDirection,
  refractionProfile,
  safeNormalize,
  sdRoundedRect,
  smin,
  sminGradient,
  type Radii4,
  type Vec2
} from './optics.ts'

/** 最多合并几块。uniform 结构体按这个数定长（4 × 96B），着色器里的循环也以它为上限。 */
export const MAX_GROUP_MEMBERS = 4

/** 合并计算需要的成员几何，单位都是画布设备像素。 */
export interface MemberGeometry {
  /** x, y, w, h */
  readonly rect: readonly [number, number, number, number]
  readonly radii: Radii4
  readonly heightPx: number
  readonly amountPx: number
  readonly squircle: number
  readonly depthEffect: number
}

export interface MergedOptics {
  readonly sd: number
  /** 折射方向（单位向量；未混合时就是成员自己的方向）。 */
  readonly dir: Vec2
  /** 高光法线。 */
  readonly normal: Vec2
  /** 已乘上方向一致度的位移。 */
  readonly displacement: number
  /** 这个像素上有没有任何一步折叠真的在混合（h 严格介于 0 与 1 之间）。 */
  readonly blended: boolean
  /** 每一步折叠的 h（成员 i 相对前面累积结果的权重）—— 调试用。 */
  readonly weights: readonly number[]
}

interface MemberOptics {
  readonly sd: number
  readonly dir: Vec2
  readonly normal: Vec2
}

/** 单个成员 —— 与单块面板的 evalOptics 完全相同的几行。 */
export function memberOptics(px: Vec2, m: MemberGeometry): MemberOptics {
  const [x, y, w, h] = m.rect
  const halfSize: Vec2 = [w / 2, h / 2]
  const centered: Vec2 = [px[0] - (x + halfSize[0]), px[1] - (y + halfSize[1])]
  const radius = radiusAt(centered, m.radii)
  const sd = sdRoundedRect(centered, halfSize, radius)
  const gradR = gradRadiusOf(radius, halfSize)
  return {
    sd,
    dir: refractionDirection(centered, halfSize, gradR, m.depthEffect),
    normal: safeNormalize(gradSdRoundedRect(centered, halfSize, gradR))
  }
}

const lerp = (a: number, b: number, h: number): number => a * (1 - h) + b * h

/**
 * 合并后的光学量。
 *
 * @param k smin 的平滑半径（画布设备像素）。0 是硬并集：互不混合，只取最近的成员。
 *   两块形状之间的缝隙小于 k/2 时，缝隙中点被填上（那里 a = b = gap/2，
 *   smin = gap/2 − k/4）。
 */
export function evalMergedOptics(px: Vec2, members: readonly MemberGeometry[], k: number): MergedOptics {
  if (members.length === 0) throw new Error('[Glassium] 合并至少需要一个成员')
  const first = members[0]!
  const f = memberOptics(px, first)
  let sd = f.sd
  let dir: Vec2 = f.dir
  let normal: Vec2 = f.normal
  let heightPx = first.heightPx
  let amountPx = first.amountPx
  let squircle = first.squircle
  let blended = false
  const weights: number[] = []

  for (let i = 1; i < members.length; i++) {
    const m = members[i]!
    const c = memberOptics(px, m)
    const s = smin(c.sd, sd, k)
    const h = s.h
    sd = s.value
    dir = sminGradient(c.dir, dir, h)
    normal = sminGradient(c.normal, normal, h)
    heightPx = lerp(heightPx, m.heightPx, h)
    amountPx = lerp(amountPx, m.amountPx, h)
    squircle = lerp(squircle, m.squircle, h)
    if (h > 0 && h < 1) blended = true
    weights.push(h)
  }

  const agreement = blended ? Math.hypot(dir[0], dir[1]) : 1
  return {
    sd,
    dir: blended ? safeNormalize(dir) : dir,
    normal: blended ? safeNormalize(normal) : normal,
    displacement: refractionProfile(sd, heightPx, amountPx, squircle) * agreement,
    blended,
    weights
  }
}

/**
 * 合并形状的包围盒会比成员的并集大多少。
 *
 * smin 的修正项 k·h·(1−h) 最大是 k/4，所以合并形状落在「并集向外扩 k/4」之内。
 * 绘制时的裁剪矩形按这个外扩，一个像素都不会被裁掉，也不会多画一大片。
 */
export function mergeBleed(k: number): number {
  return Math.max(k, 0) / 4
}
