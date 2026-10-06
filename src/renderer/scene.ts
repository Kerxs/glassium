/**
 * 场景：一帧里量到的东西收成的有类型、只读的结构 —— 渲染器的正式输入。
 *
 * **不是第二个真源。** DOM 是唯一真源：每帧 `PanelRegistry.measure()` 量出面板、合并组、填充，这里只把它们
 * 编成节点树、按层分好、标上与上一帧相比哪里变了。场景不能从外面改（没有修改接口），下一帧整个重建。
 *
 * - **节点**：面板、合并组、填充。按绘制顺序排（层号从小到大；同一层里先填充、再单独的面板、再合并组，
 *   组的后面紧跟它的成员）—— 与两个后端实际画的顺序相同。
 * - **父子**：最近的、这一帧也是节点的玻璃祖先（沿渲染树往上）；合并组的成员的父亲是组，组的父亲是第一个成员的
 *   玻璃祖先。父子只是结构：层号（决定像素的那个）在测量时就定了，按 MAX_GLASS_LAYER 封顶。
 * - **Z 序**（order）：第几个画的。合并组的成员与组一起画（一次 draw），order 与组相同。
 * - **脏标记**：与上一个画了的帧（stage 的 lastFrame）的场景逐项比，分 transform / layout / material / content 四类。
 *   四类的并集与原来「这一帧画出来会不会与上一帧相同」（idle.ts）逐项等价：拿不准就当作变了。
 *
 * 后端暂时还读三个扁平数组（`panels` / `groups` / `fills`），它们就是测量结果原样，场景是它们的视图。
 */

import type { Box, RoundedBox } from './clipping.ts'
import type { FillBitmap, FillHole, FillRecord, MeasuredFill } from './fills.ts'
import { splitLayers, type LayerItems } from './layers.ts'
import { sameMask } from './mask.ts'
import type { MeasureResult, MeasuredGroup, MeasuredPanel, PanelRecord } from './panels.ts'

/** 与上一帧相比哪里变了。 */
export interface SceneDirty {
  /** 位置、尺寸、旋转、视觉缩放。 */
  readonly transform: boolean
  /** 裁剪（scissor、裁剪祖先、圆角裁剪、遮罩）、层号；合并组还有成员的组成。 */
  readonly layout: boolean
  /** 降级结果、质量、按压的光、CSS 不透明度、文字深浅；填充的颜色、渐变、圆角；合并组的 smoothing。 */
  readonly material: boolean
  /** 位图填充的内容（图集里画过的次数、格子）与洞。面板与合并组没有这一类。 */
  readonly content: boolean
}

/** 什么都没变。共用一个对象：静止的帧不为脏标记分配。 */
export const CLEAN: SceneDirty = Object.freeze({ transform: false, layout: false, material: false, content: false })
/** 新出现的节点（上一帧没有）：全脏。 */
export const ALL_DIRTY: SceneDirty = Object.freeze({ transform: true, layout: true, material: true, content: true })

export function isClean(d: SceneDirty): boolean {
  return !(d.transform || d.layout || d.material || d.content)
}

interface NodeBase {
  /** 在 `Scene.nodes` 里的下标。 */
  readonly id: number
  /** 最近的玻璃祖先节点；没有是 null（根）。 */
  readonly parent: number | null
  /** 子节点，按 Z 序。 */
  readonly children: readonly number[]
  /** 第几层（见 panels.ts 的 MAX_GLASS_LAYER）。 */
  readonly layer: number
  /** Z 序：第几个画的（0 起）。合并组的成员与组相同。 */
  readonly order: number
  /** 画布设备像素下的轴对齐包围盒（填充、面板有旋转时是转过之后的；合并组是成员的并集，不含 smin 的外扩）。 */
  readonly worldRect: Box
  /** 裁剪祖先围出的可见区域，画布设备像素（没有裁剪的轴是 ±∞）。合并组是成员的并集。 */
  readonly clip: Box
  /** 实际的不透明度：面板是 CSS 不透明度（fade）；填充是颜色的 alpha（已乘 CSS 不透明度）；合并组是成员里最大的。 */
  readonly opacity: number
  /** 裁剪矩形不为空。合并组的成员可以在屏外（与邻居连起来的颈部在屏上）。 */
  readonly visible: boolean
  readonly dirty: SceneDirty
}

export interface PanelNode extends NodeBase {
  readonly kind: 'panel'
  readonly element: HTMLElement
  readonly panel: MeasuredPanel
  /** 所在合并组的节点；单独画的是 null。 */
  readonly group: number | null
}

