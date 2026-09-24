/**
 * 填充（`<glass-fill>`）：CSS 摆位、Glassium 画进场景的纯色圆角矩形。
 *
 * 玻璃只折射场景（R2），DOM 的背景它看不见。开关的轨道、滑块的进度条这类「玻璃底下的纯色形状」
 * 写成填充就进了场景：玻璃折射它、模糊它、按它的亮度调自适应。怎么画见 shaders/fill.wgsl.ts。
 *
 * 样式全从 CSS 来：
 * - 盒子（位置、尺寸、变换、裁剪、不透明度）与面板一样每帧量（panels.ts 共用同一段测量）；
 * - 颜色是自定义属性 `--glass-fill`，注册成不继承、可过渡的 `<color>`（register.ts 与 glassium.css
 *   各注册一次），CSS 过渡直接可用 —— 每帧读计算值；
 * - 圆角是 CSS 的 border-radius。
 *
 * 元素自己的 CSS 背景在 stage 生效时是透明的（glassium.css），否则它会挡住后面的玻璃（R1）。
 */

import { parseTint } from '../core/material.ts'
import { FILL_STRIDE_FLOATS } from '../shaders/fill.wgsl.ts'
import { CLIP_UNBOUNDED_PX, parseCornerRadius, scaleRadii, type Box, type ClipEntry } from './clipping.ts'

/** 填充颜色的 CSS 自定义属性。 */
export const FILL_PROPERTY = '--glass-fill'

/** 注册成 `<color>`：不继承（开关里的轨道不会把颜色传给里面的东西）、初始透明、可以过渡。 */
export const FILL_PROPERTY_DEFINITION = {
  name: FILL_PROPERTY,
  syntax: '<color>',
  inherits: false,
  initialValue: 'transparent'
} as const

/** 未预乘的 sRGB [r, g, b, a]，0–1。 */
export type Rgba = readonly [number, number, number, number]

const TRANSPARENT: Rgba = [0, 0, 0, 0]

/** 从元素读出的填充样式：各项计算值的原文。 */
export interface FillStyle {
  /** `--glass-fill` 的计算值。注册过的是 `rgb(…)` 一类，没注册的是作者写的原文。 */
  readonly color: string
  /** `color` 的计算值：`--glass-fill` 是 `currentcolor` 时用它。 */
  readonly currentColor: string
  /** border-top-left / top-right / bottom-right / bottom-left-radius 的计算值。 */
  readonly radii: readonly [string, string, string, string]
}

/** 从活的计算样式里读。每帧调：颜色的过渡要逐帧跟上。 */
export function readFillStyle(style: CSSStyleDeclaration): FillStyle {
  return {
    color: style.getPropertyValue(FILL_PROPERTY),
    currentColor: style.color,
    radii: [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius
    ]
  }
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
let converter: Context2D | null | undefined

/** 1×1 的 2D 画布，把任何 CSS 颜色换算成 sRGB。惰性创建；没有 DOM 时是 null。 */
function colorConverter(): Context2D | null {
  if (converter !== undefined) return converter
  converter = null
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      converter = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
    } else if (typeof document !== 'undefined') {
      converter = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    }
  } catch {
    converter = null
  }
  return converter
}

/**
 * CSS 颜色 → 未预乘的 [r, g, b, a]。
 *
 * hex 与 `rgb()` / `rgba()` 直接解析（注册过的 `<color>` 属性，sRGB 颜色的计算值都是这种写法）；
 * 其余（`oklch()`、`color(display-p3 …)`、`color-mix()` 的结果、没注册时的具名颜色）交给浏览器：
 * 在 1×1 的画布上画一个点再读回来，浏览器负责换算与色域映射，结果是 8 位的。实测约 4µs 一次，
 * 而且只在颜色文本变了时才做。解析不了（写错了、没有 DOM）返回 null。
 */
export function parseFillColor(text: string): Rgba | null {
  const s = text.trim()
  if (s === '' || s === 'transparent') return TRANSPARENT
  try {
    return parseTint(s)
  } catch {
    // 不是 hex / rgb()：往下交给浏览器
  }
  if (typeof CSS === 'undefined' || !CSS.supports('color', s)) return null
  const ctx = colorConverter()
  if (!ctx) return null
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = s
  ctx.fillRect(0, 0, 1, 1)
  const d = ctx.getImageData(0, 0, 1, 1).data
  return [d[0]! / 255, d[1]! / 255, d[2]! / 255, d[3]! / 255]
}

/**
 * 四角圆角（CSS 像素，变换之前）：百分比按盒子的宽、高解算；同一条边上相邻两角之和超过边长时一起缩小
 * （CSS 的规则，`border-radius: 999px` 的胶囊靠它变成半圆）；椭圆角取短的那个半径（着色器画的是
 * 圆角矩形，与裁剪祖先的圆角同一个近似）；最后钳到短边的一半。
 */
export function fillRadii(
  radii: readonly string[],
  width: number,
  height: number
): [number, number, number, number] {
  const resolved = radii.map((css) => {
    const [x, y] = parseCornerRadius(css)
    return [x.percent ? (x.value / 100) * width : x.value, y.percent ? (y.value / 100) * height : y.value] as const
  })
  const cap = Math.min(width, height) / 2
  const [tl, tr, br, bl] = scaleRadii(resolved, width, height).map(([x, y]) => Math.max(0, Math.min(x, y, cap)))
  return [tl!, tr!, br!, bl!]
}

