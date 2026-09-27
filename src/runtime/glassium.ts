/**
 * `glassium` 命名空间：runtime 的入口对象。`import glassium from 'glassium'`，浏览器里也挂在 `window.glassium`。
 *
 * ```js
 * import glassium from 'glassium'
 * glassium.configure({ quality: 'auto' })
 * glassium.glass(el, { preset: 'tinted' })
 * await glassium.ready
 * console.log(glassium.capabilities)   // { webgpu, webgl2, backdropFilter, tier, renderer, … }
 * glassium.debug.enable()
 * ```
 *
 * 具名导出（createGlassStage、组件类……）照旧都在，这里只是把 runtime 的几样收成一个对象。
 */

import { currentStage, onStageChange, stageOrPending, type GlassStage } from '../renderer/stage.ts'
import { startRuntime } from './auto.ts'
import { detectSync, detectWebGpu, tierOf, type GlassiumCapabilities, type RendererKind } from './capabilities.ts'
import { configure, getConfig, type GlassiumConfig } from './config.ts'
import { glass, glassOf } from './glass.ts'

let syncCaps: ReturnType<typeof detectSync> | null = null
let webgpu: boolean | null = null
let webgpuProbe: Promise<boolean> | null = null

function rendererOf(stage: GlassStage | null): RendererKind {
  if (!stage) return 'none'
  if (!stage.active) return 'css'
  return stage.backend === 'webgpu' ? 'webgpu' : stage.backend === 'webgl2' ? 'webgl2' : 'css'
}

function capabilities(): GlassiumCapabilities {
  syncCaps ??= detectSync()
  const renderer = rendererOf(currentStage())
  const base = { ...syncCaps, webgpu, renderer }
  return { ...base, tier: tierOf(base) }
}

function probeWebGpu(): Promise<boolean> {
  webgpuProbe ??= detectWebGpu().then((ok) => (webgpu = ok))
  return webgpuProbe
}

/** WebGPU 查完、runtime 正在建的 stage 建完（或者失败）之后 resolve，给出完整的能力。 */
function ready(): Promise<GlassiumCapabilities> {
  const pending = stageOrPending()
  return Promise.all([probeWebGpu(), pending ? pending.catch(() => null) : Promise.resolve(null)]).then(() => capabilities())
}

const debug = {
  /** 右下角的调试面板：后端、质量、帧时间、面板数……（只在调用时加载）。 */
  async enable(): Promise<void> {
    const { enableDebugPanel } = await import('../debug/panel.ts')
    enableDebugPanel()
  },
  async disable(): Promise<void> {
    const { disableDebugPanel } = await import('../debug/panel.ts')
    disableDebugPanel()
  }
}

export interface Glassium {
  /** 让元素变成一块玻璃（见 runtime/glass.ts）。 */
  readonly glass: typeof glass
  /** 元素上的玻璃。 */
  readonly glassOf: typeof glassOf
  /** 改全局选项（见 runtime/config.ts）。 */
  readonly configure: (options: Partial<GlassiumConfig>) => GlassiumConfig
  readonly config: GlassiumConfig
  /** 能力：同步能查到的马上就有，WebGPU 与实际后端在 ready 之后补全。 */
  readonly capabilities: GlassiumCapabilities
  /** 能力查完、stage 建好之后 resolve。 */
  readonly ready: Promise<GlassiumCapabilities>
  /** configure({ auto: false }) 之后手动启动自动发现。 */
  readonly start: () => void
  /** 当前的 stage（高级用法；没有是 null）。 */
  readonly stage: GlassStage | null
  readonly debug: typeof debug
}

let readyPromise: Promise<GlassiumCapabilities> | null = null
if (typeof window !== 'undefined') {
  // stage 换了（建好、重建）：ready 重新算
  onStageChange(() => {
    readyPromise = null
  })
}

export const glassium: Glassium = {
  glass,
  glassOf,
  configure,
  get config() {
    return getConfig()
  },
  get capabilities() {
    return capabilities()
  },
  get ready() {
    readyPromise ??= ready()
    return readyPromise
  },
  start: startRuntime,
  get stage() {
    return currentStage()
  },
  debug
}
