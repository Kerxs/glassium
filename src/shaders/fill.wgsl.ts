/**
 * 填充 pass：`<glass-fill>` 的圆角矩形，纯色或渐变（线性、径向，可重复）。
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
 * 渐变：CPU 把 CSS 的渐变解算成盒子里的一条线段或一个椭圆（core/gradient.ts），这里逐像素求位置 t，在色标之间
 * 插值 —— 与浏览器画 CSS 渐变一样在预乘的 sRGB 里插（透明的一头不发黑），线性光模式下插完再换成线性值。
 * 着色器里不除以 uniform：方向、半径、色标间距的倒数都在 CPU 上算好（除以 uniform 在 NVIDIA + ANGLE 上
 * 帧与帧之间会差 1 ulp，见 webgl2/shaders.ts 的 uStageInv）。
 *
 * 和 scene / blur / glass 一样**不经过重写器**：有入口点与绑定，各后端手写（GLSL 在 webgl2/shaders.ts）。
 */

import { MAX_GRADIENT_STOPS } from '../core/gradient.ts'
import { POSE_WGSL } from './glass.wgsl.ts'
import { OPTICS_WGSL } from './optics.wgsl.ts'
import { SRGB_WGSL } from './srgb.wgsl.ts'

/** Fill 结构体的字节数（16 个 vec4f，正好一个步长）。与面板一样按 256B 步长排进一条 buffer，用动态偏移切换。 */
export const FILL_STRUCT_BYTES = 256
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
  color: vec4f,         // 纯色：未预乘的 rgb（sRGB 编码）+ alpha（已乘上 CSS 的不透明度）；渐变：只用 a（CSS 的不透明度）
  clip: vec4f,          // 裁剪祖先围出的可见区域 x0, y0, x1, y1；没有裁剪的方向是 ±65536
  clipRadii: vec4f,     // 可见区域四角的圆角 TL, TR, BR, BL
  pose: vec4f,          // 旋转：cos θ、sin θ（屏幕坐标，y 向下），空，空
  paint: vec4f,         // 种类（0 纯色 · 1 线性 · 2 径向）、色标数、重复（0 / 1）、空
  geom: vec4f,          // 线性：起点 xy、(终点 − 起点) ÷ 长度²；径向：中心 xy、1/rx、1/ry（盒子左上角为原点、转之前，画布设备像素）
  stops: array<vec4f, ${MAX_GRADIENT_STOPS}>,  // 色标的颜色：未预乘的 rgb（sRGB 编码）+ a
  at: array<vec4f, 2>,  // 色标的位置（0–1 是 0%–100%）：at[0] 是第 0–3 个，at[1].x 第 4 个；at[1].y、z 是重复的周期的倒数与周期
  span: vec4f,          // 相邻两个色标之间：1 ÷ 位置之差（第 0–3 段；重合的是 0）
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

// 第 i 个色标的位置。
fn stopAt(i: u32) -> f32 {
  return fill.at[i / 4u][i % 4u];
}

// 渐变在 t 处的颜色，预乘。CSS 的规则：第一个色标之前是它的颜色，最后一个之后同理，中间在相邻两个之间
// 线性插值；两个色标在同一位置时是一条硬边（t 到了那个位置就取后一个）。
fn gradientAt(t0: f32) -> vec4f {
  let count = u32(fill.paint.y + 0.5);
  let first = stopAt(0u);
  var t = t0;
  if (fill.paint.z > 0.5 && fill.at[1].y > 0.0) {
    // 重复：折回 [第一个位置, 第一个位置 + 周期)
    let u = (t - first) * fill.at[1].y;
    t = first + (u - floor(u)) * fill.at[1].z;
  }
  var color = vec4f(fill.stops[0].rgb * fill.stops[0].a, fill.stops[0].a);
  if (t <= first) {
    return color;
  }
  for (var i = 1u; i < ${MAX_GRADIENT_STOPS}u; i++) {
    if (i >= count) {
      break;
    }
    let s = fill.stops[i];
    let next = vec4f(s.rgb * s.a, s.a);
    if (t < stopAt(i)) {
      let f = clamp((t - stopAt(i - 1u)) * fill.span[i - 1u], 0.0, 1.0);
      return mix(color, next, f);
    }
    color = next;
  }
  return color;
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
  if (fill.paint.x < 0.5) {
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

  // 渐变：盒子里的位置（左上角为原点、转之前）→ 渐变位置 t
  let local = c + halfSize;
  var t: f32;
  if (fill.paint.x < 1.5) {
    t = dot(local - fill.geom.xy, fill.geom.zw);
  } else {
    t = length((local - fill.geom.xy) * fill.geom.zw);
  }
  let paint = gradientAt(t);
  let k = fill.color.a * shape * clip;
  if (paint.a * k <= 0.0) {
    discard;
  }
  if (dest.linear > 0.5) {
    // 在 sRGB 里插完再换成线性值：先去掉预乘
    return vec4f(srgbToLinear(paint.rgb / paint.a) * paint.a * k, paint.a * k);
  }
  return paint * k;
}
`
