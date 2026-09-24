/**
 * 玻璃的层（见 panels.ts 的 MAX_GLASS_LAYER）：两个后端共用的那一部分 —— 一层的东西有哪些、要重画哪一块。
 *
 * 第 0 层照旧：场景 → 模糊链 → 背景上屏 → 填充 → 玻璃。第 L 层（L ≥ 1）的玻璃要看得见下面那几层的玻璃，
 * 所以画它之前：
 *
 *   1. 把画布上已经画好的那一块（场景 + 下面几层的玻璃与填充）拷出来，重采样回场景目标（模糊链的第 0 级）；
 *   2. 这一层的填充画进去（这一层的玻璃看得见它）；
 *   3. 只在这一块里重建模糊链；
 *   4. 这一层的填充按画布分辨率画到画布上，再画这一层的玻璃与合并组。
 *
 * 「这一块」是这一层所有东西的包围盒往外扩到模糊够得着的地方：玻璃在模糊链的某一级采样，那一级的值取决于
 * 第 0 级在它周围约 3σ 里的内容。扩出去的那一圈外面还是第 0 层时的旧内容（没有玻璃的场景），
 * 离玻璃足够远，影响不到它。
 */

import type { ResolvedViewport } from '../core/units.ts'
import { sigmaForLevel } from './blur.ts'
import type { Box } from './clipping.ts'
import type { MeasuredFill } from './fills.ts'
import type { MeasuredGroup, MeasuredPanel } from './panels.ts'

/** 一帧里分到某一层的东西（下标是它们在整帧列表里的位置：uniform 按整帧的顺序打包）。 */
export interface LayerItems {
  readonly layer: number
  readonly panels: readonly number[]
  readonly groups: readonly number[]
  readonly fills: readonly number[]
}

/** 按层分组，层号从小到大，只含有东西的层。 */
export function splitLayers(
  panels: readonly MeasuredPanel[],
  groups: readonly MeasuredGroup[],
  fills: readonly MeasuredFill[]
): LayerItems[] {
  const byLayer = new Map<number, { panels: number[]; groups: number[]; fills: number[] }>()
  const bucket = (layer: number): { panels: number[]; groups: number[]; fills: number[] } => {
    let b = byLayer.get(layer)
    if (!b) {
      b = { panels: [], groups: [], fills: [] }
      byLayer.set(layer, b)
    }
    return b
  }
  panels.forEach((p, i) => bucket(p.layer).panels.push(i))
  groups.forEach((g, i) => bucket(g.layer).groups.push(i))
  fills.forEach((f, i) => bucket(f.layer).fills.push(i))
  return [...byLayer.entries()].sort((a, b) => a[0] - b[0]).map(([layer, b]) => ({ layer, ...b }))
}

/** 要重画的一块：画布设备像素与场景目标像素各一份，都是整数 [x, y, w, h]，已钳到目标里。 */
export interface LayerRegion {
  readonly composite: readonly [number, number, number, number]
  readonly scene: readonly [number, number, number, number]
}

/**
 * 一层要重画的那一块。包围盒取这一层面板的包围盒、合并组与填充的裁剪矩形；往外扩的量按模糊链最粗的那一级算
 * （3σ，场景像素）—— 自适应的纱在第 4 级取样，玻璃自己的模糊也可能用到最粗的一级。空的返回 null。
 */
export function layerRegion(
  items: LayerItems,
  panels: readonly MeasuredPanel[],
  groups: readonly MeasuredGroup[],
  fills: readonly MeasuredFill[],
  viewport: ResolvedViewport,
  levels: number
): LayerRegion | null {
  let box: Box | null = null
  const add = (b: Box): void => {
    box = box
      ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) }
      : b
  }
  const fromScissor = (s: readonly [number, number, number, number]): Box => ({ x0: s[0], y0: s[1], x1: s[0] + s[2], y1: s[1] + s[3] })
  for (const i of items.panels) add(panels[i]!.bounds)
  for (const i of items.groups) add(fromScissor(groups[i]!.scissor))
  for (const i of items.fills) add(fromScissor(fills[i]!.scissor))
  if (!box) return null
  const b = box as Box

  const sw = viewport.sceneWidth
  const sh = viewport.sceneHeight
  const cw = viewport.compositeWidth
  const ch = viewport.compositeHeight
  const kx = sw / cw
  const ky = sh / ch
  const margin = Math.ceil(3 * sigmaForLevel(Math.max(1, levels - 1))) + 2
  const sx0 = Math.max(0, Math.floor(b.x0 * kx) - margin)
  const sy0 = Math.max(0, Math.floor(b.y0 * ky) - margin)
  const sx1 = Math.min(sw, Math.ceil(b.x1 * kx) + margin)
  const sy1 = Math.min(sh, Math.ceil(b.y1 * ky) + margin)
  if (sx1 <= sx0 || sy1 <= sy0) return null
  // 画布上要拷的那一块：盖住场景那一块的全部像素（重采样的双线性会读到边上一个像素）
  const cx0 = Math.max(0, Math.floor(sx0 / kx) - 1)
  const cy0 = Math.max(0, Math.floor(sy0 / ky) - 1)
  const cx1 = Math.min(cw, Math.ceil(sx1 / kx) + 1)
  const cy1 = Math.min(ch, Math.ceil(sy1 / ky) + 1)
  return {
    composite: [cx0, cy0, cx1 - cx0, cy1 - cy0],
    scene: [sx0, sy0, sx1 - sx0, sy1 - sy0]
  }
}

/**
 * 场景目标里的一块 → 模糊链第 level 级里要重建的那一块：按级缩小、往外扩 3 个纹素（5 抽头的核 ±2，
 * 再加双线性降采样读到的那一个），钳到这一级的尺寸里。
 */
export function levelRegion(
  scene: readonly [number, number, number, number],
  level: number,
  levelWidth: number,
  levelHeight: number
): [number, number, number, number] {
  const f = 2 ** level
  const x0 = Math.max(0, Math.floor(scene[0] / f) - 3)
  const y0 = Math.max(0, Math.floor(scene[1] / f) - 3)
  const x1 = Math.min(levelWidth, Math.ceil((scene[0] + scene[2]) / f) + 3)
  const y1 = Math.min(levelHeight, Math.ceil((scene[1] + scene[3]) / f) + 3)
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)]
}
