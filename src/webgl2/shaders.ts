/**
 * WebGL2 后端的着色器（GLSL ES 3.00）。
 *
 * 光学函数来自 OPTICS_GLSL —— 由 scripts/gen-glsl.ts 从 WGSL 真源机械生成，这里一行不改。
 * 这个文件手写的只有各后端本来就不同的部分：入口、绑定（uniform / UBO）、像素坐标的约定。
 * 每一段都与 WebGPU 那边的同名着色器逐段对应（scene / blur / backdrop / glass / glass-group），
 * 改一边就去对另一边。
 *
 * ## 坐标：只在上屏时翻一次
 *
 * WebGPU 的帧缓冲与纹理都是**第 0 行在上**；WebGL 的 gl_FragCoord 与默认帧缓冲是
 * **第 0 行在下**。约定：
 *
 * - 离屏 pass（场景、模糊、探针）不翻：gl_FragCoord.y 直接当成「从上往下数」。于是纹理在
 *   显存里的排布与 WebGPU 完全相同（第 0 行 = 屏幕顶部），之后按 uv（y 向下）采样也就对得上。
 * - 上屏 pass（背景、玻璃、合并组）翻一次：px.y = 画布高 − gl_FragCoord.y。
 * - scissor 与 readPixels 用的也是 GL 的左下原点，在 renderer.ts 里各换算一次。
 *
 * 全后端只有这几处翻转。翻两次和不翻看起来一样是正的，但中间任何一步采样都会错位 ——
 * 所以验证是拿两个后端的整帧回读逐像素比，而不是看截图。
 */

import { OPTICS_GLSL } from '../shaders/generated/optics.glsl.ts'

const HEADER = `#version 300 es
precision highp float;
precision highp int;
`

/**
 * 全屏三角形。没有顶点属性，用 gl_VertexID 生成（与 WGSL 的 vertex_index 同一个三角形）。
 * uFlipUv = 1 时 uv 的 y 向下对应上屏（默认帧缓冲第 0 行在下），= 0 时对应离屏。
 */
export const FULLSCREEN_VS = `${HEADER}
uniform float uFlipUv;
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  float v = uFlipUv > 0.5 ? (1.0 - p.y) * 0.5 : (1.0 + p.y) * 0.5;
  vUv = vec2((p.x + 1.0) * 0.5, v);
}
`

/** 与 scene.wgsl.ts 的 SCENE_WGSL 逐段对应。 */
export const SCENE_FS = `${HEADER}
uniform vec4 uScene0;   // resolution.xy, time, mode
uniform vec4 uScene1;   // center.xy（uv）, radius, _
in vec2 vUv;
out vec4 outColor;

vec3 palette(float t) {
  vec3 c0 = vec3(0.682, 0.835, 0.953);
  vec3 c1 = vec3(0.180, 0.345, 0.643);
  vec3 c2 = vec3(0.016, 0.063, 0.122);
  float k = clamp(t, 0.0, 1.0);
  vec3 lower = mix(c0, c1, smoothstep(0.0, 0.55, k));
  return mix(lower, c2, smoothstep(0.55, 1.0, k));
}

vec3 calibration(vec2 uv, vec2 res) {
  vec2 p = uv * res;
  float cell = 24.0;
  float checker = step(0.5, fract((floor(p.x / cell) + floor(p.y / cell)) * 0.5));
  // 两条硬边都挪开 1/4 像素，永远不经过像素中心 —— 理由见 scene.wgsl.ts
  float halfPlane = step(0.0, p.x + p.y - (res.x + res.y) * 0.5 + 0.25);
  float vstep = step(res.x * 0.5 - 0.25, p.x);
  vec3 right = mix(vec3(0.04, 0.04, 0.05), vec3(0.96, 0.96, 0.98), vstep);
  return mix(vec3(checker, checker, checker), right, halfPlane);
}

void main() {
  vec2 resolution = uScene0.xy;
  float time = uScene0.z;
  float mode = uScene0.w;
  if (mode > 2.5) {
    outColor = vec4(0.5, 0.5, 0.5, 1.0);
    return;
  }
  if (mode > 1.5) {
    float aspect = resolution.x / max(resolution.y, 1.0);
    vec2 p = vec2(vUv.x * aspect, vUv.y);
    vec2 c = vec2(uScene1.x * aspect, uScene1.y);
    float v = clamp(length(p - c) / max(uScene1.z, 1e-6), 0.0, 1.0);
    outColor = vec4(v, v, v, 1.0);
    return;
  }
  if (mode > 0.5) {
    outColor = vec4(calibration(vUv, resolution), 1.0);
    return;
  }
  float aspect = resolution.x / max(resolution.y, 1.0);
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  float drift = sin(time * 0.25) * 0.06;
  float t = clamp((p.x * 0.45 + p.y * 0.85) * 0.78 + drift, 0.0, 1.0);
  outColor = vec4(palette(t), 1.0);
}
`

