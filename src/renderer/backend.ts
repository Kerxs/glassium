/**
 * 渲染后端的公共接口与一帧的输入输出。
 *
 * stage 持有面板、参数、帧循环与监听器，这些与后端无关；一个后端（WebGPU 或 WebGL2）
 * 持有一台设备 / 一个上下文上的全部 GPU 资源，可以整体丢弃、整体重建。两个后端吃同一份
 * FrameInput（面板的 uniform 打包也是同一份字节 —— WGSL 的 uniform 布局与 GLSL 的 std140
 * 在这些结构体上逐字节相同），吐同样格式的回读与探针，于是验证代码不用知道底下是谁。
 */

import type { BlendSpace } from '../core/color.ts'
import type { ResolvedViewport } from '../core/units.ts'
import type { PanelDebugMode } from '../shaders/glass.wgsl.ts'
import type { ProbeReport } from '../webgpu/probe.ts'
import type { MeasuredFill } from './fills.ts'
import type { MeasuredGroup, MeasuredPanel } from './panels.ts'
import type { GroupOpticsProbe, OpticsProbe } from './verify.ts'

/**
 * 回读区域的边长（不给 region 时的默认值）。
 *
 * 256 不是随便取的：copyTextureToBuffer 要求 bytesPerRow 是 256 的倍数，
 * 而 256 像素 × 4 字节 = 1024，正好整除。
 */
export const READBACK_SIZE = 256

/** 回读区域，画布设备像素，左上原点。 */
export interface ReadbackRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ReadbackResult {
  /** 实际读到的区域（已与画布求交）。 */
  readonly region: ReadbackRegion
  /** 紧密排列的 RGBA8，**第 0 行在上**，已从画布格式换成 RGBA 顺序。 */
  readonly rgba: Uint8Array
  /** 画布的原始格式，留作核对（WebGL2 恒为 rgba8unorm）。 */
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

/**
 * 可以直接上传成纹理的图像源。WebGPU 的 copyExternalImageToTexture 与 WebGL2 的 texImage2D
 * 都认这几种。
 */
export type SceneImageSource =
  | ImageBitmap
  | ImageData
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLVideoElement
  | VideoFrame

/** 这一帧要画的用户场景（图片、视频或画布的当前帧）。没有时画内置场景。 */
export interface SceneImage {
  readonly source: SceneImageSource
  /** 源的像素尺寸。 */
  readonly width: number
  readonly height: number
  /**
   * 静态源的版本号：同一个源对象内容变了（比如画布重画了）时加一，后端据此重新上传。
   * 动态源（dynamic）每帧都传，不看它。
   */
  readonly version: number
  readonly dynamic: boolean
  /** 视口 uv → 图片 uv，见 core/scene.ts。 */
  readonly uvScale: readonly [number, number]
  readonly uvOffset: readonly [number, number]
  /** 图片之外（contain 留白）与图片透明处的底色，0–1。 */
  readonly background: readonly [number, number, number]
}

/** 视频还没有可用的帧时不上传（上传会抛），继续用上一帧的内容。其它源总是就绪的。 */
export function sourceReady(source: SceneImageSource): boolean {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return source.readyState >= 2 // HAVE_CURRENT_DATA
  }
  return true
}

/** 一帧需要的全部输入。都来自 stage，后端自己不持有任何跨帧的业务状态。 */
export interface FrameInput {
  /** 秒。reduced-motion 下由 stage 传 0。 */
  readonly time: number
  readonly viewport: ResolvedViewport
  /** 模糊与调色在哪个空间里做（见 core/color.ts）。变了要换模糊链的纹理格式。 */
  readonly blendSpace: BlendSpace
  readonly backdrop: BackdropState
  /** 用户场景。null 时按 backdrop.sceneMode 画内置场景。 */
  readonly sceneImage: SceneImage | null
  readonly panels: readonly MeasuredPanel[]
  readonly groups: readonly MeasuredGroup[]
  /** 填充：先画进场景（玻璃看得见），再按画布分辨率画到画布上（见 fill.wgsl.ts）。 */
  readonly fills: readonly MeasuredFill[]
  readonly panelDebugMode: PanelDebugMode
  readonly probe: ProbeRequest | null
  readonly groupProbe: GroupProbeRequest | null
  readonly readback: ReadbackRequest | null
}

export interface FrameResult {
  readonly drawCalls: number
  readonly blurPasses: number
  /** 这一帧有没有把用户场景重新传进纹理（0 或 1）。静态图片只该传一次。 */
  readonly sceneUploads: number
}

/**
 * 后端准备用户场景的结果：'none' 画不了（还没有任何内容传上去过），'kept' 用已经在纹理里的内容，
 * 'uploaded' 这一帧刚传了新内容。
 */
export type SceneUploadState = 'none' | 'kept' | 'uploaded'

/** WebGL2 上下文的能力探测结果。与 WebGPU 的 ProbeReport 用 kind 区分。 */
export interface Gl2Report {
  readonly kind: 'webgl2'
  /** 面板 256B、合并组 512B 的步长要能被它整除，才能直接按偏移绑定 UBO。 */
  readonly uniformBufferOffsetAlignment: number
  readonly maxUniformBlockSize: number
  readonly maxTextureSize: number
  /** EXT_color_buffer_float：探针要渲进 RGBA32F。没有它就只能回读颜色，不能验光学。 */
  readonly colorBufferFloat: boolean
}

export type BackendReport = ProbeReport | Gl2Report

export interface Renderer {
  readonly kind: 'webgpu' | 'webgl2'
  readonly report: BackendReport
  /** 模糊链的级数 K。 */
  readonly blurLevels: number
  /** 渲染目标分配次数。 */
  readonly allocations: number
  /** 视口尺寸变了（或刚重建）时调用：重建纹理。返回模糊链级数。 */
  resize(viewport: ResolvedViewport): number
  /** 画一帧。资源还没就绪时返回 null，调用方下一帧再来。 */
  render(input: FrameInput): FrameResult | null
  /** 释放全部资源。 */
  destroy(): void
}
