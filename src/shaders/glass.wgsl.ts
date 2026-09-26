/**
 * 玻璃 pass。
 *
 * 光学函数全部来自 OPTICS_WGSL（唯一真源），这里只写入口点、绑定和合成。
 * 和 scene / blur 一样**不经过重写器**：入口点、绑定、`discard` 都属于各后端手写的部分。
 *
 * ## 绘制方式
 *
 * 每块面板画一个全屏三角形，用 scissor 限定到面板矩形（外扩 2px 留给抗锯齿）。
 * 片元位置直接取 `@builtin(position)`，也就是画布设备像素、左上原点、像素中心在 +0.5 ——
 * 于是不需要任何顶点变换，面板几何全在片元着色器里用 SDF 算。
 *
 * ## 采样方向
 *
 * `samplePx = px - dir * d`，dir 指向外侧，所以采样点**往面板内部**走 —— 与上游一致
 * （上游把 refractionAmount 取负再乘外向梯度），也符合凸透镜在边缘放大的物理行为。
 * 因此折射读到的永远是面板内部的像素，不需要额外的采样余量。
 */

import { OPTICS_WGSL } from './optics.wgsl.ts'
import { SRGB_WGSL } from './srgb.wgsl.ts'

/** Panel 结构体的字节数。按 512B 步长排进一条 buffer，用动态偏移切换。 */
export const PANEL_STRUCT_BYTES = 432
/**
 * 每块面板在 uniform buffer 里占的步长：两个 256B 槽位（T5 实测 minUniformBufferOffsetAlignment = 256）。
 * 结构体原来是 176B、步长 256；裁剪加了椭圆角与第二个形状之后长到 304B，再加遮罩到 416B，再加 extra 到 432B。
 */
export const PANEL_STRIDE = 512
/** Float32 视角下的步长。 */
export const PANEL_STRIDE_FLOATS = PANEL_STRIDE / 4

/**
 * 旋转：屏幕上的向量转进面板自己的坐标系（转 −θ），与转回来（转 +θ）。
 * 玻璃（单块与合并组）与填充（fill.wgsl.ts）共用。
 */
export const POSE_WGSL = /* wgsl */ `// 旋转：屏幕上的向量转进面板自己的坐标系（转 −θ），与转回来（转 +θ）。
// pose = (1, 0) 时两者都逐位原样返回（乘 1 加 0）。
fn toLocal(v: vec2f, pose: vec4f) -> vec2f {
  return vec2f(pose.x * v.x + pose.y * v.y, pose.x * v.y - pose.y * v.x);
}

fn toWorld(v: vec2f, pose: vec4f) -> vec2f {
  return vec2f(pose.x * v.x - pose.y * v.y, pose.x * v.y + pose.y * v.x);
}`

/**
 * 到带圆角（可以是椭圆角）盒子边界的有符号距离，画布设备像素。裁剪区域用（玻璃与填充共用）。
 * 按象限取角；两个半径相等的角（圆角）是原来的算法，逐位不变。不相等的是椭圆角：椭圆的隐函数 |q / r| − 1
 * 除以它的梯度长度 —— 一阶近似的距离，在抗锯齿用得到的边界附近准（与 fill.wgsl.ts 的 fillSd 同一个近似）。
 * 倒数（invX、invY）由 CPU 算好：着色器里不除以 uniform。
 */
export const ROUNDED_BOX_WGSL = /* wgsl */ `fn cornerOf(v: vec4f, right: bool, bottom: bool) -> f32 {
  return select(select(v.x, v.y, right), select(v.w, v.z, right), bottom);
}

fn roundedBoxSd(px: vec2f, box: vec4f, radii: vec4f, radiiY: vec4f, invX: vec4f, invY: vec4f) -> f32 {
  let c = (box.xy + box.zw) * 0.5;
  let right = px.x > c.x;
  let bottom = px.y > c.y;
  let r = cornerOf(radii, right, bottom);
  let ry = cornerOf(radiiY, right, bottom);
  let outside = vec2f(max(box.x - px.x, px.x - box.z), max(box.y - px.y, px.y - box.w));
  if (r == ry) {
    let e = outside + r;
    return length(max(e, vec2f(0.0, 0.0))) + min(max(e.x, e.y), 0.0) - r;
  }
  let q = outside + vec2f(r, ry);
  if (q.x > 0.0 && q.y > 0.0) {
    let inv = vec2f(cornerOf(invX, right, bottom), cornerOf(invY, right, bottom));
    let k = q * inv;
    let len = length(k);
    return (len - 1.0) * len / max(length(k * inv), 1e-6);
  }
  return max(q.x - r, q.y - ry);
}`

