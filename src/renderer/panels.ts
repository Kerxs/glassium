/**
 * 面板注册表：DOM 元素 → 每帧的几何 → uniform。
 *
 * 面板是 DOM 元素，它负责占位、承载文字与子元素、接收点击和焦点；
 * Glassium 只负责把玻璃画在它后面的画布上。两边的对齐靠每帧量一次
 * `getBoundingClientRect()` —— 滚动、缩放、布局变化都自动跟上，不需要监听任何事件。
 */

import { lowerMaterial, type GlassMaterial } from '../core/material.ts'
import { MAX_GROUP_MEMBERS, mergeBleed } from '../core/merge.ts'
import type { EffectChain } from '../core/pipeline.ts'
import type { ResolvedViewport } from '../core/units.ts'
import { GROUP_STRIDE_FLOATS } from '../shaders/glass-group.wgsl.ts'
import {
  DEBUG_MODES,
  PANEL_STRIDE_FLOATS,
  PANEL_STRUCT_BYTES,
  type PanelDebugMode
} from '../shaders/glass.wgsl.ts'
import { levelForSigma } from './blur.ts'
import {
  UNBOUNDED,
  NO_CLIP,
  roundClipOf,
  findClipEntries,
  intersect,
  union,
  type Box,
  type ClipEntry
} from './clipping.ts'

export interface GlassPanel {
  readonly element: HTMLElement
  setMaterial(material: GlassMaterial): void
  /**
   * 按压处的光：Apple 玻璃的 interactive 反馈 —— 从按下的地方亮起来。null 关掉。
   * 这是交互状态，不是材质，所以单独一条路。`<glass-button>` 按下时自己调它。
   */
  setLight(light: PanelLight | null): void
  unregister(): void
}

/** 按压处的光。x、y 是相对面板元素左上角的 CSS 像素；strength 0–1。 */
export interface PanelLight {
  readonly x: number
  readonly y: number
  readonly strength: number
}

/** 光斑的高斯 σ 占面板短边的比例。 */
export const LIGHT_SIGMA_FRAC = 0.4
/** strength = 1 时光斑中心加上的亮度（0–1，加性）。 */
export const LIGHT_GAIN = 0.2

/**
 * 一组合并绘制的面板（`<glass-container>` 背后就是它）。
 *
 * 成员按**元素**指定，不按注册句柄：元素什么时候注册成面板、注册了几次、stage 换没换，
 * 都不影响分组 —— 每帧测量时才把元素解析成面板。还没注册的元素先忽略，注册之后自动加入。
 */
export interface GlassGroup {
  /** 成员元素，按顺序。前 4 个参与合并，其余单独绘制（并警告一次）。 */
  setMembers(elements: readonly HTMLElement[]): void
  /** smin 的平滑半径，dp。缝隙小于它的一半时两块玻璃连成一片。0 是硬并集。 */
  setSmoothing(dp: number): void
  /** 解散：成员回到各自单独绘制。 */
  dissolve(): void
}

/** 平滑半径的默认值，dp。并排两个按钮留 8dp 左右的缝时，默认就会连起来。 */
export const DEFAULT_SMOOTHING_DP = 20

interface GroupRecord {
  elements: readonly HTMLElement[]
  smoothingDp: number
  warnedOverflow: boolean
}

/** 一帧里量到的合并组。 */
export interface MeasuredGroup {
  readonly members: readonly MeasuredPanel[]
  /** smin 的 k，画布设备像素。 */
  readonly smoothingPx: number
  /** 成员并集外扩 k/4 再加抗锯齿余量，已与画布求交。 */
  readonly scissor: readonly [number, number, number, number]
}

export interface MeasureResult {
  /** 单独绘制的面板（不在任何组里、且至少有一部分在屏上）。 */
  readonly panels: readonly MeasuredPanel[]
  readonly groups: readonly MeasuredGroup[]
}

