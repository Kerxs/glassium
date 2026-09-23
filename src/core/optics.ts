/*
   本文件的光学数学移植自 AndroidLiquidGlass（io.github.kyant0:backdrop）的
   internal/Shaders.kt，以 Apache License 2.0 授权，Copyright 2025 Kyant。
   上游源：https://github.com/Kyant0/AndroidLiquidGlass
   commit 65ab177e90e5c1d8c62e70cf7755841982da65f6

   已修改：重写为 TypeScript；修正 radiusAt 的坐标系；色散改为径向、蓝光位移大于
   红光；高光改为不对称并新增暗边。逐条说明见 docs/porting-notes.md。

   上游未附带 NOTICE 文件，故本项目不承担 Apache-2.0 §4(d) 的转载义务；
   §4(a)–(c) 仍然适用。

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
 */

/**
 * 光学核心的 CPU 参考实现。
 *
 * 这份 TypeScript 和 src/shaders/optics.wgsl.ts 里的 WGSL 是**同一套数学的两份实现**，
 * 不是一份调用另一份。这是刻意的冗余：stage.debug.probeOptics() + compareOptics() 把两者
 * 逐像素比对（判据：零个非有限值、采样偏移 p99 < 1e-4 像素），任何一边写错都会当场暴露。
 * GPU 端没法单步调试，CPU 端可以。
 *
 * 全部函数都是纯函数、无分配优化 —— 这里优先可读性，热路径在 GPU 上。
 */

/** 二维向量。用只读元组而不是类，省得在参考实现里引入生命周期问题。 */
export type Vec2 = readonly [number, number]

/** 四角半径，**顺序固定为 TL, TR, BR, BL**（顺时针，从左上开始）。 */
export type Radii4 = readonly [number, number, number, number]

/**
 * 把四角半径钳到几何上可能的范围。
 *
 * 单角最大只能到 minDimension/2 —— 再大就会和对角的圆弧交叠，SDF 不再是
 * 有效的距离场（会出现内部为正的区域）。上游按 size.minDimension / 2 钳，这里一致。
 */
export function clampRadii(radii: Radii4, size: Vec2): Radii4 {
  const limit = Math.min(size[0], size[1]) / 2
  return [
    Math.min(Math.max(radii[0], 0), limit),
    Math.min(Math.max(radii[1], 0), limit),
    Math.min(Math.max(radii[2], 0), limit),
    Math.min(Math.max(radii[3], 0), limit)
  ]
}

/**
 * 取当前点所在象限的角半径。
 *
 * **入参必须是中心化坐标**（原点在矩形中心），不是左上原点的原始坐标。
 *
 * 上游在这里有个 bug：四个着色器全都写成 `radiusAt(coord, cornerRadii)`，传的是
 * AGSL 的原始 `coord`，而那个坐标系是左上原点、取值 [0,w]×[0,h]。于是
 * `coord.x >= 0.0` 恒真、`coord.y <= 0.0` 只在最上面一行成立 —— 实际效果是
 * **四角半径塌缩成右下角那一个**。
 *
 * 四角半径相同时（RoundedRectangle(r) 这种最常见的写法）完全看不出来，
 * 这也是它能一直活着的原因。Glassium 传中心化坐标，映射关系本身沿用上游。
 */
export function radiusAt(centered: Vec2, radii: Radii4): number {
  if (centered[0] >= 0) {
    return centered[1] <= 0 ? radii[1] : radii[2] // TR : BR
  }
  return centered[1] <= 0 ? radii[0] : radii[3] // TL : BL
}

/**
 * 圆角矩形的有符号距离场。内部为负、外部为正、边界为零。
 *
 * `outside` 处理角外与边外，`inside` 处理内部 —— 两项在各自区域里恰有一项为零，
 * 所以直接相加即可，不需要分支。
 */
export function sdRoundedRect(p: Vec2, halfSize: Vec2, radius: number): number {
  const cx = Math.abs(p[0]) - (halfSize[0] - radius)
  const cy = Math.abs(p[1]) - (halfSize[1] - radius)
  const outside = Math.hypot(Math.max(cx, 0), Math.max(cy, 0)) - radius
  const inside = Math.min(Math.max(cx, cy), 0)
  return outside + inside
}

/**
 * 上面那个 SDF 的**闭式解析梯度**（单位向量，指向外侧）。
 *
 * 不用有限差分：解析式更便宜，而且没有差分噪声 —— 差分在角上的噪声恰好会落在
 * 折射最敏感的地方。这是上游真正的贡献之一。
 *
 * 退化情况：p 恰在中心时两个分量都为零，normalize 会产生 NaN。这里返回 (0,-1)，
 * 与 WGSL 侧的守卫保持一致（见 optics.wgsl.ts 的 safeNormalize）。
 */
