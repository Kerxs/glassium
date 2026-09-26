/*
   本文件由 scripts/gen-glsl.ts 从 src/shaders/optics.wgsl.ts 自动生成。
   **不要手改** —— 改 WGSL 真源，然后跑 npm run gen:glsl。

   许可承袭真源：光学数学移植自 AndroidLiquidGlass（io.github.kyant0:backdrop），
   Apache License 2.0，Copyright 2025 Kyant。修改说明见 docs/porting-notes.md。
 */

/** GLSL ES 3.0 版的光学核心。绑定、入口点与 Y 翻转由各后端手写，不在这里。 */
export const OPTICS_GLSL = /* glsl */ `
vec2 safeNormalize(vec2 v) {
  float len = length(v);
  return (len > 1e-6 ? v / max(len, 1e-6) : vec2(0.0, -1.0));
}

// radii 的分量顺序是 TL, TR, BR, BL（.x .y .z .w）。
// 入参必须是**中心化坐标** —— 上游传的是左上原点的原始坐标，于是 x>=0 恒真，
// 四角半径实际塌缩成右下角那一个。详见 docs/porting-notes.md。
float radiusAt(vec2 centered, vec4 radii) {
  float rightHalf = (centered.y <= 0.0 ? radii.y : radii.z);
  float leftHalf = (centered.y <= 0.0 ? radii.x : radii.w);
  return (centered.x >= 0.0 ? rightHalf : leftHalf);
}

float sdRoundedRect(vec2 p, vec2 halfSize, float radius) {
  vec2 corner = abs(p) - (halfSize - vec2(radius, radius));
  float outside = length(max(corner, vec2(0.0, 0.0))) - radius;
  float inside = min(max(corner.x, corner.y), 0.0);
  return outside + inside;
}

vec2 gradSdRoundedRect(vec2 p, vec2 halfSize, float radius) {
  vec2 corner = abs(p) - (halfSize - vec2(radius, radius));
  float sx = (p.x >= 0.0 ? 1.0 : -1.0);
  float sy = (p.y >= 0.0 ? 1.0 : -1.0);
  vec2 clamped = max(corner, vec2(0.0, 0.0));
  float len = length(clamped);
  float gradX = (corner.y <= corner.x ? 1.0 : 0.0);
  vec2 axis = vec2(sx * gradX, sy * (1.0 - gradX));
  vec2 arc = vec2(sx * clamped.x, sy * clamped.y) / max(len, 1e-6);
  bool inCorner = corner.x >= 0.0 || corner.y >= 0.0;
  bool degenerate = inCorner && len <= 1e-6;
  return (degenerate ? vec2(0.0, -1.0) : (inCorner ? arc : axis));
}

float gradRadiusOf(float radius, vec2 halfSize) {
  return min(radius * 1.5, min(halfSize.x, halfSize.y));
}

float circleMap(float x) {
  return 1.0 - sqrt(1.0 - x * x);
}

float squircleMap(float x, float n) {
  return 1.0 - pow(1.0 - pow(x, n), 1.0 / n);
}

float refractionProfile(float sd, float heightPx, float amountPx, float n) {
  bool disabled = heightPx <= 0.0 || amountPx == 0.0 || -sd >= heightPx;
  float depth = min(sd, 0.0);
  float x = clamp(1.0 - (-depth) / max(heightPx, 1e-6), 0.0, 1.0);
  return (disabled ? 0.0 : squircleMap(x, n) * amountPx);
}

vec2 refractionDirection(vec2 centered, vec2 halfSize, float gradRadius, float depthEffect) {
  vec2 grad = gradSdRoundedRect(centered, halfSize, gradRadius);
  vec2 radial = safeNormalize(centered);
  vec2 mixed = grad + radial * depthEffect;
  return (depthEffect == 0.0 ? safeNormalize(grad) : safeNormalize(mixed));
}

vec2 smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / max(k, 1e-6), 0.0, 1.0);
  float blended = b * (1.0 - h) + a * h - k * h * (1.0 - h);
  float hardH = (a <= b ? 1.0 : 0.0);
  return (k <= 0.0 ? vec2(min(a, b), hardH) : vec2(blended, h));
}

vec2 sminGradient(vec2 ga, vec2 gb, float h) {
  return gb * (1.0 - h) + ga * h;
}

vec3 spectralWeights(float k) {
  return vec3(1.0 - k, 1.0, 1.0 + k);
}

// 边缘高光的范围：边界处为 1，深入面板 rimPx 之后为 0，中间平滑过渡。
// rimPx 下限 1e-6：smoothstep 两个端点相等时结果未定义。
float rimMask(float sd, float rimPx) {
  return 1.0 - smoothstep(0.0, max(rimPx, 1e-6), -sd);
}

// 亮边的角度因子：一整圈都亮，朝着与背着 lightDir 的两侧最亮（双面，与上游的 abs() 一样），
// 与它垂直的两侧是 base（上游在那里是 0）。依据是 iOS 26 截图的实测，见 src/core/optics.ts 的 rimLight。
float rimLight(vec2 n, vec2 lightDir, float base, float gloss) {
  float ndl = abs(dot(n, lightDir));
  return base + (1.0 - base) * pow(ndl, gloss);
}

// 体光：玻璃里面随竖直位置 t（0 顶、1 底）的亮度增减 —— 顶上暗，往下平滑地变亮，40% 往下满亮。
float bodyLight(float t, float shade, float light) {
  return (light + shade) * smoothstep(0.0, 0.4, t) - shade;
}
`
