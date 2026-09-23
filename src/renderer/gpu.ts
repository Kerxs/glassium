/**
 * 一台 GPU 设备上的全部渲染资源。
 *
 * 设备丢失时，从这台设备上创建的一切（管线、缓冲、纹理、bind group、画布配置）同时作废，
 * 必须在新设备上整套重建。所以把它们从 stage 里拆出来，放进一个可以**整体丢弃、整体重建**
 * 的对象。stage 那一层 —— 画布、面板注册表、调试参数、帧循环、监听器 —— 与设备无关，
 * 跨设备存活，恢复之后面板和参数原样都在。
 *
 * 这里的渲染逻辑是从 stage.ts 原样搬过来的。搬之前与搬之后对同一个场景做了整帧 SHA-256，
 * 结果一致（见 docs/calibration.md）。
 */

import type { MemberGeometry } from '../core/merge.ts'
import type { ResolvedViewport } from '../core/units.ts'
import { BACKDROP_WGSL, BLUR_WGSL } from '../shaders/blur.wgsl.ts'
import {
  GLASS_GROUP_WGSL,
  GROUP_STRIDE,
  GROUP_STRIDE_FLOATS,
  GROUP_STRUCT_BYTES
} from '../shaders/glass-group.wgsl.ts'
import {
  GLASS_WGSL,
  PANEL_STRIDE,
  PANEL_STRIDE_FLOATS,
  PANEL_STRUCT_BYTES,
  type PanelDebugMode
} from '../shaders/glass.wgsl.ts'
import { SCENE_WGSL } from '../shaders/scene.wgsl.ts'
import { probeCapabilities, type ProbeReport } from '../webgpu/probe.ts'
import { BACKDROP_FORMAT, BlurChain, levelForSigma } from './blur.ts'
import {
  PANEL_STRUCT_FLOATS,
  packGroup,
  packPanel,
  type MeasuredGroup,
  type MeasuredPanel
} from './panels.ts'
import type { GroupOpticsProbe, OpticsProbe } from './verify.ts'

/**
 * 回读区域的边长（不给 region 时的默认值）。
 *
 * 256 不是随便取的：copyTextureToBuffer 要求 bytesPerRow 是 256 的倍数，
 * 而 256 像素 × 4 字节 = 1024，正好整除。
 */
export const READBACK_SIZE = 256

/** 回读区域，画布设备像素。 */
export interface ReadbackRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ReadbackResult {
  /** 实际读到的区域（已与画布求交）。 */
  readonly region: ReadbackRegion
  /** 紧密排列的 RGBA8，已从画布格式换成 RGBA 顺序。 */
  readonly rgba: Uint8Array
  /** 画布的原始格式，留作核对。 */
  readonly canvasFormat: GPUTextureFormat
}

export interface ReadbackRequest {
  readonly region: ReadbackRegion | undefined
  readonly resolve: (result: ReadbackResult) => void
  readonly reject: (err: Error) => void
}

export interface ProbeRequest {
  readonly index: number
  readonly resolve: (probe: OpticsProbe) => void
  readonly reject: (err: Error) => void
}

export interface GroupProbeRequest {
  readonly index: number
  readonly resolve: (probe: GroupOpticsProbe) => void
  readonly reject: (err: Error) => void
}

/** 背景调试参数的当前值。由 stage 持有，跨设备存活。 */
export interface BackdropState {
  readonly blurDp: number
  readonly saturation: number
  readonly tint: readonly [number, number, number, number]
  readonly sceneMode: number
  readonly radialCenterCss: readonly [number, number]
  readonly radialRadius: number
}

/** 一帧需要的全部输入。都来自 stage，GpuRenderer 自己不持有任何跨帧的业务状态。 */
export interface FrameInput {
  /** 秒。reduced-motion 下由 stage 传 0。 */
  readonly time: number
  readonly viewport: ResolvedViewport
  readonly backdrop: BackdropState
  readonly panels: readonly MeasuredPanel[]
  readonly groups: readonly MeasuredGroup[]
  readonly panelDebugMode: PanelDebugMode
  readonly probe: ProbeRequest | null
  readonly groupProbe: GroupProbeRequest | null
  readonly readback: ReadbackRequest | null
}

