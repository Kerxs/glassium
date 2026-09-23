/**
 * Glassium 公开入口。
 *
 * 第一期按 T1→T12 逐步填充。每个 export 在其对应任务完成时加上，不提前占位 ——
 * 空壳 export 会让 playground 编译通过却在运行时崩，比缺失更难查。
 *
 * 现在有的是**核心**：光学数学、单位与分辨率策略、有序效果管线与声明式材质立面。
 * 还没有的是**渲染器**（stage / WebGPU / WebGL2 后端 / 组件）—— 那从 T5 开始。
 *
 * 也就是说：现在可以用这个包算出「该画什么」，但还不能把它画出来。
 */

export const VERSION = '0.0.0'

// —— 光学核心（CPU 参考实现，与 WGSL 侧逐点一致）——
export {
  circleMap,
  clampRadii,
  gradRadiusOf,
  gradSdRoundedRect,
  radiusAt,
  refractionDirection,
  refractionProfile,
  safeNormalize,
  sdRoundedRect,
  smin,
  sminGradient,
  spectralWeights,
  squircleMap,
  type Radii4,
  type Vec2
} from './core/optics.ts'

// —— 单位与分辨率 ——
export {
  MAX_PIXELS,
  MIN_SCENE_RATIO,
  cssToDevicePx,
  deviceToCssPx,
  describeViewport,
  dpToCssPx,
  resolveViewport,
  texelCenterUv,
  uvToTexelCoord,
  type ResolvedViewport
} from './core/units.ts'

// —— 有序效果管线（内核）——
export {
  assertCanonicalOrder,
  resolveMargins,
  sampleMargin,
  type EffectChain,
  type GlassEffect
} from './core/pipeline.ts'

// —— 声明式材质立面 ——
export {
  GlassPresets,
  glass,
  lowerMaterial,
  parseTint,
  resolveCornerRadii,
  type CornerRadius,
  type GlassMaterial,
  type GlassPresetName
} from './core/material.ts'

// —— 着色器源 ——
// 渲染器后端要用它们拼出完整着色器（绑定、入口点与 Y 翻转各后端手写）。
export { OPTICS_WGSL } from './shaders/optics.wgsl.ts'
export { OPTICS_GLSL } from './shaders/generated/optics.glsl.ts'

// —— 渲染器（T5 起）——
// T7 起有了 stage.register()：把一个 DOM 元素注册成玻璃面板。
// 组件（<glass-card> 等）要到 T9 —— 现在只能手动 register。
export {
  createGlassStage,
  simulateReducedMotion,
  type Backend,
  type DegradeReason,
  type GlassStage,
  type GlassStageOptions,
  type GlassStats
} from './renderer/stage.ts'

export { deviceLossCount, simulateNoWebGpu } from './webgpu/device.ts'
export type { ProbeReport } from './webgpu/probe.ts'

// —— 玻璃面板（T7 起）——
export type { GlassPanel } from './renderer/panels.ts'
export { DEBUG_MODES, type PanelDebugMode } from './shaders/glass.wgsl.ts'
export {
  compareOptics,
  type OpticsComparison,
  type OpticsProbe
} from './renderer/verify.ts'
