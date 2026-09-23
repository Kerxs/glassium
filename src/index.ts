/**
 * Glassium 公开入口。
 *
 * 第一期按 T1→T12 逐步填充。每个 export 在其对应任务完成时加上，不提前占位 ——
 * 空壳 export 会让 playground 编译通过却在运行时崩，比缺失更难查。
 *
 * 现在有的：光学核心、有序效果管线与材质立面（T1–T4），WebGPU 渲染器（T5–T8），
 * `<glass-card>` / `<glass-button>` 组件与层级诊断（T9），`<glass-container>` 的合并（T10），
 * WebGL2 后端（T11）。后端阶梯：WebGPU → WebGL2 → CSS 兜底。
 *
 * 在 Node 里 import 整个包是安全的（SSR）：模块顶层不碰任何浏览器全局，
 * defineGlassElements() 在没有 customElements 时什么都不做。
 */

export const VERSION = '0.0.0'

// —— 光学核心（CPU 参考实现，与 WGSL 侧逐点一致）——
export {
  channelSampleOffsets,
  circleMap,
  clampRadii,
  gradRadiusOf,
  gradSdRoundedRect,
  highlightTerms,
  radiusAt,
  refractionDirection,
  refractionProfile,
  rimMask,
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

// —— 多块玻璃的合并（T10 起）——
export {
  MAX_GROUP_MEMBERS,
  evalMergedOptics,
  memberOptics,
  mergeBleed,
  type MemberGeometry,
  type MergedOptics
} from './core/merge.ts'

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
  MATERIAL_DEFAULTS,
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
// stage.register() 把任意 DOM 元素注册成玻璃面板；组件（下面）就是在它之上的一层。
export {
  createGlassStage,
  currentStage,
  onStageChange,
  prefersReducedMotion,
  prefersMoreContrast,
  prefersReducedTransparency,
  simulateForcedColors,
  simulateMoreContrast,
  simulateReducedMotion,
  simulateReducedTransparency,
  type Backend,
  type DegradeReason,
  type GlassStage,
  type GlassStageOptions,
  type BackendReport,
  type Gl2Report,
  type GlassStats,
  type ReadbackRegion,
  type ReadbackResult,
  type GlassSceneSource,
  type SceneKind,
  type SceneOptions
} from './renderer/stage.ts'
// 减少透明度时的材质变换（纯函数，别的渲染器也能用同一套规则）。
export {
  FROST,
  frostFor,
  frostForColor,
  REDUCED_TRANSPARENCY,
  reduceTransparency,
  relativeLuminance,
  type Frost
} from './core/transparency.ts'
// 用户场景怎么铺进视口（object-fit 语义）。纯函数，别的渲染器也能用同一套算法。
export { sceneBitmapSize, sceneCssBackground, sceneUvTransform, type SceneFit, type UvTransform } from './core/scene.ts'
export { gl2CreationCounts } from './webgl2/renderer.ts'

export {
  deviceLossCount,
  gpuCreationCounts,
  simulateDeviceLoss,
  simulateNoWebGpu
} from './webgpu/device.ts'
export type { ProbeReport } from './webgpu/probe.ts'

// —— 层级诊断（T9 起）——
// 面板与画布之间有东西挡着时点名警告。stage 自动触发，这里导出的是给调试读结果用的。
export { describeElement, describeProblem, type LayerProblem } from './renderer/layering.ts'

// —— 组件（T9 起）——
// 样式兜底在 src/components/glassium.css，要用 <link> 放进 <head>。
export { defineGlassElements } from './components/register.ts'
export { GlassElement } from './components/base.ts'
export { GlassCard } from './components/glass-card.ts'
export { GlassButton } from './components/glass-button.ts'
export { GlassContainer } from './components/glass-container.ts'
export { MATERIAL_ATTRIBUTES, parseMaterialAttributes } from './components/attributes.ts'

// —— 玻璃面板（T7 起）与合并组（T10 起）——
export {
  DEFAULT_SMOOTHING_DP,
  LIGHT_GAIN,
  LIGHT_SIGMA_FRAC,
  type GlassGroup,
  type GlassPanel,
  type PanelLight
} from './renderer/panels.ts'
export { DEBUG_MODES, type PanelDebugMode } from './shaders/glass.wgsl.ts'
export {
  SECTORS,
  compareGroupOptics,
  compareOptics,
  joinProbeAndColors,
  sectorOf,
  summarizeBySector,
  type GroupOpticsProbe,
  type JoinedPixel,
  type OpticsComparison,
  type OpticsProbe,
  type Sector,
  type SectorStat
} from './renderer/verify.ts'