/** 与 scene.wgsl.ts 的 SCENE_IMAGE_WGSL 对应。离屏，vUv 不翻（纹理第 0 行 = 屏幕顶部）。 */
export const SCENE_IMAGE_FS = `${HEADER}
uniform sampler2D uImage;
uniform vec4 uUv;          // uvScale.xy, uvOffset.xy
uniform vec4 uBackground;  // rgb, _
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 uv = vUv * uUv.xy + uUv.zw;
  bool inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  vec4 c = textureLod(uImage, clamp(uv, vec2(0.0), vec2(1.0)), 0.0);
  vec3 rgb = mix(uBackground.rgb, c.rgb, c.a);
  outColor = vec4(inside ? rgb : uBackground.rgb, 1.0);
}
`

/**
 * 与 blur.wgsl.ts 的 BLUR_WGSL 对应。WebGPU 那边用单级视图（baseMipLevel = k−1）采样，
 * 这里用 textureLod 指定整数级 —— 整数 lod 下线性 mip 过滤只取那一级，两者等价。
 */
export const BLUR_FS = `${HEADER}
uniform sampler2D uSrc;
uniform vec4 uBlur;   // texelSize.xy, sigma, vertical
uniform float uLod;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 dir = uBlur.w > 0.5 ? vec2(0.0, uBlur.y) : vec2(uBlur.x, 0.0);
  float s2 = 2.0 * uBlur.z * uBlur.z;
  float w0 = 1.0;
  float w1 = exp(-1.0 / s2);
  float w2 = exp(-4.0 / s2);
  float norm = 1.0 / (w0 + 2.0 * w1 + 2.0 * w2);
  vec4 acc = textureLod(uSrc, vUv, uLod) * w0;
  acc += textureLod(uSrc, vUv + dir, uLod) * w1;
  acc += textureLod(uSrc, vUv - dir, uLod) * w1;
  acc += textureLod(uSrc, vUv + dir * 2.0, uLod) * w2;
  acc += textureLod(uSrc, vUv - dir * 2.0, uLod) * w2;
  outColor = acc * norm;
}
`

const COLOR_FILTER = `
float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 applyColorFilter(vec3 rgb, float saturation, vec4 tint) {
  float g = luma(rgb);
  vec3 saturated = mix(vec3(g, g, g), rgb, saturation);
  return mix(saturated, tint.rgb, tint.a);
}
`

/** 与 blur.wgsl.ts 的 BACKDROP_WGSL 对应。上屏，vUv 已翻转。 */
export const BACKDROP_FS = `${HEADER}
uniform sampler2D uChain;
uniform vec4 uTint;
uniform vec4 uParams;   // saturation, level, _, _
in vec2 vUv;
out vec4 outColor;
${COLOR_FILTER}
void main() {
  vec4 sampled = textureLod(uChain, vUv, uParams.y);
  outColor = vec4(applyColorFilter(sampled.rgb, uParams.x, uTint), 1.0);
}
`

