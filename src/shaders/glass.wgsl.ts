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

export const GLASS_WGSL = /* wgsl */ `
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
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> panel: Panel;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var chain: texture_2d<f32>;
@group(0) @binding(3) var<uniform> stage: Stage;

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

  let mode = u32(panel.debugMode + 0.5);
  if (mode == 1u) {
    // SDF：内部蓝、外部橙，等值线每 ~10px 一条，边界处一道白线。
    // 这个视图该是一圈干净的圆角矩形等距线 —— 不是的话，下游都不值得查。
    let bands = 0.5 + 0.5 * cos(o.sd * 0.6);
    let side = select(vec3f(0.95, 0.55, 0.25), vec3f(0.25, 0.55, 0.95), o.sd < 0.0);
    let edge = 1.0 - smoothstep(0.0, 1.5, abs(o.sd));
    return vec4f(mix(side * (0.55 + 0.45 * bands), vec3f(1.0, 1.0, 1.0), edge), 1.0);
  }
  if (mode == 2u) {
    return vec4f(coverage, coverage, coverage, 1.0);
  }
  if (mode == 3u) {
    // 折射方向当法线图看：R = x，G = y。角上的方向场应当连续旋转，不该有折痕。
    return vec4f(o.dir * 0.5 + 0.5, 0.0, 1.0);
  }
  if (mode == 4u) {
    let m = o.displacement / max(panel.amountPx, 1e-6);
    return vec4f(m, m, m, 1.0);
  }

  if (coverage <= 0.0) {
    discard;
  }

  // 往里采样：dir 指向外侧，减掉它。
  let samplePx = px - o.dir * o.displacement;
  let uv = samplePx / stage.canvasSize;
  let c = textureSampleLevel(chain, samp, uv, panel.blurLevel);
  let rgb = applyColorFilter(c.rgb, panel.saturation, panel.tint);

  let a = coverage * panel.opacity;
  // 输出预乘色。rgb ≤ 1 时 rgb·a ≤ a 天然成立，这个钳制在 T8 加上高光之后才真正起作用。
  return premultiplyClamp(rgb * a, a);
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