/**
 * 遮罩（mask-image 的渐变，renderer/mask.ts）在 px 处的不透明度。种类 0 是没有遮罩：正好 1，乘上去逐位不变。
 * 与填充的 gradientAt 同一套取色标的办法，只插不透明度。倒数都由 CPU 算好：着色器里不除以 uniform。
 */
export const MASK_WGSL = /* wgsl */ `fn maskPick(i: u32, a: vec4f, b: vec4f) -> f32 {
  return select(b.x, a[min(i, 3u)], i < 4u);
}

fn maskAlpha(px: vec2f, paint: vec4f, geom: vec4f, alpha0: vec4f, alpha1: vec4f, at0: vec4f, at1: vec4f, span: vec4f) -> f32 {
  if (paint.x < 0.5) {
    return 1.0;
  }
  var t: f32;
  if (paint.x < 1.5) {
    t = dot(px - geom.xy, geom.zw);
  } else {
    t = length((px - geom.xy) * geom.zw);
  }
  let count = u32(paint.y + 0.5);
  let first = at0.x;
  if (paint.z > 0.5 && at1.y > 0.0) {
    let u = (t - first) * at1.y;
    t = first + (u - floor(u)) * at1.z;
  }
  var a = alpha0.x;
  if (t <= first) {
    return a;
  }
  for (var i = 1u; i < 5u; i++) {
    if (i >= count) {
      break;
    }
    let next = maskPick(i, alpha0, alpha1);
    if (t < maskPick(i, at0, at1)) {
      let f = clamp((t - maskPick(i - 1u, at0, at1)) * span[i - 1u], 0.0, 1.0);
      return a + (next - a) * f;
    }
    a = next;
  }
  return a;
}`

/** 调试视图。数值同时写进 uniform，所以顺序不能随便改。 */
export const DEBUG_MODES = ['off', 'sdf', 'mask', 'grad', 'displacement'] as const
export type PanelDebugMode = (typeof DEBUG_MODES)[number]

/**
 * 单块面板与合并组（glass-group.wgsl.ts）共用的部分：结构体、常量、顶点着色器、
 * 调色，以及从「采样偏移 + 材质」到最终颜色的那一段。
 *
 * 引用了 chain / samp / stage 三个绑定 —— 它们在各自的模块里声明（WGSL 的模块级声明
 * 与顺序无关）。两个模块的绑定号相同，只有 binding 0 的结构体不同。
 */