/** 与 glass.wgsl.ts 的 GLASS_COMMON_WGSL 对应。 */
const GLASS_COMMON = `
${OPTICS_GLSL}

struct Panel {
  vec4 rect;
  vec4 radii;
  vec4 tint;
  float heightPx;
  float amountPx;
  float blurLevel;
  float saturation;
  float squircle;
  float depthEffect;
  float dispersion;
  float highlight;
  float opacity;
  float debugMode;
  float rimPx;
  float adapt;
  vec4 clip;
  vec4 clipRadii;
  vec4 light;
};

const vec2 LIGHT_DIR = vec2(-0.70710678, -0.70710678);
const float GLOSS = 2.0;
const float DARK_RIM = 0.35;

uniform sampler2D chain;
uniform vec4 uStage;       // canvasSize.xy, probeOrigin.xy
uniform float uOnScreen;   // 1 = 默认帧缓冲（翻 y），0 = 探针目标（不翻，加原点）

out vec4 outColor;

// 片元的画布设备像素坐标，左上原点、像素中心在 +0.5 —— 与 WGSL 的 @builtin(position) 一致。
vec2 fragPx() {
  return uOnScreen > 0.5
    ? vec2(gl_FragCoord.x, uStage.y - gl_FragCoord.y)
    : gl_FragCoord.xy + uStage.zw;
}
${COLOR_FILTER}
struct Shading {
  float sd;
  float coverage;
  vec2 dir;
  float displacement;
  vec2 normal;
  vec4 tint;
  float blurLevel;
  float saturation;
  float dispersion;
  float highlight;
  float opacity;
  float rimPx;
  float glow;
  vec2 veil;
};

vec4 shade(vec2 px, Shading s) {
  vec2 base = px - s.dir * s.displacement;
  vec3 sampled;
  if (s.dispersion > 0.0) {
    vec3 w = spectralWeights(s.dispersion);
    vec2 sR = px - s.dir * (s.displacement * w.x);
    vec2 sB = px - s.dir * (s.displacement * w.z);
    sampled = vec3(
      textureLod(chain, sR / uStage.xy, s.blurLevel).r,
      textureLod(chain, base / uStage.xy, s.blurLevel).g,
      textureLod(chain, sB / uStage.xy, s.blurLevel).b
    );
  } else {
    sampled = textureLod(chain, base / uStage.xy, s.blurLevel).rgb;
  }
  vec3 filtered = applyColorFilter(sampled, s.saturation, s.tint);
  vec3 rgb = filtered * s.veil.x + (vec3(1.0) - filtered * s.veil.x) * s.veil.y;
  vec2 terms = highlightTerms(s.normal, LIGHT_DIR, GLOSS) * rimMask(s.sd, s.rimPx) * s.highlight;
  float lit = terms.x + s.glow;
  float dark = terms.y * DARK_RIM;
  float a = s.coverage * s.opacity;
  return vec4((rgb * (1.0 - dark) + vec3(lit, lit, lit)) * a, a);
}

// 与 glass.wgsl.ts 的自适应对应。
const float ADAPT_MAX_LUM = 0.3;
const float ADAPT_MIN_LUM = 0.1;
const float ADAPT_LEVEL = 4.0;

float relLuminance(vec3 c) {
  vec3 s = clamp(c, vec3(0.0), vec3(1.0));
  vec3 lin = mix(pow((s + 0.055) / 1.055, vec3(2.4)), s / 12.92, vec3(lessThanEqual(s, vec3(0.04045))));
  return dot(lin, vec3(0.2126, 0.7152, 0.0722));
}

vec2 adaptVeil(vec3 avg, float adapt, float saturation, vec4 tint) {
  if (adapt == 0.0) {
    return vec2(1.0, 0.0);
  }
  float lum = relLuminance(applyColorFilter(avg, saturation, tint));
  float strength = abs(adapt);
  if (adapt > 0.0 && lum > ADAPT_MAX_LUM) {
    float scale = pow(ADAPT_MAX_LUM / lum, 1.0 / 2.2);
    return vec2(1.0 - (1.0 - scale) * strength, 0.0);
  }
  if (adapt < 0.0 && lum < ADAPT_MIN_LUM) {
    float e = pow(max(lum, 0.0), 1.0 / 2.2);
    float goal = pow(ADAPT_MIN_LUM, 1.0 / 2.2);
    return vec2(1.0, (goal - e) / max(1.0 - e, 1e-6) * strength);
  }
  return vec2(1.0, 0.0);
}

// 与 glass.wgsl.ts 的 panelAverage 对应。
vec3 panelAverage(vec4 rect) {
  vec2 spots[5] = vec2[5](vec2(0.5, 0.5), vec2(0.25, 0.25), vec2(0.75, 0.25), vec2(0.25, 0.75), vec2(0.75, 0.75));
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    vec2 p = rect.xy + rect.zw * spots[i];
    sum += textureLod(chain, p / uStage.xy, ADAPT_LEVEL).rgb;
  }
  return sum / 5.0;
}

// 与 glass.wgsl.ts 的 lightAt 对应。
float lightAt(vec2 px, vec4 light) {
  if (light.w <= 0.0) {
    return 0.0;
  }
  vec2 d = px - light.xy;
  return light.w * exp(-dot(d, d) / (2.0 * light.z * light.z));
}

// 与 glass.wgsl.ts 的 clipCoverage 对应。
float clipCoverage(vec2 px, vec4 box, vec4 radii) {
  vec2 c = (box.xy + box.zw) * 0.5;
  bool right = px.x > c.x;
  bool bottom = px.y > c.y;
  float r = bottom ? (right ? radii.z : radii.w) : (right ? radii.y : radii.x);
  vec2 e = vec2(max(box.x - px.x, px.x - box.z), max(box.y - px.y, px.y - box.w)) + r;
  float sd = length(max(e, vec2(0.0))) + min(max(e.x, e.y), 0.0) - r;
  return clamp(0.5 - sd, 0.0, 1.0);
}

vec4 debugView(int mode, float sd, float coverage, vec2 dir, float displacement, float amountPx) {
  if (mode == 1) {
    float bands = 0.5 + 0.5 * cos(sd * 0.6);
    vec3 side = sd < 0.0 ? vec3(0.25, 0.55, 0.95) : vec3(0.95, 0.55, 0.25);
    float edge = 1.0 - smoothstep(0.0, 1.5, abs(sd));
    return vec4(mix(side * (0.55 + 0.45 * bands), vec3(1.0, 1.0, 1.0), edge), 1.0);
  }
  if (mode == 2) {
    return vec4(coverage, coverage, coverage, 1.0);
  }
  if (mode == 3) {
    return vec4(dir * 0.5 + 0.5, 0.0, 1.0);
  }
  if (mode == 4) {
    float m = displacement / max(amountPx, 1e-6);
    return vec4(m, m, m, 1.0);
  }
  return vec4(0.0, 0.0, 0.0, -1.0);
}
`

