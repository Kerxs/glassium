/**
 * GlassStage —— 画布宿主与帧循环。
 *
 * 三层宿主（见 docs/limitations.md）：
 *   L0  canvas[data-glassium-scene]  position:fixed; inset:0; z-index:0
 *   L1  DOM 内容                      position:relative; z-index:1（背景必须透明）
 *   L2  #glassium-overlay             z-index:3，**第一期为空**，留给 T13+ 的
 *                                     glass-above-DOM（GlassDialog / GlassSheet）
 *
 * L2 现在就占住层级，是为了将来加它的时候不必让所有使用方重排层叠。
 *
 * 为什么不是 meshora 的 z-index:-1：那边画布只需要在所有内容之下，玻璃由
 * backdrop-filter 交给合成器解析。Glassium 的画布**本身就是玻璃**，面板像素来自它，
 * 放在 -1 会被任何带不透明 background 的祖先整块盖掉 —— 表现为完全不可见且无报错。
 *
 * ## 两层结构
 *
 * 这个文件是**外壳**：画布、面板注册表、调试参数、帧循环、监听器。这些与 GPU 设备无关，
 * 跨设备存活。一台设备上的全部渲染资源在 gpu.ts 的 GpuRenderer 里，设备丢失时整体丢弃、
 * 在新设备上整体重建 —— 面板和参数不受影响。
 */

import { parseTint, type GlassMaterial } from '../core/material.ts'
import { describeViewport, resolveViewport, type ResolvedViewport } from '../core/units.ts'
import type { PanelDebugMode } from '../shaders/glass.wgsl.ts'
import { acquireDevice, releaseDevice, type DeviceFailure } from '../webgpu/device.ts'
import type { ProbeReport } from '../webgpu/probe.ts'
import {
  GpuRenderer,
  type BackdropState,
  type ProbeRequest,
  type ReadbackRegion,
  type ReadbackRequest,
  type ReadbackResult
} from './gpu.ts'
import { PanelRegistry, type GlassPanel } from './panels.ts'
import type { OpticsProbe } from './verify.ts'

export { READBACK_SIZE, type ReadbackRegion, type ReadbackResult } from './gpu.ts'

export type Backend = 'webgpu' | 'webgl2' | 'none'

export interface GlassStats {
  readonly backend: Backend
  /** 最近一秒的帧率。prefers-reduced-motion 下恒为 0（循环根本没启动）。 */
  readonly fps: number
  readonly frames: number
  readonly drawCalls: number
  /** 渲染目标分配次数（跨设备累计）。稳定后不应再增长。 */
  readonly targetAllocations: number
  /** 上一帧的模糊趟数。应当等于 2×(K−1)，**与面板数量无关**。 */
  readonly blurPasses: number
  /** 模糊链的级数 K。 */
  readonly blurLevels: number
  /** 本帧实际画了的面板数（屏外的不算）。 */
  readonly panels: number
  /** 这个 stage 经历过的意外设备丢失次数（主动 dispose 不算）。 */
  readonly deviceLosses: number
  readonly viewport: ResolvedViewport | null
  readonly reducedMotion: boolean
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
  readonly canvas: HTMLCanvasElement
  /**
   * 把一个 DOM 元素注册成玻璃面板。
   *
   * 元素负责占位、文字、点击与焦点；stage 每帧量它的 getBoundingClientRect，
   * 在画布上它的正后方画玻璃。滚动、缩放、布局变化都自动跟上。
   *
   * R1：从这个元素到 stage 宿主之间的每个祖先都必须背景透明，
   * 否则画布会被整块盖掉 —— 玻璃完全不可见，而且没有任何报错。
   */
  register(element: HTMLElement, material?: GlassMaterial): GlassPanel
  readonly debug: {
    stats(): GlassStats
    /** 当前设备的能力探测结果。没有 GPU 时为 null；设备丢失恢复后是新设备的结果。 */
    readonly probe: ProbeReport | null
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
    /** 所有面板的调试视图：'sdf' / 'mask' / 'grad' / 'displacement'，'off' 恢复正常。 */
    setPanelDebug(mode: PanelDebugMode): void
    /**
     * 把第 index 块面板的光学中间量（sd、方向、位移）原样渲进 rgba32float 并回读。
     * 交给 compareOptics() 与 CPU 实现逐像素比对 —— 探针与正常渲染共用同一段
     * evalOptics，所以验的就是实际渲染的那条路径。
     */
    probeOptics(index?: number): Promise<OpticsProbe>
  }
  /** 请求重绘一帧。reduced-motion 下由 resize 等事件驱动。 */
  requestRender(): void
  dispose(): void
}

