/**
 * 面板注册表：DOM 元素 → 每帧的几何 → uniform。
 *
 * 面板是 DOM 元素，它负责占位、承载文字与子元素、接收点击和焦点；
 * Glassium 只负责把玻璃画在它后面的画布上。两边的对齐靠每帧量一次
 * `getBoundingClientRect()` —— 滚动、缩放、布局变化都自动跟上，不需要监听任何事件。
 */

import { lowerMaterial, type GlassMaterial } from '../core/material.ts'
import type { EffectChain } from '../core/pipeline.ts'
import type { ResolvedViewport } from '../core/units.ts'
import { DEBUG_MODES, PANEL_STRIDE_FLOATS, type PanelDebugMode } from '../shaders/glass.wgsl.ts'
import { levelForSigma } from './blur.ts'

export interface GlassPanel {
  readonly element: HTMLElement
  setMaterial(material: GlassMaterial): void
  unregister(): void
}

/** 一帧里量到的面板，已换算到画布设备像素。 */
export interface MeasuredPanel {
  readonly record: PanelRecord
  /** 画布设备像素下的矩形。 */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** 裁剪矩形（整数，已与画布求交）。完全在屏外的面板不会出现在列表里。 */
  readonly scissor: readonly [number, number, number, number]
  readonly chain: EffectChain
}

export interface PanelRecord {
  readonly element: HTMLElement
  material: GlassMaterial
  /** 按 CSS 尺寸缓存的降级结果。尺寸或材质变了才重算。 */
  cached: { readonly w: number; readonly h: number; readonly chain: EffectChain } | null
}

/** 抗锯齿需要在面板矩形外多画的像素。sd 的覆盖率过渡宽 1px，留 2px 足够。 */
const AA_MARGIN_PX = 2

export class PanelRegistry {
  readonly #records: PanelRecord[] = []
  readonly #onChange: () => void

  constructor(onChange: () => void) {
    this.#onChange = onChange
  }

  get size(): number {
    return this.#records.length
  }

  register(element: HTMLElement, material: GlassMaterial): GlassPanel {
    const existing = this.#records.find((r) => r.element === element)
    if (existing) {
      console.warn('[Glassium] 这个元素已经注册过了，更新材质而不是重复注册：', element)
      existing.material = material
      existing.cached = null
      this.#onChange()
      return this.#handle(existing)
    }
    const record: PanelRecord = { element, material, cached: null }
    this.#records.push(record)
    this.#onChange()
    return this.#handle(record)
  }

  #handle(record: PanelRecord): GlassPanel {
    return {
      element: record.element,
      setMaterial: (material: GlassMaterial): void => {
        record.material = material
        record.cached = null
        this.#onChange()
      },
      unregister: (): void => {
        const i = this.#records.indexOf(record)
        if (i >= 0) this.#records.splice(i, 1)
        this.#onChange()
      }
    }
  }

  /**
   * 量出本帧所有可见面板。
   *
   * **所有 getBoundingClientRect 在这里一次读完，帧内之后不再碰布局。**
   * 读写交错会触发强制同步布局（layout thrash），面板一多就是实打实的掉帧。
   */
  measure(viewport: ResolvedViewport, originX = 0, originY = 0): MeasuredPanel[] {
    // CSS px → 画布设备像素。用合成目标尺寸除以 CSS 尺寸，而不是直接乘 dpr ——
    // 画布的像素数是取整过的，差那一点在 DPR 1.5 这类非整数倍率下会累积成可见的错位。
    const sx = viewport.compositeWidth / viewport.cssWidth
    const sy = viewport.compositeHeight / viewport.cssHeight
    const W = viewport.compositeWidth
    const H = viewport.compositeHeight

    const out: MeasuredPanel[] = []
    for (const record of this.#records) {
      if (!record.element.isConnected) continue
      const r = record.element.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue

      // 相对画布原点。inset:0 的画布原点通常就是 (0,0)，但宿主不是 body 时未必。
      const x = (r.left - originX) * sx
      const y = (r.top - originY) * sy
      const w = r.width * sx
      const h = r.height * sy

      const x0 = Math.max(0, Math.floor(x - AA_MARGIN_PX))
      const y0 = Math.max(0, Math.floor(y - AA_MARGIN_PX))
      const x1 = Math.min(W, Math.ceil(x + w + AA_MARGIN_PX))
      const y1 = Math.min(H, Math.ceil(y + h + AA_MARGIN_PX))
      if (x1 <= x0 || y1 <= y0) continue // 完全在屏外

      // 降级按 CSS 尺寸缓存：材质的分数参数（refraction / distortion / 'frac' 圆角）
      // 是按短边算的，尺寸不变就不必重算。
      const cached = record.cached
      let chain: EffectChain
      if (cached && cached.w === r.width && cached.h === r.height) {
        chain = cached.chain
      } else {
        chain = lowerMaterial(record.material, [r.width, r.height])
        record.cached = { w: r.width, h: r.height, chain }
      }

      out.push({ record, x, y, w, h, scissor: [x0, y0, x1 - x0, y1 - y0], chain })
    }
    return out
  }
}

