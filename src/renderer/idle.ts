/**
 * 静止时不画。
 *
 * 帧循环每帧都要量一遍面板（滚动、布局变化只有量了才知道，每块约 1.7 µs），但**画**是贵的那一半：
 * 编码、提交、GPU 上十几趟全屏 pass。一个静态背景加几块不动的卡片，每一帧画出来都逐像素相同，
 * 在 240Hz 的屏上就是每秒 240 次白画。
 *
 * 这里判断「这一帧画出来会不会与上一帧逐像素相同」。相同就不画：WebGPU 不取 getCurrentTexture、
 * WebGL2 不发 draw，浏览器继续显示上一帧 —— 两个后端都是这个语义。
 *
 * 判断是**保守**的：拿不准就当作变了。只比较决定像素的输入，而且比较的是值或不可变对象的引用：
 *
 * - 视口：各级分辨率与 DPR；混合空间（blendSpace）
 * - 背景参数：stage 每次 setBackdrop 都换一个新对象，比引用
 * - 场景：内置 gradient 场景随时间漂移（reduced-motion 下时间冻结在 0，就不动了）；用户场景
 *   dynamic 的每帧都变，其余比源、版本号与铺法
 * - 面板：同一块面板、同样的矩形 / 裁剪、同一个降级结果（材质或尺寸变了会重新降级，换一个新对象）
 * - 合并组：成员逐个同上，外加 smoothing 与裁剪矩形
 * - 填充：同一块、同样的矩形 / 裁剪 / 圆角 / 颜色（颜色的 CSS 过渡期间每帧都不同）/ 渐变（解算结果缓存在记录上，
 *   渐变或尺寸没变就是同一个对象）/ 位图（图集里同一格、画过的次数相同 —— 重画一次就算变了）
 */

import type { BlendSpace } from '../core/color.ts'
import type { ResolvedViewport } from '../core/units.ts'
import type { PanelDebugMode } from '../shaders/glass.wgsl.ts'
import type { BackdropState, SceneImage } from './backend.ts'
import type { RoundedBox } from './clipping.ts'
import { sameMask } from './mask.ts'
import type { FillBitmap, FillHole, MeasuredFill } from './fills.ts'
import type { MeasuredGroup, MeasuredPanel } from './panels.ts'

/** 决定一帧像素的全部输入（FrameInput 去掉回读与探针请求）。 */
export interface FrameSnapshot {
  readonly time: number
  readonly viewport: ResolvedViewport
  readonly blendSpace: BlendSpace
  readonly backdrop: BackdropState
  readonly sceneImage: SceneImage | null
  readonly panels: readonly MeasuredPanel[]
  readonly groups: readonly MeasuredGroup[]
  readonly fills: readonly MeasuredFill[]
  readonly panelDebugMode: PanelDebugMode
}

/** 内置场景里随时间变化的只有 gradient（mode 0）。 */
const GRADIENT_SCENE = 0

function sameTuple(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameViewport(a: ResolvedViewport, b: ResolvedViewport): boolean {
  return (
    a.cssWidth === b.cssWidth &&
    a.cssHeight === b.cssHeight &&
    a.dpr === b.dpr &&
    a.compositeWidth === b.compositeWidth &&
    a.compositeHeight === b.compositeHeight &&
    a.sceneWidth === b.sceneWidth &&
    a.sceneHeight === b.sceneHeight
  )
}

function sameScene(a: SceneImage | null, b: SceneImage | null): boolean {
  if (a === null || b === null) return a === b
  if (b.dynamic) return false
  return (
    a.source === b.source &&
    a.version === b.version &&
    a.width === b.width &&
    a.height === b.height &&
    sameTuple(a.uvScale, b.uvScale) &&
    sameTuple(a.uvOffset, b.uvOffset) &&
    sameTuple(a.background, b.background)
  )
}

function sameRoundedBox(a: RoundedBox | null, b: RoundedBox | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.box.x0 === b.box.x0 &&
    a.box.y0 === b.box.y0 &&
    a.box.x1 === b.box.x1 &&
    a.box.y1 === b.box.y1 &&
    sameTuple(a.rx, b.rx) &&
    sameTuple(a.ry, b.ry)
  )
}

function samePanel(a: MeasuredPanel, b: MeasuredPanel): boolean {
  return (
    a.record === b.record &&
    a.chain === b.chain &&
    a.quality === b.quality &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    sameTuple(a.scissor, b.scissor) &&
    a.clip.x0 === b.clip.x0 &&
    a.clip.y0 === b.clip.y0 &&
    a.clip.x1 === b.clip.x1 &&
    a.clip.y1 === b.clip.y1 &&
    sameTuple(a.clipRadii, b.clipRadii) &&
    sameTuple(a.clipRadiiY, b.clipRadiiY) &&
    sameRoundedBox(a.clipShape, b.clipShape) &&
    sameMask(a.mask, b.mask) &&
    sameTuple(a.light, b.light) &&
    a.fade === b.fade &&
    a.tone === b.tone &&
    a.visualScale === b.visualScale &&
    sameTuple(a.rotation, b.rotation) &&
    a.layer === b.layer
  )
}

