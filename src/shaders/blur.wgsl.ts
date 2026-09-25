/**
 * 模糊金字塔与背景调试视图。
 *
 * 和 scene.wgsl.ts 一样**不经过 WGSL→GLSL 重写器**：有入口点和绑定，各后端手写。
 *
 * ## 为什么是 mip 链而不是 texture_2d_array
 *
 * 原计划写的是「K 层放一个 texture_2d_array，每层是前一层分辨率的一半」。这两句话
 * 自相矛盾：**纹理数组的各层必须同尺寸**，做不到逐层减半。
 *
 * 换成 mip 链之后三件事一起解决了：
 *   1. mip 天生就是逐级减半，这正是想要的（模糊本来就该在低分辨率上做）
 *   2. `textureSampleLevel` 的 level 参数取浮点时，硬件**自动在两级之间三线性插值** ——
 *      计划里那个「按 log2(σ) 手动在包夹的两层之间 lerp」直接白送
 *   3. 一个绑定、一张纹理
 *
 * T5 验过动态层索引可用，这里用的是同一个能力（动态 level），所以前提仍然成立。
 */

import { SRGB_WGSL } from './srgb.wgsl.ts'

const FULLSCREEN_VS = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var corners = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  let p = corners[i];
  var out: VsOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = vec2f((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}
`

/**
 * 可分离高斯的一趟。
 *
 * 水平趟同时兼做降采样：源是目标的两倍分辨率，采样偏移按**目标**纹素算，
 * 双线性采样顺带把降采样做掉了，省一趟 pass。垂直趟同分辨率。
 *
 * 5 个抽头。局部 σ 取 0.866 是算出来的不是拍的：高斯按方差相加，上一级的屏幕 σ
 * 是本级目标 σ 的一半，所以本级需要补的量是 sqrt(σ² − (σ/2)²) = σ·√3/2 ≈ 0.866σ；
 * 换算到本级纹素（本级 scale 正好让目标 σ 对应 1 个纹素）就是 0.866。
 * 5 抽头覆盖 ±2 纹素 ≈ ±2.3σ，约 97% 的能量。
 */
export const BLUR_WGSL = /* wgsl */ `
struct BlurUniforms {
  texelSize: vec2f,   // 1 / 目标尺寸
  sigma: f32,         // 目标纹素为单位的局部 σ
  vertical: f32,      // 0 = 水平（兼降采样），1 = 垂直
}

@group(0) @binding(0) var<uniform> blur: BlurUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

${FULLSCREEN_VS}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let dir = select(vec2f(blur.texelSize.x, 0.0), vec2f(0.0, blur.texelSize.y), blur.vertical > 0.5);

  // 权重在着色器里按 σ 现算，而不是写死常量 —— σ 是 uniform，写死就没法调了，
  // 而这是个 5 抽头，三次 exp 的代价完全不值得为它牺牲可调性。
  let s2 = 2.0 * blur.sigma * blur.sigma;
  let w0 = 1.0;
  let w1 = exp(-1.0 / s2);
  let w2 = exp(-4.0 / s2);
  let norm = 1.0 / (w0 + 2.0 * w1 + 2.0 * w2);

  var acc = textureSampleLevel(src, samp, in.uv, 0.0) * w0;
  acc += textureSampleLevel(src, samp, in.uv + dir, 0.0) * w1;
  acc += textureSampleLevel(src, samp, in.uv - dir, 0.0) * w1;
  acc += textureSampleLevel(src, samp, in.uv + dir * 2.0, 0.0) * w2;
  acc += textureSampleLevel(src, samp, in.uv - dir * 2.0, 0.0) * w2;
  return acc * norm;
}
`

/**
 * 背景调试视图：按给定 σ 采样模糊链，并施加 colorFilter。
 *
 * ## colorFilter 为什么可以放在模糊**之后**
 *
 * 管线的语义顺序是 colorFilter → blur → lens，但模糊链是**所有面板共享**的
 * （这正是「K 趟共享 pass 而不是每面板一趟」的全部意义），而各面板的
 * saturation / tint 各不相同。看起来矛盾。
 *
 * 不矛盾：saturation 和 tint 都是**逐点仿射**变换，而模糊是线性卷积，两者可交换。
 *   saturation: mix(vec3(luma(c)), c, s) —— 对 c 线性
 *   tint:       mix(c, tintRGB, tintA)   —— 对 c 仿射（常数项卷积后仍是该常数，
 *                                          因为核是归一化的）
 * 所以 blur(colorFilter(x)) 与 colorFilter(blur(x)) 逐像素相等，可以在采样之后
 * 逐面板施加，结果不变。
 *
 * **这条等价关系是共享模糊链成立的前提。** 将来要加非仿射的调色（gamma、
 * 对比度曲线、tone mapping）就不能这么放了 —— 那时要么退回逐面板模糊，
 * 要么接受近似，必须显式决定。
 *
 * 另：它成立的前提还包括「两边在同一个色彩空间」。默认两边都在 sRGB 编码空间；线性光模式下
 * 两边都在线性光里 —— 模糊链存的是 sRGB 编码、采样时硬件先解码，tint 在 CPU 上换成线性值 ——
 * 所以照样可交换。
 *
 * 同一个着色器还用来把画布上的一块重采样回场景目标（玻璃的层，见 layers.ts）：那时参数原样，
 * 来源是从画布拷来的 sRGB 编码值，线性光模式下先解码（decodeIn）；上屏时编码回去（encodeOut）。
 */
export const BACKDROP_WGSL = /* wgsl */ `
struct BackdropUniforms {
  tint: vec4f,
  saturation: f32,
  level: f32,        // 模糊链的浮点 mip 级，硬件在相邻两级间三线性插值
  decodeIn: f32,     // 1 = 采到的是 sRGB 编码值，先解码（线性光模式下层的重采样）
  encodeOut: f32,    // 1 = 输出前编码回 sRGB（线性光模式下上屏）
}

@group(0) @binding(0) var<uniform> u: BackdropUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var chain: texture_2d<f32>;

${FULLSCREEN_VS}

${SRGB_WGSL}

// Rec.709 亮度权重。和 CSS 的 saturate() 滤镜同源，所以数值上对得上。
fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn applyColorFilter(rgb: vec3f, saturation: f32, tint: vec4f) -> vec3f {
  let gray = vec3f(luma(rgb), luma(rgb), luma(rgb));
  let saturated = mix(gray, rgb, saturation);
  return mix(saturated, tint.rgb, tint.a);
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  var rgb = textureSampleLevel(chain, samp, in.uv, u.level).rgb;
  if (u.decodeIn > 0.5) {
    rgb = srgbToLinear(rgb);
  }
  var out = applyColorFilter(rgb, u.saturation, u.tint);
  if (u.encodeOut > 0.5) {
    out = linearToSrgb(out);
  }
  return vec4f(out, 1.0);
}
`
