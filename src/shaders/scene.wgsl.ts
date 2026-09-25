/**
 * 场景与呈现着色器。
 *
 * 这个文件**不经过 WGSL→GLSL 重写器**：它有入口点、绑定和内置变量，那些东西两个
 * 后端差别太大，手写比机翻清楚。重写器只处理 optics.wgsl.ts 里的纯函数子集。
 * WebGL2 版本手写在 src/webgl2/shaders.ts，与这里逐段对应。
 *
 * 坐标约定：uv 的原点在**左上**，与 CSS / DOM 一致。WebGPU 的 NDC 是 y 向上的，
 * 所以顶点着色器里做了一次翻转。全项目只在这里翻，别处不要再翻第二次 ——
 * 翻两次和不翻的表现一模一样（都是正的），但中间任何一步取样都会错位。
 */

import { SRGB_WGSL } from './srgb.wgsl.ts'

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
  mode: f32,        // 0 gradient · 1 calibration · 2 radial · 3 flat
  center: vec2f,    // radial 的中心，uv
  radius: f32,      // radial 的半径，以视口高为单位
  linear: f32,      // 1 = 输出线性值（线性光模式：场景目标是 sRGB 格式，写入时硬件编码回去）
}

@group(0) @binding(0) var<uniform> scene: SceneUniforms;

${FULLSCREEN_VS}

${SRGB_WGSL}

fn palette(t: f32) -> vec3f {
  let c0 = vec3f(0.682, 0.835, 0.953); // #AED5F3
  let c1 = vec3f(0.180, 0.345, 0.643); // #2E58A4
  let c2 = vec3f(0.016, 0.063, 0.122); // #04101F
  let k = clamp(t, 0.0, 1.0);
  let lower = mix(c0, c1, smoothstep(0.0, 0.55, k));
  return mix(lower, c2, smoothstep(0.55, 1.0, k));
}

/**
 * 校准图案：棋盘格 + 硬对角线 + 黑白阶跃。全高频、几何已知。
 *
 * 这个场景本来排在 T12，提前到 T6 是因为**没有它就验不了 T6 自己**：
 * 线性渐变几乎是高斯模糊的不动点（模糊一个线性斜坡还是同一个斜坡），
 * 在渐变上扫 σ 测到的差异小到接近本底噪声，根本分辨不出有没有台阶。
 *
 * 布局：左上半是棋盘格（处处高频），右下半是黑白竖直阶跃（一条硬边），
 * 两者之间的 45° 对角线本身又是一条硬边。
 *
 * 对角线与竖直阶跃都挪开了 1/4 像素，让硬边**永远不经过像素中心**。不挪的话：
 * 宽 + 高为偶数时对角线正好穿过一整排像素中心，宽为奇数时竖直阶跃也是 —— 那些像素上
 * step() 比较的两边在数学上相等，结果取决于 uv 插值的最后一位，两个后端（甚至两个驱动）
 * 会各判各的，整条线黑白互换。verify.html 的跨后端比对就是这样抓到它的：820×1200 的
 * 视口下对角线上 500 个像素差 250/255，而这与渲染器毫无关系。挪 1/4 像素对「不经过
 * 像素中心」的那些尺寸结果完全不变。
 */
fn calibration(uv: vec2f, res: vec2f) -> vec3f {
  let p = uv * res;
  let cell = 24.0;
  let checker = step(0.5, fract((floor(p.x / cell) + floor(p.y / cell)) * 0.5));
  let halfPlane = step(0.0, p.x + p.y - (res.x + res.y) * 0.5 + 0.25);
  let vstep = step(res.x * 0.5 - 0.25, p.x);
  let right = mix(vec3f(0.04, 0.04, 0.05), vec3f(0.96, 0.96, 0.98), vstep);
  return mix(vec3f(checker, checker, checker), right, halfPlane);
}