function samePanels(a: readonly MeasuredPanel[], b: readonly MeasuredPanel[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!samePanel(a[i]!, b[i]!)) return false
  return true
}

function sameGroups(a: readonly MeasuredGroup[], b: readonly MeasuredGroup[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const g = a[i]!
    const h = b[i]!
    if (
      g.smoothingPx !== h.smoothingPx ||
      g.layer !== h.layer ||
      !sameTuple(g.scissor, h.scissor) ||
      !samePanels(g.members, h.members)
    ) {
      return false
    }
  }
  return true
}

function sameBitmap(a: FillBitmap | null | undefined, b: FillBitmap | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.version === b.version && sameTuple(a.geom, b.geom) && sameTuple(a.cell, b.cell)
}

function sameHole(a: FillHole | null | undefined, b: FillHole | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.alpha === b.alpha && sameRoundedBox(a.shape, b.shape)
}

function sameFill(a: MeasuredFill, b: MeasuredFill): boolean {
  return (
    a.record === b.record &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    sameTuple(a.rotation, b.rotation) &&
    sameTuple(a.scissor, b.scissor) &&
    a.clip.x0 === b.clip.x0 &&
    a.clip.y0 === b.clip.y0 &&
    a.clip.x1 === b.clip.x1 &&
    a.clip.y1 === b.clip.y1 &&
    sameTuple(a.clipRadii, b.clipRadii) &&
    sameTuple(a.clipRadiiY, b.clipRadiiY) &&
    sameRoundedBox(a.clipShape, b.clipShape) &&
    sameMask(a.mask, b.mask) &&
    sameTuple(a.radii, b.radii) &&
    sameTuple(a.radiiY, b.radiiY) &&
    sameTuple(a.color, b.color) &&
    a.gradient === b.gradient &&
    sameBitmap(a.bitmap, b.bitmap) &&
    sameHole(a.hole, b.hole) &&
    a.layer === b.layer
  )
}

function sameFills(a: readonly MeasuredFill[], b: readonly MeasuredFill[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!sameFill(a[i]!, b[i]!)) return false
  return true
}

/** next 画出来与 prev 逐像素相同吗。没有 prev（第一帧、刚换过后端或画布）时一律为否。 */
export function unchangedFrame(prev: FrameSnapshot | null, next: FrameSnapshot): boolean {
  if (prev === null) return false
  // 内置 gradient 场景随时间漂移；有用户场景时内置场景不画，时间无关
  if (next.sceneImage === null && next.backdrop.sceneMode === GRADIENT_SCENE && prev.time !== next.time) {
    return false
  }
  return (
    prev.backdrop === next.backdrop &&
    prev.blendSpace === next.blendSpace &&
    prev.panelDebugMode === next.panelDebugMode &&
    sameViewport(prev.viewport, next.viewport) &&
    sameScene(prev.sceneImage, next.sceneImage) &&
    samePanels(prev.panels, next.panels) &&
    sameGroups(prev.groups, next.groups) &&
    sameFills(prev.fills, next.fills)
  )
}

/**
 * 场景能不能沿用上一帧的（合成器的脏状态）：场景目标（模糊链第 0 级）与整条模糊链只取决于这些 —— 与玻璃无关。
 * 相同就不重画场景、不重画第 0 层的填充、不重建模糊链：只动了玻璃（果冻、飞行、拖动）的帧省掉最贵的那一半。
 * 上一帧画过更高的层（layers.ts 把画布采回第 0 级、局部重建了模糊链）就不能沿用。
 */
export interface SceneKey {
  /** 模糊链的纹理（换了尺寸、格式、设备就是新的对象）。 */
  readonly target: object
  readonly time: number
  readonly viewport: ResolvedViewport
  readonly blendSpace: BlendSpace
  readonly sceneMode: number
  readonly radialCenterCss: readonly [number, number]
  readonly radialRadius: number
  readonly sceneImage: SceneImage | null
  /** 第 0 层的填充（画进场景的那些）。 */
  readonly fills: readonly MeasuredFill[]
  /** 背景上屏用「没有填充的那一份」（草稿纹理第 0 级）。 */
  readonly crisp: boolean
  /** 这一帧画了更高的层：场景目标被改过，下一帧不能沿用。 */
  readonly layered: boolean
}

export function sceneReusable(prev: SceneKey | null, next: SceneKey): boolean {
  if (prev === null || prev.layered) return false
  if (next.sceneImage === null && next.sceneMode === GRADIENT_SCENE && prev.time !== next.time) return false
  return (
    prev.target === next.target &&
    prev.blendSpace === next.blendSpace &&
    prev.sceneMode === next.sceneMode &&
    prev.radialRadius === next.radialRadius &&
    sameTuple(prev.radialCenterCss, next.radialCenterCss) &&
    prev.crisp === next.crisp &&
    sameViewport(prev.viewport, next.viewport) &&
    sameScene(prev.sceneImage, next.sceneImage) &&
    sameFills(prev.fills, next.fills)
  )
}
