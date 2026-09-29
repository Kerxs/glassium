/**
 * 场景检查器的数据：上一帧量到的东西（面板、合并组的成员、填充）换成 CSS 像素、带上材质与降级结果。
 * `stage.debug.scene()` 给它，调试面板的「场景」页用它列出来、点一行看材质。
 */

import type { GlassMaterial } from '../core/material.ts'
import type { EffectChain } from '../core/pipeline.ts'
import type { ResolvedViewport } from '../core/units.ts'
import type { MeasuredFill } from './fills.ts'
import type { FrameSnapshot } from './idle.ts'
import type { MeasuredPanel, PanelPresentation } from './panels.ts'
import type { QualityFactors } from './quality.ts'

/** 一块玻璃（单独画的面板，或者合并组里的一个成员）。 */
export interface InspectedGlass {
  readonly element: HTMLElement
  /** 在哪个合并组里（上一帧的下标）；单独画的是 null。 */
  readonly group: number | null
  /** 在第几层（0 直接在场景上）。 */
  readonly layer: number
  /** 画布上的矩形，CSS 像素 [x, y, w, h]（有旋转时是转之前的矩形）。 */
  readonly rect: readonly [number, number, number, number]
  /** 旋转的角度（度）。 */
  readonly rotationDeg: number
  /** 视觉缩放（transform: scale 与呈现变换）。 */
  readonly visualScale: number
  /** CSS 上的不透明度（自己与祖先的乘积）。 */
  readonly fade: number
  /** 注册时给的材质（交互调制之后的）。 */
  readonly material: GlassMaterial
  /** 降级出来的效果链（着色器实际用的数）。 */
  readonly chain: EffectChain
  /** 这一块用的质量系数（整页 × 自己的）。 */
  readonly quality: QualityFactors | null
  /** 这一块自己的质量系数（局部质量）；没有是 null。 */
  readonly localQuality: Partial<QualityFactors> | null
  /** 呈现变换（果冻、飞行）；没有是 null。 */
  readonly presentation: PanelPresentation | null
}

/** 一块填充。 */
export interface InspectedFill {
  readonly element: HTMLElement
  readonly layer: number
  readonly rect: readonly [number, number, number, number]
  readonly kind: 'color' | 'gradient' | 'bitmap'
  /** 纯色的颜色（0–1）；渐变、位图时只有 alpha 有意义。 */
  readonly color: readonly [number, number, number, number]
}

export interface SceneSnapshot {
  readonly glasses: readonly InspectedGlass[]
  readonly groups: number
  readonly fills: readonly InspectedFill[]
  /** 上一帧的视口（换算用）。 */
  readonly viewport: ResolvedViewport
}

/** 上一帧的快照 → 检查器的数据。没有画过（null）时是空的。 */
export function inspectFrame(frame: FrameSnapshot | null): SceneSnapshot | null {
  if (!frame) return null
  const v = frame.viewport
  const kx = v.cssWidth / v.compositeWidth
  const ky = v.cssHeight / v.compositeHeight
  const rect = (x: number, y: number, w: number, h: number): [number, number, number, number] => [x * kx, y * ky, w * kx, h * ky]
  const glass = (p: MeasuredPanel, group: number | null): InspectedGlass => {
    const r = p.record as MeasuredPanel['record'] & {
      localQuality?: Partial<QualityFactors> | null
      presentation?: PanelPresentation | null
    }
    return {
      element: p.record.element,
      group,
      layer: p.layer,
      rect: rect(p.x, p.y, p.w, p.h),
      rotationDeg: (Math.atan2(p.rotation[1], p.rotation[0]) * 180) / Math.PI,
      visualScale: p.visualScale,
      fade: p.fade,
      material: p.record.material,
      chain: p.chain,
      quality: p.quality ?? null,
      localQuality: r.localQuality ?? null,
      presentation: r.presentation ?? null
    }
  }
  const glasses: InspectedGlass[] = frame.panels.map((p) => glass(p, null))
  frame.groups.forEach((g, i) => {
    for (const m of g.members) glasses.push(glass(m, i))
  })
  const fills = frame.fills.map(
    (f: MeasuredFill): InspectedFill => ({
      element: f.record.element,
      layer: f.layer,
      rect: rect(f.x, f.y, f.w, f.h),
      kind: f.bitmap ? 'bitmap' : f.gradient ? 'gradient' : 'color',
      color: f.color
    })
  )
  return { glasses, groups: frame.groups.length, fills, viewport: v }
}