export interface FrameResult {
  readonly drawCalls: number
  readonly blurPasses: number
}

export class GpuRenderer {
  readonly device: GPUDevice
  readonly format: GPUTextureFormat
  readonly probe: ProbeReport

  readonly #context: GPUCanvasContext
  readonly #blurChain: BlurChain
  readonly #sampler: GPUSampler

  readonly #scenePipeline: GPURenderPipeline
  readonly #backdropPipeline: GPURenderPipeline
  readonly #glassPipeline: GPURenderPipeline
  readonly #probePipeline: GPURenderPipeline
  readonly #glassLayout: GPUBindGroupLayout
  readonly #groupPipeline: GPURenderPipeline
  readonly #groupProbePipeline: GPURenderPipeline
  readonly #groupLayout: GPUBindGroupLayout

  readonly #sceneUniforms: GPUBuffer
  readonly #sceneUniformData = new Float32Array(8)
  readonly #sceneBindGroup: GPUBindGroup
  readonly #backdropUniforms: GPUBuffer
  readonly #backdropUniformData = new Float32Array(8)
  // Stage: canvasSize + probeOrigin。正常 pass 与探针 pass 各一份 ——
  // 共用一份的话，同一帧里两次 writeBuffer 只有后写的那次生效（T6 的模糊踩过同一个坑）。
  readonly #stageUniforms: GPUBuffer
  readonly #probeStageUniforms: GPUBuffer

  #backdropBindGroup: GPUBindGroup | null = null
  #glassBindGroup: GPUBindGroup | null = null
  #probeBindGroup: GPUBindGroup | null = null
  #panelCapacity = 0
  #panelBuffer: GPUBuffer | null = null
  #panelData = new Float32Array(0)
  #groupBindGroup: GPUBindGroup | null = null
  #groupProbeBindGroup: GPUBindGroup | null = null
  #groupCapacity = 0
  #groupBuffer: GPUBuffer | null = null
  #groupData = new Float32Array(0)
  #destroyed = false

