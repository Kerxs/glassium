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

/** Panel 结构体的字节数。按 256B 步长排进一条 buffer，用动态偏移切换。 */
export const PANEL_STRUCT_BYTES = 160
/** 每块面板在 uniform buffer 里占的步长。T5 实测 minUniformBufferOffsetAlignment = 256。 */
export const PANEL_STRIDE = 256
/** Float32 视角下的步长。 */
export const PANEL_STRIDE_FLOATS = PANEL_STRIDE / 4

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

struct Stage {
  canvasSize: vec2f,
  // 探针 pass 专用：探针目标只覆盖面板那一块，片元位置要加上这块在画布里的原点。
  // 正常 pass 里恒为 (0, 0)。
  probeOrigin: vec2f,
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
  clipRadii: vec4f,     // 可见区域四角的圆角 TL, TR, BR, BL
  light: vec4f,         // 按压处的光：中心 x、y，σ（画布设备像素），强度（0 = 没有）
  shadow: vec4f,        // 投影：峰值 alpha、σ、向下的偏移（画布设备像素）、空
}

// 光源方向：指向光源的单位向量，屏幕坐标（y 向下）。左上 45°。
// 于是上边和左边受光、右边和下边背光；左上角最亮、右下角暗边最深、另两角居中。
// 选 45° 是为了验证时四个角的预期各不相同，一眼能对上。
const LIGHT_DIR: vec2f = vec2f(-0.70710678, -0.70710678);
// 高光对入射角的集中程度。2 = 左上角满强度、上边与左边约一半。
const GLOSS: f32 = 2.0;
// 暗边相对亮边的强度。Apple 的那道暗边很淡，所以远小于 1。
const DARK_RIM: f32 = 0.35;

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

// 投影：形状往下挪 offset 之后的 SDF，外面按高斯衰减，里面是峰值（被玻璃盖住的那部分看不见）。
// 强度 0 时恰好是 0 —— 该丢弃的片元照样丢弃，其余加上去逐位不变。
fn shadowAlpha(sdShifted: f32, strength: f32, sigma: f32) -> f32 {
  if (strength <= 0.0) {
    return 0.0;
  }
  let d = max(sdShifted, 0.0);
  return strength * exp(-d * d / (2.0 * sigma * sigma));
}