export const GLASS_COMMON_WGSL = /* wgsl */ `
${OPTICS_WGSL}

${SRGB_WGSL}

struct Stage {
  canvasSize: vec2f,
  // 探针 pass 专用：探针目标只覆盖面板那一块，片元位置要加上这块在画布里的原点。
  // 正常 pass 里恒为 (0, 0)。
  probeOrigin: vec2f,
  // 1 = 线性光模式：模糊链采到的是线性值（sRGB 格式的纹理，硬件先解码），tint 换成线性值再混，
  // 输出前编码回 sRGB。0 = 一切照 sRGB 编码值算（默认）。
  linear: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

struct Panel {
  rect: vec4f,          // x, y, w, h —— 画布设备像素
  radii: vec4f,         // TL, TR, BR, BL —— 画布设备像素
  tint: vec4f,          // rgb + 叠加强度
  heightPx: f32,
  amountPx: f32,
  blurLevel: f32,       // 模糊链的浮点 mip 级
  saturation: f32,
  squircle: f32,
  depthEffect: f32,
  dispersion: f32,      // T8
  highlight: f32,       // T8
  opacity: f32,
  debugMode: f32,
  rimPx: f32,           // 边缘高光的宽度，画布设备像素
  adapt: f32,           // 自适应：强度带文字深浅的符号（> 0 浅色文字、< 0 深色文字、0 关掉）
  clip: vec4f,          // 裁剪祖先围出的可见区域 x0, y0, x1, y1 —— 画布设备像素；没有裁剪的方向是 ±65536
  clipRadii: vec4f,     // 可见区域四角的圆角 TL, TR, BR, BL（水平半径）
  light: vec4f,         // 按压处的光：中心 x、y，σ（画布设备像素），强度（0 = 没有）
  shadow: vec4f,        // 投影：峰值 alpha、σ、向下的偏移、形状往里缩的量（都是画布设备像素）
  pose: vec4f,          // 旋转：cos θ、sin θ（屏幕坐标，y 向下）；放大系数 m / (1 + m)；1 ÷ 面板的高（体光用，CPU 算好倒数）
  clipRadiiY: vec4f,    // 可见区域四角的竖直半径（与 clipRadii 相等的角是圆角）
  clipInv: array<vec4f, 2>, // 1 ÷ 水平半径、1 ÷ 竖直半径（半径 0 写 0）
  shapeBox: vec4f,      // 单独算的那个圆角形状（被截断的圆角祖先、clip-path 的圆 / 椭圆）；没有时是 ±65536、半径 0
  shapeRadii: vec4f,
  shapeRadiiY: vec4f,
  shapeInv: array<vec4f, 2>,
  maskPaint: vec4f,     // 遮罩（mask-image 的渐变）：种类（0 没有 · 1 线性 · 2 径向）、色标数、重复、空
  maskGeom: vec4f,      // 线性：起点、(终点 − 起点) ÷ 长度²；径向：中心、1/rx、1/ry（画布设备像素，绝对坐标）
  maskAlpha: array<vec4f, 2>, // 色标的不透明度（5 个）
  maskAt: array<vec4f, 2>,    // 色标的位置（5 个）；maskAt[1].y、z 是重复的周期的倒数与周期
  maskSpan: vec4f,      // 相邻两个位置之差的倒数（重合的是 0）
  extra: vec4f,         // x：体光的强度（材质的 bodyLight，0–1）；y、z、w 空
}

// 光照，按 iOS 26 截图的实测定（docs/calibration.md「质感对照」）。各项都乘材质的 highlight。
// 亮边一整圈：上下两侧最亮（双面），左右是它的 RIM_BASE 倍；没有暗边。
const RIM_LIGHT_DIR: vec2f = vec2f(0.0, -1.0);
const RIM_BASE: f32 = 0.45;
const RIM_GLOSS: f32 = 1.0;
// highlight = 1 时亮边最亮处加的亮度
const RIM_GAIN: f32 = 0.3;
// 倒角带：最外一圈的饱和度倍增与加亮，往里按折射剖面的平方衰减 —— 边上弯过来的颜色略艳、略亮
const BEVEL_SATURATION: f32 = 0.3;
const BEVEL_GLOW: f32 = 0.02;
// 体光（材质的 bodyLight = 1 时）：顶上的暗度、下面的亮度（截图：按住的滑块旋钮顶上 −12、下面 +14 级）
const BODY_SHADE: f32 = 0.047;
const BODY_LIGHT: f32 = 0.055;
// 外线：最外一圈往深灰 EDGE_GRAY 混（与亮边一样乘 highlight）—— 一圈半透明的深灰描边，左右深、上下浅
// （混的比例 EDGE_MIX·(1 − EDGE_TOP·|n·L|)）。iOS 27 截图：白底上左右 −80、上下 −30；暗底上几乎看不见。
// 宽 EDGE_FRAC 倍亮边（至少 1.5 个设备像素：DPR 1 上再窄，上下两条就被亮边抵消没了）；亮边从它里面开始（截图上是「灰线，紧接着一道白」），不叠在线上。
const EDGE_GRAY: f32 = 0.16;
const EDGE_MIX: f32 = 0.5;
const EDGE_TOP: f32 = 0.62;
const EDGE_FRAC: f32 = 0.6;
// 影子的颜色：玻璃背后的平均色压暗到这个比例（截图上浅灰底上的影子偏蓝，不是纯黑）
const SHADOW_TINT: f32 = 0.5;

struct VsOut {
  @builtin(position) pos: vec4f,
}

// 裁剪祖先围出的可见区域（带圆角）的覆盖率。矩形部分 scissor 已经裁过；这里把圆角外那一小块抹掉，
// 并给裁剪边一个像素的抗锯齿。没有裁剪时区域是 ±65536、圆角 0，结果恰好是 1.0（乘上去逐位不变）。
//
// 用「到四条边的距离」而不是「到中心的偏移减半宽」来算：区域一边是 ±65536 时，中心在几万像素之外，
// f32 在那个量级上只剩 1/256 像素量级的精度 —— 而到边的距离 max(x0 − p, p − x1) 是精确的。
// 按压处的光：以按下的点为中心的高斯光斑，加到亮边的加性光上。强度 0 时恰好是 0，乘不乘都逐位不变。
fn lightAt(px: vec2f, light: vec4f) -> f32 {
  if (light.w <= 0.0) {
    return 0.0;
  }
  let d = px - light.xy;
  return light.w * exp(-dot(d, d) / (2.0 * light.z * light.z));
}

${POSE_WGSL}

// 投影：形状往下挪 offset、四周往里缩 inset 之后的 SDF，外面按高斯衰减，里面是峰值（被玻璃盖住的那部分看不见）。
// 缩进去的形状只在玻璃正下方露出来，两侧没有影子 —— 截图上就是这样。
// 强度 0 时恰好是 0 —— 该丢弃的片元照样丢弃，其余加上去逐位不变。
fn shadowSd(centered: vec2f, halfSize: vec2f, radii: vec4f, shadow: vec4f, pose: vec4f) -> f32 {
  let shifted = centered - toLocal(vec2f(0.0, shadow.z), pose);
  let inner = max(halfSize - vec2f(shadow.w, shadow.w), vec2f(0.0, 0.0));
  return sdRoundedRect(shifted, inner, max(radiusAt(shifted, radii) - shadow.w, 0.0));
}

fn shadowAlpha(sdShifted: f32, strength: f32, sigma: f32) -> f32 {
  if (strength <= 0.0) {
    return 0.0;
  }
  let d = max(sdShifted, 0.0);
  return strength * exp(-d * d / (2.0 * sigma * sigma));
}

${ROUNDED_BOX_WGSL}

${MASK_WGSL}

// 裁剪的覆盖率：交集矩形（带角上的圆角）× 单独算的那个形状 × 遮罩。没有那个形状、没有遮罩时后两项正好是 1，
// 乘上去逐位不变。
fn clipCoverage(px: vec2f, p: Panel) -> f32 {
  let a = clamp(0.5 - roundedBoxSd(px, p.clip, p.clipRadii, p.clipRadiiY, p.clipInv[0], p.clipInv[1]), 0.0, 1.0);
  let b = clamp(0.5 - roundedBoxSd(px, p.shapeBox, p.shapeRadii, p.shapeRadiiY, p.shapeInv[0], p.shapeInv[1]), 0.0, 1.0);
  let m = maskAlpha(px, p.maskPaint, p.maskGeom, p.maskAlpha[0], p.maskAlpha[1], p.maskAt[0], p.maskAt[1], p.maskSpan);
  return a * b * m;
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

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// 与 blur.wgsl.ts 里的同名函数一致。saturation / tint 都是逐点仿射，
// 所以放在采样之后与放在模糊之前等价 —— 共享模糊链成立的前提。
fn applyColorFilter(rgb: vec3f, saturation: f32, tint: vec4f) -> vec3f {
  let g = luma(rgb);
  let saturated = mix(vec3f(g, g, g), rgb, saturation);
  return mix(saturated, tint.rgb, tint.a);
}

// 材质的 tint 是 CSS 颜色（sRGB 编码）。线性光模式下与采到的颜色（线性值）混之前先换成线性值；
// alpha 是叠加的强度，不是颜色，不换。
fn workingTint(t: vec4f) -> vec4f {
  if (stage.linear > 0.5) {
    return vec4f(srgbToLinear(t.rgb), t.a);
  }
  return t;
}

// 着色需要的全部输入：几何（已经算好的方向、位移、法线、sd）加材质。
struct Shading {
  sd: f32,
  coverage: f32,
  dir: vec2f,
  displacement: f32,
  offset: vec2f,        // 放大：采样点往中心挪的量（没有放大时是 0）
  bevel: f32,           // 倒角带里的位置：折射剖面按幅值 1 算（边缘 1、带的内边 0）
  vpos: f32,            // 竖直位置：0 顶、1 底（体光用）
  body: f32,            // 体光的强度（材质的 bodyLight，0 = 没有）
  normal: vec2f,
  tint: vec4f,
  blurLevel: f32,
  saturation: f32,
  dispersion: f32,
  highlight: f32,
  opacity: f32,
  rimPx: f32,
  glow: f32,            // 按压处的光在这个像素上的亮度（lightAt 的结果）
  veil: vec2f,          // 自适应的纱：(乘数, 往白混的比例)，(1, 0) 是没有
}

fn shade(px: vec2f, s: Shading) -> vec4f {
  // —— 折射、放大与色散 ——
  // 往里采样：dir 指向外侧，减掉它；放大再把采样点往中心挪 s.offset。
  let base = px - s.dir * s.displacement - s.offset;
  var sampled: vec3f;
  if (s.dispersion > 0.0) {
    // 三个通道沿同一方向往里采，长度按 spectralWeights 缩放：蓝最长、红最短。
    // 所以边缘每一点上蓝都比红采得更靠里 —— 四个角的关系完全一致。
    // 上游用 (x·y)/(hx·hy) 调制色散，这个关系逐象限翻转。
    let w = spectralWeights(s.dispersion);
    let sR = px - s.dir * (s.displacement * w.x) - s.offset;
    let sB = px - s.dir * (s.displacement * w.z) - s.offset;
    sampled = vec3f(
      textureSampleLevel(chain, samp, sR / stage.canvasSize, s.blurLevel).r,
      textureSampleLevel(chain, samp, base / stage.canvasSize, s.blurLevel).g,
      textureSampleLevel(chain, samp, sB / stage.canvasSize, s.blurLevel).b
    );
  } else {
    // dispersion = 0 走单次采样。这一支与 T7 的代码逐字相同，
    // 所以关掉色散时的输出与 T7 逐位一致（有整帧哈希比对为证）。
    sampled = textureSampleLevel(chain, samp, base / stage.canvasSize, s.blurLevel).rgb;
  }
  // 倒角带里饱和度更高：边上弯过来的颜色更艳（截图上滑块旋钮左缘那圈蓝）
  let bevel2 = s.bevel * s.bevel;
  let filtered = applyColorFilter(sampled, s.saturation * (1.0 + BEVEL_SATURATION * bevel2), workingTint(s.tint));
  let veiled = filtered * s.veil.x + (vec3f(1.0) - filtered * s.veil.x) * s.veil.y;
  let edgeGray = select(vec3f(EDGE_GRAY), srgbToLinear(vec3f(EDGE_GRAY)), stage.linear > 0.5);
  let edgePx = max(s.rimPx * EDGE_FRAC, 1.5);
  let edge = rimMask(s.sd, edgePx);
  let ndl = abs(dot(s.normal, RIM_LIGHT_DIR));
  let rgb = mix(veiled, edgeGray, EDGE_MIX * (1.0 - EDGE_TOP * ndl) * s.highlight * edge);

  // —— 光：亮边、倒角的辉光、体光，都是加性的 ——
  // 法线用纯 SDF 梯度（放大后的角半径），不混 depthEffect —— 与上游一致，
  // 高光描述的是面板轮廓的朝向，不是折射方向。
  let rim = rimLight(s.normal, RIM_LIGHT_DIR, RIM_BASE, RIM_GLOSS) * rimMask(s.sd + edgePx, s.rimPx) * (1.0 - edge) * (1.0 - edge) * RIM_GAIN;
  let body = bodyLight(s.vpos, BODY_SHADE, BODY_LIGHT) * s.body;
  let lit = (rim + BEVEL_GLOW * bevel2 + body) * s.highlight + s.glow;

  let a = s.coverage * s.opacity;
  // 光是加性的（体光顶上那条暗带是负的加性光）。
  //
  // **不钳 rgb ≤ a。** 原计划要钳，理由是预乘画布下 rgb > a 的合成结果未定义。
  // 但整个画布的 alpha 恒为 1（背景写 1，预乘混合保持 1 —— 实测全画布 alpha 皆为 255），
  // 所以画布边界上那条约束天然成立；而 pass 内部 rgb > a 就是加性光，混合方程处理得
  // 完全正确。钳制只会在低 opacity 时把高光压平，别无作用。
  //
  // 线性光模式下这里之前的一切（采样、调色、纱、亮边与暗边）都在线性光里，最后编码回 sRGB：
  // 画布上的合成（抗锯齿的边、投影）仍在编码空间，与 DOM 一样。
  var color = max(rgb + vec3f(lit, lit, lit), vec3f(0.0, 0.0, 0.0));
  if (stage.linear > 0.5) {
    color = linearToSrgb(color);
  }
  return vec4f(color * a, a);
}

// 影子的颜色（预乘之前）：玻璃背后的平均色压暗。线性光模式下平均色是线性值，编码回 sRGB 再用（画布上是编码值）。
fn shadowColor(avg: vec3f) -> vec3f {
  let c = avg * SHADOW_TINT;
  if (stage.linear > 0.5) {
    return linearToSrgb(c);
  }
  return c;
}

// 自适应（文字可读性）。玻璃看起来有多亮，由它背后在面板范围里的平均颜色、经过这块玻璃自己的调色算出；
// 浅色文字要求它不亮过 ADAPT_MAX_LUM，深色文字要求它不暗过 ADAPT_MIN_LUM（都按与文字 3:1 的对比度算）。
// 超出时给整块玻璃蒙一层纱：压暗是乘一个系数，提亮是往白混 —— 整块一样、不按像素，
// 否则会把玻璃里的图像压平。不超出时返回 (1, 0)，乘上去逐位不变。
const ADAPT_MAX_LUM: f32 = 0.3;   // 白字 3:1：1.05 / 3 − 0.05
const ADAPT_MIN_LUM: f32 = 0.1;   // 黑字 3:1：0.05 × 3 − 0.05
const ADAPT_LEVEL: f32 = 4.0;     // 在模糊链的第 4 级取样：一个纹素是 16 个场景像素的模糊平均

fn relLuminance(c: vec3f) -> f32 {
  let lin = srgbToLinear(clamp(c, vec3f(0.0), vec3f(1.0)));
  return dot(lin, vec3f(0.2126, 0.7152, 0.0722));
}

// 返回 (乘数, 往白混的比例)。默认模式下颜色是 sRGB 编码值：亮度的比较在「编码后的明度」上做
// （线性亮度的 1/2.2 次方），这样乘数与混合比例可以直接作用在编码值上。线性光模式下颜色本来就是
// 线性值：乘数就是亮度之比，往白混的比例按线性亮度解 lum + (1 − lum)·t = 目标。
fn adaptVeil(avg: vec3f, adapt: f32, saturation: f32, tint: vec4f) -> vec2f {
  if (adapt == 0.0) {
    return vec2f(1.0, 0.0);
  }
  let filtered = applyColorFilter(avg, saturation, workingTint(tint));
  let linear = stage.linear > 0.5;
  let lum = select(
    relLuminance(filtered),
    dot(clamp(filtered, vec3f(0.0), vec3f(1.0)), vec3f(0.2126, 0.7152, 0.0722)),
    linear
  );
  let strength = abs(adapt);
  if (adapt > 0.0 && lum > ADAPT_MAX_LUM) {
    let ratio = ADAPT_MAX_LUM / lum;
    let scale = select(pow(ratio, 1.0 / 2.2), ratio, linear);
    return vec2f(1.0 - (1.0 - scale) * strength, 0.0);
  }
  if (adapt < 0.0 && lum < ADAPT_MIN_LUM) {
    if (linear) {
      return vec2f(1.0, (ADAPT_MIN_LUM - lum) / max(1.0 - lum, 1e-6) * strength);
    }
    let e = pow(max(lum, 0.0), 1.0 / 2.2);
    let goal = pow(ADAPT_MIN_LUM, 1.0 / 2.2);
    return vec2f(1.0, (goal - e) / max(1.0 - e, 1e-6) * strength);
  }
  return vec2f(1.0, 0.0);
}

// 面板背后的平均颜色：中心与四个象限中心，在模糊链的粗级别上取样。单块面板与合并组共用
// （合并组逐个成员算，与单独绘制时逐位相同）。chain / samp / stage 由各模块自己声明 ——
// WGSL 模块作用域的声明与顺序无关。
fn panelAverage(rect: vec4f) -> vec3f {
  var sum = vec3f(0.0);
  let spots = array<vec2f, 5>(vec2f(0.5, 0.5), vec2f(0.25, 0.25), vec2f(0.75, 0.25), vec2f(0.25, 0.75), vec2f(0.75, 0.75));
  for (var i = 0; i < 5; i++) {
    let p = rect.xy + rect.zw * spots[i];
    sum += textureSampleLevel(chain, samp, p / stage.canvasSize, ADAPT_LEVEL).rgb;
  }
  return sum / 5.0;
}

// 调试视图，两个模块共用。mode 与 DEBUG_MODES 的下标一致；返回 alpha < 0 表示「不是调试模式」。
fn debugView(mode: u32, sd: f32, coverage: f32, dir: vec2f, displacement: f32, amountPx: f32) -> vec4f {
  if (mode == 1u) {
    // SDF：内部蓝、外部橙，等值线每 ~10px 一条，边界处一道白线。
    // 这个视图该是一圈干净的圆角矩形等距线 —— 不是的话，下游都不值得查。
    let bands = 0.5 + 0.5 * cos(sd * 0.6);
    let side = select(vec3f(0.95, 0.55, 0.25), vec3f(0.25, 0.55, 0.95), sd < 0.0);
    let edge = 1.0 - smoothstep(0.0, 1.5, abs(sd));
    return vec4f(mix(side * (0.55 + 0.45 * bands), vec3f(1.0, 1.0, 1.0), edge), 1.0);
  }
  if (mode == 2u) {
    return vec4f(coverage, coverage, coverage, 1.0);
  }
  if (mode == 3u) {
    // 折射方向当法线图看：R = x，G = y。角上的方向场应当连续旋转，不该有折痕。
    return vec4f(dir * 0.5 + 0.5, 0.0, 1.0);
  }
  if (mode == 4u) {
    let m = displacement / max(amountPx, 1e-6);
    return vec4f(m, m, m, 1.0);
  }
  return vec4f(0.0, 0.0, 0.0, -1.0);
}
`