export function gradSdRoundedRect(p: Vec2, halfSize: Vec2, radius: number): Vec2 {
  const cx = Math.abs(p[0]) - (halfSize[0] - radius)
  const cy = Math.abs(p[1]) - (halfSize[1] - radius)
  const sx = p[0] >= 0 ? 1 : -1
  const sy = p[1] >= 0 ? 1 : -1

  if (cx >= 0 || cy >= 0) {
    // 角区（或边外）：方向由角坐标决定。只有一个分量为正时，normalize 退化成轴向，
    // 与下面的 else 分支在接缝处自然衔接。
    const mx = Math.max(cx, 0)
    const my = Math.max(cy, 0)
    const len = Math.hypot(mx, my)
    if (len <= 1e-6) return [0, -1]
    return [(sx * mx) / len, (sy * my) / len]
  }
  // 内部：方向吸附到较近的那条边。注意这里在对角线上（cx === cy）有一个 90° 的
  // 硬跳变 —— 这就是 gradRadiusOf 要把角半径放大 1.5 倍的原因：把这块区域推到
  // 折射提前返回之后，让边缘带永远落在上面那个平滑分支里。
  const gradX = cy <= cx ? 1 : 0
  return [sx * gradX, sy * (1 - gradX)]
}

/**
 * 求梯度场使用的角半径 —— **放大 1.5 倍**，与 SDF 自身的半径解耦。
 *
 * 这是整份移植里最容易被当成笔误删掉的一行。它做两件事：
 *
 *   1. 角区变大，方向绕角的 90° 转弯分摊到更长的弧上 —— 峰值转向率从
 *      1/(r − 深度) 降到 1/(1.5r − 深度)，实测平缓 1.66 倍（docs/calibration.md）。
 *      要说清楚它**不**做什么：放不放大，方向场在接缝处都是连续的（两侧都给出轴向）；
 *      接缝处转向率从 0 跳到 1/(gr − 深度) 这个一阶间断也仍然在，只是跳得小了。
 *   2. 把 gradSdRoundedRect 内部分支那条 cy = cx 的 90° 跳变推到更深处，远离折射带。
 *
 * optics.test.ts 用一条**正反双向**的测试钉住第 1 点：改回 1.0 之后那条必须失败，
 * 否则它什么也没测。
 */
export function gradRadiusOf(radius: number, halfSize: Vec2): number {
  return Math.min(radius * 1.5, Math.min(halfSize[0], halfSize[1]))
}

/**
 * 圆形（球面）倒角剖面：x∈[0,1] → [0,1]，在 x=1 处斜率发散。
 *
 * 不是线性斜坡、不是高斯、也不是 Snell 定律，是个几何近似 —— 但它正是 Apple
 * 那种「折射集中在边缘、中心几乎不变形」的观感来源。
 *
 * 定义域外会让 sqrt 拿到负数（真实驱动上产出 NaN），所以**在调用点 clamp**，
 * 不在这里悄悄兜底 —— 让那个 clamp 是可见的。
 */
export function circleMap(x: number): number {
  return 1 - Math.sqrt(1 - x * x)
}

/**
 * 超椭圆（squircle）倒角剖面。n=2 时与 circleMap 完全等价；n 越大中心越平、
 * 过渡越柔和 —— 即 kube.io 所说的「Apple 偏好的更柔的过渡」。
 *
 * squircleMap(x,2) === circleMap(x) 这条恒等式由测试钉住，它是这两个函数
 * 可以互换的依据。
 */
export function squircleMap(x: number, n: number): number {
  return 1 - Math.pow(1 - Math.pow(x, n), 1 / n)
}

/**
 * 折射位移剖面：把「到边界的有符号距离」映射成位移幅值（像素）。
 *
 * 返回 0 表示这个点在边缘带之外 —— 调用方应当直通采样。这就是上游那个
 * `if (-sd >= refractionHeight) return content.eval(coord);` 的提前返回，
 * 既是视觉特征也是性能优化。
 */
export function refractionProfile(
  sd: number,
  heightPx: number,
  amountPx: number,
  squircleExponent = 2
): number {
  if (heightPx <= 0 || amountPx === 0) return 0
  if (-sd >= heightPx) return 0 // 深于边缘带：直通
  const clamped = Math.min(sd, 0)
  // x = 1 在边界处（sd=0）取到，x = 0 在深度 heightPx 处取到。
  const x = Math.min(Math.max(1 - -clamped / heightPx, 0), 1)
  return squircleMap(x, squircleExponent) * amountPx
}

/**
 * 多形状合并用的平滑最小值（polynomial smin）。
 *
 * 一并返回混合系数 h —— 梯度那边要复用同一个 h，见 sminGradient。
 */
export function smin(a: number, b: number, k: number): { value: number; h: number } {
  if (k <= 0) return { value: Math.min(a, b), h: a <= b ? 1 : 0 }
  const h = Math.min(Math.max(0.5 + (0.5 * (b - a)) / k, 0), 1)
  return { value: b * (1 - h) + a * h - k * h * (1 - h), h }
}