/** 一帧里量到的面板，已换算到画布设备像素。 */
export interface MeasuredPanel {
  readonly record: PanelRecord
  /** 画布设备像素下的矩形。 */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** 裁剪矩形（整数，已与画布、与裁剪祖先求交）。完全看不见的面板不会出现在列表里。 */
  readonly scissor: readonly [number, number, number, number]
  /** 裁剪祖先围出的可见区域，画布设备像素（没有裁剪的轴是 ±∞）。合并组要用它。 */
  readonly clip: Box
  /** 可见区域四角的圆角（TL, TR, BR, BL），画布设备像素。着色器按它把圆角外的玻璃抹掉。 */
  readonly clipRadii: readonly [number, number, number, number]
  /** 按压处的光：中心 x、y 与 σ（画布设备像素）、强度（已乘 LIGHT_GAIN）。没有光时强度为 0。 */
  readonly light: readonly [number, number, number, number]
  readonly chain: EffectChain
}

/**
 * 注册表级的材质变换（比如减少透明度）。
 *
 * key 从元素上读出影响结果的东西（比如文字是深是浅），只在样式可能变了之后才重读；key 没变就不重新
 * 降级 —— 降级结果还是同一个对象，「静止时不画」的比较（idle.ts）也就不受打扰。
 */
export interface MaterialFilter {
  key(element: HTMLElement): string
  apply(material: GlassMaterial, key: string): GlassMaterial
}

export interface PanelRecord {
  readonly element: HTMLElement
  material: GlassMaterial
  /** 按压处的光（见 GlassPanel.setLight）。 */
  light?: PanelLight | null
  /** 按 CSS 尺寸缓存的降级结果。尺寸或材质变了才重算。 */
  cached: { readonly w: number; readonly h: number; readonly chain: EffectChain } | null
  /** 缓存的裁剪祖先（要读计算样式，所以不每帧重找）。clipGeneration 过期时重找。 */
  clips?: readonly ClipEntry[]
  clipGeneration?: number
  /** 材质变换的 key 与读它时的样式代数（见 MaterialFilter）。 */
  filterKey?: string
  filterGeneration?: number
}

/**
 * 材质能不能降级。不能就在**调用处**抛。
 *
 * 不提前校验的话，写错的 tint 要等到帧循环里 lowerMaterial 才抛 —— 那里抛出的异常会让
 * 下一帧的 requestAnimationFrame 排不上，整个 stage 就此冻住，报错位置还离写错的地方很远。
 */
function assertLowerable(material: GlassMaterial): void {
  lowerMaterial(material, [100, 100])
}

/**
 * 元素是不是真的画出来了。
 *
 * `visibility: hidden` 与 `opacity: 0`（自身或任一祖先）的元素照样有盒子，
 * getBoundingClientRect 量得到 —— 不跳过的话，DOM 已经看不见了，玻璃还留在原地。
 * 渐隐收起的菜单就是这样。部分透明（0 < opacity < 1）玻璃跟不上，那由 layering.ts 警告。
 */
export function isRendered(element: HTMLElement): boolean {
  if (typeof element.checkVisibility !== 'function') return true
  return element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
}

/**
 * 裁剪边界落在分数像素上时取最近的整数像素。DOM 在那条边上是精确裁的，
 * 往外取整会漏出一条玻璃，往里取整会少一条，四舍五入两边各差不到半个像素。
 */
function roundBox(b: Box): Box {
  const r = (v: number): number => (Number.isFinite(v) ? Math.round(v) : v)
  return { x0: r(b.x0), y0: r(b.y0), x1: r(b.x1), y1: r(b.y1) }
}

/** 抗锯齿需要在面板矩形外多画的像素。sd 的覆盖率过渡宽 1px，留 2px 足够。 */
const AA_MARGIN_PX = 2

/**
 * 边缘高光的宽度，dp。
 *
 * 上游 Highlight 默认 0.5dp、再按宽度的一半模糊 —— 那基本就是抗锯齿那一个像素。
 * Apple 的高光是细线但肉眼能分辨，这里取 1.5dp。
 */
export const RIM_WIDTH_DP = 1.5

export class PanelRegistry {
  readonly #records: PanelRecord[] = []
  readonly #groups: GroupRecord[] = []
  readonly #onChange: () => void
  /** 样式代数：DOM 或样式每变一次加一，从样式读出来的缓存（裁剪祖先、材质变换的 key）据此过期。 */
  #styleGeneration = 0
  #filter: MaterialFilter | null = null