/**
 * 与 glass.wgsl.ts 的 GLASS_WGSL 对应。uProbe = 1 时是 fsProbe：
 * 输出 (sd, dir.x, dir.y, displacement) 到 RGBA32F（要 EXT_color_buffer_float）。
 */
export const GLASS_FS = `${HEADER}
${GLASS_COMMON}
layout(std140) uniform PanelBlock {
  Panel panel;
};
uniform float uProbe;

struct Optics {
  vec2 centered;
  vec2 halfSize;
  float radius;
  float sd;
  vec2 dir;
  float displacement;
};

Optics evalOptics(vec2 px) {
  Optics o;
  o.halfSize = panel.rect.zw * 0.5;
  o.centered = px - (panel.rect.xy + o.halfSize);
  o.radius = radiusAt(o.centered, panel.radii);
  o.sd = sdRoundedRect(o.centered, o.halfSize, o.radius);
  float gradR = gradRadiusOf(o.radius, o.halfSize);
  o.dir = refractionDirection(o.centered, o.halfSize, gradR, panel.depthEffect);
  o.displacement = refractionProfile(o.sd, panel.heightPx, panel.amountPx, panel.squircle);
  return o;
}

void main() {
  vec2 px = fragPx();
  Optics o = evalOptics(px);
  if (uProbe > 0.5) {
    outColor = vec4(o.sd, o.dir.x, o.dir.y, o.displacement);
    return;
  }
  float coverage = clamp(0.5 - o.sd, 0.0, 1.0) * clipCoverage(px, panel.clip, panel.clipRadii);
  vec4 debug = debugView(int(panel.debugMode + 0.5), o.sd, coverage, o.dir, o.displacement, panel.amountPx);
  if (debug.a >= 0.0) {
    outColor = debug;
    return;
  }
  if (coverage <= 0.0) {
    discard;
  }
  Shading s;
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
  outColor = shade(px, s);
}
`

