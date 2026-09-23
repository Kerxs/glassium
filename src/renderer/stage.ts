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
 */

import { parseTint, type GlassMaterial } from '../core/material.ts'
import { describeViewport, resolveViewport, type ResolvedViewport } from '../core/units.ts'
import { BACKDROP_WGSL, BLUR_WGSL } from '../shaders/blur.wgsl.ts'
import { SCENE_WGSL } from '../shaders/scene.wgsl.ts'
import { acquireDevice, releaseDevice, type DeviceFailure } from '../webgpu/device.ts'
import { probeCapabilities, type ProbeReport } from '../webgpu/probe.ts'
import {
  GLASS_WGSL,
  PANEL_STRIDE,
  PANEL_STRIDE_FLOATS,
  PANEL_STRUCT_BYTES,
  type PanelDebugMode
} from '../shaders/glass.wgsl.ts'
import { BACKDROP_FORMAT, BlurChain, levelForSigma } from './blur.ts'
import { PanelRegistry, packPanel, type GlassPanel, type MeasuredPanel } from './panels.ts'
import type { OpticsProbe } from './verify.ts'

export type Backend = 'webgpu' | 'webgl2' | 'none'

export interface GlassStats {
  readonly backend: Backend
  /** 最近一秒的帧率。prefers-reduced-motion 下恒为 0（循环根本没启动）。 */
  readonly fps: number
  readonly frames: number
  readonly drawCalls: number
  /** 渲染目标分配次数。稳定后不应再增长。 */
  readonly targetAllocations: number
  /** 上一帧的模糊趟数。应当等于 2×(K−1)，**与面板数量无关**。 */
  readonly blurPasses: number
  /** 模糊链的级数 K。 */
  readonly blurLevels: number
  /** 本帧实际画了的面板数（屏外的不算）。 */
  readonly panels: number
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
  readonly scene?: 'gradient' | 'calibration'
}

export interface GlassStage {
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
    /** 能力探测结果。backend 不是 webgpu 时为 null。 */
    readonly probe: ProbeReport | null
    /** 调整全屏背景视图的参数。见 BackdropDebugParams。 */
    setBackdrop(params: BackdropDebugParams): void
    /**
     * 回读画布中心的一块像素（RGBA8，边长 READBACK_SIZE）。
     *
     * 必须走 GPU 侧的 copyTextureToBuffer —— **DOM 侧读不出来**：
     * 对 WebGPU 画布调 drawImage / createImageBitmap 得到的是全黑，即使
     * 画面正常显示、即使 configure 时加了 COPY_SRC。画面明明在动而回读一片黑，
     * 很容易被当成「渲染没出来」去查渲染，实际是读法不对。
     */
    readback(): Promise<Uint8Array>
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

/**
 * 回读区域的边长。
 *
 * 256 不是随便取的：copyTextureToBuffer 要求 bytesPerRow 是 256 的倍数，
 * 而 256 像素 × 4 字节 = 1024，正好整除。
 */
export const READBACK_SIZE = 256

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

  const { device, format } = acquired.value
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
  context.configure({
    device,
    format,
    alphaMode,
    // 默认只有 RENDER_ATTACHMENT。不加 COPY_SRC 的话画布**能正常显示**，但
    // drawImage / createImageBitmap 读出来全是 0 —— 画面明明在动，回读却是一片黑，
    // 很容易被当成「渲染没出来」而去查渲染。
    // T12 的 /verify.html 靠回读比对 GPU 与 CPU 实现，没有它整条验证路线都不成立。
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
  })

  const probe = await probeCapabilities(device)

  // —— 管线 ——
  const sceneModule = device.createShaderModule({ label: 'glassium:scene', code: SCENE_WGSL })
  const blurModule = device.createShaderModule({ label: 'glassium:blur', code: BLUR_WGSL })
  const backdropModule = device.createShaderModule({
    label: 'glassium:backdrop',
    code: BACKDROP_WGSL
  })