/** 着色器没起来时的兜底底色，照 meshora 的做法：宁可退回 CSS，也不要白屏。 */
const CSS_FALLBACK =
  'radial-gradient(130% 150% at 16% 4%, #aed5f3 0%, #2e58a4 42%, #04101f 100%)'

let activeStage: GlassStage | null = null

let reducedMotionOverride: boolean | null = null
let onReducedMotionOverrideChange: (() => void) | null = null

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
 */
export async function createGlassStage(options: GlassStageOptions = {}): Promise<GlassStage> {
  if (activeStage) {
    console.warn(
      '[Glassium] 已经存在一个 stage，返回既有实例。每文档只应有一个 —— ' +
        '多个画布之间无法互相采样，glass-container 的合并会失效。'
    )
    return activeStage
  }

  const host = options.host ?? document.body
  const alphaMode = options.alphaMode ?? 'opaque'

  const canvas = document.createElement('canvas')
  canvas.dataset.glassiumScene = ''
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    zIndex: '0',
    pointerEvents: 'none',
    background: CSS_FALLBACK
  } satisfies Partial<CSSStyleDeclaration>)
  host.prepend(canvas)

  const degrade = (reason: DegradeReason): void => {
    console.warn(`[Glassium] 降级 ${reason.from} → ${reason.to}：${reason.detail}`)
    options.onDegrade?.(reason)
  }

  const acquired = await acquireDevice()
  if (!acquired.ok) {
    const stage = makeInertStage(canvas, acquired.failure, degrade)
    activeStage = stage
    return stage
  }

  const context = canvas.getContext('webgpu')
  if (!context) {
    const stage = makeInertStage(
      canvas,
      { kind: 'no-device', detail: 'canvas.getContext("webgpu") 返回 null' },
      degrade
    )
    activeStage = stage
    return stage
  }

  // —— 与设备无关、跨设备存活的状态 ——
  let gpu: GpuRenderer | null = await GpuRenderer.create(
    acquired.value.device,
    acquired.value.format,
    context,
    alphaMode
  )
  let backend: Backend = 'webgpu'
  let deviceLosses = 0
  let retiredAllocations = 0
  /** 刚在新设备上重建：视口没变也必须 resize 一次，新设备上还没有任何纹理。 */
  let forceResize = false

  let viewport: ResolvedViewport | null = null
  let disposed = false
  let rafId = 0
  let pendingOneShot = 0
  let frames = 0
  let drawCalls = 0
  let blurPasses = 0
  let panelsLastFrame = 0
  let fps = 0
  let fpsWindowStart = 0
  let fpsWindowFrames = 0
  const startTime = performance.now()

  let pendingProbe: ProbeRequest | null = null
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

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const readReducedMotion = (): boolean => reducedMotionOverride ?? motionQuery.matches
  let reducedMotion = readReducedMotion()

  /** 在途的回读与探针全部作废。设备丢失或 stage 销毁时调用，免得调用方的 Promise 永远挂着。 */
  const rejectPending = (why: string): void => {
    pendingProbe?.reject(new Error(`[Glassium] ${why}，探针作废`))
    pendingReadback?.reject(new Error(`[Glassium] ${why}，回读作废`))
    pendingProbe = null
    pendingReadback = null
  }

  const syncViewport = (): void => {
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
    if (!changed || !gpu) return
    forceResize = false

    canvas.width = next.compositeWidth
    canvas.height = next.compositeHeight
    const levels = gpu.resize(next)
    console.info(`[Glassium] ${describeViewport(next)} · 模糊链 ${levels} 级`)
    if (next.budgetExceeded) {
      console.warn(
        '[Glassium] 保底清晰度压过了像素预算 —— 场景分辨率高于预算允许的值。' +
          '这是定死的优先级，不是 bug，但大视口上会更吃 GPU。'
      )
    }
  }

  const renderFrame = (now: number): void => {
    if (disposed || !gpu) return
    syncViewport()
    if (!viewport) return

    // 所有面板在这里一次量完，帧内之后不再碰布局（避免 layout thrash）。
    const canvasBox = canvas.getBoundingClientRect()
    const measured = panels.measure(viewport, canvasBox.left, canvasBox.top)

    const probe = pendingProbe
    const readback = pendingReadback
    pendingProbe = null
    pendingReadback = null

    const result = gpu.render({
      // reduced-motion 下时间冻结在 0：循环不跑的同时画面也必须是确定的那一帧，
      // 否则 resize 触发的重绘会跳到另一个相位，看起来像闪烁。
      time: reducedMotion ? 0 : (now - startTime) / 1000,
      viewport,
      backdrop,
      panels: measured,
      panelDebugMode,
      probe,
      readback
    })
    if (!result) {
      // 这一帧没画成（比如资源还没就绪）：请求放回去，下一帧再服务
      pendingProbe ??= probe
      pendingReadback ??= readback
      return
    }

    frames++
    drawCalls = result.drawCalls
    blurPasses = result.blurPasses
    panelsLastFrame = measured.length

    if (fpsWindowStart === 0) fpsWindowStart = now
    fpsWindowFrames++
    if (now - fpsWindowStart >= 1000) {
      fps = Math.round((fpsWindowFrames * 1000) / (now - fpsWindowStart))
      fpsWindowStart = now
      fpsWindowFrames = 0
    }
  }

  const loop = (now: number): void => {
    if (disposed) return
    renderFrame(now)
    rafId = requestAnimationFrame(loop)
  }

  const startLoop = (): void => {
    if (disposed || rafId !== 0 || backend === 'none') return
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
    if (disposed || rafId !== 0 || pendingOneShot !== 0 || backend === 'none') return
    pendingOneShot = requestAnimationFrame((now) => {
      pendingOneShot = 0
      renderFrame(now)
    })
  }

  // —— 设备丢失 ——
  //
  // 第一次：在新设备上整套重建，面板、参数、监听器原样保留。
  // 第二次：不再重试，降级。WebGL2 后端要到 T11，所以现在只能退到 CSS 兜底底色。
  //
  // 为什么只重试一次：连续丢失通常说明驱动或 GPU 本身有问题，反复重建只会让页面反复卡顿。

  const degradeToNone = (detail: string): void => {
    if (gpu) {
      retiredAllocations += gpu.allocations
      gpu.destroy() // 解除画布配置 → 画布变透明，CSS 兜底底色露出来
      gpu = null
    }
    backend = 'none'
    stopLoop()
    rejectPending('已降级')
    degrade({ from: 'webgpu', to: 'webgl2', detail })
    degrade({
      from: 'webgl2',
      to: 'none',
      detail: 'WebGL2 后端尚未实现（计划中的 T11），退到 CSS 兜底底色。面板元素照常显示，只是后面没有玻璃'
    })
  }

  const recover = async (lost: GpuRenderer): Promise<void> => {
    deviceLosses++
    rejectPending('设备丢失')
    retiredAllocations += lost.allocations
    lost.destroy()
    if (gpu === lost) gpu = null

    if (deviceLosses > 1) {
      degradeToNone(`设备第 ${deviceLosses} 次丢失，不再重试`)
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
      degradeToNone(`重新获取设备失败：${next.failure.kind}：${next.failure.detail}`)
      return
    }
    try {
      const renderer = await GpuRenderer.create(next.value.device, next.value.format, context, alphaMode)
      if (disposed) {
        renderer.destroy()
        releaseDevice()
        return
      }
      gpu = renderer
      watchDevice(renderer)
      forceResize = true
      console.info(`[Glassium] 已在新设备上恢复，耗时 ${Math.round(performance.now() - t0)} ms`)
      requestRender()
    } catch (err) {
      degradeToNone(`在新设备上重建失败：${String(err)}`)
    }
  }

  function watchDevice(renderer: GpuRenderer): void {
    void renderer.device.lost.then(() => {
      // 主动 dispose 不算丢失；已经换过设备的旧设备再报丢失也不理
      if (disposed || gpu !== renderer) return
      void recover(renderer)
    })
  }
  watchDevice(gpu)

  // —— 监听器 ——

  const onResize = (): void => {
    if (disposed) return
    if (rafId === 0) requestRender() // 循环没在跑时，resize 也必须能触发重绘
  }

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

  window.addEventListener('resize', onResize)
  // 滚动条出现或消失时画布宽度会变 15px 左右，但 window.resize **不会**触发。
  // 帧循环在跑时每帧都会重新量，问题不大；reduced-motion 下循环不跑，
  // 就只能靠它来唤醒重绘，否则会停在一张按旧宽度拉伸的画面上。
  const resizeObserver = new ResizeObserver(() => onResize())
  resizeObserver.observe(canvas)
  motionQuery.addEventListener('change', onMotionChange)
  onReducedMotionOverrideChange = applyMotionPreference

  syncViewport()
  if (reducedMotion) {
    console.info('[Glassium] prefers-reduced-motion: reduce —— 只画一帧，不启动帧循环')
  }
  startLoop()

  const stage: GlassStage = {
    get backend(): Backend {
      return backend
    },
    canvas,
    debug: {
      get probe(): ProbeReport | null {
        return gpu?.probe ?? null
      },
      stats: (): GlassStats => ({
        backend,
        fps,
        frames,
        drawCalls,
        targetAllocations: retiredAllocations + (gpu?.allocations ?? 0),
        blurPasses,
        blurLevels: gpu?.blurLevels ?? 0,
        panels: panelsLastFrame,
        deviceLosses,
        viewport,
        reducedMotion
      }),
      readback(region?: ReadbackRegion): Promise<ReadbackResult> {
        return new Promise<ReadbackResult>((resolve, reject) => {
          if (backend === 'none') {
            reject(new Error('[Glassium] 没有 GPU 后端，无法回读'))
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
          if (backend === 'none') {
            reject(new Error('[Glassium] 没有 GPU 后端，无法探针'))
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
      return panels.register(element, material)
    },
    requestRender,
    dispose(): void {
      if (disposed) return
      disposed = true
      stopLoop()
      if (pendingOneShot !== 0) cancelAnimationFrame(pendingOneShot)
      window.removeEventListener('resize', onResize)
      resizeObserver.disconnect()
      motionQuery.removeEventListener('change', onMotionChange)
      onReducedMotionOverrideChange = null
      rejectPending('stage 已销毁')
      gpu?.destroy()
      gpu = null
      canvas.remove()
      releaseDevice() // 主动释放：device.ts 不会把它记成丢失
      activeStage = null
    }
  }

  activeStage = stage
  return stage
}

/**
 * 拿不到 GPU 时的惰性 stage。
 *
 * 不抛、不返回 null：页面应当**照常工作**，只是没有玻璃。画布留着并带 CSS 兜底
 * 底色，所以不会白屏。
 */
function makeInertStage(
  canvas: HTMLCanvasElement,
  failure: DeviceFailure,
  degrade: (reason: DegradeReason) => void
): GlassStage {
  degrade({ from: 'webgpu', to: 'webgl2', detail: `${failure.kind}：${failure.detail}` })
  // T11 之前这里是死路一条，必须说出来 —— 默默变成 none 会让人以为 WebGL2 兜底
  // 已经生效了，然后困惑于为什么什么都没有。
  degrade({
    from: 'webgl2',
    to: 'none',
    detail: 'WebGL2 后端尚未实现（计划中的 T11），暂时只能退到 CSS 兜底底色'
  })

  let disposed = false
  return {
    backend: 'none',
    canvas,
    debug: {
      probe: null,
      setBackdrop(): void {},
      readback: (): Promise<ReadbackResult> =>
        Promise.reject(new Error('[Glassium] 没有 GPU 后端，无法回读')),
      setPanelDebug(): void {},
      probeOptics: (): Promise<OpticsProbe> =>
        Promise.reject(new Error('[Glassium] 没有 GPU 后端，无法探针')),
      stats: (): GlassStats => ({
        backend: 'none',
        fps: 0,
        frames: 0,
        drawCalls: 0,
        targetAllocations: 0,
        blurPasses: 0,
        blurLevels: 0,
        panels: 0,
        deviceLosses: 0,
        viewport: null,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      })
    },
    // 没有 GPU 时面板照样可以注册 —— 元素本身照常显示，只是后面没有玻璃。
    // 返回一个什么都不做的句柄，而不是抛：页面不该因为拿不到 GPU 就挂掉。
    register(element: HTMLElement): GlassPanel {
      return { element, setMaterial(): void {}, unregister(): void {} }
    },
    requestRender(): void {},
    dispose(): void {
      if (disposed) return
      disposed = true
      canvas.remove()
      activeStage = null
    }
  }
}
