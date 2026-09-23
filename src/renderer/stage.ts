/**
 * GlassStage —— 画布宿主与帧循环。
 *
 * 三层宿主（见 docs/limitations.md）：
 *   L0  canvas[data-glassium-scene]  position:fixed; inset:0; z-index:-1
 *   L1  DOM 内容                      照常排版，不需要任何层叠设置（背景必须透明，R1）
 *   L2  #glassium-overlay             z-index:3，**第一期为空**，留给 T13+ 的
 *                                     glass-above-DOM（GlassDialog / GlassSheet）
 *
 * L2 现在就占住层级，是为了将来加它的时候不必让所有使用方重排层叠。
 *
 * ## 为什么是 z-index: -1（与 meshora 相同）
 *
 * T5 到 T9 期间这里是 z-index: 0，理由写的是「-1 会画到根背景之下、被任何带背景的祖先
 * 盖掉」。前半句是错的：负 z-index 的层叠上下文画在根背景**之上**、所有常规流内容之下
 * （CSS 2.1 附录 E 的第 2 步）。实测 -1 时一点上的命中栈是 [面板, main.content, body, 画布, html]，
 * 画布在 html 之上，场景照常可见。后半句对 -1 和 0 同样成立，不构成区别。
 *
 * 而 0 有一个实打实的代价：画布画在所有**不定位**的内容之上。一个没把内容包进
 * z-index ≥ 1 容器的普通页面，正文会整个被画布盖住（实测：一行不定位的文字在 0 下消失，
 * 在 -1 下正常显示）。这恰好是第一次用的人最可能写出的页面。
 *
 * -1 的代价只有一个：<html> 和 <body> **都**设了背景时，body 的背景画在画布之上，把玻璃挡住。
 * 只给 body 设背景没事 —— html 没有背景时 body 的背景会传播成根背景，画在最底层。
 * 前一种情况 layering.ts 会点名报出来。
 *
 * ## 两层结构
 *
 * 这个文件是**外壳**：画布、面板注册表、调试参数、帧循环、监听器。这些与 GPU 后端无关，
 * 跨设备存活。一个后端（gpu.ts 的 GpuRenderer 或 webgl2/renderer.ts 的 Gl2Renderer）持有
 * 一台设备 / 一个上下文上的全部渲染资源，丢失时整体丢弃、整体重建 —— 面板和参数不受影响。
 *
 * 后端的阶梯：WebGPU → WebGL2 → none（CSS 兜底）。启动时按这个顺序选；运行中某个后端
 * 第二次丢失，也按这个顺序往下降。
 */

import { parseTint, type GlassMaterial } from '../core/material.ts'
import { describeViewport, resolveViewport, type ResolvedViewport } from '../core/units.ts'
import type { PanelDebugMode } from '../shaders/glass.wgsl.ts'
import {
  acquireDevice,
  gpuCreationCounts,
  releaseDevice,
  simulateDeviceLoss
} from '../webgpu/device.ts'
import { Gl2Renderer, gl2CreationCounts } from '../webgl2/renderer.ts'
import type {
  BackdropState,
  BackendReport,
  GroupProbeRequest,
  ProbeRequest,
  ReadbackRegion,
  ReadbackRequest,
  ReadbackResult,
  Renderer
} from './backend.ts'
import { GpuRenderer } from './gpu.ts'
import { unchangedFrame, type FrameSnapshot } from './idle.ts'
import { LayerWatcher, type LayerProblem } from './layering.ts'
import { PanelRegistry, type GlassGroup, type GlassPanel } from './panels.ts'
import {
  SceneSlot,
  sceneFallbackCss,
  type GlassSceneSource,
  type SceneKind,
  type SceneOptions
} from './scene-source.ts'
import type { GroupOpticsProbe, OpticsProbe } from './verify.ts'

export type { GlassSceneSource, SceneKind, SceneOptions } from './scene-source.ts'

export {
  READBACK_SIZE,
  type BackendReport,
  type Gl2Report,
  type ReadbackRegion,
  type ReadbackResult
} from './backend.ts'

export type Backend = 'webgpu' | 'webgl2' | 'none'

export interface GlassStats {
  readonly backend: Backend
  /**
   * 最近一秒实际画了几帧。什么都没变时不画（见 idle.ts），所以静止的页面上是 0；
   * prefers-reduced-motion 下也恒为 0（循环根本没启动）。
   */
  readonly fps: number
  /** 画了的帧数。 */
  readonly frames: number
  /** 因为与上一帧逐像素相同而没有画的帧数（循环照跑、面板照量，只是不提交）。 */
  readonly skippedFrames: number
  readonly drawCalls: number
  /** 渲染目标分配次数（跨设备累计）。稳定后不应再增长。 */
  readonly targetAllocations: number
  /** 上一帧的模糊趟数。应当等于 2×(K−1)，**与面板数量无关**。 */
  readonly blurPasses: number
  /** 模糊链的级数 K。 */
  readonly blurLevels: number
  /** 本帧实际画了的面板数，含合并组里的成员（屏外的不算）。 */
  readonly panels: number
  /** 本帧画了几个合并组。每组一次 draw call，与成员数无关。 */
  readonly groups: number
  /**
   * 上一帧主线程上的耗时，毫秒：measure 是量所有面板（getBoundingClientRect 等）的那一段，
   * total 是整帧（测量 + 打包 + 编码与提交）。不含 GPU 执行时间。没有画的帧只有测量与比较。
   */
  readonly cpuMs: { readonly measure: number; readonly total: number }
  /** 这个 stage 经历过的意外设备丢失次数（主动 dispose 不算）。 */
  readonly deviceLosses: number
  /**
   * 本会话建过的渲染/计算管线总数（跨设备累计，数在设备上，见 webgpu/device.ts）。
   * 预热之后必须走平 —— 持续上涨说明有东西拿逐面板或逐帧的值在建管线。
   */
  readonly pipelineCreations: number
  /** 同上，bind group。只在视口尺寸变化、面板数超过容量、场景图片换尺寸、换设备时增长。 */
  readonly bindGroupCreations: number
  /** 当前场景是哪一类。'builtin' 是内置的程序化场景。 */
  readonly scene: SceneKind
  /**
   * 用户场景累计上传了几次。静态图片只在换图、视口变化重新缩放时各传一次；
   * 视频只在出新帧时传。一直涨说明有东西在每帧重传。
   */
  readonly sceneUploads: number
  readonly viewport: ResolvedViewport | null
  readonly reducedMotion: boolean
  /** 高对比度模式（forced-colors: active）。开着时 stage 停用，画布隐藏。 */
  readonly forcedColors: boolean
}