/**
 * 把一块面板写进 uniform 数组的第 index 个槽位（每槽 256B）。
 *
 * 字段顺序必须与 glass.wgsl.ts 的 `struct Panel` 逐一对应。这里写错一个偏移，
 * WebGPU 不会报任何错，你只会看到一块位置或形状微妙不对的玻璃 —— 所以两处的注释
 * 都写了字节偏移，改一处就去对另一处。
 */
export function packPanel(
  data: Float32Array,
  index: number,
  panel: MeasuredPanel,
  viewport: ResolvedViewport,
  blurLevels: number,
  debugMode: PanelDebugMode
): void {
  const o = index * PANEL_STRIDE_FLOATS
  // dp（= CSS px）→ 画布设备像素
  const scale = viewport.compositeWidth / viewport.cssWidth
  const chain = panel.chain

  let saturation = 1
  let tint: readonly [number, number, number, number] = [0, 0, 0, 0]
  let sigmaDp = 0
  let heightDp = 0
  let amountDp = 0
  let squircle = 2
  let depthEffect = 0
  let dispersion = 0
  let highlight = 0
  for (const e of chain.effects) {
    if (e.kind === 'colorFilter') {
      saturation = e.saturation
      tint = e.tint
    } else if (e.kind === 'blur') {
      sigmaDp = e.sigmaDp
    } else {
      heightDp = e.heightDp
      amountDp = e.amountDp
      squircle = e.squircle
      depthEffect = e.depthEffect
      dispersion = e.dispersion
      highlight = e.highlight
    }
  }

  // rect: vec4f @ 0
  data[o + 0] = panel.x
  data[o + 1] = panel.y
  data[o + 2] = panel.w
  data[o + 3] = panel.h
  // radii: vec4f @ 16
  data[o + 4] = chain.cornerRadiiDp[0] * scale
  data[o + 5] = chain.cornerRadiiDp[1] * scale
  data[o + 6] = chain.cornerRadiiDp[2] * scale
  data[o + 7] = chain.cornerRadiiDp[3] * scale
  // tint: vec4f @ 32
  data[o + 8] = tint[0]
  data[o + 9] = tint[1]
  data[o + 10] = tint[2]
  data[o + 11] = tint[3]
  // 标量 @ 48 起
  data[o + 12] = heightDp * scale
  data[o + 13] = amountDp * scale
  // 模糊 σ 以**场景像素**计：模糊链的第 0 级就是场景分辨率，不是画布分辨率。
  data[o + 14] = levelForSigma(sigmaDp * viewport.sceneScale, blurLevels)
  data[o + 15] = saturation
  data[o + 16] = squircle
  data[o + 17] = depthEffect
  data[o + 18] = dispersion
  data[o + 19] = highlight
  data[o + 20] = chain.opacity
  data[o + 21] = DEBUG_MODES.indexOf(debugMode)
  data[o + 22] = 0
  data[o + 23] = 0
}
