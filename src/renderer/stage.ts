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

import { describeViewport, resolveViewport, type ResolvedViewport } from '../core/units.ts'
import { PRESENT_WGSL, SCENE_WGSL } from '../shaders/scene.wgsl.ts'
import { acquireDevice, releaseDevice, type DeviceFailure } from '../webgpu/device.ts'
import { probeCapabilities, type ProbeReport } from '../webgpu/probe.ts'
import { SCENE_FORMAT, TargetPool } from './targets.ts'

export type Backend = 'webgpu' | 'webgl2' | 'none'

export interface GlassStats {
  readonly backend: Backend
  /** 最近一秒的帧率。prefers-reduced-motion 下恒为 0（循环根本没启动）。 */
  readonly fps: number
  readonly frames: number
  readonly drawCalls: number
  /** 渲染目标分配次数。稳定后不应再增长。 */
  readonly targetAllocations: number
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

export interface GlassStage {
  readonly backend: Backend
  readonly canvas: HTMLCanvasElement
  readonly debug: {
    stats(): GlassStats
    /** 能力探测结果。backend 不是 webgpu 时为 null。 */
    readonly probe: ProbeReport | null
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
  context.configure({ device, format, alphaMode })

  const probe = await probeCapabilities(device)
  const targets = new TargetPool(device)

  // —— 管线 ——
  const sceneModule = device.createShaderModule({ label: 'glassium:scene', code: SCENE_WGSL })
  const presentModule = device.createShaderModule({ label: 'glassium:present', code: PRESENT_WGSL })

  const scenePipeline = device.createRenderPipeline({
    label: 'glassium:scene',
    layout: 'auto',
    vertex: { module: sceneModule, entryPoint: 'vs' },
    fragment: { module: sceneModule, entryPoint: 'fs', targets: [{ format: SCENE_FORMAT }] },
    primitive: { topology: 'triangle-list' }
  })
  const presentPipeline = device.createRenderPipeline({
    label: 'glassium:present',
    layout: 'auto',
    vertex: { module: presentModule, entryPoint: 'vs' },
    fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format }] },
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

  const sampler = device.createSampler({
    label: 'glassium:linear',
    magFilter: 'linear',
    minFilter: 'linear'
  })

  // —— 状态 ——
  let viewport: ResolvedViewport | null = null
  let presentBindGroup: GPUBindGroup | null = null
  let disposed = false
  let rafId = 0
  let pendingOneShot = 0
  let frames = 0
  let drawCalls = 0
  let fps = 0
  let fpsWindowStart = 0
  let fpsWindowFrames = 0
  const startTime = performance.now()

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const readReducedMotion = (): boolean => reducedMotionOverride ?? motionQuery.matches
  let reducedMotion = readReducedMotion()

  const syncViewport = (): boolean => {
    const cssWidth = Math.max(1, Math.round(window.innerWidth))
    const cssHeight = Math.max(1, Math.round(window.innerHeight))
    const dpr = window.devicePixelRatio || 1
    const next = resolveViewport(cssWidth, cssHeight, dpr, options.maxPixels, options.minSceneRatio)

    const changed =
      !viewport ||
      viewport.compositeWidth !== next.compositeWidth ||
      viewport.compositeHeight !== next.compositeHeight ||
      viewport.sceneWidth !== next.sceneWidth ||
      viewport.sceneHeight !== next.sceneHeight

    if (changed) {
      canvas.width = next.compositeWidth
      canvas.height = next.compositeHeight
      console.info(`[Glassium] ${describeViewport(next)}`)
      if (next.budgetExceeded) {
        console.warn(
          '[Glassium] 保底清晰度压过了像素预算 —— 场景分辨率高于预算允许的值。' +
            '这是定死的优先级，不是 bug，但大视口上会更吃 GPU。'
        )
      }
      const target = targets.ensure(next)
      presentBindGroup = device.createBindGroup({
        layout: presentPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: target.view }
        ]
      })
    }
    viewport = next
    return changed
  }

  const renderFrame = (now: number): void => {
    if (disposed || !viewport) return
    syncViewport()
    const target = targets.ensure(viewport)
    if (!presentBindGroup) return

    const elapsed = (now - startTime) / 1000
    sceneUniformData[0] = target.width
    sceneUniformData[1] = target.height
    // reduced-motion 下时间冻结在 0：循环不跑的同时，画面也必须是确定的那一帧，
    // 否则 resize 触发的重绘会跳到另一个相位，看起来像闪烁。
    sceneUniformData[2] = reducedMotion ? 0 : elapsed
    sceneUniformData[3] = 0
    device.queue.writeBuffer(sceneUniforms, 0, sceneUniformData)

    const encoder = device.createCommandEncoder({ label: 'glassium:frame' })

    // 1) 场景 → 场景目标
    const scenePass = encoder.beginRenderPass({
      label: 'glassium:scene',
      colorAttachments: [
        {
          view: target.view,
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

    // 2) 场景目标 → 画布（放大）
    //    T7 起中间会插入玻璃 pass，那时这一步的输入变成合成目标。
    const presentPass = encoder.beginRenderPass({
      label: 'glassium:present',
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    presentPass.setPipeline(presentPipeline)
    presentPass.setBindGroup(0, presentBindGroup)
    presentPass.draw(3)
    presentPass.end()

    device.queue.submit([encoder.finish()])

    frames++
    drawCalls = 2

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
        targetAllocations: targets.allocations,
        viewport,
        reducedMotion
      })
    },
    requestRender,
    dispose(): void {
      if (disposed) return
      disposed = true
      stopLoop()
      if (pendingOneShot !== 0) cancelAnimationFrame(pendingOneShot)
      window.removeEventListener('resize', onResize)
      motionQuery.removeEventListener('change', onMotionChange)
      onReducedMotionOverrideChange = null
      sceneUniforms.destroy()
      targets.destroy()
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
      stats: (): GlassStats => ({
        backend: 'none',
        fps: 0,
        frames: 0,
        drawCalls: 0,
        targetAllocations: 0,
        viewport: null,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      })
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