export interface GroupNode extends NodeBase {
  readonly kind: 'group'
  readonly group: MeasuredGroup
  /** 成员节点，按合并的顺序。 */
  readonly members: readonly number[]
}

export interface FillNode extends NodeBase {
  readonly kind: 'fill'
  readonly element: HTMLElement
  readonly fill: MeasuredFill
}

export type SceneNode = PanelNode | GroupNode | FillNode

export interface Scene {
  /** 这个场景的编号（每建一个加一）。 */
  readonly serial: number
  /** 脏标记是相对哪个场景算的（它的 serial）；没有上一帧是 null。 */
  readonly base: number | null
  /** 与 base 那个场景相比，画出来可能不同：节点多了、少了、换了顺序，或者有节点脏了。没有 base 时为 true。 */
  readonly changed: boolean
  /** 全部节点，按绘制顺序。 */
  readonly nodes: readonly SceneNode[]
  /** 没有父亲的节点，按 Z 序。 */
  readonly roots: readonly number[]
  /** 按层分好（下标是扁平数组里的位置：uniform 按整帧的顺序打包），层号从小到大，只含有东西的层。 */
  readonly layers: readonly LayerItems[]
  /** 单独画的面板（测量结果原样）。 */
  readonly panels: readonly MeasuredPanel[]
  readonly groups: readonly MeasuredGroup[]
  readonly fills: readonly MeasuredFill[]
  /** 记录 → 节点：下一帧按它找「上一帧的同一块」。合并组按第一个成员的记录（一块面板只在一个组里）。 */
  readonly index: SceneIndex
}

export interface SceneIndex {
  readonly panels: ReadonlyMap<PanelRecord, number>
  readonly groups: ReadonlyMap<PanelRecord, number>
  readonly fills: ReadonlyMap<FillRecord, number>
}

let nextSerial = 0

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export function sameTuple(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function sameBox(a: Box, b: Box): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
}

export function sameRoundedBox(a: RoundedBox | null, b: RoundedBox | null): boolean {
  if (a === null || b === null) return a === b
  return sameBox(a.box, b.box) && sameTuple(a.rx, b.rx) && sameTuple(a.ry, b.ry)
}

function sameBitmap(a: FillBitmap | null | undefined, b: FillBitmap | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.version === b.version && sameTuple(a.geom, b.geom) && sameTuple(a.cell, b.cell)
}

function sameHole(a: FillHole | null | undefined, b: FillHole | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.alpha === b.alpha && sameRoundedBox(a.shape, b.shape)
}

function dirtyOf(transform: boolean, layout: boolean, material: boolean, content: boolean): SceneDirty {
  return transform || layout || material || content ? { transform, layout, material, content } : CLEAN
}

/** 同一块面板（同一个记录）两帧之间哪里变了。 */
export function panelDirty(a: MeasuredPanel, b: MeasuredPanel): SceneDirty {
  if (a.record !== b.record) return ALL_DIRTY
  return dirtyOf(
    a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || a.visualScale !== b.visualScale || !sameTuple(a.rotation, b.rotation),
    !sameTuple(a.scissor, b.scissor) ||
      !sameBox(a.clip, b.clip) ||
      !sameTuple(a.clipRadii, b.clipRadii) ||
      !sameTuple(a.clipRadiiY, b.clipRadiiY) ||
      !sameRoundedBox(a.clipShape, b.clipShape) ||
      !sameMask(a.mask, b.mask) ||
      a.layer !== b.layer,
    // 降级结果与质量系数按引用比：材质或尺寸变了会重新降级，换一个新对象
    a.chain !== b.chain || a.quality !== b.quality || !sameTuple(a.light, b.light) || a.fade !== b.fade || a.tone !== b.tone,
    false
  )
}

/** 同一块填充两帧之间哪里变了。 */
export function fillDirty(a: MeasuredFill, b: MeasuredFill): SceneDirty {
  if (a.record !== b.record) return ALL_DIRTY
  return dirtyOf(
    a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || !sameTuple(a.rotation, b.rotation),
    !sameTuple(a.scissor, b.scissor) ||
      !sameBox(a.clip, b.clip) ||
      !sameTuple(a.clipRadii, b.clipRadii) ||
      !sameTuple(a.clipRadiiY, b.clipRadiiY) ||
      !sameRoundedBox(a.clipShape, b.clipShape) ||
      !sameMask(a.mask, b.mask) ||
      a.layer !== b.layer,
    // 渐变按引用比：解算结果缓存在记录上，渐变与尺寸没变就是同一个对象
    !sameTuple(a.radii, b.radii) || !sameTuple(a.radiiY, b.radiiY) || !sameTuple(a.color, b.color) || a.gradient !== b.gradient,
    !sameBitmap(a.bitmap, b.bitmap) || !sameHole(a.hole, b.hole)
  )
}

