/**
 * 合并组的玻璃 pass —— `<glass-container>`。
 *
 * 一组最多 4 块面板，一次 draw：全屏三角形用 scissor 限定到成员并集外扩 k/4
 * （合并形状不会超出这个范围，见 core/merge.ts 的 mergeBleed）。片元里逐个成员算
 * sd / 方向 / 法线，用 smin 折叠成一个场，然后走与单块面板**同一段** shade()。
 *
 * 数学逐行对应 src/core/merge.ts 的 evalMergedOptics；探针入口 fsProbe 把合并后的
 * 光学量原样写出来，与 CPU 逐像素比对。
 *
 * ## 为什么混合不用 mix()
 *
 * WGSL 规范把 mix(a, b, h) 定义为 a·(1−h) + b·h，但 D3D 后端把它编成 HLSL 的 lerp，
 * 也就是 a + h·(b − a)。h = 1 时后者不一定精确等于 b。而「没有发生混合的像素逐位取自
 * 最近的成员」这条性质要求 h 恰为 0 或 1 时混合结果精确 —— 所以这里一律显式写
 * a·(1−h) + b·h（与 sminGradient 同一个形式），哪怕编译器把它收缩成 fma，h 为 0 或 1 时
 * 结果也是精确的。
 */

import { GLASS_COMMON_WGSL, PANEL_STRUCT_BYTES } from './glass.wgsl.ts'

/** 一组最多几块。与 core/merge.ts 的 MAX_GROUP_MEMBERS 一致（有测试核对）。 */
export const GROUP_CAPACITY = 4
/** Group 结构体的字节数：16B 的头 + 4 × 144B 的成员 = 592B。 */
export const GROUP_STRUCT_BYTES = 16 + GROUP_CAPACITY * PANEL_STRUCT_BYTES
/** 每组在 uniform buffer 里占的步长：三个 256B 槽位（动态偏移仍按 256 对齐）。 */
export const GROUP_STRIDE = 768
export const GROUP_STRIDE_FLOATS = GROUP_STRIDE / 4