  /** 构造函数不跑能力探测（那是异步的），请用 GpuRenderer.create。 */
  private constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    context: GPUCanvasContext,
    alphaMode: GPUCanvasAlphaMode,
    probe: ProbeReport
  ) {
    this.device = device
    this.format = format
    this.probe = probe
    this.#context = context

    context.configure({
      device,
      format,
      alphaMode,
      // 默认只有 RENDER_ATTACHMENT。不加 COPY_SRC 的话画布**能正常显示**，但回读不到 ——
      // 回读靠 copyTextureToBuffer，没有它整条验证路线都不成立。
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    })

    const sceneModule = device.createShaderModule({ label: 'glassium:scene', code: SCENE_WGSL })
    const blurModule = device.createShaderModule({ label: 'glassium:blur', code: BLUR_WGSL })
    const backdropModule = device.createShaderModule({
      label: 'glassium:backdrop',
      code: BACKDROP_WGSL
    })

    this.#scenePipeline = device.createRenderPipeline({
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
    this.#backdropPipeline = device.createRenderPipeline({
      label: 'glassium:backdrop',
      layout: 'auto',
      vertex: { module: backdropModule, entryPoint: 'vs' },
      fragment: { module: backdropModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    })

    // SceneUniforms: resolution + time + mode + center + radius + pad = 32B
    this.#sceneUniforms = device.createBuffer({
      label: 'glassium:scene-uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    this.#sceneBindGroup = device.createBindGroup({
      layout: this.#scenePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.#sceneUniforms } }]
    })

    // BackdropUniforms: vec4f tint + f32 saturation + f32 level + 2xf32 pad = 32B
    this.#backdropUniforms = device.createBuffer({
      label: 'glassium:backdrop-uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })

    // mipmapFilter 必须是 linear —— 模糊链的连续 σ 全靠硬件在相邻两级之间三线性插值。
    this.#sampler = device.createSampler({
      label: 'glassium:linear',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear'
    })

    this.#blurChain = new BlurChain(device, blurPipeline, this.#sampler)

    // 显式的 bind group layout：'auto' 布局不支持 hasDynamicOffset，
    // 而所有面板共用一条 uniform buffer、逐块只换动态偏移，正是整个设计的要点。
    this.#glassLayout = device.createBindGroupLayout({
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
      bindGroupLayouts: [this.#glassLayout]
    })
    const glassModule = device.createShaderModule({ label: 'glassium:glass', code: GLASS_WGSL })
    this.#glassPipeline = device.createRenderPipeline({
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
    this.#probePipeline = device.createRenderPipeline({
      label: 'glassium:glass-probe',
      layout: glassPipelineLayout,
      vertex: { module: glassModule, entryPoint: 'vs' },
      fragment: { module: glassModule, entryPoint: 'fsProbe', targets: [{ format: 'rgba32float' }] },
      primitive: { topology: 'triangle-list' }
    })

    // 合并组：同一套绑定号，只有 binding 0 的结构体不同（一组 4 块面板，400B）。
    // 单独一条管线而不是在单块面板的着色器里加分支 —— 单块面板的输出因此一个字节都不变。
    this.#groupLayout = device.createBindGroupLayout({
      label: 'glassium:glass-group',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: GROUP_STRUCT_BYTES }
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
      ]
    })
    const groupPipelineLayout = device.createPipelineLayout({
      label: 'glassium:glass-group',
      bindGroupLayouts: [this.#groupLayout]
    })
    const groupModule = device.createShaderModule({ label: 'glassium:glass-group', code: GLASS_GROUP_WGSL })
    this.#groupPipeline = device.createRenderPipeline({
      label: 'glassium:glass-group',
      layout: groupPipelineLayout,
      vertex: { module: groupModule, entryPoint: 'vs' },
      fragment: {
        module: groupModule,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
            }
          }
        ]
      },
      primitive: { topology: 'triangle-list' }
    })
    this.#groupProbePipeline = device.createRenderPipeline({
      label: 'glassium:glass-group-probe',
      layout: groupPipelineLayout,
      vertex: { module: groupModule, entryPoint: 'vs' },
      fragment: { module: groupModule, entryPoint: 'fsProbe', targets: [{ format: 'rgba32float' }] },
      primitive: { topology: 'triangle-list' }
    })

    this.#stageUniforms = device.createBuffer({
      label: 'glassium:stage-uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    this.#probeStageUniforms = device.createBuffer({
      label: 'glassium:probe-stage-uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })

    this.#ensurePanelCapacity(16)
    this.#ensureGroupCapacity(4)
  }

  static async create(
    device: GPUDevice,
    format: GPUTextureFormat,
    context: GPUCanvasContext,
    alphaMode: GPUCanvasAlphaMode
  ): Promise<GpuRenderer> {
    const probe = await probeCapabilities(device)
    return new GpuRenderer(device, format, context, alphaMode, probe)
  }

  get blurLevels(): number {
    return this.#blurChain.textures?.levels ?? 0
  }

  get allocations(): number {
    return this.#blurChain.allocations
  }

  /** 视口尺寸变了（或者刚在新设备上重建）时调用：重建纹理与依赖纹理的 bind group。 */
  resize(viewport: ResolvedViewport): number {
    const textures = this.#blurChain.ensure(viewport)
    this.#backdropBindGroup = this.device.createBindGroup({
      layout: this.#backdropPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#backdropUniforms } },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: textures.chainView }
      ]
    })
    this.device.queue.writeBuffer(
      this.#stageUniforms,
      0,
      new Float32Array([viewport.compositeWidth, viewport.compositeHeight, 0, 0])
    )
    this.#rebuildGlassBindGroups()
    return textures.levels
  }

  #rebuildGlassBindGroups(): void {
    const textures = this.#blurChain.textures
    const panelBuffer = this.#panelBuffer
    if (!textures || !panelBuffer) return
    const entries = (stageBuffer: GPUBuffer): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: panelBuffer, size: PANEL_STRUCT_BYTES } },
      { binding: 1, resource: this.#sampler },
      { binding: 2, resource: textures.chainView },
      { binding: 3, resource: { buffer: stageBuffer } }
    ]
    this.#glassBindGroup = this.device.createBindGroup({
      label: 'glassium:glass',
      layout: this.#glassLayout,
      entries: entries(this.#stageUniforms)
    })
    this.#probeBindGroup = this.device.createBindGroup({
      label: 'glassium:glass-probe',
      layout: this.#glassLayout,
      entries: entries(this.#probeStageUniforms)
    })
    this.#rebuildGroupBindGroups()
  }

  #rebuildGroupBindGroups(): void {
    const textures = this.#blurChain.textures
    const groupBuffer = this.#groupBuffer
    if (!textures || !groupBuffer) return
    const entries = (stageBuffer: GPUBuffer): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: groupBuffer, size: GROUP_STRUCT_BYTES } },
      { binding: 1, resource: this.#sampler },
      { binding: 2, resource: textures.chainView },
      { binding: 3, resource: { buffer: stageBuffer } }
    ]
    this.#groupBindGroup = this.device.createBindGroup({
      label: 'glassium:glass-group',
      layout: this.#groupLayout,
      entries: entries(this.#stageUniforms)
    })
    this.#groupProbeBindGroup = this.device.createBindGroup({
      label: 'glassium:glass-group-probe',
      layout: this.#groupLayout,
      entries: entries(this.#probeStageUniforms)
    })
  }

  /** 按需扩容合并组的 uniform buffer（翻倍），扩容后重建组的 bind group。 */
  #ensureGroupCapacity(count: number): void {
    if (count <= this.#groupCapacity && this.#groupBuffer) return
    let next = Math.max(4, this.#groupCapacity)
    while (next < count) next *= 2
    this.#groupBuffer?.destroy()
    this.#groupBuffer = this.device.createBuffer({
      label: 'glassium:groups',
      size: next * GROUP_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    this.#groupData = new Float32Array(next * GROUP_STRIDE_FLOATS)
    this.#groupCapacity = next
    this.#rebuildGroupBindGroups()
  }

  /** 按需扩容面板 uniform buffer（翻倍），扩容后要重建 bind group。 */
  #ensurePanelCapacity(count: number): void {
    if (count <= this.#panelCapacity && this.#panelBuffer) return
    let next = Math.max(16, this.#panelCapacity)
    while (next < count) next *= 2
    this.#panelBuffer?.destroy()
    this.#panelBuffer = this.device.createBuffer({
      label: 'glassium:panels',
      size: next * PANEL_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    this.#panelData = new Float32Array(next * PANEL_STRIDE_FLOATS)
    this.#panelCapacity = next
    this.#rebuildGlassBindGroups()
  }

  render(input: FrameInput): FrameResult | null {
    if (this.#destroyed) return null
    const { viewport, backdrop, panels } = input
    const device = this.device
    const textures = this.#blurChain.ensure(viewport)
    const backdropBindGroup = this.#backdropBindGroup
    if (!backdropBindGroup) return null

    const scene = this.#sceneUniformData
    scene[0] = textures.width
    scene[1] = textures.height
    scene[2] = input.time
    scene[3] = backdrop.sceneMode
    scene[4] = backdrop.radialCenterCss[0] / viewport.cssWidth
    scene[5] = backdrop.radialCenterCss[1] / viewport.cssHeight
    scene[6] = backdrop.radialRadius
    scene[7] = 0
    device.queue.writeBuffer(this.#sceneUniforms, 0, scene)

    // blur 的 dp 要换算到场景像素：场景目标通常不是 CSS 分辨率。
    const bd = this.#backdropUniformData
    bd[0] = backdrop.tint[0]
    bd[1] = backdrop.tint[1]
    bd[2] = backdrop.tint[2]
    bd[3] = backdrop.tint[3]
    bd[4] = backdrop.saturation
    bd[5] = levelForSigma(backdrop.blurDp * viewport.sceneScale, textures.levels)
    device.queue.writeBuffer(this.#backdropUniforms, 0, bd)

    this.#ensurePanelCapacity(panels.length)
    for (let i = 0; i < panels.length; i++) {
      packPanel(this.#panelData, i, panels[i]!, viewport, textures.levels, input.panelDebugMode)
    }
    if (panels.length > 0 && this.#panelBuffer) {
      device.queue.writeBuffer(
        this.#panelBuffer,
        0,
        this.#panelData,
        0,
        panels.length * PANEL_STRIDE_FLOATS
      )
    }

    const groups = input.groups
    this.#ensureGroupCapacity(groups.length)
    for (let i = 0; i < groups.length; i++) {
      packGroup(this.#groupData, i, groups[i]!, viewport, textures.levels, input.panelDebugMode)
    }
    if (groups.length > 0 && this.#groupBuffer) {
      device.queue.writeBuffer(this.#groupBuffer, 0, this.#groupData, 0, groups.length * GROUP_STRIDE_FLOATS)
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
    scenePass.setPipeline(this.#scenePipeline)
    scenePass.setBindGroup(0, this.#sceneBindGroup)
    scenePass.draw(3)
    scenePass.end()

    // 2) 建模糊链。趟数只和级数有关，与面板数量无关。
    this.#blurChain.build(encoder)

    // 3) 背景 -> 画布
    const canvasTexture = this.#context.getCurrentTexture()
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
    presentPass.setPipeline(this.#backdropPipeline)
    presentPass.setBindGroup(0, backdropBindGroup)
    presentPass.draw(3)

    // 4) 玻璃。和背景在同一个 pass 里：玻璃采样的是模糊链而不是画布，
    //    所以没有读写冲突，也就不需要单独的合成目标。
    if (panels.length > 0 && this.#glassBindGroup) {
      presentPass.setPipeline(this.#glassPipeline)
      for (let i = 0; i < panels.length; i++) {
        const [sx, sy, sw, sh] = panels[i]!.scissor
        presentPass.setScissorRect(sx, sy, sw, sh)
        presentPass.setBindGroup(0, this.#glassBindGroup, [i * PANEL_STRIDE])
        presentPass.draw(3)
      }
    }
    // 5) 合并组：每组一次 draw，与成员数无关。画在单块面板之后。
    if (groups.length > 0 && this.#groupBindGroup) {
      presentPass.setPipeline(this.#groupPipeline)
      for (let i = 0; i < groups.length; i++) {
        const [sx, sy, sw, sh] = groups[i]!.scissor
        presentPass.setScissorRect(sx, sy, sw, sh)
        presentPass.setBindGroup(0, this.#groupBindGroup, [i * GROUP_STRIDE])
        presentPass.draw(3)
      }
    }
    presentPass.end()

    const finishProbe = input.probe ? this.#encodeProbe(encoder, input.probe, panels, viewport) : null
    const finishGroupProbe = input.groupProbe
      ? this.#encodeGroupProbe(encoder, input.groupProbe, groups, viewport)
      : null
    const finishReadback = input.readback
      ? this.#encodeReadback(encoder, input.readback, canvasTexture)
      : null

    device.queue.submit([encoder.finish()])

    finishProbe?.()
    finishGroupProbe?.()
    finishReadback?.()

    return {
      drawCalls: 2 + this.#blurChain.passesLastFrame + panels.length + groups.length,
      blurPasses: this.#blurChain.passesLastFrame
    }
  }

  /** 合并组的探针：把合并后的 sd、方向、位移渲进 rgba32float，覆盖整组的裁剪矩形。 */
  #encodeGroupProbe(
    encoder: GPUCommandEncoder,
    probe: GroupProbeRequest,
    groups: readonly MeasuredGroup[],
    viewport: ResolvedViewport
  ): (() => void) | null {
    const target = groups[probe.index]
    if (!target || !this.#groupProbeBindGroup) {
      probe.reject(new Error(`[Glassium] 第 ${probe.index} 个合并组不存在或不在屏上`))
      return null
    }
    const device = this.device
    const [ox, oy, w, h] = target.scissor
    const tex = device.createTexture({
      label: 'glassium:group-probe',
      size: { width: w, height: h },
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    })
    device.queue.writeBuffer(
      this.#probeStageUniforms,
      0,
      new Float32Array([viewport.compositeWidth, viewport.compositeHeight, ox, oy])
    )
    const pass = encoder.beginRenderPass({
      label: 'glassium:group-probe',
      colorAttachments: [
        { view: tex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }
      ]
    })
    pass.setPipeline(this.#groupProbePipeline)
    pass.setBindGroup(0, this.#groupProbeBindGroup, [probe.index * GROUP_STRIDE])
    pass.draw(3)
    pass.end()

    const rowBytes = Math.ceil((w * 16) / 256) * 256
    const staging = device.createBuffer({
      label: 'glassium:group-probe-staging',
      size: rowBytes * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    })
    encoder.copyTextureToBuffer({ texture: tex }, { buffer: staging, bytesPerRow: rowBytes }, { width: w, height: h })

    // CPU 侧要用 GPU 实际拿到的 f32 参数，不用 f64 的原值 —— 否则比的是舍入差而不是实现差。
    const d = this.#groupData
    const o = probe.index * GROUP_STRIDE_FLOATS
    const members: MemberGeometry[] = []
    for (let i = 0; i < target.members.length; i++) {
      const m = o + 4 + i * PANEL_STRUCT_FLOATS
      members.push({
        rect: [d[m]!, d[m + 1]!, d[m + 2]!, d[m + 3]!],
        radii: [d[m + 4]!, d[m + 5]!, d[m + 6]!, d[m + 7]!],
        heightPx: d[m + 12]!,
        amountPx: d[m + 13]!,
        squircle: d[m + 16]!,
        depthEffect: d[m + 17]!
      })
    }
    const smoothingPx = d[o + 1]!
    return (): void => {
      staging.mapAsync(GPUMapMode.READ).then(
        () => {
          const raw = new Float32Array(staging.getMappedRange())
          const rowFloats = rowBytes / 4
          const data = new Float32Array(w * h * 4)
          for (let j = 0; j < h; j++) {
            data.set(raw.subarray(j * rowFloats, j * rowFloats + w * 4), j * w * 4)
          }
          staging.unmap()
          staging.destroy()
          tex.destroy()
          probe.resolve({ width: w, height: h, origin: [ox, oy], data, members, smoothingPx })
        },
        (err: unknown) => probe.reject(new Error(`[Glassium] 合并组探针回读失败：${String(err)}`))
      )
    }
  }

  /** 探针（调试用）：把某块面板的光学中间量原样渲进 rgba32float。 */
  #encodeProbe(
    encoder: GPUCommandEncoder,
    probe: ProbeRequest,
    panels: readonly MeasuredPanel[],
    viewport: ResolvedViewport
  ): (() => void) | null {
    const target = panels[probe.index]
    if (!target || !this.#probeBindGroup) {
      probe.reject(new Error(`[Glassium] 第 ${probe.index} 块面板不存在或不在屏上`))
      return null
    }
    const device = this.device
    const [ox, oy, w, h] = target.scissor
    const tex = device.createTexture({
      label: 'glassium:probe',
      size: { width: w, height: h },
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    })
    device.queue.writeBuffer(
      this.#probeStageUniforms,
      0,
      new Float32Array([viewport.compositeWidth, viewport.compositeHeight, ox, oy])
    )
    const pass = encoder.beginRenderPass({
      label: 'glassium:probe',
      colorAttachments: [
        { view: tex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }
      ]
    })
    pass.setPipeline(this.#probePipeline)
    pass.setBindGroup(0, this.#probeBindGroup, [probe.index * PANEL_STRIDE])
    pass.draw(3)
    pass.end()

    // bytesPerRow 必须是 256 的倍数；rgba32float 每像素 16 字节，一般要补齐。
    const rowBytes = Math.ceil((w * 16) / 256) * 256
    const staging = device.createBuffer({
      label: 'glassium:probe-staging',
      size: rowBytes * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    })
    encoder.copyTextureToBuffer({ texture: tex }, { buffer: staging, bytesPerRow: rowBytes }, { width: w, height: h })

    const d = this.#panelData
    const o = probe.index * PANEL_STRIDE_FLOATS
    const params = {
      rect: [d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!] as const,
      radii: [d[o + 4]!, d[o + 5]!, d[o + 6]!, d[o + 7]!] as const,
      heightPx: d[o + 12]!,
      amountPx: d[o + 13]!,
      squircle: d[o + 16]!,
      depthEffect: d[o + 17]!
    }
    return (): void => {
      staging.mapAsync(GPUMapMode.READ).then(
        () => {
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
        },
        // 设备在这之间丢失的话 mapAsync 会被拒绝 —— 要把拒绝传给调用方，而不是让它永远挂着。
        (err: unknown) => probe.reject(new Error(`[Glassium] 探针回读失败：${String(err)}`))
      )
    }
  }

  /** 回读要在 present 之后、submit 之前排进同一个 encoder。 */
  #encodeReadback(
    encoder: GPUCommandEncoder,
    request: ReadbackRequest,
    canvasTexture: GPUTexture
  ): (() => void) | null {
    const cw = canvasTexture.width
    const ch = canvasTexture.height
    const want = request.region ?? {
      x: Math.floor((cw - READBACK_SIZE) / 2),
      y: Math.floor((ch - READBACK_SIZE) / 2),
      width: READBACK_SIZE,
      height: READBACK_SIZE
    }
    const x = Math.max(0, Math.floor(want.x))
    const y = Math.max(0, Math.floor(want.y))
    const w = Math.min(cw, Math.floor(want.x + want.width)) - x
    const h = Math.min(ch, Math.floor(want.y + want.height)) - y
    if (w <= 0 || h <= 0) {
      request.reject(new Error('[Glassium] 回读区域与画布没有交集'))
      return null
    }
    // bytesPerRow 必须是 256 的倍数，按行补齐，读完再剥掉。
    const rowBytes = Math.ceil((w * 4) / 256) * 256
    const staging = this.device.createBuffer({
      label: 'glassium:readback',
      size: rowBytes * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    })
    encoder.copyTextureToBuffer(
      { texture: canvasTexture, origin: { x, y } },
      { buffer: staging, bytesPerRow: rowBytes },
      { width: w, height: h }
    )
    // Windows 上画布是 bgra8unorm：原始字节第 0 个是蓝不是红。任何比较 R 与 B 的测量
    // 拿原始字节都会把结论弄反，所以这里一律换成 RGBA 再交出去。
    const bgra = this.format === 'bgra8unorm'
    const format = this.format
    return (): void => {
      staging.mapAsync(GPUMapMode.READ).then(
        () => {
          const raw = new Uint8Array(staging.getMappedRange())
          const rgba = new Uint8Array(w * h * 4)
          for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
              const s0 = j * rowBytes + i * 4
              const d0 = (j * w + i) * 4
              rgba[d0] = raw[s0 + (bgra ? 2 : 0)]!
              rgba[d0 + 1] = raw[s0 + 1]!
              rgba[d0 + 2] = raw[s0 + (bgra ? 0 : 2)]!
              rgba[d0 + 3] = raw[s0 + 3]!
            }
          }
          staging.unmap()
          staging.destroy()
          request.resolve({ region: { x, y, width: w, height: h }, rgba, canvasFormat: format })
        },
        (err: unknown) => request.reject(new Error(`[Glassium] 回读失败：${String(err)}`))
      )
    }
  }

  /**
   * 释放这台设备上的全部资源，并解除画布配置。
   *
   * 解除配置之后画布恢复成透明，于是它自己的 CSS 背景（兜底底色）就露出来了 ——
   * 这正是降级到 none 时想要的效果：不白屏，也不冻在最后一帧上。
   */
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#sceneUniforms.destroy()
    this.#backdropUniforms.destroy()
    this.#stageUniforms.destroy()
    this.#probeStageUniforms.destroy()
    this.#panelBuffer?.destroy()
    this.#groupBuffer?.destroy()
    this.#blurChain.destroy()
    try {
      this.#context.unconfigure()
    } catch {
      // 设备已经丢失时 unconfigure 可能抛；画布照样会被下一次 configure 覆盖，不影响恢复
    }
  }
}
