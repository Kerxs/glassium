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
export const PANEL_STRUCT_BYTES = 96
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
  _pad1: f32,
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
  let rgb = applyColorFilter(sampled, s.saturation, s.tint);

  // —— 高光 ——
  // 法线用纯 SDF 梯度（放大后的角半径），不混 depthEffect —— 与上游一致，
  // 高光描述的是面板轮廓的朝向，不是折射方向。
  let terms = highlightTerms(s.normal, LIGHT_DIR, GLOSS) * rimMask(s.sd, s.rimPx) * s.highlight;
  let lit = terms.x;
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
  let coverage = clamp(0.5 - o.sd, 0.0, 1.0);

  let debug = debugView(u32(panel.debugMode + 0.5), o.sd, coverage, o.dir, o.displacement, panel.amountPx);
  if (debug.a >= 0.0) {
    return debug;
  }

  if (coverage <= 0.0) {
    discard;
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
  return shade(px, s);
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