/** 与 glass-group.wgsl.ts 的 GLASS_GROUP_WGSL 对应。混合同样不用 mix()，理由见那边的文件头。 */
export function glassGroupFs(capacity: number): string {
  return `${HEADER}
${GLASS_COMMON}
struct Group {
  vec4 header;
  Panel members[${capacity}];
};
layout(std140) uniform GroupBlock {
  Group grp;
};
uniform float uProbe;

struct MemberOptics {
  float sd;
  vec2 dir;
  vec2 normal;
};

MemberOptics memberOptics(Panel p, vec2 px) {
  vec2 halfSize = p.rect.zw * 0.5;
  vec2 centered = px - (p.rect.xy + halfSize);
  float radius = radiusAt(centered, p.radii);
  float gradR = gradRadiusOf(radius, halfSize);
  MemberOptics m;
  m.sd = sdRoundedRect(centered, halfSize, radius);
  m.dir = refractionDirection(centered, halfSize, gradR, p.depthEffect);
  m.normal = safeNormalize(gradSdRoundedRect(centered, halfSize, gradR));
  return m;
}

float blend1(float a, float b, float h) {
  return a * (1.0 - h) + b * h;
}

vec4 blend4(vec4 a, vec4 b, float h) {
  return a * (1.0 - h) + b * h;
}

struct Merged {
  float sd;
  vec2 dir;
  vec2 normal;
  float displacement;
  vec4 tint;
  float heightPx;
  float amountPx;
  float blurLevel;
  float saturation;
  float squircle;
  float dispersion;
  float highlight;
  float opacity;
  float rimPx;
  vec2 veil;
};

vec2 blend2(vec2 a, vec2 b, float h) {
  return a * (1.0 - h) + b * h;
}

vec2 memberVeil(Panel p) {
  return adaptVeil(panelAverage(p.rect), p.adapt, p.saturation, p.tint);
}

Merged evalGroup(vec2 px) {
  int count = min(int(grp.header.x + 0.5), ${capacity});
  float k = grp.header.y;

  Panel first = grp.members[0];
  MemberOptics f = memberOptics(first, px);
  Merged m;
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
  m.veil = memberVeil(first);

  bool blended = false;
  for (int i = 1; i < ${capacity}; i++) {
    if (i >= count) break;
    Panel p = grp.members[i];
    MemberOptics c = memberOptics(p, px);
    vec2 s = smin(c.sd, m.sd, k);
    float h = s.y;
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
    m.veil = blend2(m.veil, memberVeil(p), h);
    blended = blended || (h > 0.0 && h < 1.0);
  }

  float agreement = blended ? length(m.dir) : 1.0;
  m.dir = blended ? safeNormalize(m.dir) : m.dir;
  m.normal = blended ? safeNormalize(m.normal) : m.normal;
  m.displacement = refractionProfile(m.sd, m.heightPx, m.amountPx, m.squircle) * agreement;
  return m;
}

float groupGlow(vec2 px) {
  int count = min(int(grp.header.x + 0.5), ${capacity});
  float g = 0.0;
  for (int i = 0; i < ${capacity}; i++) {
    if (i >= count) break;
    g += lightAt(px, grp.members[i].light);
  }
  return g;
}

float groupClip(vec2 px) {
  int count = min(int(grp.header.x + 0.5), ${capacity});
  float c = clipCoverage(px, grp.members[0].clip, grp.members[0].clipRadii);
  for (int i = 1; i < ${capacity}; i++) {
    if (i >= count) break;
    c = max(c, clipCoverage(px, grp.members[i].clip, grp.members[i].clipRadii));
  }
  return c;
}

void main() {
  vec2 px = fragPx();
  Merged m = evalGroup(px);
  if (uProbe > 0.5) {
    outColor = vec4(m.sd, m.dir.x, m.dir.y, m.displacement);
    return;
  }
  float coverage = clamp(0.5 - m.sd, 0.0, 1.0) * groupClip(px);
  vec4 debug = debugView(int(grp.header.z + 0.5), m.sd, coverage, m.dir, m.displacement, m.amountPx);
  if (debug.a >= 0.0) {
    outColor = debug;
    return;
  }
  if (coverage <= 0.0) {
    discard;
  }
  Shading s;
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
  s.veil = m.veil;
  outColor = shade(px, s);
}
`
}