export const GLASS_GROUP_WGSL = /* wgsl */ `
${GLASS_COMMON_WGSL}

struct Group {
  header: vec4f,                    // x = 成员数, y = smoothing k（画布设备像素）, z = debugMode, w = 未用
  members: array<Panel, ${GROUP_CAPACITY}>,
}

@group(0) @binding(0) var<uniform> group: Group;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var chain: texture_2d<f32>;
@group(0) @binding(3) var<uniform> stage: Stage;

struct MemberOptics {
  sd: f32,
  dir: vec2f,
  normal: vec2f,
}

// 与单块面板的 evalOptics 完全相同的几行。
fn memberOptics(p: Panel, px: vec2f) -> MemberOptics {
  let halfSize = p.rect.zw * 0.5;
  let centered = px - (p.rect.xy + halfSize);
  let radius = radiusAt(centered, p.radii);
  let gradR = gradRadiusOf(radius, halfSize);
  var m: MemberOptics;
  m.sd = sdRoundedRect(centered, halfSize, radius);
  m.dir = refractionDirection(centered, halfSize, gradR, p.depthEffect);
  m.normal = safeNormalize(gradSdRoundedRect(centered, halfSize, gradR));
  return m;
}

// a·(1−h) + b·h —— 不用 mix()，理由见文件头。
fn blend1(a: f32, b: f32, h: f32) -> f32 {
  return a * (1.0 - h) + b * h;
}

fn blend4(a: vec4f, b: vec4f, h: f32) -> vec4f {
  return a * (1.0 - h) + b * h;
}

struct Merged {
  sd: f32,
  dir: vec2f,
  normal: vec2f,
  displacement: f32,
  tint: vec4f,
  heightPx: f32,
  amountPx: f32,
  blurLevel: f32,
  saturation: f32,
  squircle: f32,
  dispersion: f32,
  highlight: f32,
  opacity: f32,
  rimPx: f32,
}

fn evalGroup(px: vec2f) -> Merged {
  let count = min(u32(group.header.x + 0.5), ${GROUP_CAPACITY}u);
  let k = group.header.y;

  let first = group.members[0];
  let f = memberOptics(first, px);
  var m: Merged;
  m.sd = f.sd;
  m.dir = f.dir;
  m.normal = f.normal;
  m.tint = first.tint;
  m.heightPx = first.heightPx;
  m.amountPx = first.amountPx;
  m.blurLevel = first.blurLevel;
  m.saturation = first.saturation;
  m.squircle = first.squircle;
  m.dispersion = first.dispersion;
  m.highlight = first.highlight;
  m.opacity = first.opacity;
  m.rimPx = first.rimPx;

  var blended = false;
  for (var i = 1u; i < count; i++) {
    let p = group.members[i];
    let c = memberOptics(p, px);
    let s = smin(c.sd, m.sd, k);
    let h = s.y;
    m.sd = s.x;
    m.dir = sminGradient(c.dir, m.dir, h);
    m.normal = sminGradient(c.normal, m.normal, h);
    m.tint = blend4(m.tint, p.tint, h);
    m.heightPx = blend1(m.heightPx, p.heightPx, h);
    m.amountPx = blend1(m.amountPx, p.amountPx, h);
    m.blurLevel = blend1(m.blurLevel, p.blurLevel, h);
    m.saturation = blend1(m.saturation, p.saturation, h);
    m.squircle = blend1(m.squircle, p.squircle, h);
    m.dispersion = blend1(m.dispersion, p.dispersion, h);
    m.highlight = blend1(m.highlight, p.highlight, h);
    m.opacity = blend1(m.opacity, p.opacity, h);
    m.rimPx = blend1(m.rimPx, p.rimPx, h);
    blended = blended || (h > 0.0 && h < 1.0);
  }

  // 颈部两侧方向相对，混合后的向量变短 —— 长度就是方向的一致度，位移乘上它。
  // 没有混合过的像素原样保留成员自己的量（不归一化、不乘长度），与单块面板逐位相同。
  let agreement = select(1.0, length(m.dir), blended);
  m.dir = select(m.dir, safeNormalize(m.dir), blended);
  m.normal = select(m.normal, safeNormalize(m.normal), blended);
  m.displacement = refractionProfile(m.sd, m.heightPx, m.amountPx, m.squircle) * agreement;
  return m;
}

// 成员各自的裁剪区域取并集（任一成员的区域允许就可见）。成员通常同在一个容器里，那就是那个容器。
// 成员各自的光斑相加：只有被按下的那块有光，其余贡献 0。
fn groupGlow(px: vec2f) -> f32 {
  let count = min(u32(group.header.x + 0.5), ${GROUP_CAPACITY}u);
  var g = 0.0;
  for (var i = 0u; i < count; i++) {
    g += lightAt(px, group.members[i].light);
  }
  return g;
}

fn groupClip(px: vec2f) -> f32 {
  let count = min(u32(group.header.x + 0.5), ${GROUP_CAPACITY}u);
  var c = clipCoverage(px, group.members[0].clip, group.members[0].clipRadii);
  for (var i = 1u; i < count; i++) {
    c = max(c, clipCoverage(px, group.members[i].clip, group.members[i].clipRadii));
  }
  return c;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let px = in.pos.xy;
  let m = evalGroup(px);
  let coverage = clamp(0.5 - m.sd, 0.0, 1.0) * groupClip(px);

  let debug = debugView(u32(group.header.z + 0.5), m.sd, coverage, m.dir, m.displacement, m.amountPx);
  if (debug.a >= 0.0) {
    return debug;
  }

  if (coverage <= 0.0) {
    discard;
  }

  var s: Shading;
  s.sd = m.sd;
  s.coverage = coverage;
  s.dir = m.dir;
  s.displacement = m.displacement;
  s.normal = m.normal;
  s.tint = m.tint;
  s.blurLevel = m.blurLevel;
  s.saturation = m.saturation;
  s.dispersion = m.dispersion;
  s.highlight = m.highlight;
  s.opacity = m.opacity;
  s.rimPx = m.rimPx;
  s.glow = groupGlow(px);
  return shade(px, s);
}

// 探针：r = sd, g = dir.x, b = dir.y, a = displacement（已乘一致度）。
@fragment fn fsProbe(in: VsOut) -> @location(0) vec4f {
  let px = in.pos.xy + stage.probeOrigin;
  let m = evalGroup(px);
  return vec4f(m.sd, m.dir.x, m.dir.y, m.displacement);
}
`
