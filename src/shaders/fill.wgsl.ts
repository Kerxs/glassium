/**
 * 填充 pass：`<glass-fill>` 的纯色圆角矩形。
 *
 * 玻璃只折射场景（R2），DOM 的背景它看不见。填充是「CSS 摆位、Glassium 画」的纯色形状，
 * 每块画两次：
 *
 *   1. 画进场景目标（模糊链的第 0 级），在场景之后、建模糊链之前 —— 于是玻璃折射它、模糊它、
 *      按它的亮度调自适应，与场景里的任何东西一样。
 *   2. 画到画布上，在背景上屏之后、玻璃之前 —— 场景目标受像素预算约束，分辨率常常低于画布；
 *      直接看到的那部分按画布分辨率再画一遍，边缘才和旁边的 DOM 文字一样锐利。
 *
 * 两次是同一个着色器，只有目标不同：片元位置乘上「一个目标像素是几个画布设备像素」换算到画布坐标，
 * 形状与面板一样在画布设备像素里算（旋转也一样），抗锯齿按一个目标像素的宽度过渡。
 *
 * 和 scene / blur / glass 一样**不经过重写器**：有入口点与绑定，各后端手写（GLSL 在 webgl2/shaders.ts）。
 */

import { POSE_WGSL } from './glass.wgsl.ts'
import { OPTICS_WGSL } from './optics.wgsl.ts'
import { SRGB_WGSL } from './srgb.wgsl.ts'

/** Fill 结构体的字节数（6 个 vec4f）。与面板一样按 256B 步长排进一条 buffer，用动态偏移切换。 */
export const FILL_STRUCT_BYTES = 96
export const FILL_STRIDE = 256
export const FILL_STRIDE_FLOATS = FILL_STRIDE / 4
/** Dest 结构体：scale.xy、aa、linear。 */
export const FILL_DEST_BYTES = 16

export const FILL_WGSL = /* wgsl */ `
${OPTICS_WGSL}

${POSE_WGSL}

${SRGB_WGSL}

struct Fill {
  rect: vec4f,          // x, y, w, h —— 画布设备像素（有旋转时是转之前的矩形，中心与包围盒的中心相同）
  radii: vec4f,         // TL, TR, BR, BL —— 画布设备像素
  color: vec4f,         // 未预乘的 rgb（sRGB 编码）+ alpha（已乘上 CSS 的不透明度）
  clip: vec4f,          // 裁剪祖先围出的可见区域 x0, y0, x1, y1；没有裁剪的方向是 ±65536
  clipRadii: vec4f,     // 可见区域四角的圆角 TL, TR, BR, BL
  pose: vec4f,          // 旋转：cos θ、sin θ（屏幕坐标，y 向下），空，空
}

// 这一次画到哪里。（不叫 target：那是 WGSL 的保留字。）
struct Dest {
  scale: vec2f,         // 一个目标像素是几个画布设备像素：场景目标是 画布 ÷ 场景，画布本身是 1
  aa: f32,              // 抗锯齿过渡的宽度 = 一个目标像素，画布设备像素
  linear: f32,          // 1 = 输出线性值（线性光模式下画进场景目标：那时它是 sRGB 格式，混合也在线性光里）
}

@group(0) @binding(0) var<uniform> fill: Fill;
@group(0) @binding(1) var<uniform> dest: Dest;

struct VsOut {
  @builtin(position) pos: vec4f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var corners = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var out: VsOut;
  out.pos = vec4f(corners[i], 0.0, 1.0);
  return out;
}

// 到裁剪区域（带圆角）边界的有符号距离。与 glass.wgsl.ts 的 clipCoverage 是同一个 SDF，
// 只是不在这里钳成覆盖率 —— 覆盖率要按目标像素的宽度换算。
fn clipSd(px: vec2f, box: vec4f, radii: vec4f) -> f32 {
  let c = (box.xy + box.zw) * 0.5;
  let right = px.x > c.x;
  let bottom = px.y > c.y;
  let r = select(select(radii.x, radii.y, right), select(radii.w, radii.z, right), bottom);
  let e = vec2f(max(box.x - px.x, px.x - box.z), max(box.y - px.y, px.y - box.w)) + r;
  return length(max(e, vec2f(0.0, 0.0))) + min(max(e.x, e.y), 0.0) - r;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  // 目标像素的中心 → 画布设备像素。与玻璃采样场景时「uv = 画布坐标 ÷ 画布尺寸」是同一个对应关系，
  // 所以场景目标里的填充与画布上的填充、与玻璃看到的位置严丝合缝
  let px = in.pos.xy * dest.scale;
  let halfSize = fill.rect.zw * 0.5;
  let c = toLocal(px - (fill.rect.xy + halfSize), fill.pose);
  let sd = sdRoundedRect(c, halfSize, radiusAt(c, fill.radii));
  let shape = clamp(0.5 - sd / dest.aa, 0.0, 1.0);
  let clip = clamp(0.5 - clipSd(px, fill.clip, fill.clipRadii) / dest.aa, 0.0, 1.0);
  let a = fill.color.a * shape * clip;
  if (a <= 0.0) {
    discard;
  }
  var rgb = fill.color.rgb;
  if (dest.linear > 0.5) {
    rgb = srgbToLinear(rgb);
  }
  return vec4f(rgb * a, a); // 预乘，混合是 one / one-minus-src-alpha
}
`
