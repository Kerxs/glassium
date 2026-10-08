/**
 * 能力检测：`glassium.capabilities`。
 *
 * 看的是浏览器**能做什么**（有没有 WebGPU、WebGL2、backdrop-filter、纹理上限……），不看设备型号。
 * 实际跑得动多少由自适应质量（performance/）按实测帧时间决定。
 *
 * 同步能查到的（backdrop-filter、视频帧回调……）在 import 时就有；WebGPU 要请求 adapter（异步），
 * 以及实际用上的后端，在 `glassium.ready` 之后补全。
 *
 * WebGL2 与纹理上限要真的建一个 WebGL2 上下文才查得到 —— 这很贵（第一次还要拉起 GPU 进程，慢的机器上上百毫秒，
 * 堵在主线程上）。所以它们是**用到时才查**的（[`detectWebGl2`]，查一次记住）：后端已经是 WebGPU 时，
 * 档位不看它们，就不会为了一个用不上的数建上下文。
 */

export type RendererKind = 'webgpu' | 'webgl2' | 'css' | 'none'

export interface GlassiumCapabilities {
  /** WebGPU：有 navigator.gpu 并且拿得到 adapter。异步查完之前是 null。 */
  readonly webgpu: boolean | null
  readonly webgl2: boolean
  /** CSS backdrop-filter（CSS 兜底的玻璃靠它）。 */
  readonly backdropFilter: boolean
  /** 纹理边长上限（WebGL2 查到的；WebGPU 用上之后换成它的）。查不到是 0。 */
  readonly maxTextureSize: number
  readonly videoFrameCallback: boolean
  readonly offscreenCanvas: boolean
  /** 实际用上的后端：stage 建好之前是 none；没有 GPU、高对比度模式下是 css。 */
  readonly renderer: RendererKind
  /**
   * 档位，按能力定：0 没有玻璃（普通 DOM），1 只有 CSS 玻璃，2 WebGL2，3 WebGPU。
   * 还没建 stage 时按「能用上的最好的」估。
   */
  readonly tier: 0 | 1 | 2 | 3
}

/** 能力 → 档位（纯函数，单元测试）。 */
export function tierOf(c: Pick<GlassiumCapabilities, 'webgpu' | 'webgl2' | 'backdropFilter' | 'renderer'>): 0 | 1 | 2 | 3 {
  if (c.renderer === 'webgpu') return 3
  if (c.renderer === 'webgl2') return 2
  if (c.renderer === 'css') return c.backdropFilter ? 1 : 0
  if (c.webgpu) return 3
  if (c.webgl2) return 2
  return c.backdropFilter ? 1 : 0
}

/** 同步、便宜的那部分（不建任何上下文）。SSR / Node 里全是 false。 */
export function detectSync(): Pick<GlassiumCapabilities, 'backdropFilter' | 'videoFrameCallback' | 'offscreenCanvas'> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { backdropFilter: false, videoFrameCallback: false, offscreenCanvas: false }
  }
  const supports = (prop: string): boolean => typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports(prop)
  return {
    backdropFilter: supports('backdrop-filter: blur(1px)') || supports('-webkit-backdrop-filter: blur(1px)'),
    videoFrameCallback: typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined'
  }
}

/** WebGL2 与纹理上限：建一个 WebGL2 上下文、读完就丢。贵，用到时才调（见模块文档）。SSR / Node 里是 false / 0。 */
export function detectWebGl2(): Pick<GlassiumCapabilities, 'webgl2' | 'maxTextureSize'> {
  if (typeof document === 'undefined') return { webgl2: false, maxTextureSize: 0 }
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return { webgl2: false, maxTextureSize: 0 }
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { webgl2: true, maxTextureSize }
  } catch {
    return { webgl2: false, maxTextureSize: 0 }
  }
}

/** WebGPU：请求一次 adapter（不建设备）。 */
export async function detectWebGpu(): Promise<boolean> {
  const gpu = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}