fn clipCoverage(px: vec2f, box: vec4f, radii: vec4f) -> f32 {
  let c = (box.xy + box.zw) * 0.5;
  let right = px.x > c.x;
  let bottom = px.y > c.y;
  let r = select(select(radii.x, radii.y, right), select(radii.w, radii.z, right), bottom);
  let e = vec2f(max(box.x - px.x, px.x - box.z), max(box.y - px.y, px.y - box.w)) + r;
  let sd = length(max(e, vec2f(0.0, 0.0))) + min(max(e.x, e.y), 0.0) - r;
  return clamp(0.5 - sd, 0.0, 1.0);
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

// 着色需要的全部输入：几何（已经算好的方向、位移、法线、sd）加材质。
struct Shading {
  sd: f32,
  coverage: f32,
  dir: vec2f,
  displacement: f32,
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
  // —— 折射与色散 ——
  // 往里采样：dir 指向外侧，减掉它。
  let base = px - s.dir * s.displacement;
  var sampled: vec3f;
  if (s.dispersion > 0.0) {
    // 三个通道沿同一方向往里采，长度按 spectralWeights 缩放：蓝最长、红最短。
    // 所以边缘每一点上蓝都比红采得更靠里 —— 四个角的关系完全一致。
    // 上游用 (x·y)/(hx·hy) 调制色散，这个关系逐象限翻转。
    let w = spectralWeights(s.dispersion);
    let sR = px - s.dir * (s.displacement * w.x);
    let sB = px - s.dir * (s.displacement * w.z);
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
  let filtered = applyColorFilter(sampled, s.saturation, s.tint);
  let rgb = filtered * s.veil.x + (vec3f(1.0) - filtered * s.veil.x) * s.veil.y;

  // —— 高光 ——
  // 法线用纯 SDF 梯度（放大后的角半径），不混 depthEffect —— 与上游一致，
  // 高光描述的是面板轮廓的朝向，不是折射方向。
  let terms = highlightTerms(s.normal, LIGHT_DIR, GLOSS) * rimMask(s.sd, s.rimPx) * s.highlight;
  let lit = terms.x + s.glow;
  let dark = terms.y * DARK_RIM;

  let a = s.coverage * s.opacity;
  // 暗边按比例压暗玻璃本身；亮边是加性光。
  //
  // **不钳 rgb ≤ a。** 原计划要钳，理由是预乘画布下 rgb > a 的合成结果未定义。
  // 但整个画布的 alpha 恒为 1（背景写 1，预乘混合保持 1 —— 实测全画布 alpha 皆为 255），
  // 所以画布边界上那条约束天然成立；而 pass 内部 rgb > a 就是加性光，混合方程处理得
  // 完全正确。钳制只会在低 opacity 时把高光压平，别无作用。
  return vec4f((rgb * (1.0 - dark) + vec3f(lit, lit, lit)) * a, a);
}

// 自适应（文字可读性）。玻璃看起来有多亮，由它背后在面板范围里的平均颜色、经过这块玻璃自己的调色算出；
// 浅色文字要求它不亮过 ADAPT_MAX_LUM，深色文字要求它不暗过 ADAPT_MIN_LUM（都按与文字 3:1 的对比度算）。
// 超出时给整块玻璃蒙一层纱：压暗是乘一个系数，提亮是往白混 —— 整块一样、不按像素，
// 否则会把玻璃里的图像压平。不超出时返回 (1, 0)，乘上去逐位不变。
const ADAPT_MAX_LUM: f32 = 0.3;   // 白字 3:1：1.05 / 3 − 0.05
const ADAPT_MIN_LUM: f32 = 0.1;   // 黑字 3:1：0.05 × 3 − 0.05
const ADAPT_LEVEL: f32 = 4.0;     // 在模糊链的第 4 级取样：一个纹素是 16 个场景像素的模糊平均

fn relLuminance(c: vec3f) -> f32 {
  let s = clamp(c, vec3f(0.0), vec3f(1.0));
  let lin = select(pow((s + 0.055) / 1.055, vec3f(2.4)), s / 12.92, s <= vec3f(0.04045));
  return dot(lin, vec3f(0.2126, 0.7152, 0.0722));
}

// 返回 (乘数, 往白混的比例)。亮度的比较在「编码后的明度」上做（线性亮度的 1/2.2 次方），
// 这样乘数与混合比例可以直接作用在 sRGB 编码的颜色上。
fn adaptVeil(avg: vec3f, adapt: f32, saturation: f32, tint: vec4f) -> vec2f {
  if (adapt == 0.0) {
    return vec2f(1.0, 0.0);
  }
  let lum = relLuminance(applyColorFilter(avg, saturation, tint));
  let strength = abs(adapt);
  if (adapt > 0.0 && lum > ADAPT_MAX_LUM) {
    let scale = pow(ADAPT_MAX_LUM / lum, 1.0 / 2.2);
    return vec2f(1.0 - (1.0 - scale) * strength, 0.0);
  }
  if (adapt < 0.0 && lum < ADAPT_MIN_LUM) {
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
  o.centered = px - (panel.rect.xy + o.halfSize);
  o.radius = radiusAt(o.centered, panel.radii);
  o.sd = sdRoundedRect(o.centered, o.halfSize, o.radius);
  let gradR = gradRadiusOf(o.radius, o.halfSize);
  o.dir = refractionDirection(o.centered, o.halfSize, gradR, panel.depthEffect);
  o.displacement = refractionProfile(o.sd, panel.heightPx, panel.amountPx, panel.squircle);
  return o;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let px = in.pos.xy;
  let o = evalOptics(px);
  // 1px 抗锯齿：sd 以像素为单位，所以 0.5 - sd 在边界两侧各半个像素内从 1 过渡到 0。
  // 再乘上裁剪区域的覆盖率（祖先的圆角）。探针不乘 —— 它验的是光学，不是裁剪。
  let clip = clipCoverage(px, panel.clip, panel.clipRadii);
  let coverage = clamp(0.5 - o.sd, 0.0, 1.0) * clip;

  let debug = debugView(u32(panel.debugMode + 0.5), o.sd, coverage, o.dir, o.displacement, panel.amountPx);
  if (debug.a >= 0.0) {
    return debug;
  }

  // 投影：往下挪 offset 的同一个形状。与玻璃一样受裁剪、跟着不透明度
  let shifted = o.centered - vec2f(0.0, panel.shadow.z);
  let sdShadow = sdRoundedRect(shifted, o.halfSize, radiusAt(shifted, panel.radii));
  let shade0 = shadowAlpha(sdShadow, panel.shadow.x, panel.shadow.y) * clip * panel.opacity;

  if (coverage <= 0.0) {
    if (shade0 <= 0.0) {
      discard;
    }
    return vec4f(0.0, 0.0, 0.0, shade0); // 玻璃外面只有影子：预乘的黑
  }

  var s: Shading;
  s.sd = o.sd;
  s.coverage = coverage;
  s.dir = o.dir;
  s.displacement = o.displacement;
  s.normal = safeNormalize(gradSdRoundedRect(o.centered, o.halfSize, gradRadiusOf(o.radius, o.halfSize)));
  s.tint = panel.tint;
  s.blurLevel = panel.blurLevel;
  s.saturation = panel.saturation;
  s.dispersion = panel.dispersion;
  s.highlight = panel.highlight;
  s.opacity = panel.opacity;
  s.rimPx = panel.rimPx;
  s.glow = lightAt(px, panel.light);
  s.veil = adaptVeil(panelAverage(panel.rect), panel.adapt, panel.saturation, panel.tint);
  // 抗锯齿的那一圈边上，影子垫在玻璃下面
  let glass = shade(px, s);
  return vec4f(glass.rgb, glass.a + shade0 * (1.0 - glass.a));
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