export const GLASS_WGSL = /* wgsl */ `
${GLASS_COMMON_WGSL}

@group(0) @binding(0) var<uniform> panel: Panel;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var chain: texture_2d<f32>;
@group(0) @binding(3) var<uniform> stage: Stage;

struct Optics {
  centered: vec2f,
  halfSize: vec2f,
  radius: f32,
  sd: f32,
  dir: vec2f,
  displacement: f32,
}

// 正常 pass 与探针 pass 共用这一段，保证两者算的是同一个东西 ——
// 探针验证的必须就是实际渲染用的那条路径，否则验了也白验。
fn evalOptics(px: vec2f) -> Optics {
  var o: Optics;
  o.halfSize = panel.rect.zw * 0.5;
  // 形状在面板自己的坐标系里算（有旋转时先把像素转进去），折射方向再转回屏幕坐标
  o.centered = toLocal(px - (panel.rect.xy + o.halfSize), panel.pose);
  o.radius = radiusAt(o.centered, panel.radii);
  o.sd = sdRoundedRect(o.centered, o.halfSize, o.radius);
  let gradR = gradRadiusOf(o.radius, o.halfSize);
  o.dir = toWorld(refractionDirection(o.centered, o.halfSize, gradR, panel.depthEffect), panel.pose);
  o.displacement = refractionProfile(o.sd, panel.heightPx, panel.amountPx, panel.squircle);
  return o;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let px = in.pos.xy;
  let o = evalOptics(px);
  // 1px 抗锯齿：sd 以像素为单位，所以 0.5 - sd 在边界两侧各半个像素内从 1 过渡到 0。
  // 再乘上裁剪区域的覆盖率（祖先的圆角）。探针不乘 —— 它验的是光学，不是裁剪。
  let clip = clipCoverage(px, panel);
  let coverage = clamp(0.5 - o.sd, 0.0, 1.0) * clip;

  let debug = debugView(u32(panel.debugMode + 0.5), o.sd, coverage, o.dir, o.displacement, panel.amountPx);
  if (debug.a >= 0.0) {
    return debug;
  }

  // 投影：往下挪、往里缩的同一个形状（shadowSd）。与玻璃一样受裁剪、跟着不透明度
  let shade0 = shadowAlpha(shadowSd(o.centered, o.halfSize, panel.radii, panel.shadow, panel.pose), panel.shadow.x, panel.shadow.y) * clip * panel.opacity;
  // 玻璃背后的平均色：自适应与影子的颜色共用
  let avg = panelAverage(panel.rect);

  if (coverage <= 0.0) {
    if (shade0 <= 0.0) {
      discard;
    }
    return vec4f(shadowColor(avg) * shade0, shade0); // 玻璃外面只有影子（预乘）
  }

  var s: Shading;
  s.sd = o.sd;
  s.coverage = coverage;
  s.dir = o.dir;
  s.displacement = o.displacement;
  // 放大：pose.z = m / (1 + m)，采样点往中心挪（屏幕坐标，旋转不影响）
  s.offset = (px - (panel.rect.xy + o.halfSize)) * panel.pose.z;
  s.bevel = refractionProfile(o.sd, panel.heightPx, 1.0, panel.squircle);
  // 竖直位置：pose.w 是 1 ÷ 面板的高（CPU 算好，着色器里不除以 uniform）
  s.vpos = clamp((o.centered.y + o.halfSize.y) * panel.pose.w, 0.0, 1.0);
  s.body = panel.extra.x;
  s.normal = toWorld(safeNormalize(gradSdRoundedRect(o.centered, o.halfSize, gradRadiusOf(o.radius, o.halfSize))), panel.pose);
  s.tint = panel.tint;
  s.blurLevel = panel.blurLevel;
  s.saturation = panel.saturation;
  s.dispersion = panel.dispersion;
  s.highlight = panel.highlight;
  s.opacity = panel.opacity;
  s.rimPx = panel.rimPx;
  s.glow = lightAt(px, panel.light);
  s.veil = adaptVeil(avg, panel.adapt, panel.saturation, panel.tint);
  // 抗锯齿的那一圈边上，影子垫在玻璃下面
  let glass = shade(px, s);
  let under = shade0 * (1.0 - glass.a);
  return vec4f(glass.rgb + shadowColor(avg) * under, glass.a + under);
}

/**
 * 探针入口：不画颜色，直接把光学中间量原样写进 rgba32float。
 *   r = sd, g = dir.x, b = dir.y, a = displacement
 * 回读之后与 src/core/optics.ts 的 CPU 实现逐像素比对。
 */
@fragment fn fsProbe(in: VsOut) -> @location(0) vec4f {
  let px = in.pos.xy + stage.probeOrigin;
  let o = evalOptics(px);
  return vec4f(o.sd, o.dir.x, o.dir.y, o.displacement);
}
`
