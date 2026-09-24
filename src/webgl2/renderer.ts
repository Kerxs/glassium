/**
 * WebGL2 后端 —— WebGPU 不可用时的兜底。
 *
 * Firefox 没有 Linux / Intel Mac / Android 的 WebGPU，Chrome 在 Linux 与部分 Android 上受 GPU
 * 门禁，所以这一级不是可选项。它和 GpuRenderer 吃同一份 FrameInput、做同样的事：
 *
 *   场景 → 模糊链（mip 0 是锐利场景，mip 1+ 逐级减半、逐级更模糊）
 *        → 背景上屏 → 单块面板（每块一次 draw）→ 合并组（每组一次 draw）
 *
 * 面板与合并组的 uniform 用的是**同一份打包字节**：Panel / Group 结构体在 WGSL 的 uniform
 * 布局与 GLSL 的 std140 下逐字节相同（启动时用 UNIFORM_BLOCK_DATA_SIZE 核对一遍，
 * 不对就拒绝启动，而不是画出一块位置微妙不对的玻璃）。
 *
 * 坐标约定见 shaders.ts：离屏不翻、上屏翻一次；scissor 与 readPixels 在这里各换算一次。
 */

import type { MemberGeometry } from '../core/merge.ts'
import type { ResolvedViewport } from '../core/units.ts'
import {
  GROUP_CAPACITY,
  GROUP_STRIDE,
  GROUP_STRIDE_FLOATS,
  GROUP_STRUCT_BYTES
} from '../shaders/glass-group.wgsl.ts'
import { FILL_STRIDE, FILL_STRIDE_FLOATS, FILL_STRUCT_BYTES } from '../shaders/fill.wgsl.ts'
import { PANEL_STRIDE, PANEL_STRIDE_FLOATS, PANEL_STRUCT_BYTES } from '../shaders/glass.wgsl.ts'
import {
  READBACK_SIZE,
  type FrameInput,
  type FrameResult,
  type Gl2Report,
  type GroupProbeRequest,
  type ProbeRequest,
  type ReadbackRequest,
  type Renderer,
  type SceneImage,
  type SceneUploadState,
  sourceReady
} from '../renderer/backend.ts'
import { LOCAL_SIGMA, MAX_LEVELS, levelForSigma } from '../renderer/blur.ts'
import { CANVAS_DEST, packFill, sceneDest, sceneScissor, type MeasuredFill } from '../renderer/fills.ts'
import { layerRegion, levelRegion, splitLayers, type LayerItems } from '../renderer/layers.ts'
import {
  PANEL_STRUCT_FLOATS,
  packGroup,
  packPanel,
  type MeasuredGroup,
  type MeasuredPanel
} from '../renderer/panels.ts'
import {
  BACKDROP_FS,
  BLUR_FS,
  FILL_FS,
  FULLSCREEN_VS,
  GLASS_FS,
  SCENE_FS,
  SCENE_IMAGE_FS,
  glassGroupFs
} from './shaders.ts'

let programsCreated = 0
let objectsCreated = 0

/**
 * 本会话 WebGL2 一侧建过多少个程序、多少个 GL 对象（纹理、帧缓冲、缓冲）。
 * 与 WebGPU 的 pipelineCreations / bindGroupCreations 是同一类判据：预热之后必须走平。
 */
export function gl2CreationCounts(): { readonly programs: number; readonly objects: number } {
  return { programs: programsCreated, objects: objectsCreated }
}

export type Gl2Result =
  | { readonly ok: true; readonly value: Gl2Renderer }
  | { readonly ok: false; readonly detail: string }

interface Program {
  readonly program: WebGLProgram
  readonly uniforms: Map<string, WebGLUniformLocation | null>
}

/** UBO 的绑定点。 */
const PANEL_BINDING = 0
const GROUP_BINDING = 1
const FILL_BINDING = 2

export class Gl2Renderer implements Renderer {
  readonly kind = 'webgl2' as const
  readonly report: Gl2Report
  readonly gl: WebGL2RenderingContext

  readonly #scene: Program
  readonly #sceneImage: Program
  #imageTexture: WebGLTexture | null = null
  #uploadedSource: SceneImage['source'] | null = null
  #uploadedVersion = -1
  #uploadWarned = false
  readonly #blur: Program
  readonly #backdrop: Program
  readonly #glass: Program
  readonly #group: Program
  readonly #fill: Program
  readonly #vao: WebGLVertexArrayObject
  /** 对齐值整除步长时，整块上传一次、按偏移绑定；否则每次 draw 前把那一块传到偏移 0。 */
  readonly #rangeBinding: boolean

  #chain: WebGLTexture | null = null
  #scratch: WebGLTexture | null = null
  #chainFbos: WebGLFramebuffer[] = []
  #scratchFbos: (WebGLFramebuffer | null)[] = []
  #levels = 0
  #width = 0
  #height = 0
  #allocations = 0