/**
 * smin 的梯度：用**同一个 h** 对两个输入梯度做线性插值。
 *
 * 这不是近似 —— 对上面那个多项式 smin 而言它就是精确梯度。
 * （k·h·(1-h) 那一项对 h 的依赖在链式法则里与 ∂h/∂a、∂h/∂b 相消。）
 * 测试用有限差分钉住这条恒等式。
 */
export function sminGradient(ga: Vec2, gb: Vec2, h: number): Vec2 {
  return [gb[0] * (1 - h) + ga[0] * h, gb[1] * (1 - h) + ga[1] * h]
}

/**
 * 色散的逐通道位移系数。
 *
 * 物理次序：**蓝光位移大于红光** —— 波长更短、折射率更高、偏折更大。
 * 上游在主导边上是反的，而且用 (x·y)/(hx·hy) 这个鞍面做调制，逐象限变号，
 * 彩边方向会在相邻两角之间翻转。Glassium 的幅值取径向，方向沿基础折射的同一条
 * 内法线，所以四个角的彩边方向一致。
 *
 * @param k 色散强度，0 表示关闭（此时三通道系数恒为 1，与无色散路径逐位相同）。
 */
export function spectralWeights(k: number): { r: number; g: number; b: number } {
  return { r: 1 - k, g: 1, b: 1 + k }
}

/**
 * 边缘高光的范围：边界处（sd = 0）为 1，深入面板 rimPx 之后为 0，中间是 smoothstep。
 * 与 WGSL 侧逐点一致（smoothstep 展开为 t²(3 − 2t)）。
 */
export function rimMask(sd: number, rimPx: number): number {
  const e1 = Math.max(rimPx, 1e-6)
  const t = Math.min(Math.max(-sd / e1, 0), 1)
  return 1 - t * t * (3 - 2 * t)
}

/**
 * 高光：返回受光强度与背光强度。
 *
 * 上游是 `pow(abs(dot(n, L)), falloff)`。abs() 让朝光和背光两条边**等亮** ——
 * 那等于两个光源，不是一个；而且没有暗边（上游 issue #118 在要这个）。
 * 这里拆成两项：只有朝光一侧发亮（lit），背光一侧给出暗边强度（dark），
 * 两者在任何一点上至多一个非零。
 *
 * @param lightDir 指向光源的单位向量，屏幕坐标（y 向下）。
 */
export function highlightTerms(
  n: Vec2,
  lightDir: Vec2,
  gloss: number
): { lit: number; dark: number } {
  const ndl = n[0] * lightDir[0] + n[1] * lightDir[1]
  return {
    lit: Math.pow(Math.max(ndl, 0), gloss),
    dark: Math.pow(Math.max(-ndl, 0), gloss)
  }
}

/**
 * 色散：三个通道各自的采样偏移（相对当前像素，像素单位）。
 *
 * 全部沿同一个方向 −dir（往面板内部），只是长度按 spectralWeights 缩放：
 * 蓝 1+k 最长、红 1−k 最短。所以在边缘的每一点上，蓝通道都比红通道采得更靠里 ——
 * **这个关系在四个角上完全一致**。上游用 (x·y)/(hx·hy) 调制色散，这个关系逐象限翻转。
 *
 * k = 0 时三个偏移完全相等（乘的都是精确的 1），与无色散路径逐位相同。
 */
export function channelSampleOffsets(
  dir: Vec2,
  displacement: number,
  k: number
): { r: Vec2; g: Vec2; b: Vec2 } {
  const w = spectralWeights(k)
  const at = (m: number): Vec2 => [-dir[0] * displacement * m, -dir[1] * displacement * m]
  return { r: at(w.r), g: at(w.g), b: at(w.b) }
}

/** 归一化，零向量返回 (0,-1) —— 与 WGSL 侧的守卫一致。 */
export function safeNormalize(v: Vec2): Vec2 {
  const len = Math.hypot(v[0], v[1])
  if (len <= 1e-6) return [0, -1]
  return [v[0] / len, v[1] / len]
}

/**
 * 边缘带内某点的完整折射位移方向。
 *
 * depthEffect 把 SDF 梯度与「由中心指向外」的径向量混合 —— 前者让玻璃读起来像
 * 一片倒角的薄板，后者让它读起来像一整块厚透镜。上游传 1/0 当开关，这里保留
 * 连续值，因为我们没有理由把它离散化。
 */
export function refractionDirection(
  centered: Vec2,
  halfSize: Vec2,
  gradRadius: number,
  depthEffect: number
): Vec2 {
  const grad = gradSdRoundedRect(centered, halfSize, gradRadius)
  if (depthEffect === 0) return safeNormalize(grad)
  const radial = safeNormalize(centered)
  return safeNormalize([
    grad[0] + depthEffect * radial[0],
    grad[1] + depthEffect * radial[1]
  ])
}