export interface GlassStageOptions {
  /** 画布挂到哪里。默认 document.body。 */
  readonly host?: HTMLElement
  readonly maxPixels?: number
  readonly minSceneRatio?: number
  /**
   * 画布的 alphaMode。
   *
   * 默认 'opaque'：画布是最底层、并且**自己画背景**（R1：页面背景属于场景，
   * 不属于 CSS），所以硬遮挡下方一切正是想要的，而且更快。
   *
   * 想让页面自己的 CSS 背景透上来时才用 'premultiplied' —— 那时片元必须满足
   * rgb <= a，否则合成结果未定义。规范不允许 'unpremultiplied'。
   */
  readonly alphaMode?: GPUCanvasAlphaMode
  /** 降级发生时回调。在 console.warn **之后**触发。 */
  readonly onDegrade?: (reason: DegradeReason) => void
  /**
   * 用哪个后端。默认 'auto'：WebGPU → WebGL2 → CSS 兜底。
   * 显式指定时只试那一个，失败就直接到 CSS 兜底 —— 指定了就是想要它，悄悄换成另一个
   * 会让「我到底在测哪个后端」说不清。
   */
  readonly backend?: 'auto' | 'webgpu' | 'webgl2'
  /**
   * 初始场景，同 setScene。加载完成之前画 sceneOptions.background 的纯色 —— 不画内置场景，
   * 免得先闪一下别的图案。加载失败时警告，退回内置场景。createGlassStage 不等它加载完。
   */
  readonly scene?: GlassSceneSource
  readonly sceneOptions?: SceneOptions
}

export interface DegradeReason {
  readonly from: Backend
  readonly to: Backend
  readonly detail: string
}

/**
 * 背景调试参数。
 *
 * 这是**实验用的全局旋钮**，不是最终 API —— 真正的用法是逐面板的 GlassMaterial（T7）。
 * 放在 debug 下面是为了不让人误以为它是正式接口。
 */
export interface BackdropDebugParams {
  /** 模糊 σ，dp。 */
  readonly blurDp?: number
  readonly saturation?: number
  /** CSS 颜色字符串，alpha 是叠加强度。 */
  readonly tint?: string
  /**
   * 场景图案。
   *
   * 'calibration' 是棋盘格 + 硬对角线 + 黑白阶跃 —— **判断效果对不对只能用它**。
   * 'gradient' 好看，但线性渐变几乎是高斯模糊的不动点，也几乎看不出折射与色散，
   * 拿它验效果等于什么都没验。
   */
  readonly scene?: 'gradient' | 'calibration' | 'radial' | 'flat'
  /** radial 场景的中心，画布 CSS 像素。 */
  readonly radialCenter?: readonly [number, number]
  /** radial 场景的半径，以视口高为单位。 */
  readonly radialRadius?: number
}

export interface GlassStage {
  /** 当前后端。设备第二次丢失之后会从 'webgpu' 变成 'none'。 */
  readonly backend: Backend
  /**
   * 此刻是不是真的在画玻璃。没有 GPU 后端、或者处于高对比度模式时为 false。
   * 组件据此决定要不要显示 CSS 兜底表面（见 components/glassium.css）。
   */
  readonly active: boolean
  /**
   * 画布（L0）。**降级时会换成一块新的**（一块画布只能有一种上下文），所以别缓存它，
   * 每次用的时候从这里取。
   */
  readonly canvas: HTMLCanvasElement
  /**
   * 把一个 DOM 元素注册成玻璃面板。
   *
   * 元素负责占位、文字、点击与焦点；stage 每帧量它的 getBoundingClientRect，
   * 在画布上它的正后方画玻璃。滚动、缩放、布局变化都自动跟上。
   *
   * R1：面板和画布之间的每一层都必须背景透明，否则玻璃会被整块挡住。
   * 注册之后 stage 会在面板进入视口时查一遍（见 layering.ts），查出来就点名警告。
   *
   * 材质写错（比如 tint 解析不了）在这里就抛，而不是等到帧循环里。
   */
  register(element: HTMLElement, material?: GlassMaterial): GlassPanel
  /**
   * 建一个合并组：成员（按元素指定）的玻璃用 smin 连成一个连续形状，一次 draw 画完。
   * `<glass-container>` 背后就是它。最多 4 块，多出来的单独绘制并警告一次。
   */
  group(options?: { readonly smoothing?: number }): GlassGroup
  /**
   * 玻璃后面画什么：一张图、一段视频或一块画布，按 fit 铺满视口。传 null 回到内置场景。
   *
   * 返回的 Promise 在新场景可以画出来时 resolve（图片已解码并缩放好、视频有了第一帧），
   * 在那之前继续画旧场景，中间不闪。加载失败时 reject，场景保持原样；被后一次 setScene
   * 取代的调用 reject 一个 name 为 'AbortError' 的 DOMException。
   *
   * 跨源的图片与视频需要 CORS（服务器带 Access-Control-Allow-Origin，元素设 crossOrigin），
   * 否则浏览器不允许把它传进 GPU —— 这种情况在这里就 reject，不会等到画的时候。
   * 传进来的 ImageBitmap 在换掉之前要保持打开：视口变化时要从它重新缩放。
   */
  setScene(source: GlassSceneSource | null, options?: SceneOptions): Promise<void>
  /** 非 dynamic 的画布、ImageData 内容变了（或者想让暂停的视频换一帧）：下一帧重新上传。 */
  refreshScene(): void
  readonly debug: {
    stats(): GlassStats
    /**
     * 立即检查所有在视口里的面板与画布之间有什么，返回全部问题（含已经警告过的）。
     * 平时不需要手动调 —— 面板进入视口、页面上的 style / class 变化都会自动触发。
     */
    checkLayers(): LayerProblem<Element>[]
    /**
     * 当前后端的能力探测结果（WebGPU 与 WebGL2 用 kind 区分）。没有 GPU 时为 null；
     * 丢失恢复后是新设备的结果。
     */
    readonly probe: BackendReport | null
    /** 调整全屏背景视图的参数。见 BackdropDebugParams。 */
    setBackdrop(params: BackdropDebugParams): void
    /**
     * 回读画布上一块区域的像素。不给 region 时取画布中心 READBACK_SIZE 见方。
     *
     * 返回的数据**一律是 RGBA 顺序**。画布的实际格式由 getPreferredCanvasFormat 决定，
     * Windows 上是 bgra8unorm —— 原样返回的话，第 0 个字节是蓝不是红。任何比较 R 和 B 的
     * 测量（比如色散的彩边次序）拿到原始字节都会把结论弄反，而且弄反了也看不出来。
     *
     * 必须走 GPU 侧的 copyTextureToBuffer —— **DOM 侧读不出来**：
     * 对 WebGPU 画布调 drawImage / createImageBitmap 得到的是全黑，即使
     * 画面正常显示、即使 configure 时加了 COPY_SRC。
     */
    readback(region?: ReadbackRegion): Promise<ReadbackResult>
    /**
     * 立刻同步画一帧，不等 requestAnimationFrame。
     *
     * 给验证用：标签页或面板被隐藏时浏览器会暂停 rAF，readback() / probeOptics() 就会
     * 一直等下去。Claude 桌面端的浏览器面板就是这样，而且隐藏时 document.visibilityState
     * **不一定**报 hidden（实测两种都见过），从页面里看不出来。在 readback() 之后调一次，
     * 请求就在这一帧里被服务 —— WebGPU 的提交与 mapAsync 都不依赖 rAF。
     */
    renderNow(): void
    /**
     * 模拟一次意外丢失：WebGPU 销毁当前设备，WebGL2 用 WEBGL_lose_context 丢掉上下文
     * （并在下一个任务里恢复，与真实的驱动重置一样是异步的）。验证恢复与降级那条路径用。
     */
    simulateContextLoss(): boolean
    /** 所有面板的调试视图：'sdf' / 'mask' / 'grad' / 'displacement'，'off' 恢复正常。 */
    setPanelDebug(mode: PanelDebugMode): void
    /**
     * 把第 index 块面板的光学中间量（sd、方向、位移）原样渲进 rgba32float 并回读。
     * 交给 compareOptics() 与 CPU 实现逐像素比对 —— 探针与正常渲染共用同一段
     * evalOptics，所以验的就是实际渲染的那条路径。
     */
    probeOptics(index?: number): Promise<OpticsProbe>
    /** 第 index 个合并组的光学量探针，交给 compareGroupOptics() 与 CPU 实现逐像素比对。 */
    probeGroup(index?: number): Promise<GroupOpticsProbe>
  }
  /** 请求重绘一帧。reduced-motion 下由 resize 等事件驱动。 */
  requestRender(): void
  dispose(): void
}

