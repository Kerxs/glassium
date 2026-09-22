/**
 * 场景与呈现着色器。
 *
 * 这个文件**不经过 WGSL→GLSL 重写器**：它有入口点、绑定和内置变量，那些东西两个
 * 后端差别太大，手写比机翻清楚。重写器只处理 optics.wgsl.ts 里的纯函数子集。
 * WebGL2 版本在 T11 由 src/webgl2/passes.ts 手写。
 *
 * 坐标约定：uv 的原点在**左上**，与 CSS / DOM 一致。WebGPU 的 NDC 是 y 向上的，
 * 所以顶点着色器里做了一次翻转。全项目只在这里翻，别处不要再翻第二次 ——
 * 翻两次和不翻的表现一模一样（都是正的），但中间任何一步取样都会错位。
 */

/** 全屏三角形。比全屏四边形少一个顶点，也没有对角线接缝上的重复着色。 */
const FULLSCREEN_VS = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var corners = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  let p = corners[i];
  var out: VsOut;
  out.pos = vec4f(p, 0.0, 1.0);
  // y 翻转：NDC 的 y 向上，uv 的 y 向下。
  out.uv = vec2f((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}
`

/**
 * 渐变场景。
 *
 * 需要说清楚的一点：**平滑渐变是检验折射效果最差的背景。** 透镜把采样点挪 24px，
 * 而渐变在 24px 内只变约 1/255，与没有透镜无从区分；色散作为通道间的差分位移更是
 * 彻底消失，因为 R、G、B 落到了同一个颜色上。
 *
 * 所以这个场景只用来验证 T5 的管线通不通（画布、分辨率、rAF 闸门），**不是**用来
 * 判断玻璃好不好看的。真正的判据是 T12 的 calibration 场景：棋盘格 + 硬对角线 +
 * 黑白阶跃，全高频、几何已知。
 *
 * 配色取自工作区 meshora 的那套（浅蓝 → 深蓝 → 近黑），深色放在末位压得住白字。
 */
export const SCENE_WGSL = /* wgsl */ `
struct SceneUniforms {
  resolution: vec2f,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> scene: SceneUniforms;

${FULLSCREEN_VS}

fn palette(t: f32) -> vec3f {
  let c0 = vec3f(0.682, 0.835, 0.953); // #AED5F3
  let c1 = vec3f(0.180, 0.345, 0.643); // #2E58A4
  let c2 = vec3f(0.016, 0.063, 0.122); // #04101F
  let k = clamp(t, 0.0, 1.0);
  let lower = mix(c0, c1, smoothstep(0.0, 0.55, k));
  return mix(lower, c2, smoothstep(0.55, 1.0, k));
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let aspect = scene.resolution.x / max(scene.resolution.y, 1.0);
  let p = vec2f(in.uv.x * aspect, in.uv.y);

  // 对角线渐变，叠一个很慢的漂移。漂移存在的意义不是好看，是让「rAF 到底在不在跑」
  // 用肉眼就能判断 —— prefers-reduced-motion 下它必须完全静止。
  let drift = sin(scene.time * 0.25) * 0.06;
  let t = clamp((p.x * 0.45 + p.y * 0.85) * 0.78 + drift, 0.0, 1.0);

  return vec4f(palette(t), 1.0);
}
`

/**
 * 呈现（把场景目标放大贴到画布）。
 *
 * 场景目标受像素预算约束，通常比画布小（1080p@2x 下是 1520x855 对 3840x2160），
 * 所以这一步是**放大**。用线性采样，取纹素中心。
 */
export const PRESENT_WGSL = /* wgsl */ `
${FULLSCREEN_VS}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  // 用 textureSampleLevel 而不是 textureSample：全项目统一，免得将来有人把这段
  // 复制进带分支的玻璃着色器里，再去查为什么编译不过（隐式导数要求统一控制流）。
  return textureSampleLevel(src, samp, in.uv, 0.0);
}
`
