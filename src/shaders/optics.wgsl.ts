/*
   本文件的光学数学移植自 AndroidLiquidGlass（io.github.kyant0:backdrop）的
   internal/Shaders.kt，以 Apache License 2.0 授权，Copyright 2025 Kyant。
   上游源：https://github.com/Kyant0/AndroidLiquidGlass
   commit 65ab177e90e5c1d8c62e70cf7755841982da65f6

   已修改：重写为 WGSL；修正 radiusAt 的坐标系；色散改为径向、蓝光位移大于红光；
   高光保留双面并加上侧面的基础亮度；新增体光。逐条说明见 docs/porting-notes.md。

   上游未附带 NOTICE 文件，故本项目不承担 Apache-2.0 §4(d) 的转载义务；
   §4(a)–(c) 仍然适用。

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
 */

/**
 * 光学核心的 WGSL 源 —— **唯一真源**。
 *
 * GLSL ES 3.0 版本由 scripts/gen-glsl.ts 从这里机械生成并签入
 * （src/shaders/generated/optics.glsl.ts），永远不要手改生成物。
 *
 * 这个字符串里**只放纯函数**，不放绑定、入口点和纹理采样。两个理由：
 *
 *   1. 绑定与入口在两个后端差别太大（`@group/@binding` vs `layout(std140)`），
 *      机械翻译得不偿失，手写反而清楚。
 *   2. 把可翻译的部分压到最小，重写器就能做到「看不懂就抛」而不是「猜一个」。
 *
 * 写法约束（重写器依赖这些，违反会抛）：
 *   - 每个 let / var 都必须带类型标注
 *   - 条件用 select(假值, 真值, 条件)，不用 if 表达式
 *   - 只用两边同名的内置函数（abs/min/max/sqrt/pow/clamp/length/normalize/dot/smoothstep）
 *   - **不用 sign()**：见下一段
 *
 * 数值上必须与 src/core/optics.ts 逐点一致（probeOptics + compareOptics 逐像素比对，
 * 判据见 spec/golden/README.md）。
 * 尤其注意符号约定：`p.x >= 0` 取 +1 而不是 sign(p.x) —— 在 p.x 恰为 0 时
 * 两者不同，而面板中心线正好落在那里。
 */