  constructor(onChange: () => void) {
    this.#onChange = onChange
  }

  get size(): number {
    return this.#records.length
  }

  register(element: HTMLElement, material: GlassMaterial): GlassPanel {
    assertLowerable(material)
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

  group(options: { readonly smoothing?: number } = {}): GlassGroup {
    const record: GroupRecord = {
      elements: [],
      smoothingDp: Math.max(options.smoothing ?? DEFAULT_SMOOTHING_DP, 0),
      warnedOverflow: false
    }
    this.#groups.push(record)
    this.#onChange()
    return {
      setMembers: (elements: readonly HTMLElement[]): void => {
        record.elements = [...elements]
        this.#onChange()
      },
      setSmoothing: (dp: number): void => {
        record.smoothingDp = Math.max(Number.isFinite(dp) ? dp : 0, 0)
        this.#onChange()
      },
      dissolve: (): void => {
        const i = this.#groups.indexOf(record)
        if (i >= 0) this.#groups.splice(i, 1)
        this.#onChange()
      }
    }
  }

  get groupCount(): number {
    return this.#groups.length
  }

  /**
   * DOM 或样式变了（stage 的 MutationObserver 调它）：从样式读出来的缓存作废 —— 裁剪祖先、
   * 材质变换的 key —— 下一帧重读。只是把代数加一，不在这里读任何样式：变化可能很频繁，
   * 重读推迟到真正要画的那一帧。
   */
  invalidateStyles(): void {
    this.#styleGeneration++
  }

  /** 换注册表级的材质变换（null 去掉）。所有面板下一帧重新降级。 */
  setMaterialFilter(filter: MaterialFilter | null): void {
    if (filter === this.#filter) return
    this.#filter = filter
    for (const record of this.#records) {
      record.cached = null
      delete record.filterKey
      delete record.filterGeneration
    }
    this.#onChange()
  }

  #handle(record: PanelRecord): GlassPanel {
    return {
      element: record.element,
      setMaterial: (material: GlassMaterial): void => {
        assertLowerable(material)
        record.material = material
        record.cached = null
        this.#onChange()
      },
      setLight: (light: PanelLight | null): void => {
        const next = light && light.strength > 0 ? light : null
        const prev = record.light ?? null
        if (next === prev) return
        if (next && prev && next.x === prev.x && next.y === prev.y && next.strength === prev.strength) return
        record.light = next
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
   * 量出本帧所有可见面板与合并组。
   *
   * **所有 getBoundingClientRect 在这里一次读完，帧内之后不再碰布局。**
   * 读写交错会触发强制同步布局（layout thrash），面板一多就是实打实的掉帧。
   */
  measure(viewport: ResolvedViewport, originX = 0, originY = 0): MeasureResult {
    // CSS px → 画布设备像素。用合成目标尺寸除以 CSS 尺寸，而不是直接乘 dpr ——
    // 画布的像素数是取整过的，差那一点在 DPR 1.5 这类非整数倍率下会累积成可见的错位。
    const sx = viewport.compositeWidth / viewport.cssWidth
    const sy = viewport.compositeHeight / viewport.cssHeight
    const W = viewport.compositeWidth
    const H = viewport.compositeHeight
    const clip = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => {
      const cx0 = Math.max(0, Math.floor(x0))
      const cy0 = Math.max(0, Math.floor(y0))
      const cx1 = Math.min(W, Math.ceil(x1))
      const cy1 = Math.min(H, Math.ceil(y1))
      return [cx0, cy0, Math.max(0, cx1 - cx0), Math.max(0, cy1 - cy0)]
    }

    // 裁剪祖先的矩形这一帧只量一次，多块面板共用同一个滚动容器时不重复量
    const clipRects = new Map<Element, DOMRect>()
    const toDevice = (b: Box): Box => ({
      x0: (b.x0 - originX) * sx,
      y0: (b.y0 - originY) * sy,
      x1: (b.x1 - originX) * sx,
      y1: (b.y1 - originY) * sy
    })

    // 1) 每块画出来了的面板都量一遍。屏外的也量 —— 它可能是某个组的成员，
    //    自己不在屏上，与邻居连起来的颈部却在。
    const measured = new Map<PanelRecord, MeasuredPanel>()
    for (const record of this.#records) {
      if (!record.element.isConnected) continue
      if (!isRendered(record.element)) continue
      const r = record.element.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue

      // 相对画布原点。inset:0 的画布原点通常就是 (0,0)，但宿主不是 body 时未必。
      const x = (r.left - originX) * sx
      const y = (r.top - originY) * sy
      const w = r.width * sx
      const h = r.height * sy

      // 材质变换的 key 只在样式可能变了之后重读；变了才让降级缓存作废
      const filter = this.#filter
      if (filter && record.filterGeneration !== this.#styleGeneration) {
        const key = filter.key(record.element)
        if (key !== record.filterKey) {
          record.filterKey = key
          record.cached = null
        }
        record.filterGeneration = this.#styleGeneration
      }

      // 降级按 CSS 尺寸缓存：材质的分数参数（refraction / distortion / 'frac' 圆角）
      // 是按短边算的，尺寸不变就不必重算。
      const cached = record.cached
      let chain: EffectChain
      if (cached && cached.w === r.width && cached.h === r.height) {
        chain = cached.chain
      } else {
        const material = filter ? filter.apply(record.material, record.filterKey ?? '') : record.material
        chain = lowerMaterial(material, [r.width, r.height])
        record.cached = { w: r.width, h: r.height, chain }
      }

      if (record.clips === undefined || record.clipGeneration !== this.#styleGeneration) {
        record.clips = findClipEntries(record.element)
        record.clipGeneration = this.#styleGeneration
      }
      const visible = record.clips.length > 0 ? roundClipOf(record.clips, clipRects) : NO_CLIP
      const clipBox = visible === NO_CLIP ? UNBOUNDED : toDevice(visible.box)
      const clipRadii = visible.radii.map((r) => r * sx) as [number, number, number, number]
      const own = intersect(
        { x0: x - AA_MARGIN_PX, y0: y - AA_MARGIN_PX, x1: x + w + AA_MARGIN_PX, y1: y + h + AA_MARGIN_PX },
        roundBox(clipBox)
      )
      const scissor = clip(own.x0, own.y0, own.x1, own.y1)
      const l = record.light
      const light: [number, number, number, number] = l
        ? [x + l.x * sx, y + l.y * sy, LIGHT_SIGMA_FRAC * Math.min(w, h), Math.min(1, Math.max(0, l.strength)) * LIGHT_GAIN]
        : [0, 0, 1, 0]
      measured.set(record, { record, x, y, w, h, scissor, clip: clipBox, clipRadii, light, chain })
    }

    // 2) 合并组。一块面板只能属于一个组（先到先得），一组最多 MAX_GROUP_MEMBERS 块。
    const grouped = new Set<PanelRecord>()
    const groups: MeasuredGroup[] = []
    if (this.#groups.length > 0) {
      const byElement = new Map<HTMLElement, PanelRecord>()
      for (const record of this.#records) byElement.set(record.element, record)
      for (const g of this.#groups) {
        const members: MeasuredPanel[] = []
        let overflow = 0
        for (const element of g.elements) {
          const record = byElement.get(element)
          const m = record ? measured.get(record) : undefined
          if (!record || !m || grouped.has(record)) continue
          if (members.length >= MAX_GROUP_MEMBERS) {
            overflow++
            continue
          }
          members.push(m)
          grouped.add(record)
        }
        if (overflow > 0 && !g.warnedOverflow) {
          g.warnedOverflow = true
          console.warn(
            `[Glassium] 一组最多合并 ${MAX_GROUP_MEMBERS} 块玻璃，这一组有 ${members.length + overflow} 块。` +
              `第 ${MAX_GROUP_MEMBERS + 1} 块起单独绘制，不参与合并。`
          )
        }
        if (members.length === 0) continue

        const k = g.smoothingDp * sx
        const bleed = mergeBleed(k) + AA_MARGIN_PX
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        // 成员各自的可见区域取并集：通常同在一个滚动容器里，那就是那个容器
        let visible: Box | null = null
        for (const m of members) {
          x0 = Math.min(x0, m.x)
          y0 = Math.min(y0, m.y)
          x1 = Math.max(x1, m.x + m.w)
          y1 = Math.max(y1, m.y + m.h)
          visible = visible ? union(visible, m.clip) : m.clip
        }
        const bounded = intersect(
          { x0: x0 - bleed, y0: y0 - bleed, x1: x1 + bleed, y1: y1 + bleed },
          roundBox(visible ?? UNBOUNDED)
        )
        const scissor = clip(bounded.x0, bounded.y0, bounded.x1, bounded.y1)
        if (scissor[2] === 0 || scissor[3] === 0) continue // 整组都在屏外
        groups.push({ members, smoothingPx: k, scissor })
      }
    }

    // 3) 单独绘制的面板：不在组里、且裁剪矩形不为空（完全在屏外的不占 draw call）
    const panels: MeasuredPanel[] = []
    for (const m of measured.values()) {
      if (grouped.has(m.record)) continue
      if (m.scissor[2] === 0 || m.scissor[3] === 0) continue
      panels.push(m)
    }
    return { panels, groups }
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
  writePanel(data, index * PANEL_STRIDE_FLOATS, panel, viewport, blurLevels, debugMode)
}

/** Panel 结构体占几个 float（144B / 4）。合并组里的成员按这个步长紧挨着排。 */
export const PANEL_STRUCT_FLOATS = PANEL_STRUCT_BYTES / 4

/**
 * 没有裁剪的方向写进 uniform 的值。不写 ±∞：着色器里 ∞ − ∞ 是 NaN。
 * 画布最大 16384 像素，±65536 离得足够远，f32 在这个量级上仍有 1/256 像素的精度。
 */
export const CLIP_UNBOUNDED_PX = 65536

/**
 * 把一个合并组写进 uniform 数组的第 index 个组槽位（每槽 768B）。
 *
 * 布局必须与 glass-group.wgsl.ts 的 `struct Group` 一致：16B 的头
 * （成员数、k、调试模式、空）之后是 4 个紧挨着的 Panel。
 */
export function packGroup(
  data: Float32Array,
  index: number,
  group: MeasuredGroup,
  viewport: ResolvedViewport,
  blurLevels: number,
  debugMode: PanelDebugMode
): void {
  const o = index * GROUP_STRIDE_FLOATS
  data[o + 0] = group.members.length
  data[o + 1] = group.smoothingPx
  data[o + 2] = DEBUG_MODES.indexOf(debugMode)
  data[o + 3] = 0
  for (let i = 0; i < MAX_GROUP_MEMBERS; i++) {
    const at = o + 4 + i * PANEL_STRUCT_FLOATS
    const member = group.members[i]
    if (member) writePanel(data, at, member, viewport, blurLevels, debugMode)
    else data.fill(0, at, at + PANEL_STRUCT_FLOATS) // 不用的槽位清零，免得留着上一帧别的组的数
  }
}

function writePanel(
  data: Float32Array,
  o: number,
  panel: MeasuredPanel,
  viewport: ResolvedViewport,
  blurLevels: number,
  debugMode: PanelDebugMode
): void {
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
  data[o + 22] = RIM_WIDTH_DP * scale
  data[o + 23] = 0
  // clip: vec4f @ 96 —— 可见区域 x0, y0, x1, y1
  const bound = (v: number): number => Math.max(-CLIP_UNBOUNDED_PX, Math.min(CLIP_UNBOUNDED_PX, v))
  data[o + 24] = bound(panel.clip.x0)
  data[o + 25] = bound(panel.clip.y0)
  data[o + 26] = bound(panel.clip.x1)
  data[o + 27] = bound(panel.clip.y1)
  // clipRadii: vec4f @ 112 —— TL, TR, BR, BL
  data[o + 28] = panel.clipRadii[0]
  data[o + 29] = panel.clipRadii[1]
  data[o + 30] = panel.clipRadii[2]
  data[o + 31] = panel.clipRadii[3]
  // light: vec4f @ 128 —— 中心 x、y，σ，强度
  data[o + 32] = panel.light[0]
  data[o + 33] = panel.light[1]
  data[o + 34] = panel.light[2]
  data[o + 35] = panel.light[3]
}
