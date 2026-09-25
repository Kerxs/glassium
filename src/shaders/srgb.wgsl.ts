/**
 * sRGB 编码 ↔ 线性光，与 core/color.ts 是同一条公式（IEC 61966-2-1）。场景、背景、玻璃、填充共用。
 * 负数按 0 算；大于 1 的线性值照曲线外推（加性的高光可以超过 1）。
 *
 * 不放进 optics.wgsl.ts：那里是移植自上游的光学数学（带 Apache 头、经重写器生成 GLSL），这两个函数与上游
 * 无关。GLSL 那份手写在 webgl2/shaders.ts（SRGB_GLSL），改一边就去对另一边。
 */
export const SRGB_WGSL = /* wgsl */ `
fn srgbToLinear(c: vec3f) -> vec3f {
  let s = max(c, vec3f(0.0));
  return select(pow((s + 0.055) / 1.055, vec3f(2.4)), s / 12.92, s <= vec3f(0.04045));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let l = max(c, vec3f(0.0));
  return select(1.055 * pow(l, vec3f(1.0 / 2.4)) - 0.055, l * 12.92, l <= vec3f(0.0031308));
}
`