/** 着色器没起来时的兜底底色，照 meshora 的做法：宁可退回 CSS，也不要白屏。 */
const CSS_FALLBACK =
  'radial-gradient(130% 150% at 16% 4%, #aed5f3 0%, #2e58a4 42%, #04101f 100%)'

let activeStage: GlassStage | null = null
/** 正在创建中的 stage。createGlassStage 要等 GPU 设备，两次调用可能交错。 */
let pendingStage: Promise<GlassStage> | null = null

const stageListeners = new Set<(stage: GlassStage | null) => void>()

/** 当前的 stage。还没建好或已经 dispose 时为 null。 */
export function currentStage(): GlassStage | null {
  return activeStage
}

/**
 * 订阅 stage 的变化：建好、dispose、降级、高对比度开关。返回取消订阅的函数。
 *
 * 组件靠它来**早于 stage** upgrade：createGlassStage 要等 GPU 设备，而
 * customElements.define 一执行，页面上已有的元素就立即 upgrade —— 「先建 stage 再 upgrade」
 * 在实际页面里做不到。组件 upgrade 时没有 stage 就先等着，stage 建好时统一注册。
 */
export function onStageChange(listener: (stage: GlassStage | null) => void): () => void {
  stageListeners.add(listener)
  return () => {
    stageListeners.delete(listener)
  }
}

function notifyStageChange(): void {
  for (const listener of [...stageListeners]) listener(activeStage)
}

let reducedMotionOverride: boolean | null = null
let onReducedMotionOverrideChange: (() => void) | null = null

let forcedColorsOverride: boolean | null = null
let onForcedColorsOverrideChange: (() => void) | null = null

/** 当前是否减少动效（尊重 simulateReducedMotion）。组件的交互动画也看它。 */
export function prefersReducedMotion(): boolean {
  if (reducedMotionOverride !== null) return reducedMotionOverride
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 强制高对比度（forced-colors）状态，传 null 恢复为读真实媒体查询。
 *
 * 理由同 simulateReducedMotion：本机打开高对比度要改系统设置，而验证的是 stage 的
 * 反应 —— 画布要藏起来、帧循环要停、组件要换成 CSS 兜底表面。
 * `@media (forced-colors: active)` 里那几条 CSS 本身不经过这里，它们要靠真的打开
 * 系统高对比度来验。
 */
export function simulateForcedColors(on: boolean | null): void {
  forcedColorsOverride = on
  onForcedColorsOverrideChange?.()
}

/**
 * 强制 reduced-motion 状态，传 null 恢复为读真实媒体查询。
 *
 * 和 simulateNoWebGpu 是同一类东西，理由也一样：这条路径在本机跑不到。
 * 改不了 OS 设置，而 `window.matchMedia()` **每次调用都返回一个新对象** ——
 * 在外面 dispatchEvent 到自己那个实例上，根本到不了 stage 持有的那个监听器。
 * （这一点踩过：合成事件看起来发出去了，处理函数从头到尾没被调用过。）
 *
 * 它验证的是**帧循环的闸门逻辑**：该不该停、停了还能不能被 resize 唤醒。
 * 媒体查询本身求值对不对是浏览器的事，不在这里验。
 */
export function simulateReducedMotion(on: boolean | null): void {
  reducedMotionOverride = on
  onReducedMotionOverrideChange?.()
}

/**
 * 创建 stage。每文档一个（R3）。
 *
 * 第二次调用会**警告并返回同一个** —— 不抛。抛的话会让「组件各自确保 stage 存在」
 * 这种很自然的写法变成必须由调用方做全局协调，而多个上下文的真实代价（浏览器上限、
 * 互相之间无法采样）用一条警告说清楚就够了。
 *
 * 第一次调用还没完成（在等 GPU 设备）时的第二次调用，拿到的是同一个 Promise ——
 * 早先这里只查已经建好的 stage，两次调用交错时会建出两个。
 */
export function createGlassStage(options: GlassStageOptions = {}): Promise<GlassStage> {
  const existing = activeStage ? Promise.resolve(activeStage) : pendingStage
  if (existing) {
    console.warn(
      '[Glassium] 已经存在一个 stage，返回既有实例。每文档只应有一个 —— ' +
        '多个画布之间无法互相采样，glass-container 的合并会失效。'
    )
    return existing
  }
  const pending = buildStage(options)
  pendingStage = pending
  const settle = (): void => {
    if (pendingStage === pending) pendingStage = null
  }
  pending.then(settle, settle)
  return pending
}

/** 建一块画布（L0）。还没有任何上下文 —— 取哪一种由选后端的逻辑决定。 */
function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.dataset.glassiumScene = ''
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    zIndex: '-1', // 理由见文件头
    pointerEvents: 'none',
    background: CSS_FALLBACK
  } satisfies Partial<CSSStyleDeclaration>)
  return canvas
}