  #panelUbo: WebGLBuffer | null = null
  #panelCapacity = 0
  #panelData = new Float32Array(0)
  #groupUbo: WebGLBuffer | null = null
  #groupCapacity = 0
  #groupData = new Float32Array(0)
  #fillUbo: WebGLBuffer | null = null
  #fillCapacity = 0
  #fillData = new Float32Array(0)
  /** 玻璃的层（layers.ts）：默认帧缓冲上已经画好的那一块 blit 进来，再重采样回场景目标。 */
  #layerSource: WebGLTexture | null = null
  #layerSourceFbo: WebGLFramebuffer | null = null
  #layerSourceWidth = 0
  #layerSourceHeight = 0

  #destroyed = false

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null
    this.report = {
      kind: 'webgl2',
      uniformBufferOffsetAlignment: gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number,
      maxUniformBlockSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) as number,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      colorBufferFloat
    }
    const alignment = this.report.uniformBufferOffsetAlignment
    this.#rangeBinding =
      PANEL_STRIDE % alignment === 0 && GROUP_STRIDE % alignment === 0 && FILL_STRIDE % alignment === 0
    console.info(
      `[Glassium] WebGL2：UNIFORM_BUFFER_OFFSET_ALIGNMENT=${alignment}` +
        `（${this.#rangeBinding ? '256B 步长成立，按偏移绑定' : '不整除 256，退回逐次上传'}）` +
        ` · EXT_color_buffer_float=${colorBufferFloat ? '有' : '无（探针不可用）'}` +
        ` · MAX_TEXTURE_SIZE=${this.report.maxTextureSize}`
    )

    this.#scene = compile(gl, SCENE_FS, 'scene')
    this.#sceneImage = compile(gl, SCENE_IMAGE_FS, 'scene-image')
    this.#blur = compile(gl, BLUR_FS, 'blur')
    this.#backdrop = compile(gl, BACKDROP_FS, 'backdrop')
    this.#glass = compile(gl, GLASS_FS, 'glass')
    this.#group = compile(gl, glassGroupFs(GROUP_CAPACITY), 'glass-group')
    this.#fill = compile(gl, FILL_FS, 'fill')
    bindBlock(gl, this.#glass, 'PanelBlock', PANEL_BINDING, PANEL_STRUCT_BYTES)
    bindBlock(gl, this.#group, 'GroupBlock', GROUP_BINDING, GROUP_STRUCT_BYTES)
    bindBlock(gl, this.#fill, 'FillBlock', FILL_BINDING, FILL_STRUCT_BYTES)

    // 没有顶点属性（全屏三角形用 gl_VertexID），但 WebGL2 仍要求绑定一个 VAO
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('[Glassium] createVertexArray 返回 null')
    this.#vao = vao

    this.#ensurePanelCapacity(16)
    this.#ensureGroupCapacity(4)
    this.#ensureFillCapacity(4)

    const err = gl.getError()
    if (err !== gl.NO_ERROR) throw new Error(`[Glassium] WebGL2 初始化后 getError() = 0x${err.toString(16)}`)
  }

  /**
   * 在画布上建 WebGL2 上下文与全部资源。失败时不抛，返回原因 —— 拿不到 WebGL2
   * 也是预期内的（很老的设备、被禁用的 GPU），调用方继续往下降级。
   */
  static create(canvas: HTMLCanvasElement, alphaMode: GPUCanvasAlphaMode): Gl2Result {
    let gl: WebGL2RenderingContext | null
    try {
      gl = canvas.getContext('webgl2', {
        // 与 WebGPU 的 alphaMode 对应：opaque 时画布没有 alpha 通道，硬遮挡下方一切
        alpha: alphaMode !== 'opaque',
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      })
    } catch (err) {
      return { ok: false, detail: `getContext('webgl2') 抛出：${String(err)}` }
    }
    if (!gl) return { ok: false, detail: 'canvas.getContext("webgl2") 返回 null' }
    try {
      return { ok: true, value: new Gl2Renderer(gl) }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  get blurLevels(): number {
    return this.#levels
  }

  get allocations(): number {
    return this.#allocations
  }

  resize(viewport: ResolvedViewport): number {
    this.#ensureTargets(viewport)
    return this.#levels
  }

  // —— 资源 ——

  #ensureTargets(viewport: ResolvedViewport): void {
    const gl = this.gl
    const width = viewport.sceneWidth
    const height = viewport.sceneHeight
    if (this.#chain && width === this.#width && height === this.#height) return
    this.#destroyTargets()

    const maxBySize = Math.floor(Math.log2(Math.max(1, Math.min(width, height)))) + 1
    const levels = Math.max(1, Math.min(MAX_LEVELS, maxBySize))

    const makeTexture = (): WebGLTexture => {
      const tex = gl.createTexture()
      if (!tex) throw new Error('[Glassium] createTexture 返回 null')
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, width, height)
      // 与 WebGPU 的 sampler 一致：线性、线性 mip（模糊链的连续 σ 靠三线性插值）、钳边
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      objectsCreated++
      return tex
    }
    const makeFbo = (tex: WebGLTexture, level: number): WebGLFramebuffer => {
      const fbo = gl.createFramebuffer()
      if (!fbo) throw new Error('[Glassium] createFramebuffer 返回 null')
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, level)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`[Glassium] 模糊链第 ${level} 级的帧缓冲不完整：0x${status.toString(16)}`)
      }
      objectsCreated++
      return fbo
    }

    const chain = makeTexture()
    const scratch = makeTexture()
    this.#chainFbos = []
    this.#scratchFbos = []
    for (let k = 0; k < levels; k++) this.#chainFbos.push(makeFbo(chain, k))
    // 草稿的第 0 级模糊用不到；有填充时放「没有填充的场景」（与 WebGPU 那边的 BlurChainTextures.clean 相同）
    for (let k = 0; k < levels; k++) this.#scratchFbos.push(makeFbo(scratch, k))
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    this.#chain = chain
    this.#scratch = scratch
    this.#levels = levels
    this.#width = width
    this.#height = height
    this.#allocations++
  }

  #destroyTargets(): void {
    const gl = this.gl
    for (const fbo of this.#chainFbos) gl.deleteFramebuffer(fbo)
    for (const fbo of this.#scratchFbos) if (fbo) gl.deleteFramebuffer(fbo)
    if (this.#chain) gl.deleteTexture(this.#chain)
    if (this.#scratch) gl.deleteTexture(this.#scratch)
    this.#chainFbos = []
    this.#scratchFbos = []
    this.#chain = null
    this.#scratch = null
    this.#levels = 0
  }

  #ensurePanelCapacity(count: number): void {
    if (count <= this.#panelCapacity && this.#panelUbo) return
    let next = Math.max(16, this.#panelCapacity)
    while (next < count) next *= 2
    this.#panelUbo = this.#replaceBuffer(this.#panelUbo, next * PANEL_STRIDE)
    this.#panelData = new Float32Array(next * PANEL_STRIDE_FLOATS)
    this.#panelCapacity = next
  }

  #ensureGroupCapacity(count: number): void {
    if (count <= this.#groupCapacity && this.#groupUbo) return
    let next = Math.max(4, this.#groupCapacity)
    while (next < count) next *= 2
    this.#groupUbo = this.#replaceBuffer(this.#groupUbo, next * GROUP_STRIDE)
    this.#groupData = new Float32Array(next * GROUP_STRIDE_FLOATS)
    this.#groupCapacity = next
  }

  #ensureFillCapacity(count: number): void {
    if (count <= this.#fillCapacity && this.#fillUbo) return
    let next = Math.max(4, this.#fillCapacity)
    while (next < count) next *= 2
    this.#fillUbo = this.#replaceBuffer(this.#fillUbo, next * FILL_STRIDE)
    this.#fillData = new Float32Array(next * FILL_STRIDE_FLOATS)
    this.#fillCapacity = next
  }

  /**
   * 画填充。离屏（场景目标）不翻 y、scissor 直接用；画布上翻一次、scissor 换成左下原点。
   * 调用方已经打包、上传好了填充的 UBO。返回画了几次。
   */
  #drawFills(
    fills: readonly MeasuredFill[],
    indices: readonly number[],
    dest: readonly [number, number, number, number],
    onScreen: boolean,
    targetHeight: number,
    scissorOf: (fill: MeasuredFill) => readonly [number, number, number, number] | null
  ): number {
    const gl = this.gl
    const p = this.#fill
    useProgram(gl, p)
    gl.uniform1f(loc(gl, p, 'uFlipUv'), onScreen ? 1 : 0)
    gl.uniform4f(loc(gl, p, 'uDest'), dest[0], dest[1], dest[2], onScreen ? 1 : 0)
    gl.uniform1f(loc(gl, p, 'uDestHeight'), targetHeight)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.SCISSOR_TEST)
    let draws = 0
    for (const i of indices) {
      const s = scissorOf(fills[i]!)
      if (!s) continue
      const [sx, sy, sw, sh] = s
      gl.scissor(sx, onScreen ? targetHeight - sy - sh : sy, sw, sh)
      this.#bindSlot(this.#fillUbo!, this.#fillData, FILL_BINDING, i, FILL_STRIDE, FILL_STRUCT_BYTES)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      draws++
    }
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    return draws
  }

  #replaceBuffer(old: WebGLBuffer | null, bytes: number): WebGLBuffer {
    const gl = this.gl
    if (old) gl.deleteBuffer(old)
    const buf = gl.createBuffer()
    if (!buf) throw new Error('[Glassium] createBuffer 返回 null')
    gl.bindBuffer(gl.UNIFORM_BUFFER, buf)
    gl.bufferData(gl.UNIFORM_BUFFER, bytes, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.UNIFORM_BUFFER, null)
    objectsCreated++
    return buf
  }

  /** 把第 index 块面板（或第 index 组）的 uniform 绑到它的绑定点上。 */
  #bindSlot(
    buffer: WebGLBuffer,
    data: Float32Array,
    binding: number,
    index: number,
    strideBytes: number,
    structBytes: number
  ): void {
    const gl = this.gl
    if (this.#rangeBinding) {
      gl.bindBufferRange(gl.UNIFORM_BUFFER, binding, buffer, index * strideBytes, structBytes)
      return
    }
    // 对齐值不整除步长：把这一块传到缓冲开头再绑。每次 draw 多一次小上传，但结果一样。
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data, (index * strideBytes) / 4, structBytes / 4)
    gl.bindBufferRange(gl.UNIFORM_BUFFER, binding, buffer, 0, structBytes)
  }

  // —— 一帧 ——

  render(input: FrameInput): FrameResult | null {
    const gl = this.gl
    if (this.#destroyed || gl.isContextLost()) return null
    const { viewport, backdrop, panels, groups, fills } = input
    this.#ensureTargets(viewport)
    const chain = this.#chain
    const scratch = this.#scratch
    if (!chain || !scratch) return null
    const W = this.#width
    const H = this.#height
    const cw = viewport.compositeWidth
    const ch = viewport.compositeHeight

    gl.bindVertexArray(this.#vao)
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    gl.activeTexture(gl.TEXTURE0)

    // 面板、合并组、填充：同一份打包字节（逐次上传时在 draw 前各传各的槽位）
    this.#ensurePanelCapacity(panels.length)
    for (let i = 0; i < panels.length; i++) {
      packPanel(this.#panelData, i, panels[i]!, viewport, this.#levels, input.panelDebugMode)
    }
    this.#ensureGroupCapacity(groups.length)
    for (let i = 0; i < groups.length; i++) {
      packGroup(this.#groupData, i, groups[i]!, viewport, this.#levels, input.panelDebugMode)
    }
    this.#ensureFillCapacity(fills.length)
    for (let i = 0; i < fills.length; i++) packFill(this.#fillData, i, fills[i]!)
    if (this.#rangeBinding) {
      if (panels.length > 0) {
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.#panelUbo)
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.#panelData, 0, panels.length * PANEL_STRIDE_FLOATS)
      }
      if (groups.length > 0) {
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.#groupUbo)
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.#groupData, 0, groups.length * GROUP_STRIDE_FLOATS)
      }
      if (fills.length > 0) {
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.#fillUbo)
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.#fillData, 0, fills.length * FILL_STRIDE_FLOATS)
      }
    }

    // 分层：第 0 层照旧，更高的层在第 6 步逐层画（与 gpu.ts 相同）
    const layers = splitLayers(panels, groups, fills)
    const base: LayerItems = layers[0]?.layer === 0 ? layers[0] : { layer: 0, panels: [], groups: [], fills: [] }
    let draws = 2 // 场景与背景

    // 1) 场景 → 模糊链的 mip 0（离屏：不翻 y，纹理第 0 行 = 屏幕顶部，与 WebGPU 相同）
    const scene = input.sceneImage ? this.#prepareImage(input.sceneImage) : 'none'
    const image = scene !== 'none' ? input.sceneImage : null
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#chainFbos[0]!)
    gl.viewport(0, 0, W, H)
    if (image) {
      const p = this.#sceneImage
      useProgram(gl, p)
      gl.bindTexture(gl.TEXTURE_2D, this.#imageTexture)
      gl.uniform1i(loc(gl, p, 'uImage'), 0)
      gl.uniform1f(loc(gl, p, 'uFlipUv'), 0)
      gl.uniform4f(loc(gl, p, 'uUv'), image.uvScale[0], image.uvScale[1], image.uvOffset[0], image.uvOffset[1])
      gl.uniform4f(loc(gl, p, 'uBackground'), image.background[0], image.background[1], image.background[2], 1)
    } else {
      useProgram(gl, this.#scene)
      gl.uniform1f(loc(gl, this.#scene, 'uFlipUv'), 0)
      gl.uniform4f(loc(gl, this.#scene, 'uScene0'), W, H, input.time, backdrop.sceneMode)
      gl.uniform4f(
        loc(gl, this.#scene, 'uScene1'),
        backdrop.radialCenterCss[0] / viewport.cssWidth,
        backdrop.radialCenterCss[1] / viewport.cssHeight,
        backdrop.radialRadius,
        0
      )
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 1.5) 第 0 层的填充画进场景：之后建的模糊链、玻璃的采样都看得见它。画之前把「没有填充的场景」
    //      拷到草稿的第 0 级，背景上屏用那一份（理由见 gpu.ts 的同一步）
    const backdropLevel = levelForSigma(backdrop.blurDp * viewport.sceneScale, this.#levels)
    const crispFills =
      base.fills.length > 0 && backdrop.tint[3] === 0 && backdrop.saturation === 1 && backdropLevel === 0
    if (base.fills.length > 0) {
      if (crispFills) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.#chainFbos[0]!)
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.#scratchFbos[0]!)
        gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.#chainFbos[0]!)
      }
      draws += this.#drawFills(fills, base.fills, sceneDest(W, H, cw, ch), false, H, (f) =>
        sceneScissor(f.scissor, W, H, cw, ch)
      )
    }

    // 2) 模糊链：每级两趟，与面板数量无关
    let passes = this.#buildBlur(null)

    // 3) 背景上屏（翻 y）。有要按画布分辨率画的填充时，用没有填充的那一份场景
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, cw, ch)
    gl.bindTexture(gl.TEXTURE_2D, crispFills ? scratch : chain)
    useProgram(gl, this.#backdrop)
    gl.uniform1f(loc(gl, this.#backdrop, 'uFlipUv'), 1)
    gl.uniform1i(loc(gl, this.#backdrop, 'uChain'), 0)
    gl.uniform4f(loc(gl, this.#backdrop, 'uTint'), ...backdrop.tint)
    gl.uniform4f(loc(gl, this.#backdrop, 'uParams'), backdrop.saturation, backdropLevel, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 3.5) 填充按画布分辨率画（背景调试视图调过色或模糊过时不画，理由见 gpu.ts）
    if (crispFills) draws += this.#drawFills(fills, base.fills, CANVAS_DEST, true, ch, (f) => f.scissor)

    // 4) 第 0 层的面板与合并组
    draws += this.#drawGlass(base, panels, groups, cw, ch)

    // 6) 更高的层，逐层：拷画布 → 重采样回场景目标 → 这一层的填充 → 局部重建模糊链 → 填充、玻璃上屏
    for (const layer of layers) {
      if (layer.layer === 0) continue
      const region = layerRegion(layer, panels, groups, fills, viewport, this.#levels)
      if (!region) continue
      const sourceFbo = this.#ensureLayerSource(cw, ch)
      // 默认帧缓冲 → 来源纹理，同样左下原点（纹理第 0 行是屏幕底部）。用 blit 不用 copyTexSubImage2D：
      // alphaMode 是 opaque 时默认帧缓冲没有 alpha 通道，copyTexSubImage2D 不许往 RGBA 里拷
      const [cx, cy, cww, chh] = region.composite
      const gy = ch - cy - chh
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sourceFbo)
      gl.blitFramebuffer(cx, gy, cx + cww, gy + chh, cx, gy, cx + cww, gy + chh, gl.COLOR_BUFFER_BIT, gl.NEAREST)

      // 重采样进场景目标的那一块（离屏，scissor 不翻）。来源纹理第 0 行在下，所以 uFlipUv = 1
      const [sx, sy, sw, sh] = region.scene
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#chainFbos[0]!)
      gl.viewport(0, 0, W, H)
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(sx, sy, sw, sh)
      gl.bindTexture(gl.TEXTURE_2D, this.#layerSource)
      useProgram(gl, this.#backdrop)
      gl.uniform1f(loc(gl, this.#backdrop, 'uFlipUv'), 1)
      gl.uniform1i(loc(gl, this.#backdrop, 'uChain'), 0)
      gl.uniform4f(loc(gl, this.#backdrop, 'uTint'), 1, 1, 1, 0)
      gl.uniform4f(loc(gl, this.#backdrop, 'uParams'), 1, 0, 0, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.disable(gl.SCISSOR_TEST)
      draws++
      if (layer.fills.length > 0) {
        draws += this.#drawFills(fills, layer.fills, sceneDest(W, H, cw, ch), false, H, (f) =>
          sceneScissor(f.scissor, W, H, cw, ch)
        )
      }

      passes += this.#buildBlur(region.scene)

      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, cw, ch)
      if (layer.fills.length > 0) draws += this.#drawFills(fills, layer.fills, CANVAS_DEST, true, ch, (f) => f.scissor)
      draws += this.#drawGlass(layer, panels, groups, cw, ch)
    }

    // 回读必须在上屏之后、交还事件循环之前：preserveDrawingBuffer = false，
    // 浏览器合成之后默认帧缓冲的内容就没了。
    if (input.readback) this.#readback(input.readback, cw, ch)
    if (input.probe) this.#probePanel(input.probe, panels, cw, ch)
    if (input.groupProbe) this.#probeGroup(input.groupProbe, groups, cw, ch)

    return {
      drawCalls: draws + passes,
      blurPasses: passes,
      sceneUploads: scene === 'uploaded' ? 1 : 0
    }
  }

  /**
   * 建模糊链（或只重建场景目标里的一块，见 layers.ts）：每级两趟。给了 region 时各级用 scissor 限住，
   * 这一块外面保持原样。返回跑了多少趟。
   */
  #buildBlur(region: readonly [number, number, number, number] | null): number {
    const gl = this.gl
    const chain = this.#chain
    const scratch = this.#scratch
    if (!chain || !scratch) return 0
    const W = this.#width
    const H = this.#height
    useProgram(gl, this.#blur)
    gl.uniform1f(loc(gl, this.#blur, 'uFlipUv'), 0)
    gl.uniform1i(loc(gl, this.#blur, 'uSrc'), 0)
    const blurLoc = loc(gl, this.#blur, 'uBlur')
    const lodLoc = loc(gl, this.#blur, 'uLod')
    let passes = 0
    for (let k = 1; k < this.#levels; k++) {
      const w = Math.max(1, W >> k)
      const h = Math.max(1, H >> k)
      const r = region ? levelRegion(region, k, w, h) : null
      if (r && (r[2] === 0 || r[3] === 0)) continue
      if (r) {
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(r[0], r[1], r[2], r[3]) // 离屏：不翻
      }
      // 水平（兼降采样）：读 chain 的 k−1 级，写 scratch 的 k 级
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#scratchFbos[k]!)
      gl.viewport(0, 0, w, h)
      gl.bindTexture(gl.TEXTURE_2D, chain)
      gl.uniform4f(blurLoc, 1 / w, 1 / h, LOCAL_SIGMA, 0)
      gl.uniform1f(lodLoc, k - 1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      // 垂直：读 scratch 的 k 级，写 chain 的 k 级。读写的是不同纹理，没有反馈回路
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#chainFbos[k]!)
      gl.bindTexture(gl.TEXTURE_2D, scratch)
      gl.uniform4f(blurLoc, 1 / w, 1 / h, LOCAL_SIGMA, 1)
      gl.uniform1f(lodLoc, k)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      passes += 2
    }
    gl.disable(gl.SCISSOR_TEST)
    return passes
  }

  /** 一层的玻璃：单块面板，再合并组（默认帧缓冲，翻 y）。返回画了几次。 */
  #drawGlass(
    layer: LayerItems,
    panels: readonly MeasuredPanel[],
    groups: readonly MeasuredGroup[],
    cw: number,
    ch: number
  ): number {
    const gl = this.gl
    if (layer.panels.length === 0 && layer.groups.length === 0) return 0
    gl.enable(gl.BLEND)
    // 片元输出预乘色，与 WebGPU 的 one / one-minus-src-alpha 相同
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.SCISSOR_TEST)
    let n = 0
    if (layer.panels.length > 0) {
      this.#setGlassUniforms(this.#glass, cw, ch, 0, 0, true)
      for (const i of layer.panels) {
        const [sx, sy, sw, sh] = panels[i]!.scissor
        gl.scissor(sx, ch - sy - sh, sw, sh) // GL 的 scissor 是左下原点
        this.#bindSlot(this.#panelUbo!, this.#panelData, PANEL_BINDING, i, PANEL_STRIDE, PANEL_STRUCT_BYTES)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        n++
      }
    }
    if (layer.groups.length > 0) {
      this.#setGlassUniforms(this.#group, cw, ch, 0, 0, true)
      for (const i of layer.groups) {
        const [sx, sy, sw, sh] = groups[i]!.scissor
        gl.scissor(sx, ch - sy - sh, sw, sh)
        this.#bindSlot(this.#groupUbo!, this.#groupData, GROUP_BINDING, i, GROUP_STRIDE, GROUP_STRUCT_BYTES)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        n++
      }
    }
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    return n
  }

  /** 层的来源纹理（画布大小、RGBA8）与挂着它的帧缓冲。视口变了重新分配。 */
  #ensureLayerSource(cw: number, ch: number): WebGLFramebuffer {
    const gl = this.gl
    if (this.#layerSourceFbo && this.#layerSourceWidth === cw && this.#layerSourceHeight === ch) return this.#layerSourceFbo
    if (this.#layerSourceFbo) gl.deleteFramebuffer(this.#layerSourceFbo)
    if (this.#layerSource) gl.deleteTexture(this.#layerSource)
    const tex = gl.createTexture()
    if (!tex) throw new Error('[Glassium] createTexture 返回 null')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, cw, ch)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()
    if (!fbo) throw new Error('[Glassium] createFramebuffer 返回 null')
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    objectsCreated += 2
    this.#layerSource = tex
    this.#layerSourceFbo = fbo
    this.#layerSourceWidth = cw
    this.#layerSourceHeight = ch
    return fbo
  }

  /**
   * 把用户场景传进纹理（需要时）。
   * 与 WebGPU 那边一样：上传失败不抛进帧循环，警告一次，有旧内容就用旧的，没有就画内置场景。
   */
  #prepareImage(img: SceneImage): SceneUploadState {
    const gl = this.gl
    if (!this.#imageTexture) {
      const tex = gl.createTexture()
      if (!tex) return 'none'
      gl.bindTexture(gl.TEXTURE_2D, tex)
      // 只有一级、不做 mip：静态图已经在 CPU 上缩到视口大小（见 core/scene.ts 的 sceneBitmapSize）
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.#imageTexture = tex
      objectsCreated++
    }
    let uploaded = false
    const stale = img.dynamic || img.source !== this.#uploadedSource || img.version !== this.#uploadedVersion
    if (stale && sourceReady(img.source)) {
      gl.bindTexture(gl.TEXTURE_2D, this.#imageTexture)
      // 与 WebGPU 的 copyExternalImageToTexture（flipY: false、不预乘）一致：第 0 行是图片顶部
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img.source as TexImageSource)
        this.#uploadedSource = img.source
        this.#uploadedVersion = img.version
        uploaded = true
      } catch (err) {
        if (!this.#uploadWarned) {
          this.#uploadWarned = true
          console.warn(
            `[Glassium] 场景图片上传失败，先画${this.#uploadedSource ? '上一次的内容' : '内置场景'}：${String(err)}` +
              '（跨源图片要带 CORS 头并设 crossOrigin）'
          )
        }
      }
    }
    if (this.#uploadedSource === null) return 'none'
    return uploaded ? 'uploaded' : 'kept'
  }

  #setGlassUniforms(p: Program, cw: number, ch: number, ox: number, oy: number, onScreen: boolean): void {
    const gl = this.gl
    useProgram(gl, p)
    gl.bindTexture(gl.TEXTURE_2D, this.#chain)
    gl.uniform1i(loc(gl, p, 'chain'), 0)
    gl.uniform4f(loc(gl, p, 'uStage'), cw, ch, ox, oy)
    gl.uniform2f(loc(gl, p, 'uStageInv'), 1 / cw, 1 / ch) // 乘倒数而不是除：理由见 shaders.ts 的 uStageInv
    gl.uniform1f(loc(gl, p, 'uOnScreen'), onScreen ? 1 : 0)
    gl.uniform1f(loc(gl, p, 'uProbe'), onScreen ? 0 : 1)
  }

  #readback(request: ReadbackRequest, cw: number, ch: number): void {
    const gl = this.gl
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
      return
    }
    const raw = new Uint8Array(w * h * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    // GL 的 readPixels 是左下原点、行从下往上：换算起点，读完再把行倒过来
    gl.readPixels(x, ch - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    const rgba = new Uint8Array(w * h * 4)
    const row = w * 4
    for (let j = 0; j < h; j++) rgba.set(raw.subarray((h - 1 - j) * row, (h - j) * row), j * row)
    request.resolve({ region: { x, y, width: w, height: h }, rgba, canvasFormat: 'rgba8unorm' })
  }

  /**
   * 探针：在一张 RGBA32F 离屏目标上重跑同一段着色器（uProbe = 1），读回光学中间量。
   * 离屏不翻 y，读回的第 0 行就是探针区域的最上一行 —— 与 WebGPU 的探针数据同一个排布。
   */
  #renderProbe(
    program: Program,
    scissor: readonly [number, number, number, number],
    cw: number,
    ch: number,
    bind: () => void
  ): Float32Array | Error {
    const gl = this.gl
    if (!this.report.colorBufferFloat) {
      return new Error('[Glassium] 这个 WebGL2 上下文没有 EXT_color_buffer_float，探针渲不进 RGBA32F')
    }
    const [ox, oy, w, h] = scissor
    const tex = gl.createTexture()
    const fbo = gl.createFramebuffer()
    if (!tex || !fbo) return new Error('[Glassium] 探针的纹理或帧缓冲创建失败')
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        return new Error(`[Glassium] 探针帧缓冲不完整：0x${status.toString(16)}`)
      }
      gl.viewport(0, 0, w, h)
      gl.disable(gl.BLEND)
      gl.disable(gl.SCISSOR_TEST)
      this.#setGlassUniforms(program, cw, ch, ox, oy, false)
      bind()
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      const data = new Float32Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, data)
      return data
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tex)
    }
  }

  #probePanel(probe: ProbeRequest, panels: readonly MeasuredPanel[], cw: number, ch: number): void {
    const target = panels[probe.index]
    if (!target) {
      probe.reject(new Error(`[Glassium] 第 ${probe.index} 块面板不存在或不在屏上`))
      return
    }
    const data = this.#renderProbe(this.#glass, target.scissor, cw, ch, () =>
      this.#bindSlot(this.#panelUbo!, this.#panelData, PANEL_BINDING, probe.index, PANEL_STRIDE, PANEL_STRUCT_BYTES)
    )
    if (data instanceof Error) {
      probe.reject(data)
      return
    }
    const d = this.#panelData
    const o = probe.index * PANEL_STRIDE_FLOATS
    const [ox, oy, w, h] = target.scissor
    probe.resolve({
      width: w,
      height: h,
      origin: [ox, oy],
      data,
      panel: {
        rect: [d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!],
        radii: [d[o + 4]!, d[o + 5]!, d[o + 6]!, d[o + 7]!],
        heightPx: d[o + 12]!,
        amountPx: d[o + 13]!,
        squircle: d[o + 16]!,
        depthEffect: d[o + 17]!
      }
    })
  }

  #probeGroup(probe: GroupProbeRequest, groups: readonly MeasuredGroup[], cw: number, ch: number): void {
    const target = groups[probe.index]
    if (!target) {
      probe.reject(new Error(`[Glassium] 第 ${probe.index} 个合并组不存在或不在屏上`))
      return
    }
    const data = this.#renderProbe(this.#group, target.scissor, cw, ch, () =>
      this.#bindSlot(this.#groupUbo!, this.#groupData, GROUP_BINDING, probe.index, GROUP_STRIDE, GROUP_STRUCT_BYTES)
    )
    if (data instanceof Error) {
      probe.reject(data)
      return
    }
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
    const [ox, oy, w, h] = target.scissor
    probe.resolve({ width: w, height: h, origin: [ox, oy], data, members, smoothingPx: d[o + 1]! })
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    const gl = this.gl
    this.#destroyTargets()
    if (this.#imageTexture) gl.deleteTexture(this.#imageTexture)
    for (const p of [this.#scene, this.#sceneImage, this.#blur, this.#backdrop, this.#glass, this.#group, this.#fill]) {
      gl.deleteProgram(p.program)
    }
    gl.deleteVertexArray(this.#vao)
    if (this.#panelUbo) gl.deleteBuffer(this.#panelUbo)
    if (this.#groupUbo) gl.deleteBuffer(this.#groupUbo)
    if (this.#fillUbo) gl.deleteBuffer(this.#fillUbo)
    if (this.#layerSourceFbo) gl.deleteFramebuffer(this.#layerSourceFbo)
    if (this.#layerSource) gl.deleteTexture(this.#layerSource)
  }
}

// —— 程序 ——

function compile(gl: WebGL2RenderingContext, fragment: string, label: string): Program {
  const make = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)
    if (!shader) throw new Error(`[Glassium] createShader 返回 null（${label}）`)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? ''
      gl.deleteShader(shader)
      throw new Error(`[Glassium] WebGL2 着色器 ${label} 编译失败：${log}`)
    }
    return shader
  }
  const vs = make(gl.VERTEX_SHADER, FULLSCREEN_VS)
  const fs = make(gl.FRAGMENT_SHADER, fragment)
  const program = gl.createProgram()
  if (!program) throw new Error(`[Glassium] createProgram 返回 null（${label}）`)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? ''
    gl.deleteProgram(program)
    throw new Error(`[Glassium] WebGL2 程序 ${label} 链接失败：${log}`)
  }
  programsCreated++
  return { program, uniforms: new Map() }
}

/**
 * 把 uniform block 接到绑定点上，并核对它的大小。
 *
 * std140 与 WGSL 的 uniform 布局在这两个结构体上应当逐字节相同（打包代码两个后端共用）。
 * 这里不对就说明两边的结构体定义漂了 —— 拒绝启动，比画出一块参数错位的玻璃好查得多。
 */
function bindBlock(gl: WebGL2RenderingContext, p: Program, name: string, binding: number, expectBytes: number): void {
  const index = gl.getUniformBlockIndex(p.program, name)
  if (index === gl.INVALID_INDEX) throw new Error(`[Glassium] 程序里没有 uniform block ${name}`)
  const size = gl.getActiveUniformBlockParameter(p.program, index, gl.UNIFORM_BLOCK_DATA_SIZE) as number
  if (size !== expectBytes) {
    throw new Error(`[Glassium] ${name} 的 std140 大小是 ${size}B，与 WGSL 侧的 ${expectBytes}B 不一致`)
  }
  gl.uniformBlockBinding(p.program, index, binding)
}

function useProgram(gl: WebGL2RenderingContext, p: Program): void {
  gl.useProgram(p.program)
}

function loc(gl: WebGL2RenderingContext, p: Program, name: string): WebGLUniformLocation | null {
  let l = p.uniforms.get(name)
  if (l === undefined) {
    l = gl.getUniformLocation(p.program, name)
    p.uniforms.set(name, l)
  }
  return l
}