/**
 * 两个验证用的场景，都不是给人看的。
 *
 * flat：处处 0.5 的灰。模糊与折射都改变不了一个常数场，所以边缘上出现的任何亮度差
 *       都**只可能**来自高光 —— 用它验「只有朝光一侧发亮、背光一侧有暗边」。
 *
 * radial：亮度随到中心的距离单调增加。把中心放在某块面板的中心，折射往里采样就意味着
 *       采到更暗的地方；色散让蓝通道采得比红通道更靠里，于是边缘上**蓝应当比红暗**。
 *       这个关系在四个角上都成立，才说明色散方向是一致的 —— 上游的鞍面调制会让
 *       相邻两个角给出相反的结论。
 */
fn sceneColor(uv: vec2f) -> vec3f {
  if (scene.mode > 2.5) {
    return vec3f(0.5, 0.5, 0.5);
  }
  if (scene.mode > 1.5) {
    let aspect = scene.resolution.x / max(scene.resolution.y, 1.0);
    let p = vec2f(uv.x * aspect, uv.y);
    let c = vec2f(scene.center.x * aspect, scene.center.y);
    let v = clamp(length(p - c) / max(scene.radius, 1e-6), 0.0, 1.0);
    return vec3f(v, v, v);
  }
  if (scene.mode > 0.5) {
    return calibration(uv, scene.resolution);
  }

  let aspect = scene.resolution.x / max(scene.resolution.y, 1.0);
  let p = vec2f(uv.x * aspect, uv.y);

  // 对角线渐变，叠一个很慢的漂移。漂移存在的意义不是好看，是让「rAF 到底在不在跑」
  // 用肉眼就能判断 —— prefers-reduced-motion 下它必须完全静止。
  let drift = sin(scene.time * 0.25) * 0.06;
  let t = clamp((p.x * 0.45 + p.y * 0.85) * 0.78 + drift, 0.0, 1.0);

  return palette(t);
}

// 图案里的颜色都是 sRGB 编码值（0.5 的灰就是屏幕上的 128）。线性光模式下换成线性值再写：
// 场景目标那时是 sRGB 格式，硬件写入时编码回去，存下来的字节与默认模式相同。
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let c = sceneColor(in.uv);
  if (scene.linear > 0.5) {
    return vec4f(srgbToLinear(c), 1.0);
  }
  return vec4f(c, 1.0);
}
`

/**
 * 用户场景：一张图（或视频、画布的当前帧），按 object-fit 铺进场景目标。
 *
 * uv 的变换在 CPU 上算好（core/scene.ts 的 sceneUvTransform），这里只做一次乘加。
 * 落在 [0, 1] 之外（contain 留白）的像素填底色；图片自己带透明时合到底色上 ——
 * 画布恒为不透明，场景里不能留下 alpha < 1 的像素。
 *
 * 图片纹理只有一级：静态图片上传前已经按场景分辨率做过高质量缩放，采样基本是 1:1。
 */
export const SCENE_IMAGE_WGSL = /* wgsl */ `
struct ImageScene {
  uvScale: vec2f,
  uvOffset: vec2f,
  background: vec4f,    // rgb 是底色（sRGB 编码）；w = 1 时输出线性值（线性光模式，同上面的内置场景）
}

@group(0) @binding(0) var<uniform> u: ImageScene;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var img: texture_2d<f32>;

${FULLSCREEN_VS}

${SRGB_WGSL}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let uv = in.uv * u.uvScale + u.uvOffset;
  let inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  let c = textureSampleLevel(img, samp, clamp(uv, vec2f(0.0, 0.0), vec2f(1.0, 1.0)), 0.0);
  let rgb = mix(u.background.rgb, c.rgb, c.a);
  let out = select(u.background.rgb, rgb, inside);
  if (u.background.w > 0.5) {
    return vec4f(srgbToLinear(out), 1.0);
  }
  return vec4f(out, 1.0);
}
`