/** 同一个合并组（第一个成员相同）两帧之间组自己哪里变了；成员各自的变化在成员节点上。 */
export function groupDirty(a: MeasuredGroup, b: MeasuredGroup): SceneDirty {
  let members = a.members.length === b.members.length
  for (let i = 0; members && i < a.members.length; i++) members = a.members[i]!.record === b.members[i]!.record
  return dirtyOf(
    !sameBox(unionBounds(a.members), unionBounds(b.members)),
    !members || !sameTuple(a.scissor, b.scissor) || a.layer !== b.layer,
    a.smoothingPx !== b.smoothingPx,
    false
  )
}

function unionBounds(members: readonly MeasuredPanel[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const m of members) {
    x0 = Math.min(x0, m.bounds.x0)
    y0 = Math.min(y0, m.bounds.y0)
    x1 = Math.max(x1, m.bounds.x1)
    y1 = Math.max(y1, m.bounds.y1)
  }
  return { x0, y0, x1, y1 }
}

function unionClip(members: readonly MeasuredPanel[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const m of members) {
    x0 = Math.min(x0, m.clip.x0)
    y0 = Math.min(y0, m.clip.y0)
    x1 = Math.max(x1, m.clip.x1)
    y1 = Math.max(y1, m.clip.y1)
  }
  return { x0, y0, x1, y1 }
}

/** 填充的包围盒：有旋转时是转过之后的矩形的轴对齐包围盒（绕矩形中心转）。 */
function fillBounds(f: MeasuredFill): Box {
  const [c, s] = f.rotation
  if (s === 0) return { x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h }
  const cx = f.x + f.w / 2
  const cy = f.y + f.h / 2
  const hw = (Math.abs(c) * f.w + Math.abs(s) * f.h) / 2
  const hh = (Math.abs(s) * f.w + Math.abs(c) * f.h) / 2
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }
}

const visibleScissor = (s: readonly [number, number, number, number]): boolean => s[2] > 0 && s[3] > 0

/** 两个场景的节点在结构上对得上吗：每种节点的记录序列（扁平数组里的顺序）逐个相同。 */
function sameStructure(prev: Scene, next: Scene): boolean {
  if (prev.panels.length !== next.panels.length || prev.groups.length !== next.groups.length || prev.fills.length !== next.fills.length) {
    return false
  }
  for (let i = 0; i < next.panels.length; i++) if (prev.panels[i]!.record !== next.panels[i]!.record) return false
  for (let i = 0; i < next.groups.length; i++) if (prev.groups[i]!.members[0]!.record !== next.groups[i]!.members[0]!.record) return false
  for (let i = 0; i < next.fills.length; i++) if (prev.fills[i]!.record !== next.fills[i]!.record) return false
  return true
}

/**
 * 把一帧的测量结果编成场景。prev 是上一个**画了的**帧的场景（脏标记相对它算）；没有就全脏。
 */