export const OPTICS_WGSL = /* wgsl */ `
fn safeNormalize(v: vec2f) -> vec2f {
  let len: f32 = length(v);
  return select(vec2f(0.0, -1.0), v / max(len, 1e-6), len > 1e-6);
}

// radii 的分量顺序是 TL, TR, BR, BL（.x .y .z .w）。
// 入参必须是**中心化坐标** —— 上游传的是左上原点的原始坐标，于是 x>=0 恒真，
// 四角半径实际塌缩成右下角那一个。详见 docs/porting-notes.md。
fn radiusAt(centered: vec2f, radii: vec4f) -> f32 {
  let rightHalf: f32 = select(radii.z, radii.y, centered.y <= 0.0);
  let leftHalf: f32 = select(radii.w, radii.x, centered.y <= 0.0);
  return select(leftHalf, rightHalf, centered.x >= 0.0);
}

fn sdRoundedRect(p: vec2f, halfSize: vec2f, radius: f32) -> f32 {
  let corner: vec2f = abs(p) - (halfSize - vec2f(radius, radius));
  let outside: f32 = length(max(corner, vec2f(0.0, 0.0))) - radius;
  let inside: f32 = min(max(corner.x, corner.y), 0.0);
  return outside + inside;
}

fn gradSdRoundedRect(p: vec2f, halfSize: vec2f, radius: f32) -> vec2f {
  let corner: vec2f = abs(p) - (halfSize - vec2f(radius, radius));
  let sx: f32 = select(-1.0, 1.0, p.x >= 0.0);
  let sy: f32 = select(-1.0, 1.0, p.y >= 0.0);
  let clamped: vec2f = max(corner, vec2f(0.0, 0.0));
  let len: f32 = length(clamped);
  let gradX: f32 = select(0.0, 1.0, corner.y <= corner.x);
  let axis: vec2f = vec2f(sx * gradX, sy * (1.0 - gradX));
  let arc: vec2f = vec2f(sx * clamped.x, sy * clamped.y) / max(len, 1e-6);
  let inCorner: bool = corner.x >= 0.0 || corner.y >= 0.0;
  let degenerate: bool = inCorner && len <= 1e-6;
  return select(select(axis, arc, inCorner), vec2f(0.0, -1.0), degenerate);
}

fn gradRadiusOf(radius: f32, halfSize: vec2f) -> f32 {
  return min(radius * 1.5, min(halfSize.x, halfSize.y));
}

fn circleMap(x: f32) -> f32 {
  return 1.0 - sqrt(1.0 - x * x);
}

fn squircleMap(x: f32, n: f32) -> f32 {
  return 1.0 - pow(1.0 - pow(x, n), 1.0 / n);
}

fn refractionProfile(sd: f32, heightPx: f32, amountPx: f32, n: f32) -> f32 {
  let disabled: bool = heightPx <= 0.0 || amountPx == 0.0 || -sd >= heightPx;
  let depth: f32 = min(sd, 0.0);
  let x: f32 = clamp(1.0 - (-depth) / max(heightPx, 1e-6), 0.0, 1.0);
  return select(squircleMap(x, n) * amountPx, 0.0, disabled);
}

fn refractionDirection(centered: vec2f, halfSize: vec2f, gradRadius: f32, depthEffect: f32) -> vec2f {
  let grad: vec2f = gradSdRoundedRect(centered, halfSize, gradRadius);
  let radial: vec2f = safeNormalize(centered);
  let mixed: vec2f = grad + radial * depthEffect;
  return select(safeNormalize(mixed), safeNormalize(grad), depthEffect == 0.0);
}

fn smin(a: f32, b: f32, k: f32) -> vec2f {
  let h: f32 = clamp(0.5 + 0.5 * (b - a) / max(k, 1e-6), 0.0, 1.0);
  let blended: f32 = b * (1.0 - h) + a * h - k * h * (1.0 - h);
  let hardH: f32 = select(0.0, 1.0, a <= b);
  return select(vec2f(blended, h), vec2f(min(a, b), hardH), k <= 0.0);
}

fn sminGradient(ga: vec2f, gb: vec2f, h: f32) -> vec2f {
  return gb * (1.0 - h) + ga * h;
}

fn spectralWeights(k: f32) -> vec3f {
  return vec3f(1.0 - k, 1.0, 1.0 + k);
}

// 边缘高光的范围：边界处为 1，深入面板 rimPx 之后为 0，中间平滑过渡。
// rimPx 下限 1e-6：smoothstep 两个端点相等时结果未定义。
fn rimMask(sd: f32, rimPx: f32) -> f32 {
  return 1.0 - smoothstep(0.0, max(rimPx, 1e-6), -sd);
}

// 亮边的角度因子：一整圈都亮，朝着与背着 lightDir 的两侧最亮（双面，与上游的 abs() 一样），
// 与它垂直的两侧是 base（上游在那里是 0）。依据是 iOS 26 截图的实测，见 src/core/optics.ts 的 rimLight。
fn rimLight(n: vec2f, lightDir: vec2f, base: f32, gloss: f32) -> f32 {
  let ndl: f32 = abs(dot(n, lightDir));
  return base + (1.0 - base) * pow(ndl, gloss);
}

// 体光：玻璃里面随竖直位置 t（0 顶、1 底）的亮度增减 —— 顶上暗，往下平滑地变亮，40% 往下满亮。
fn bodyLight(t: f32, shade: f32, light: f32) -> f32 {
  return (light + shade) * smoothstep(0.0, 0.4, t) - shade;
}
`
