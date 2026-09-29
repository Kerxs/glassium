/// <reference types="@webgpu/types" preserve="true" />
/**
 * `glassium/runtime`：只有 runtime —— `<div glass>`、`glass()`、`configure`、能力、自适应质量、内容进场景、果冻与飞行、
 * 变形、时间轴 —— **不注册 `<glass-*>` 组件**，也不带组件的代码。只用 `<div glass>` 的页面引它更小。
 *
 * ```js
 * import 'glassium/runtime'            // 零配置：页面上的 [glass] 自动变成玻璃
 * import { glass, configure } from 'glassium/runtime'
 * ```
 *
 * 要组件（`<glass-switch>`、`<glass-tab-bar>`……）就引完整的 `glassium`。两个入口可以同时用：它们共用同一套模块，
 * 引了完整入口之后组件照常注册。这里的导出是完整入口的子集（名字、行为都相同）。
 */

import { scheduleAutoStart } from './runtime/auto.ts'
import { glassium } from './runtime/glassium.ts'

export { VERSION } from './version.ts'
export { glassium }
export default glassium
export { glass, glassOf, type GlassHandle, type GlassInteractionOptions, type GlassOptions } from './runtime/glass.ts'
export { configure, type GlassiumConfig, type QualitySetting } from './runtime/config.ts'
export { tierOf, type GlassiumCapabilities, type RendererKind } from './runtime/capabilities.ts'
export { RUNTIME_PRESETS, runtimePreset, type RuntimePresetName } from './runtime/presets.ts'
export { startRuntime, stopRuntime } from './runtime/auto.ts'
export { absorbedElements } from './runtime/absorb.ts'
export { contentBlocks, contentStats } from './runtime/content.ts'
export { cancelFrame, everyFrame, nextFrame, type FrameCallback } from './animation/timeline.ts'
export { morphGlass, type GlassMorph, type MorphGlassOptions } from './interaction/morph.ts'
export { createGlassStage, currentStage, onStageChange, type GlassStage, type GlassStageOptions } from './renderer/stage.ts'
export { GlassPresets, type GlassMaterial, type GlassPresetName } from './core/material.ts'

if (typeof window !== 'undefined') {
  ;(window as unknown as { glassium?: typeof glassium }).glassium ??= glassium
  scheduleAutoStart()
}
