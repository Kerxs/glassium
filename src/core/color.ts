/**
 * sRGB 编码 ↔ 线性光。
 *
 * IEC 61966-2-1 的分段曲线，与着色器里的 srgbToLinear / linearToSrgb 是同一条公式（WGSL 在
 * shaders/srgb.wgsl.ts，GLSL 在 webgl2/shaders.ts）。CSS 颜色是 sRGB 编码的；线性光模式下交给 GPU
 * 之前先换成线性值。
 */

/**
 * 模糊与调色在哪个空间里做。
 *
 * - `'srgb'`（默认）：直接在 sRGB 编码值上做。第一期起的全部校准数值都按它量。
 * - `'linear'`：线性光。物理上更对 —— 亮暗交界模糊之后不发灰：黑白阶跃中间是 180 而不是 128；
 *   白色的 tint 叠上去更亮。代价是已经校准过的数值要换一套（见 docs/calibration.md）。
 *
 * 实现：模糊链改用 sRGB 格式的纹理（写入时硬件编码、采样时先解码再过滤），所以模糊、三线性插值、
 * 玻璃的调色都在线性光里；玻璃最后编码回 sRGB 再合到画布上 —— 玻璃的抗锯齿边缘与投影和 DOM 一样
 * 在编码空间里混合。
 */
export type BlendSpace = 'srgb' | 'linear'

/** sRGB 编码值 → 线性光。负数按 0 算。 */
export function srgbToLinear(c: number): number {
  const s = Math.max(0, c)
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** 线性光 → sRGB 编码值。负数按 0 算；大于 1 的照曲线外推（加性的高光可以超过 1，之后才钳）。 */
export function linearToSrgb(c: number): number {
  const l = Math.max(0, c)
  return l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055
}

/** 调用处校验：写错的值在这里就抛，而不是悄悄当成默认值。 */
export function assertBlendSpace(space: unknown): asserts space is BlendSpace {
  if (space !== 'srgb' && space !== 'linear') {
    throw new TypeError(`[Glassium] blendSpace 只能是 'srgb' 或 'linear'，收到 ${JSON.stringify(space)}`)
  }
}
