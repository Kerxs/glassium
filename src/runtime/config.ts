/**
 * `glassium.configure()`：runtime 的全局选项。
 *
 * 默认值就是零配置：自动发现 `[glass]`、后端自动挑、质量自适应、玻璃后面的背景自动收进场景。
 * configure 要在 runtime 启动之前调才对「启动」这件事生效（import 之后同步调就行 —— 启动放在微任务里）；
 * 质量、收背景这些随时改随时生效。
 */

export type QualitySetting = 'auto' | 'high' | 'medium' | 'low' | number

export interface GlassiumConfig {
  /** 自动发现并接管 `[glass]` 元素。默认 true。 */
  readonly auto: boolean
  /**
   * 后端：auto 按 WebGPU → WebGL2 → CSS 挑。只在 runtime 建 stage 时用。
   * `'css'`：不建 GPU stage，所有玻璃照材质用 CSS 画（backdrop-filter，没有折射）—— 与 overlay 玻璃同一套画法。
   * 触屏设备上用得着：那里的滚动由合成线程直接做，画在页面底下的 GPU 玻璃会慢一两帧、落在文字后面
   */
  readonly backend: 'auto' | 'webgpu' | 'webgl2' | 'css'
  /** 质量：auto 按实测帧时间自适应；high / medium / low 是固定档；0–1 是固定的质量值。 */
  readonly quality: QualitySetting
  /** 玻璃后面挡着的 CSS 背景自动收进场景（见 absorb.ts）。默认 true。 */
  readonly absorbBackgrounds: boolean
  /** 组件（`<glass-*>`）也收背景。默认 false：组件照旧按 R1（祖先背景透明）。 */
  readonly absorbForComponents: boolean
  /** 玻璃后面的内容（文字、图片、SVG、画布、视频）画进场景（DOM Renderer，见 content.ts）。默认 true。 */
  readonly absorbContent: boolean
  /** 自适应质量把上次的结果记在 localStorage 里，下次从附近起步。默认 true。 */
  readonly rememberQuality: boolean
  /** 显存预算（字节，估计值；null 不限）。超了先放闲着的纹理、再降场景分辨率（stage.setMemoryBudget）。默认 null。 */
  readonly memoryBudget: number | null
  /**
   * CSS 画的玻璃也折射、色散（Chromium：backdrop-filter 叠一层 SVG 位移滤镜，见 refraction.ts）。默认 true；
   * 别的浏览器不认，照旧只有模糊与着色。玻璃多、设备弱时可以关掉
   */
  readonly cssRefraction: boolean
}

export const DEFAULT_CONFIG: GlassiumConfig = Object.freeze({
  auto: true,
  backend: 'auto',
  quality: 'auto',
  absorbBackgrounds: true,
  absorbForComponents: false,
  absorbContent: true,
  rememberQuality: true,
  memoryBudget: null,
  cssRefraction: true
})

let current: GlassiumConfig = DEFAULT_CONFIG
const listeners = new Set<(config: GlassiumConfig, previous: GlassiumConfig) => void>()

export function getConfig(): GlassiumConfig {
  return current
}

/** 合并进当前配置；非法值报一次、忽略。返回合并后的配置。 */
export function configure(options: Partial<GlassiumConfig>): GlassiumConfig {
  const previous = current
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(options)) {
    if (!(key in DEFAULT_CONFIG)) {
      console.warn(`[Glassium] configure 不认识 ${key}，已忽略`)
      continue
    }
    if (key === 'quality' && !validQuality(value)) {
      console.warn(`[Glassium] quality 只能是 'auto' | 'high' | 'medium' | 'low' 或 0–1 的数，收到 ${String(value)}`)
      continue
    }
    if (key === 'memoryBudget' && value !== null && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      console.warn(`[Glassium] memoryBudget 只能是正的字节数或 null，收到 ${String(value)}`)
      continue
    }
    if (key === 'backend' && value !== 'auto' && value !== 'webgpu' && value !== 'webgl2' && value !== 'css') {
      console.warn(`[Glassium] backend 只能是 'auto' | 'webgpu' | 'webgl2' | 'css'，收到 ${String(value)}`)
      continue
    }
    next[key] = value
  }
  current = Object.freeze(next) as unknown as GlassiumConfig
  for (const l of listeners) l(current, previous)
  return current
}

export function onConfigChange(listener: (config: GlassiumConfig, previous: GlassiumConfig) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function validQuality(q: unknown): q is QualitySetting {
  return q === 'auto' || q === 'high' || q === 'medium' || q === 'low' || (typeof q === 'number' && q >= 0 && q <= 1)
}

/** 固定档的质量值（auto 返回 null）。 */
export function fixedQuality(q: QualitySetting): number | null {
  if (q === 'auto') return null
  if (q === 'high') return 1
  if (q === 'medium') return 0.7
  if (q === 'low') return 0.4
  return q
}

/** 测试用：回到默认配置。 */
export function resetConfig(): void {
  current = DEFAULT_CONFIG
}
