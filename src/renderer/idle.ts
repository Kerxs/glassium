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
 * - 场景（scene.ts 的脏标记）：节点一个不多一个不少、顺序相同，每个节点四类都不脏 ——
 *   面板：同一块面板、同样的矩形 / 裁剪、同一个降级结果（材质或尺寸变了会重新降级，换一个新对象）；
 *   合并组：成员逐个同上，外加 smoothing 与裁剪矩形；
 *   填充：同一块、同样的矩形 / 裁剪 / 圆角 / 颜色（颜色的 CSS 过渡期间每帧都不同）/ 渐变（解算结果缓存在记录上，
 *   渐变或尺寸没变就是同一个对象）/ 位图（图集里同一格、画过的次数相同 —— 重画一次就算变了）
 */

import type { BlendSpace } from '../core/color.ts'
import type { ResolvedViewport } from '../core/units.ts'
import type { PanelDebugMode } from '../shaders/glass.wgsl.ts'
import type { BackdropState, SceneImage } from './backend.ts'
import type { MeasuredFill } from './fills.ts'
import { fillDirty, isClean, sameTuple, sceneChanged, type Scene } from './scene.ts'

/** 决定一帧像素的全部输入（FrameInput 去掉回读与探针请求）。 */
export interface FrameSnapshot {
  readonly time: number
  readonly viewport: ResolvedViewport
  readonly blendSpace: BlendSpace
  readonly backdrop: BackdropState
  readonly sceneImage: SceneImage | null
  /** 量到的面板、合并组、填充（scene.ts）。 */
  readonly scene: Scene
  readonly panelDebugMode: PanelDebugMode
}

/** 内置场景里随时间变化的只有 gradient（mode 0）。 */
const GRADIENT_SCENE = 0

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

/** 填充逐个相同（scene.ts 的 fillDirty 四类都不脏）。 */
function sameFills(a: readonly MeasuredFill[], b: readonly MeasuredFill[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!isClean(fillDirty(a[i]!, b[i]!))) return false
  return true
}

/**
 * 内置场景被整个盖住了吗：第 0 层有一块不透明的填充铺满画布（runtime 收进来的页面根背景就是这样）。
 * 盖住时内置 gradient 场景随时间漂也看不见 —— 时间不算，静止的页面才能不画、只动玻璃的帧才能沿用场景。
 * 保守：只认轴对齐、没有圆角、没有裁剪 / 遮罩 / 洞、纯色或全不透明渐变的填充；位图不认（不知道透不透）。
 */
export function sceneHidden(fills: readonly MeasuredFill[], viewport: ResolvedViewport): boolean {
  const W = viewport.compositeWidth
  const H = viewport.compositeHeight
  for (const f of fills) {
    if (f.layer !== 0 || f.bitmap || f.hole || f.mask || f.clipShape) continue
    if (f.rotation[0] !== 1 || f.rotation[1] !== 0) continue
    if (!(f.color[3]! >= 1)) continue
    if (f.gradient && f.gradient.colors.some((c) => !(c[3]! >= 1))) continue
    if (f.radii.some((r) => r > 0) || f.radiiY.some((r) => r > 0) || f.clipRadii.some((r) => r > 0) || f.clipRadiiY.some((r) => r > 0)) continue
    if (!(f.x <= 0 && f.y <= 0 && f.x + f.w >= W && f.y + f.h >= H)) continue
    if (!(f.clip.x0 <= 0 && f.clip.y0 <= 0 && f.clip.x1 >= W && f.clip.y1 >= H)) continue
    return true
  }
  return false
}

/** next 画出来与 prev 逐像素相同吗。没有 prev（第一帧、刚换过后端或画布）时一律为否。 */
export function unchangedFrame(prev: FrameSnapshot | null, next: FrameSnapshot): boolean {
  if (prev === null) return false
  // 内置 gradient 场景随时间漂移；有用户场景时内置场景不画、被不透明的填充整个盖住时看不见，时间无关
  if (
    next.sceneImage === null &&
    next.backdrop.sceneMode === GRADIENT_SCENE &&
    prev.time !== next.time &&
    !sceneHidden(next.scene.fills, next.viewport)
  ) {
    return false
  }
  return (
    prev.backdrop === next.backdrop &&
    prev.blendSpace === next.blendSpace &&
    prev.panelDebugMode === next.panelDebugMode &&
    sameViewport(prev.viewport, next.viewport) &&
    sameScene(prev.sceneImage, next.sceneImage) &&
    !sceneChanged(prev.scene, next.scene)
  )
}

/**
 * 场景能不能沿用上一帧的（合成器的脏状态）：场景目标（模糊链第 0 级）与整条模糊链只取决于这些 —— 与玻璃无关。
 * 相同就不重画场景、不重画第 0 层的填充、不重建模糊链：只动了玻璃（果冻、飞行、拖动）的帧省掉最贵的那一半。
 * 上一帧画过更高的层（layers.ts 把画布采回第 0 级、局部重建了模糊链）也能沿用：后端在画层之前把那一块的第 0 级
 * 备份下来，沿用时先拷回去、在同一块里重建模糊链 —— 那一块以外本来就是上一次整帧建的值，逐位复原。
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
}

export function sceneReusable(prev: SceneKey | null, next: SceneKey): boolean {
  if (prev === null) return false
  if (next.sceneImage === null && next.sceneMode === GRADIENT_SCENE && prev.time !== next.time && !sceneHidden(next.fills, next.viewport)) {
    return false
  }
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