export function buildScene(measured: MeasureResult, prev: Scene | null): Scene {
  const { panels, groups, fills } = measured
  const glassParents = measured.glassParents
  const layers = splitLayers(panels, groups, fills)

  // 1) 节点，按绘制顺序；脏标记相对上一帧的同一块。节点就地建好（父子在第 2 步填），不另建草稿再拷
  const nodes: Mutable<SceneNode>[] = []
  const panelIds = new Map<PanelRecord, number>()
  const groupIds = new Map<PanelRecord, number>()
  const fillIds = new Map<FillRecord, number>()
  const prevNode = (id: number | undefined): SceneNode | undefined => (id === undefined ? undefined : prev!.nodes[id])
  const addPanel = (p: MeasuredPanel, order: number, group: number | null): number => {
    const before = prev ? prevNode(prev.index.panels.get(p.record)) : undefined
    const id = nodes.length
    nodes.push({
      id,
      kind: 'panel',
      parent: group,
      children: [],
      layer: p.layer,
      order,
      worldRect: p.bounds,
      clip: p.clip,
      opacity: p.fade,
      visible: visibleScissor(p.scissor),
      dirty: before?.kind === 'panel' ? panelDirty(before.panel, p) : ALL_DIRTY,
      element: p.record.element,
      panel: p,
      group
    })
    panelIds.set(p.record, id)
    return id
  }
  let order = 0
  for (const layer of layers) {
    for (const i of layer.fills) {
      const f = fills[i]!
      const before = prev ? prevNode(prev.index.fills.get(f.record)) : undefined
      const id = nodes.length
      nodes.push({
        id,
        kind: 'fill',
        parent: null,
        children: [],
        layer: f.layer,
        order: order++,
        worldRect: fillBounds(f),
        clip: f.clip,
        opacity: f.color[3],
        visible: visibleScissor(f.scissor),
        dirty: before?.kind === 'fill' ? fillDirty(before.fill, f) : ALL_DIRTY,
        element: f.record.element,
        fill: f
      })
      fillIds.set(f.record, id)
    }
    for (const i of layer.panels) addPanel(panels[i]!, order++, null)
    for (const i of layer.groups) {
      const g = groups[i]!
      const key = g.members[0]!.record
      const before = prev ? prevNode(prev.index.groups.get(key)) : undefined
      const id = nodes.length
      const own = order++
      let opacity = 0
      for (const m of g.members) opacity = Math.max(opacity, m.fade)
      const members: number[] = []
      nodes.push({
        id,
        kind: 'group',
        parent: null,
        children: members,
        layer: g.layer,
        order: own,
        worldRect: unionBounds(g.members),
        clip: unionClip(g.members),
        opacity,
        visible: visibleScissor(g.scissor),
        dirty: before?.kind === 'group' ? groupDirty(before.group, g) : ALL_DIRTY,
        group: g,
        members
      })
      groupIds.set(key, id)
      for (const m of g.members) members.push(addPanel(m, own, id))
    }
  }

  // 2) 父子：最近的、这一帧也是节点的玻璃祖先。祖先不是节点（屏外、单独没画）就接着往上找。
  //    没有玻璃祖先的帧（最常见）整段跳过
  const roots: number[] = []
  if (glassParents && glassParents.size > 0) {
    const nodeAbove = (record: PanelRecord | FillRecord): number | null => {
      let p = glassParents.get(record) ?? null
      for (let guard = 0; p && guard <= nodes.length; guard++) {
        const id = panelIds.get(p)
        if (id !== undefined) return id
        p = glassParents.get(p) ?? null
      }
      return null
    }
    for (const n of nodes) {
      if (n.kind === 'fill') n.parent = nodeAbove(n.fill.record)
      else if (n.kind === 'panel' && n.group === null) n.parent = nodeAbove(n.panel.record)
    }
    for (const n of nodes) {
      if (n.kind !== 'group') continue
      // 组的父亲：第一个成员的玻璃祖先。成员写在另一个成员里面这种怪情形会成环 —— 那就当作根
      let parent = nodeAbove(n.group.members[0]!.record)
      for (let p = parent, guard = 0; p !== null && guard <= nodes.length; p = nodes[p]!.parent, guard++) {
        if (p === n.id) {
          parent = null
          break
        }
      }
      n.parent = parent
    }
  }
  for (const n of nodes) {
    if (n.parent === null) roots.push(n.id)
    else if (nodes[n.parent]!.kind !== 'group') (nodes[n.parent]!.children as number[]).push(n.id) // 组的子节点就是成员，已经填好
  }

  let changed = prev === null
  for (let i = 0; !changed && i < nodes.length; i++) changed = !isClean(nodes[i]!.dirty)
  const scene: Scene = {
    serial: nextSerial++,
    base: prev ? prev.serial : null,
    changed,
    nodes,
    roots,
    layers,
    panels,
    groups,
    fills,
    index: { panels: panelIds, groups: groupIds, fills: fillIds }
  }
  if (!changed && !sameStructure(prev!, scene)) return { ...scene, changed: true }
  return scene
}

/**
 * next 画出来可能与 prev 不同吗（只看场景，帧级的视口、背景、时间在 idle.ts）。
 * next 正是相对 prev 建的：直接用建的时候算好的；否则现比一遍（同一套比较）。
 */
export function sceneChanged(prev: Scene | null, next: Scene): boolean {
  if (prev === null) return true
  if (next.base === prev.serial) return next.changed
  if (!sameStructure(prev, next)) return true
  for (let i = 0; i < next.panels.length; i++) if (!isClean(panelDirty(prev.panels[i]!, next.panels[i]!))) return true
  for (let i = 0; i < next.fills.length; i++) if (!isClean(fillDirty(prev.fills[i]!, next.fills[i]!))) return true
  for (let i = 0; i < next.groups.length; i++) {
    const a = prev.groups[i]!
    const b = next.groups[i]!
    if (!isClean(groupDirty(a, b))) return true
    for (let j = 0; j < b.members.length; j++) if (!isClean(panelDirty(a.members[j]!, b.members[j]!))) return true
  }
  return false
}