type WebGpuStart =
  | { readonly ok: true; readonly value: GpuRenderer }
  | { readonly ok: false; readonly detail: string; readonly claimed: boolean }

/**
 * 在画布上起 WebGPU。失败时说明原因，并告诉调用方画布是不是已经被取过 webgpu 上下文 ——
 * 一块画布只能有一种上下文，取过就得换一块新画布才能再试 WebGL2。
 */
async function startWebGpu(canvas: HTMLCanvasElement, alphaMode: GPUCanvasAlphaMode): Promise<WebGpuStart> {
  const acquired = await acquireDevice()
  if (!acquired.ok) {
    return { ok: false, claimed: false, detail: `${acquired.failure.kind}：${acquired.failure.detail}` }
  }
  const context = canvas.getContext('webgpu')
  if (!context) return { ok: false, claimed: false, detail: 'canvas.getContext("webgpu") 返回 null' }
  try {
    const renderer = await GpuRenderer.create(acquired.value.device, acquired.value.format, context, alphaMode)
    return { ok: true, value: renderer }
  } catch (err) {
    return { ok: false, claimed: true, detail: `建 WebGPU 渲染资源失败：${String(err)}` }
  }
}

async function buildStage(options: GlassStageOptions): Promise<GlassStage> {
  const host = options.host ?? document.body
  const alphaMode = options.alphaMode ?? 'opaque'
  const preferred = options.backend ?? 'auto'

  let canvas = makeCanvas()
  host.prepend(canvas)

  const degrade = (reason: DegradeReason): void => {
    console.warn(`[Glassium] 降级 ${reason.from} → ${reason.to}：${reason.detail}`)
    options.onDegrade?.(reason)
  }

  // —— 选后端：WebGPU → WebGL2 → none ——
  //
  // 'auto' 走完整的阶梯；显式指定 'webgpu' 或 'webgl2' 时只试那一个 —— 指定了就是想要它，
  // 悄悄换成另一个会让「我到底在测哪个后端」变得说不清。
  let renderer: Renderer | null = null
  let claimed = false
  if (preferred !== 'webgl2') {
    const started = await startWebGpu(canvas, alphaMode)
    if (started.ok) {
      renderer = started.value
    } else {
      claimed = started.claimed
      degrade({ from: 'webgpu', to: preferred === 'auto' ? 'webgl2' : 'none', detail: started.detail })
    }
  }
  if (!renderer && preferred !== 'webgpu') {
    if (claimed) {
      const fresh = makeCanvas()
      canvas.replaceWith(fresh)
      canvas = fresh
    }
    const started = Gl2Renderer.create(canvas, alphaMode)
    if (started.ok) renderer = started.value
    else degrade({ from: 'webgl2', to: 'none', detail: started.detail })
  }
  if (!renderer) {
    const stage = makeInertStage(canvas, options)
    activeStage = stage
    notifyStageChange()
    return stage
  }

  // —— 与后端无关、跨设备存活的状态 ——
  let backend: Backend = renderer.kind
  /** 整个 stage 经历过的意外丢失（WebGPU 设备 + WebGL2 上下文）。 */
  let deviceLosses = 0
  /** 当前这个后端丢过几次。换后端时清零：第一次重建，第二次降级，每个后端各算各的。 */
  let lossesThisBackend = 0
  let retiredAllocations = 0
  /** 刚重建或换了画布：视口没变也必须 resize 一次，新资源上还没有任何纹理。 */
  let forceResize = false

  let viewport: ResolvedViewport | null = null
  let disposed = false
  let rafId = 0
  let pendingOneShot = 0
  let frames = 0
  let skippedFrames = 0
  /** 上一帧画的是什么、用哪个后端画的。与这一帧相同就不画（idle.ts）。 */
  let lastFrame: FrameSnapshot | null = null
  let lastRenderer: Renderer | null = null
  let drawCalls = 0
  let blurPasses = 0
  let panelsLastFrame = 0
  let groupsLastFrame = 0
  let measureMs = 0
  let frameMs = 0
  let sceneUploads = 0
  let fps = 0
  let fpsWindowStart = 0
  let fpsWindowFrames = 0
  const startTime = performance.now()

  let pendingProbe: ProbeRequest | null = null
  let pendingGroupProbe: GroupProbeRequest | null = null
  let pendingReadback: ReadbackRequest | null = null

  // 背景调试参数（实验用，非正式 API）
  let backdrop: BackdropState = {
    blurDp: 0,
    saturation: 1,
    tint: [1, 1, 1, 0],
    sceneMode: 0,
    radialCenterCss: [0, 0],
    radialRadius: 0.5
  }
  let panelDebugMode: PanelDebugMode = 'off'

  const panels = new PanelRegistry(() => requestRender())
  const scene = new SceneSlot(
    () => viewport,
    () => requestRender()
  )

  /** 没有 GPU 后端时，画布露出来的是它自己的 CSS 背景：用户场景能写成 CSS 就用它，否则用兜底底色。 */
  const applyFallbackBackground = (): void => {
    canvas.style.background = scene.fallbackCss() ?? CSS_FALLBACK
  }

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const readReducedMotion = (): boolean => reducedMotionOverride ?? motionQuery.matches
  let reducedMotion = readReducedMotion()

  // 高对比度模式下折射图像没有意义，还会让强制配色下的文字压在一张花哨的背景上。
  // 停用 stage：画布藏起来、帧循环停下，组件换成 CSS 兜底表面（由 active 驱动）。
  const forcedColorsQuery = window.matchMedia('(forced-colors: active)')
  const readForcedColors = (): boolean => forcedColorsOverride ?? forcedColorsQuery.matches
  let forcedColors = readForcedColors()
  if (forcedColors) canvas.style.display = 'none'

  /** 此刻为什么不画玻璃；在画时返回 null。 */
  const inactiveReason = (): string | null =>
    disposed
      ? 'stage 已销毁'
      : backend === 'none'
        ? '没有 GPU 后端'
        : forcedColors
          ? '高对比度模式下 stage 停用'
          : null

  /** 此刻是不是真的在画玻璃。 */
  const isActive = (): boolean => inactiveReason() === null

  const layers = new LayerWatcher(() => canvas, isActive)

  /** 在途的回读与探针全部作废。设备丢失或 stage 销毁时调用，免得调用方的 Promise 永远挂着。 */
  const rejectPending = (why: string): void => {
    pendingProbe?.reject(new Error(`[Glassium] ${why}，探针作废`))
    pendingGroupProbe?.reject(new Error(`[Glassium] ${why}，探针作废`))
    pendingReadback?.reject(new Error(`[Glassium] ${why}，回读作废`))
    pendingProbe = null
    pendingGroupProbe = null
    pendingReadback = null
  }

  /** 量画布、按需重新分配。返回这次有没有重新分配（重新分配会清空画布，这一帧必须画）。 */
  const syncViewport = (): boolean => {
    // 用画布**自己的**盒子，不用 window.innerWidth。
    //
    // innerWidth 包含垂直滚动条，而 position:fixed; inset:0 的画布不包含。
    // 实测 1024 宽视口、15px 滚动条、DPR 1.5：按 innerWidth 分配了 1536 个设备像素，
    // 浏览器却把它们摊在 1008.67 个 CSS 像素上显示 —— 实际缩放 1.5228 而不是 1.5，
    // 玻璃相对元素的错位随 x 线性增长，右侧到 7.5 CSS 像素（11 个设备像素）。
    // 页面不滚动时没有滚动条，这个 bug 完全看不见。
    const box = canvas.getBoundingClientRect()
    const cssWidth = Math.max(1, box.width)
    const cssHeight = Math.max(1, box.height)
    const dpr = window.devicePixelRatio || 1
    const next = resolveViewport(cssWidth, cssHeight, dpr, options.maxPixels, options.minSceneRatio)

    const changed =
      forceResize ||
      !viewport ||
      viewport.compositeWidth !== next.compositeWidth ||
      viewport.compositeHeight !== next.compositeHeight ||
      viewport.sceneWidth !== next.sceneWidth ||
      viewport.sceneHeight !== next.sceneHeight

    viewport = next
    if (!changed || !renderer) return false
    forceResize = false

    canvas.width = next.compositeWidth
    canvas.height = next.compositeHeight
    const levels = renderer.resize(next)
    console.info(`[Glassium] ${describeViewport(next)} · 模糊链 ${levels} 级 · ${renderer.kind}`)
    if (next.budgetExceeded) {
      console.warn(
        '[Glassium] 保底清晰度压过了像素预算 —— 场景分辨率高于预算允许的值。' +
          '这是定死的优先级，不是 bug，但大视口上会更吃 GPU。'
      )
    }
    return true
  }

  /** 帧率窗口每次循环都要推进 —— 只在画了的帧上推进的话，静止之后它会停在最后一个忙碌的值上。 */
  const tickFps = (now: number, rendered: boolean): void => {
    if (fpsWindowStart === 0) fpsWindowStart = now
    if (rendered) fpsWindowFrames++
    if (now - fpsWindowStart >= 1000) {
      fps = Math.round((fpsWindowFrames * 1000) / (now - fpsWindowStart))
      fpsWindowStart = now
      fpsWindowFrames = 0
    }
  }

  /** @param force 与上一帧相同也画（renderNow 用：它的意思就是「现在画一帧」）。 */
  const renderFrame = (now: number, force = false): void => {
    if (disposed || !renderer) return
    const t0 = performance.now()
    const resized = syncViewport()
    if (!viewport) return

    // 所有面板在这里一次量完，帧内之后不再碰布局（避免 layout thrash）。
    const canvasBox = canvas.getBoundingClientRect()
    const measured = panels.measure(viewport, canvasBox.left, canvasBox.top)
    const t1 = performance.now()

    const frame: FrameSnapshot = {
      // reduced-motion 下时间冻结在 0：循环不跑的同时画面也必须是确定的那一帧，
      // 否则 resize 触发的重绘会跳到另一个相位，看起来像闪烁。
      time: reducedMotion ? 0 : (now - startTime) / 1000,
      viewport,
      backdrop,
      sceneImage: scene.frame(viewport),
      panels: measured.panels,
      groups: measured.groups,
      panelDebugMode
    }

    // 与上一帧逐像素相同就不画：浏览器继续显示上一帧。回读与探针要一帧来服务，照画。
    const requested = pendingProbe !== null || pendingGroupProbe !== null || pendingReadback !== null
    if (!force && !resized && !requested && renderer === lastRenderer && unchangedFrame(lastFrame, frame)) {
      skippedFrames++
      measureMs = t1 - t0
      frameMs = performance.now() - t0
      tickFps(now, false)
      return
    }

    const probe = pendingProbe
    const groupProbe = pendingGroupProbe
    const readback = pendingReadback
    pendingProbe = null
    pendingGroupProbe = null
    pendingReadback = null

    const result = renderer.render({ ...frame, probe, groupProbe, readback })
    if (!result) {
      // 这一帧没画成（比如资源还没就绪、上下文刚丢）：请求放回去，下一帧再服务
      pendingProbe ??= probe
      pendingGroupProbe ??= groupProbe
      pendingReadback ??= readback
      lastFrame = null
      return
    }
    lastFrame = frame
    lastRenderer = renderer

    frames++
    sceneUploads += result.sceneUploads
    measureMs = t1 - t0
    frameMs = performance.now() - t0
    drawCalls = result.drawCalls
    blurPasses = result.blurPasses
    let grouped = 0
    for (const g of measured.groups) grouped += g.members.length
    panelsLastFrame = measured.panels.length + grouped
    groupsLastFrame = measured.groups.length
    tickFps(now, true)
  }

  const loop = (now: number): void => {
    if (disposed) return
    renderFrame(now)
    rafId = requestAnimationFrame(loop)
  }

  const startLoop = (): void => {
    if (disposed || rafId !== 0 || backend === 'none' || forcedColors) return
    if (reducedMotion) {
      // 一个 rAF 都不排 —— 零持续开销，不是「排了但什么都不做」。
      fps = 0
      requestRender()
      return
    }
    rafId = requestAnimationFrame(loop)
  }

  const stopLoop = (): void => {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    fps = 0
    fpsWindowStart = 0
    fpsWindowFrames = 0
  }

  function requestRender(): void {
    if (disposed || rafId !== 0 || pendingOneShot !== 0 || backend === 'none' || forcedColors) return
    pendingOneShot = requestAnimationFrame((now) => {
      pendingOneShot = 0
      renderFrame(now)
    })
  }

  // —— 换画布 ——
  //
  // 一块画布只能有一种上下文：WebGPU 降到 WebGL2 必须换一块新的；降到 none 也换 ——
  // 新画布上没有任何上下文，它自己的 CSS 背景（兜底底色）直接露出来，不会冻在最后一帧。

  const onContextLost = (event: Event): void => {
    event.preventDefault() // 不阻止的话浏览器不会恢复这个上下文
    const lost = renderer
    if (disposed || !(lost instanceof Gl2Renderer)) return
    deviceLosses++
    lossesThisBackend++
    rejectPending('WebGL2 上下文丢失')
    retiredAllocations += lost.allocations
    lost.destroy()
    renderer = null
    stopLoop()
    if (lossesThisBackend > 1) {
      degradeFromCurrent(`WebGL2 上下文第 ${lossesThisBackend} 次丢失，不再重试`)
      return
    }
    glLostAt = performance.now()
    console.warn('[Glassium] WebGL2 上下文丢失，等浏览器恢复后重建全部资源（面板与参数保留）')
  }
  let glLostAt = 0

  const onContextRestored = (): void => {
    if (disposed || backend !== 'webgl2' || renderer) return
    const started = Gl2Renderer.create(canvas, alphaMode)
    if (!started.ok) {
      degradeFromCurrent(`WebGL2 上下文恢复后重建失败：${started.detail}`)
      return
    }
    renderer = started.value
    forceResize = true
    console.info(`[Glassium] WebGL2 上下文已恢复，重建耗时 ${Math.round(performance.now() - glLostAt)} ms`)
    startLoop()
    requestRender()
  }

  const attachCanvasListeners = (c: HTMLCanvasElement): void => {
    c.addEventListener('webglcontextlost', onContextLost)
    c.addEventListener('webglcontextrestored', onContextRestored)
  }
  const detachCanvasListeners = (c: HTMLCanvasElement): void => {
    c.removeEventListener('webglcontextlost', onContextLost)
    c.removeEventListener('webglcontextrestored', onContextRestored)
  }

  const replaceCanvas = (): void => {
    const fresh = makeCanvas()
    if (forcedColors) fresh.style.display = 'none'
    detachCanvasListeners(canvas)
    resizeObserver.unobserve(canvas)
    canvas.replaceWith(fresh)
    canvas = fresh
    attachCanvasListeners(fresh)
    resizeObserver.observe(fresh)
    viewport = null
    forceResize = true
  }

  // —— 降级 ——
  //
  // 当前后端第二次丢失（或重建失败）时调用。WebGPU 在 'auto' 下先降到 WebGL2，
  // 其余情况降到 none。为什么只重试一次：连续丢失通常说明驱动或 GPU 本身有问题，
  // 反复重建只会让页面反复卡顿。

  function degradeFromCurrent(detail: string): void {
    const from = backend
    if (renderer) {
      retiredAllocations += renderer.allocations
      renderer.destroy()
      renderer = null
    }
    stopLoop()
    rejectPending('已降级')
    replaceCanvas()

    if (from === 'webgpu' && preferred === 'auto') {
      const started = Gl2Renderer.create(canvas, alphaMode)
      degrade({ from: 'webgpu', to: 'webgl2', detail })
      if (started.ok) {
        renderer = started.value
        backend = 'webgl2'
        lossesThisBackend = 0
        console.info('[Glassium] 已在 WebGL2 上继续渲染（面板与参数保留）')
        startLoop()
        requestRender()
        notifyStageChange()
        return
      }
      degrade({ from: 'webgl2', to: 'none', detail: started.detail })
    } else {
      degrade({ from, to: 'none', detail })
    }
    backend = 'none'
    applyFallbackBackground()
    notifyStageChange() // 组件据此换上 CSS 兜底表面
  }

  // —— WebGPU 设备丢失：第一次在新设备上重建，第二次降级 ——

  const recover = async (lost: GpuRenderer): Promise<void> => {
    deviceLosses++
    lossesThisBackend++
    rejectPending('设备丢失')
    retiredAllocations += lost.allocations
    lost.destroy()
    if (renderer === lost) renderer = null

    if (lossesThisBackend > 1) {
      degradeFromCurrent(`设备第 ${lossesThisBackend} 次丢失，不再重试`)
      return
    }

    console.warn('[Glassium] 设备丢失，正在新设备上重建全部 GPU 资源（面板与参数保留）')
    const t0 = performance.now()
    const next = await acquireDevice()
    if (disposed) {
      if (next.ok) releaseDevice()
      return
    }
    if (!next.ok) {
      degradeFromCurrent(`重新获取设备失败：${next.failure.kind}：${next.failure.detail}`)
      return
    }
    const context = canvas.getContext('webgpu')
    if (!context) {
      degradeFromCurrent('重新获取 webgpu 上下文失败')
      return
    }
    try {
      const rebuilt = await GpuRenderer.create(next.value.device, next.value.format, context, alphaMode)
      if (disposed) {
        rebuilt.destroy()
        releaseDevice()
        return
      }
      renderer = rebuilt
      watchDevice(rebuilt)
      forceResize = true
      console.info(`[Glassium] 已在新设备上恢复，耗时 ${Math.round(performance.now() - t0)} ms`)
      requestRender()
    } catch (err) {
      degradeFromCurrent(`在新设备上重建失败：${String(err)}`)
    }
  }

  function watchDevice(watched: GpuRenderer): void {
    void watched.device.lost.then(() => {
      // 主动 dispose 不算丢失；已经换过设备的旧设备再报丢失也不理
      if (disposed || renderer !== watched) return
      void recover(watched)
    })
  }
  if (renderer instanceof GpuRenderer) watchDevice(renderer)

  // —— 监听器 ——

  const onResize = (): void => {
    if (disposed) return
    panels.invalidateClips() // 媒体查询可能改了哪个祖先的 overflow
    if (rafId === 0) requestRender() // 循环没在跑时，resize 也必须能触发重绘
  }

  // DOM 或样式变了：面板的裁剪祖先可能变了（被挪进 / 挪出滚动容器、某个祖先的 overflow 改了）。
  // 这里只让缓存作废，重找推迟到下一帧；也请求一帧，reduced-motion 下循环不跑时才看得到变化。
  const clipObserver = new MutationObserver(() => {
    if (disposed) return
    panels.invalidateClips()
    if (rafId === 0) requestRender()
  })
  clipObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
    childList: true,
    subtree: true
  })

  const applyMotionPreference = (): void => {
    const next = readReducedMotion()
    if (next === reducedMotion) return
    reducedMotion = next
    console.info(
      `[Glassium] prefers-reduced-motion 变为 ${reducedMotion ? 'reduce' : 'no-preference'}，` +
        `${reducedMotion ? '停止帧循环' : '启动帧循环'}`
    )
    stopLoop()
    startLoop()
  }

  const onMotionChange = (): void => applyMotionPreference()

  const applyForcedColors = (): void => {
    const next = readForcedColors()
    if (next === forcedColors) return
    forcedColors = next
    console.info(
      `[Glassium] forced-colors 变为 ${forcedColors ? 'active，停用 stage、隐藏画布' : 'none，恢复 stage'}`
    )
    if (forcedColors) {
      stopLoop()
      rejectPending('高对比度模式下 stage 停用')
      canvas.style.display = 'none'
    } else {
      canvas.style.display = 'block'
      forceResize = true // 藏起来期间视口可能变过，而且藏着的画布量出来是 0×0
      startLoop()
      layers.schedule()
    }
    notifyStageChange()
  }

  const onForcedColorsChange = (): void => applyForcedColors()

  window.addEventListener('resize', onResize)
  // 滚动条出现或消失时画布宽度会变 15px 左右，但 window.resize **不会**触发。
  // 帧循环在跑时每帧都会重新量，问题不大；reduced-motion 下循环不跑，
  // 就只能靠它来唤醒重绘，否则会停在一张按旧宽度拉伸的画面上。
  const resizeObserver = new ResizeObserver(() => onResize())
  resizeObserver.observe(canvas)
  attachCanvasListeners(canvas)
  motionQuery.addEventListener('change', onMotionChange)
  onReducedMotionOverrideChange = applyMotionPreference
  forcedColorsQuery.addEventListener('change', onForcedColorsChange)
  onForcedColorsOverrideChange = applyForcedColors

  syncViewport()
  if (reducedMotion) {
    console.info('[Glassium] prefers-reduced-motion: reduce —— 只画一帧，不启动帧循环')
  }
  if (forcedColors) {
    console.info('[Glassium] forced-colors: active —— stage 停用，画布隐藏，组件显示 CSS 兜底表面')
  }
  startLoop()

  const stage: GlassStage = {
    get backend(): Backend {
      return backend
    },
    get active(): boolean {
      return isActive()
    },
    get canvas(): HTMLCanvasElement {
      return canvas
    },
    debug: {
      get probe(): BackendReport | null {
        return renderer?.report ?? null
      },
      stats: (): GlassStats => {
        const gpuCreated = gpuCreationCounts()
        const glCreated = gl2CreationCounts()
        return {
          backend,
          fps,
          frames,
          skippedFrames,
          drawCalls,
          targetAllocations: retiredAllocations + (renderer?.allocations ?? 0),
          blurPasses,
          blurLevels: renderer?.blurLevels ?? 0,
          panels: panelsLastFrame,
          groups: groupsLastFrame,
          cpuMs: { measure: measureMs, total: frameMs },
          deviceLosses,
          pipelineCreations: gpuCreated.pipelines + glCreated.programs,
          bindGroupCreations: gpuCreated.bindGroups + glCreated.objects,
          scene: scene.kind,
          sceneUploads,
          viewport,
          reducedMotion,
          forcedColors
        }
      },
      checkLayers: (): LayerProblem<Element>[] => layers.check(),
      renderNow(): void {
        if (!isActive()) return
        renderFrame(performance.now(), true)
      },
      simulateContextLoss(): boolean {
        if (renderer instanceof GpuRenderer) return simulateDeviceLoss()
        if (renderer instanceof Gl2Renderer) {
          const ext = renderer.gl.getExtension('WEBGL_lose_context')
          if (!ext) return false
          ext.loseContext()
          // 真实的驱动重置之后浏览器会自己恢复；模拟时手动恢复，放到下一个任务里 ——
          // 与真实情形一样是异步的。
          setTimeout(() => ext.restoreContext(), 0)
          return true
        }
        return false
      },
      readback(region?: ReadbackRegion): Promise<ReadbackResult> {
        return new Promise<ReadbackResult>((resolve, reject) => {
          // 不画的时候不会有下一帧 —— 不在这里拒绝的话，这个 Promise 会永远挂着
          const why = inactiveReason()
          if (why) {
            reject(new Error(`[Glassium] ${why}，无法回读`))
            return
          }
          if (pendingReadback) {
            reject(new Error('[Glassium] 上一次回读还没完成'))
            return
          }
          pendingReadback = { region, resolve, reject }
          requestRender()
        })
      },
      setPanelDebug(mode: PanelDebugMode): void {
        panelDebugMode = mode
        requestRender()
      },
      probeOptics(index = 0): Promise<OpticsProbe> {
        return new Promise<OpticsProbe>((resolve, reject) => {
          const why = inactiveReason()
          if (why) {
            reject(new Error(`[Glassium] ${why}，无法探针`))
            return
          }
          if (pendingProbe) {
            reject(new Error('[Glassium] 上一次探针还没完成'))
            return
          }
          pendingProbe = { index, resolve, reject }
          requestRender()
        })
      },
      probeGroup(index = 0): Promise<GroupOpticsProbe> {
        return new Promise<GroupOpticsProbe>((resolve, reject) => {
          const why = inactiveReason()
          if (why) {
            reject(new Error(`[Glassium] ${why}，无法探针`))
            return
          }
          if (pendingGroupProbe) {
            reject(new Error('[Glassium] 上一次合并组探针还没完成'))
            return
          }
          pendingGroupProbe = { index, resolve, reject }
          requestRender()
        })
      },
      setBackdrop(params: BackdropDebugParams): void {
        backdrop = {
          blurDp: params.blurDp ?? backdrop.blurDp,
          saturation: params.saturation ?? backdrop.saturation,
          tint: params.tint !== undefined ? parseTint(params.tint) : backdrop.tint,
          sceneMode:
            params.scene !== undefined
              ? { gradient: 0, calibration: 1, radial: 2, flat: 3 }[params.scene]
              : backdrop.sceneMode,
          radialCenterCss: params.radialCenter ?? backdrop.radialCenterCss,
          radialRadius: params.radialRadius ?? backdrop.radialRadius
        }
        requestRender()
      }
    },
    register(element: HTMLElement, material: GlassMaterial = {}): GlassPanel {
      const handle = panels.register(element, material)
      layers.watch(element)
      return {
        element: handle.element,
        setMaterial: handle.setMaterial,
        unregister(): void {
          handle.unregister()
          layers.unwatch(element)
        }
      }
    },
    group(options: { readonly smoothing?: number } = {}): GlassGroup {
      return panels.group(options)
    },
    setScene(source: GlassSceneSource | null, sceneOptions: SceneOptions = {}): Promise<void> {
      return scene.set(source, sceneOptions).then(() => {
        if (backend === 'none') applyFallbackBackground()
      })
    },
    refreshScene(): void {
      scene.refresh()
    },
    requestRender,
    dispose(): void {
      if (disposed) return
      disposed = true
      stopLoop()
      scene.dispose()
      if (pendingOneShot !== 0) cancelAnimationFrame(pendingOneShot)
      window.removeEventListener('resize', onResize)
      resizeObserver.disconnect()
      clipObserver.disconnect()
      detachCanvasListeners(canvas)
      motionQuery.removeEventListener('change', onMotionChange)
      onReducedMotionOverrideChange = null
      forcedColorsQuery.removeEventListener('change', onForcedColorsChange)
      onForcedColorsOverrideChange = null
      layers.dispose()
      rejectPending('stage 已销毁')
      const wasWebGpu = renderer instanceof GpuRenderer
      renderer?.destroy()
      renderer = null
      canvas.remove()
      if (wasWebGpu) releaseDevice() // 主动释放：device.ts 不会把它记成丢失
      activeStage = null
      notifyStageChange()
    }
  }

  if (options.scene !== undefined) {
    try {
      scene.showPlaceholder(options.sceneOptions)
    } catch {
      // 选项写错：下面的 setScene 会以同一个错误失败并警告
    }
    stage.setScene(options.scene, options.sceneOptions).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'AbortError') return
      console.warn(`[Glassium] 初始场景没加载成，改画内置场景：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  activeStage = stage
  notifyStageChange()
  return stage
}

/**
 * 拿不到任何 GPU 后端时的惰性 stage。降级警告已经由调用方报过了。
 *
 * 不抛、不返回 null：页面应当**照常工作**，只是没有玻璃。画布留着并带 CSS 兜底
 * 底色，所以不会白屏；组件显示 glassium.css 的兜底表面。
 */
function makeInertStage(canvas: HTMLCanvasElement, options: GlassStageOptions): GlassStage {
  let disposed = false
  let sceneKind: SceneKind = 'builtin'
  let releaseScene = (): void => {}
  // 没有 GPU 也尽量保住背景：URL、<img>、Blob 写成画布的 CSS 背景
  const setScene = (source: GlassSceneSource | null, sceneOptions: SceneOptions = {}): Promise<void> => {
    try {
      const fallback = sceneFallbackCss(source, sceneOptions)
      releaseScene()
      releaseScene = fallback?.release ?? ((): void => {})
      canvas.style.background = fallback?.css ?? CSS_FALLBACK
      sceneKind = fallback ? 'image' : 'builtin'
      return Promise.resolve()
    } catch (err) {
      return Promise.reject(err)
    }
  }
  if (options.scene !== undefined) {
    setScene(options.scene, options.sceneOptions).catch((err: unknown) => {
      console.warn(`[Glassium] 初始场景写不成 CSS 背景：${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return {
    backend: 'none',
    active: false,
    canvas,
    debug: {
      probe: null,
      setBackdrop(): void {},
      readback: (): Promise<ReadbackResult> =>
        Promise.reject(new Error('[Glassium] 没有 GPU 后端，无法回读')),
      setPanelDebug(): void {},
      probeOptics: (): Promise<OpticsProbe> =>
        Promise.reject(new Error('[Glassium] 没有 GPU 后端，无法探针')),
      probeGroup: (): Promise<GroupOpticsProbe> =>
        Promise.reject(new Error('[Glassium] 没有 GPU 后端，无法探针')),
      checkLayers: (): LayerProblem<Element>[] => [],
      renderNow(): void {},
      simulateContextLoss: (): boolean => false,
      stats: (): GlassStats => ({
        backend: 'none',
        fps: 0,
        frames: 0,
        skippedFrames: 0,
        drawCalls: 0,
        targetAllocations: 0,
        blurPasses: 0,
        blurLevels: 0,
        panels: 0,
        groups: 0,
        cpuMs: { measure: 0, total: 0 },
        deviceLosses: 0,
        pipelineCreations: 0,
        bindGroupCreations: 0,
        scene: sceneKind,
        sceneUploads: 0,
        viewport: null,
        reducedMotion: prefersReducedMotion(),
        forcedColors: forcedColorsOverride ?? window.matchMedia('(forced-colors: active)').matches
      })
    },
    // 没有 GPU 时面板照样可以注册 —— 元素本身照常显示，只是后面没有玻璃。
    // 返回一个什么都不做的句柄，而不是抛：页面不该因为拿不到 GPU 就挂掉。
    register(element: HTMLElement): GlassPanel {
      return { element, setMaterial(): void {}, unregister(): void {} }
    },
    group(): GlassGroup {
      return { setMembers(): void {}, setSmoothing(): void {}, dissolve(): void {} }
    },
    setScene,
    refreshScene(): void {},
    requestRender(): void {},
    dispose(): void {
      if (disposed) return
      disposed = true
      releaseScene()
      canvas.remove()
      activeStage = null
      notifyStageChange()
    }
  }
}