/** 一块注册过的填充。 */
export interface FillRecord {
  readonly element: HTMLElement
  /** 与面板相同的几何缓存（panels.ts 的测量读写它们）。 */
  clips?: readonly ClipEntry[]
  clipGeneration?: number
  opacityStyles?: readonly CSSStyleDeclaration[]
  opacityGeneration?: number
  /** 元素自己的计算样式（活对象）。 */
  style?: CSSStyleDeclaration
  /** 上一次解析的颜色：文本没变就不重新解析。 */
  colorText?: string
  color?: Rgba
  /** 颜色解析不了时只警告一次。 */
  warnedColor?: boolean
  /** 最近的玻璃祖先（见 panels.ts 的层）与找它时的树代数。 */
  glassParent?: object | null
  glassParentGeneration?: number
  /** 最近的对话框 / popover 祖先（见 panels.ts 的 overlay）与找它时的树代数。 */
  topAnchor?: Element | null
  topAnchorGeneration?: number
}

/** 一帧里量到的填充，已换算到画布设备像素。 */
export interface MeasuredFill {
  readonly record: FillRecord
  /** 矩形。有旋转时是转之前的矩形（中心 = 包围盒的中心）。 */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** 旋转（cos θ, sin θ），没有是 (1, 0)。 */
  readonly rotation: readonly [number, number]
  /** 画布上的裁剪矩形（整数，已外扩抗锯齿余量、已与画布和裁剪祖先求交）。 */
  readonly scissor: readonly [number, number, number, number]
  readonly clip: Box
  readonly clipRadii: readonly [number, number, number, number]
  /** 四角圆角，画布设备像素。 */
  readonly radii: readonly [number, number, number, number]
  /** 颜色，alpha 已乘上 CSS 的不透明度。 */
  readonly color: Rgba
  /**
   * 在第几层（见 panels.ts 的 MAX_GLASS_LAYER）：0 是场景里、所有玻璃之下；写在一块玻璃里面的填充在那块玻璃之上，
   * 是它的层号加一 —— 同一层的玻璃看得见它，下面那层的玻璃看不见。
   */
  readonly layer: number
}

/**
 * 把一块填充写进 uniform 数组的第 index 个槽位（每槽 256B）。
 * 字段顺序必须与 fill.wgsl.ts 的 `struct Fill` 逐一对应（fills.test.ts 从 WGSL 源里解析出来核对）。
 */
export function packFill(data: Float32Array, index: number, fill: MeasuredFill): void {
  const o = index * FILL_STRIDE_FLOATS
  // rect @ 0
  data[o + 0] = fill.x
  data[o + 1] = fill.y
  data[o + 2] = fill.w
  data[o + 3] = fill.h
  // radii @ 16
  data[o + 4] = fill.radii[0]
  data[o + 5] = fill.radii[1]
  data[o + 6] = fill.radii[2]
  data[o + 7] = fill.radii[3]
  // color @ 32
  data[o + 8] = fill.color[0]
  data[o + 9] = fill.color[1]
  data[o + 10] = fill.color[2]
  data[o + 11] = fill.color[3]
  // clip @ 48：没有裁剪的方向写有限的 ±65536（着色器里 ∞ − ∞ 是 NaN）
  const bound = (v: number): number => Math.max(-CLIP_UNBOUNDED_PX, Math.min(CLIP_UNBOUNDED_PX, v))
  data[o + 12] = bound(fill.clip.x0)
  data[o + 13] = bound(fill.clip.y0)
  data[o + 14] = bound(fill.clip.x1)
  data[o + 15] = bound(fill.clip.y1)
  // clipRadii @ 64
  data[o + 16] = fill.clipRadii[0]
  data[o + 17] = fill.clipRadii[1]
  data[o + 18] = fill.clipRadii[2]
  data[o + 19] = fill.clipRadii[3]
  // pose @ 80
  data[o + 20] = fill.rotation[0]
  data[o + 21] = fill.rotation[1]
  data[o + 22] = 0
  data[o + 23] = 0
}

/**
 * 画布设备像素的裁剪矩形 → 场景目标像素：往外取整，与目标求交。空的返回 null。
 *
 * 画布上的裁剪矩形已经外扩了 2 个画布像素的抗锯齿余量；场景目标的像素不比画布的小
 * （像素预算只往下压），所以换算过去至少还有一个场景像素 —— 抗锯齿那半个像素够用。
 */
export function sceneScissor(
  scissor: readonly [number, number, number, number],
  sceneWidth: number,
  sceneHeight: number,
  compositeWidth: number,
  compositeHeight: number
): [number, number, number, number] | null {
  const kx = sceneWidth / compositeWidth
  const ky = sceneHeight / compositeHeight
  const x0 = Math.max(0, Math.floor(scissor[0] * kx))
  const y0 = Math.max(0, Math.floor(scissor[1] * ky))
  const x1 = Math.min(sceneWidth, Math.ceil((scissor[0] + scissor[2]) * kx))
  const y1 = Math.min(sceneHeight, Math.ceil((scissor[1] + scissor[3]) * ky))
  if (x1 <= x0 || y1 <= y0) return null
  return [x0, y0, x1 - x0, y1 - y0]
}

/** 场景目标的 Dest：一个场景像素是几个画布设备像素，抗锯齿宽度取较大的那个轴。 */
export function sceneDest(
  sceneWidth: number,
  sceneHeight: number,
  compositeWidth: number,
  compositeHeight: number
): [number, number, number, number] {
  const sx = compositeWidth / sceneWidth
  const sy = compositeHeight / sceneHeight
  return [sx, sy, Math.max(sx, sy), 0]
}

/** 画布本身的 Dest：一比一。 */
export const CANVAS_DEST: readonly [number, number, number, number] = [1, 1, 1, 0]