  const scenePipeline = device.createRenderPipeline({
    label: 'glassium:scene',
    layout: 'auto',
    vertex: { module: sceneModule, entryPoint: 'vs' },
    fragment: { module: sceneModule, entryPoint: 'fs', targets: [{ format: BACKDROP_FORMAT }] },
    primitive: { topology: 'triangle-list' }
  })
  const blurPipeline = device.createRenderPipeline({
    label: 'glassium:blur',
    layout: 'auto',
    vertex: { module: blurModule, entryPoint: 'vs' },
    fragment: { module: blurModule, entryPoint: 'fs', targets: [{ format: BACKDROP_FORMAT }] },
    primitive: { topology: 'triangle-list' }
  })
  const backdropPipeline = device.createRenderPipeline({
    label: 'glassium:backdrop',
    layout: 'auto',
    vertex: { module: backdropModule, entryPoint: 'vs' },
    fragment: { module: backdropModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' }
  })

  // SceneUniforms: vec2f resolution + f32 time + f32 pad = 16B
  const sceneUniforms = device.createBuffer({
    label: 'glassium:scene-uniforms',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const sceneUniformData = new Float32Array(4)
  const sceneBindGroup = device.createBindGroup({
    layout: scenePipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: sceneUniforms } }]
  })

  // BackdropUniforms: vec4f tint + f32 saturation + f32 level + 2xf32 pad = 32B
  const backdropUniforms = device.createBuffer({
    label: 'glassium:backdrop-uniforms',
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const backdropUniformData = new Float32Array(8)

  // mipmapFilter 必须是 linear —— 模糊链的连续 σ 全靠硬件在相邻两级之间三线性插值。
  // 写成 nearest 的话 σ 扫描会出现肉眼可见的台阶，而那看起来像「模糊档位不够」，
  // 不像「采样器配错了」。
  const sampler = device.createSampler({
    label: 'glassium:linear',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear'
  })

  const blurChain = new BlurChain(device, blurPipeline, sampler)

  // —— 玻璃 ——
  // 显式的 bind group layout：'auto' 布局不支持 hasDynamicOffset，
  // 而所有面板共用一条 uniform buffer、逐块只换动态偏移，正是整个设计的要点 ——
  // 一条管线、一个 pass、N 次 draw，不为每块面板建 bind group。
  const glassLayout = device.createBindGroupLayout({
    label: 'glassium:glass',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PANEL_STRUCT_BYTES }
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
    ]
  })
  const glassPipelineLayout = device.createPipelineLayout({
    label: 'glassium:glass',
    bindGroupLayouts: [glassLayout]
  })
  const glassModule = device.createShaderModule({ label: 'glassium:glass', code: GLASS_WGSL })
  const glassPipeline = device.createRenderPipeline({
    label: 'glassium:glass',
    layout: glassPipelineLayout,
    vertex: { module: glassModule, entryPoint: 'vs' },
    fragment: {
      module: glassModule,
      entryPoint: 'fs',
      targets: [
        {
          format,
          // 片元输出预乘色，所以是 one / one-minus-src-alpha，不是 src-alpha。
          // 用错成非预乘混合的话，玻璃边缘的抗锯齿会多乘一次 alpha，出现一圈暗边。
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
          }
        }
      ]
    },
    primitive: { topology: 'triangle-list' }
  })
  // 探针：同一个模块、另一个入口，写 rgba32float，不混合（32 位浮点默认不可混合）。
  const probePipeline = device.createRenderPipeline({
    label: 'glassium:glass-probe',
    layout: glassPipelineLayout,
    vertex: { module: glassModule, entryPoint: 'vs' },
    fragment: { module: glassModule, entryPoint: 'fsProbe', targets: [{ format: 'rgba32float' }] },
    primitive: { topology: 'triangle-list' }
  })

  // Stage: canvasSize + probeOrigin。正常 pass 与探针 pass 各一份 ——
  // 共用一份的话，同一帧里两次 writeBuffer 只有后写的那次生效（T6 的模糊踩过同一个坑）。
  const stageUniforms = device.createBuffer({
    label: 'glassium:stage-uniforms',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const probeStageUniforms = device.createBuffer({
    label: 'glassium:probe-stage-uniforms',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })

  const panels = new PanelRegistry(() => requestRender())
  let panelCapacity = 0
  let panelBuffer: GPUBuffer | null = null
  let panelData = new Float32Array(0)
  let glassBindGroup: GPUBindGroup | null = null
  let probeBindGroup: GPUBindGroup | null = null
  let panelDebugMode: PanelDebugMode = 'off'
  let panelsLastFrame = 0

  const rebuildGlassBindGroups = (): void => {
    const textures = blurChain.textures
    if (!textures || !panelBuffer) return
    const entries = (stageBuffer: GPUBuffer): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: panelBuffer!, size: PANEL_STRUCT_BYTES } },
      { binding: 1, resource: sampler },
      { binding: 2, resource: textures.chainView },
      { binding: 3, resource: { buffer: stageBuffer } }
    ]
    glassBindGroup = device.createBindGroup({
      label: 'glassium:glass',
      layout: glassLayout,
      entries: entries(stageUniforms)
    })
    probeBindGroup = device.createBindGroup({
      label: 'glassium:glass-probe',
      layout: glassLayout,
      entries: entries(probeStageUniforms)
    })
  }

  /** 按需扩容面板 uniform buffer（翻倍），扩容后要重建 bind group。 */
  const ensurePanelCapacity = (count: number): void => {
    if (count <= panelCapacity && panelBuffer) return
    let next = Math.max(16, panelCapacity)
    while (next < count) next *= 2
    panelBuffer?.destroy()
    panelBuffer = device.createBuffer({
      label: 'glassium:panels',
      size: next * PANEL_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    panelData = new Float32Array(next * PANEL_STRIDE_FLOATS)
    panelCapacity = next
    rebuildGlassBindGroups()
  }
  ensurePanelCapacity(16)

  interface ProbeRequest {
    readonly index: number
    readonly resolve: (probe: OpticsProbe) => void
    readonly reject: (err: Error) => void
  }
  let pendingProbe: ProbeRequest | null = null

  // —— 状态 ——
  let viewport: ResolvedViewport | null = null
  let backdropBindGroup: GPUBindGroup | null = null
  let disposed = false
  let rafId = 0
  let pendingOneShot = 0
  let frames = 0
  let drawCalls = 0
  let fps = 0
  let fpsWindowStart = 0
  let fpsWindowFrames = 0
  const startTime = performance.now()

  const readbackBuffer = device.createBuffer({
    label: 'glassium:readback',
    size: READBACK_SIZE * READBACK_SIZE * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  })
  let pendingReadback: ((data: Uint8Array) => void) | null = null

  // 背景调试参数（实验用，非正式 API）
  let backdropBlurDp = 0
  let backdropSaturation = 1
  let backdropTint: [number, number, number, number] = [1, 1, 1, 0]
  let sceneMode = 0

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const readReducedMotion = (): boolean => reducedMotionOverride ?? motionQuery.matches
  let reducedMotion = readReducedMotion()

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
      !viewport ||
      viewport.compositeWidth !== next.compositeWidth ||
      viewport.compositeHeight !== next.compositeHeight ||
      viewport.sceneWidth !== next.sceneWidth ||
      viewport.sceneHeight !== next.sceneHeight

    viewport = next
    if (!changed) return

    canvas.width = next.compositeWidth
    canvas.height = next.compositeHeight
    const textures = blurChain.ensure(next)
    console.info(`[Glassium] ${describeViewport(next)} · 模糊链 ${textures.levels} 级`)
    if (next.budgetExceeded) {
      console.warn(
        '[Glassium] 保底清晰度压过了像素预算 —— 场景分辨率高于预算允许的值。' +
          '这是定死的优先级，不是 bug，但大视口上会更吃 GPU。'
      )
    }
    backdropBindGroup = device.createBindGroup({
      layout: backdropPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: backdropUniforms } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: textures.chainView }
      ]
    })
    device.queue.writeBuffer(
      stageUniforms,
      0,
      new Float32Array([next.compositeWidth, next.compositeHeight, 0, 0])
    )
    rebuildGlassBindGroups()
  }

  const renderFrame = (now: number): void => {
    if (disposed) return
    syncViewport()
    if (!viewport) return
    const textures = blurChain.ensure(viewport)
    if (!backdropBindGroup) return

    const elapsed = (now - startTime) / 1000
    sceneUniformData[0] = textures.width
    sceneUniformData[1] = textures.height
    // reduced-motion 下时间冻结在 0：循环不跑的同时画面也必须是确定的那一帧，
    // 否则 resize 触发的重绘会跳到另一个相位，看起来像闪烁。
    sceneUniformData[2] = reducedMotion ? 0 : elapsed
    sceneUniformData[3] = sceneMode
    device.queue.writeBuffer(sceneUniforms, 0, sceneUniformData)

    // blur 的 dp 要换算到场景像素：场景目标通常不是 CSS 分辨率。
    const sigmaScenePx = backdropBlurDp * viewport.sceneScale
    backdropUniformData[0] = backdropTint[0]
    backdropUniformData[1] = backdropTint[1]
    backdropUniformData[2] = backdropTint[2]
    backdropUniformData[3] = backdropTint[3]
    backdropUniformData[4] = backdropSaturation
    backdropUniformData[5] = levelForSigma(sigmaScenePx, textures.levels)
    device.queue.writeBuffer(backdropUniforms, 0, backdropUniformData)

    // 所有面板在这里一次量完，帧内之后不再碰布局（避免 layout thrash）。
    const canvasBox = canvas.getBoundingClientRect()
    const measured: MeasuredPanel[] = panels.measure(viewport, canvasBox.left, canvasBox.top)
    ensurePanelCapacity(measured.length)
    for (let i = 0; i < measured.length; i++) {
      packPanel(panelData, i, measured[i]!, viewport, textures.levels, panelDebugMode)
    }
    if (measured.length > 0 && panelBuffer) {
      device.queue.writeBuffer(panelBuffer, 0, panelData, 0, measured.length * PANEL_STRIDE_FLOATS)
    }

    const encoder = device.createCommandEncoder({ label: 'glassium:frame' })

    // 1) 场景 -> 模糊链的 mip 0（锐利背景就是这一级，不需要额外拷贝）
    const scenePass = encoder.beginRenderPass({
      label: 'glassium:scene',
      colorAttachments: [
        {
          view: textures.sceneView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    scenePass.setPipeline(scenePipeline)
    scenePass.setBindGroup(0, sceneBindGroup)
    scenePass.draw(3)
    scenePass.end()

    // 2) 建模糊链。趟数只和级数有关，与面板数量无关。
    blurChain.build(encoder)

    // 3) 背景 -> 画布。T7 起玻璃 pass 会插在这之前。
    const canvasTexture = context.getCurrentTexture()
    const presentPass = encoder.beginRenderPass({
      label: 'glassium:present',
      colorAttachments: [
        {
          view: canvasTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    presentPass.setPipeline(backdropPipeline)
    presentPass.setBindGroup(0, backdropBindGroup)
    presentPass.draw(3)

    // 4) 玻璃。和背景在同一个 pass 里：玻璃采样的是模糊链而不是画布，
    //    所以没有读写冲突，也就不需要单独的合成目标。
    if (measured.length > 0 && glassBindGroup) {
      presentPass.setPipeline(glassPipeline)
      for (let i = 0; i < measured.length; i++) {
        const [sx, sy, sw, sh] = measured[i]!.scissor
        presentPass.setScissorRect(sx, sy, sw, sh)
        presentPass.setBindGroup(0, glassBindGroup, [i * PANEL_STRIDE])
        presentPass.draw(3)
      }
    }
    presentPass.end()
    panelsLastFrame = measured.length

    // 5) 探针（调试用）：把某块面板的光学中间量原样渲进 rgba32float。
    const probe = pendingProbe
    let probeReadback: (() => void) | null = null
    if (probe) {
      pendingProbe = null
      const target = measured[probe.index]
      if (!target || !probeBindGroup) {
        probe.reject(new Error(`[Glassium] 第 ${probe.index} 块面板不存在或不在屏上`))
      } else {
        const [ox, oy, w, h] = target.scissor
        const tex = device.createTexture({
          label: 'glassium:probe',
          size: { width: w, height: h },
          format: 'rgba32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        })
        device.queue.writeBuffer(
          probeStageUniforms,
          0,
          new Float32Array([viewport.compositeWidth, viewport.compositeHeight, ox, oy])
        )
        const pass = encoder.beginRenderPass({
          label: 'glassium:probe',
          colorAttachments: [
            {
              view: tex.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store'
            }
          ]
        })
        pass.setPipeline(probePipeline)
        pass.setBindGroup(0, probeBindGroup, [probe.index * PANEL_STRIDE])
        pass.draw(3)
        pass.end()

        // bytesPerRow 必须是 256 的倍数；rgba32float 每像素 16 字节，一般要补齐。
        const rowBytes = Math.ceil((w * 16) / 256) * 256
        const staging = device.createBuffer({
          label: 'glassium:probe-staging',
          size: rowBytes * h,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        })
        encoder.copyTextureToBuffer(
          { texture: tex },
          { buffer: staging, bytesPerRow: rowBytes },
          { width: w, height: h }
        )

        const o = probe.index * PANEL_STRIDE_FLOATS
        const params = {
          rect: [panelData[o]!, panelData[o + 1]!, panelData[o + 2]!, panelData[o + 3]!] as const,
          radii: [panelData[o + 4]!, panelData[o + 5]!, panelData[o + 6]!, panelData[o + 7]!] as const,
          heightPx: panelData[o + 12]!,
          amountPx: panelData[o + 13]!,
          squircle: panelData[o + 16]!,
          depthEffect: panelData[o + 17]!
        }
        probeReadback = (): void => {
          void staging.mapAsync(GPUMapMode.READ).then(() => {
            const raw = new Float32Array(staging.getMappedRange())
            const rowFloats = rowBytes / 4
            const data = new Float32Array(w * h * 4)
            for (let j = 0; j < h; j++) {
              data.set(raw.subarray(j * rowFloats, j * rowFloats + w * 4), j * w * 4)
            }
            staging.unmap()
            staging.destroy()
            tex.destroy()
            probe.resolve({ width: w, height: h, origin: [ox, oy], data, panel: params })
          })
        }
      }
    }

    // 回读要在 present 之后、submit 之前排进同一个 encoder。
    const readbackResolve = pendingReadback
    if (readbackResolve) {
      pendingReadback = null
      const ox = Math.max(0, Math.floor((canvasTexture.width - READBACK_SIZE) / 2))
      const oy = Math.max(0, Math.floor((canvasTexture.height - READBACK_SIZE) / 2))
      encoder.copyTextureToBuffer(
        { texture: canvasTexture, origin: { x: ox, y: oy } },
        { buffer: readbackBuffer, bytesPerRow: READBACK_SIZE * 4 },
        { width: READBACK_SIZE, height: READBACK_SIZE }
      )
    }

    device.queue.submit([encoder.finish()])

    probeReadback?.()

    if (readbackResolve) {
      void readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
        const copy = new Uint8Array(readbackBuffer.getMappedRange()).slice()
        readbackBuffer.unmap()
        readbackResolve(copy)
      })
    }

    frames++
    drawCalls = 2 + blurChain.passesLastFrame + measured.length

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
    if (disposed || rafId !== 0) return
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
    if (disposed || rafId !== 0 || pendingOneShot !== 0) return
    pendingOneShot = requestAnimationFrame((now) => {
      pendingOneShot = 0
      renderFrame(now)
    })
  }

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
    backend: 'webgpu',
    canvas,
    debug: {
      probe,
      stats: (): GlassStats => ({
        backend: 'webgpu',
        fps,
        frames,
        drawCalls,
        targetAllocations: blurChain.allocations,
        blurPasses: blurChain.passesLastFrame,
        blurLevels: blurChain.textures?.levels ?? 0,
        panels: panelsLastFrame,
        viewport,
        reducedMotion
      }),
      readback(): Promise<Uint8Array> {
        return new Promise<Uint8Array>((resolve, reject) => {
          if (pendingReadback) {
            reject(new Error('[Glassium] 上一次回读还没完成'))
            return
          }
          pendingReadback = resolve
          requestRender()
        })
      },
      setPanelDebug(mode: PanelDebugMode): void {
        panelDebugMode = mode
        requestRender()
      },
      probeOptics(index = 0): Promise<OpticsProbe> {
        return new Promise<OpticsProbe>((resolve, reject) => {
          if (pendingProbe) {
            reject(new Error('[Glassium] 上一次探针还没完成'))
            return
          }
          pendingProbe = { index, resolve, reject }
          requestRender()
        })
      },
      setBackdrop(params: BackdropDebugParams): void {
        if (params.blurDp !== undefined) backdropBlurDp = params.blurDp
        if (params.saturation !== undefined) backdropSaturation = params.saturation
        if (params.tint !== undefined) backdropTint = parseTint(params.tint)
        if (params.scene !== undefined) sceneMode = params.scene === 'calibration' ? 1 : 0
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
      sceneUniforms.destroy()
      backdropUniforms.destroy()
      readbackBuffer.destroy()
      stageUniforms.destroy()
      probeStageUniforms.destroy()
      panelBuffer?.destroy()
      blurChain.destroy()
      canvas.remove()
      releaseDevice()
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
      readback: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(0)),
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
