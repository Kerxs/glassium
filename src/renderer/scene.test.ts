import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveViewport } from '../core/units.ts'
import type { RoundedBox } from './clipping.ts'
import type { FillBitmap, FillHole, FillRecord, MeasuredFill } from './fills.ts'
import { splitLayers } from './layers.ts'
import { sameMask, type DeviceMask } from './mask.ts'
import { PanelRegistry, type MeasureResult, type MeasuredGroup, type MeasuredPanel, type PanelRecord } from './panels.ts'
import { ALL_DIRTY, CLEAN, buildScene, sceneChanged, type PanelNode, type Scene, type SceneNode } from './scene.ts'

/* ------------------------------------------------------------------ *
 * 与旧的扁平比较逐项等价
 *
 * 1.0 的 idle.ts 直接比三个扁平数组（samePanels / sameGroups / sameFills）。场景把它们换成脏标记之后，
 * 「这一帧画出来会不会与上一帧不同」必须一个结论都不变 —— 多画是浪费，少画是错。下面是 1.0 那份比较的原样拷贝，
 * 作为对照；随机生成的帧逐个改一项，两边的结论必须相同。
 * ------------------------------------------------------------------ */

function sameTuple(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
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
function oldSamePanel(a: MeasuredPanel, b: MeasuredPanel): boolean {
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
function oldSamePanels(a: readonly MeasuredPanel[], b: readonly MeasuredPanel[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!oldSamePanel(a[i]!, b[i]!)) return false
  return true
}
function oldSameGroups(a: readonly MeasuredGroup[], b: readonly MeasuredGroup[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const g = a[i]!
    const h = b[i]!
    if (g.smoothingPx !== h.smoothingPx || g.layer !== h.layer || !sameTuple(g.scissor, h.scissor) || !oldSamePanels(g.members, h.members)) {
      return false
    }
  }
  return true
}
function oldSameBitmap(a: FillBitmap | null | undefined, b: FillBitmap | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.version === b.version && sameTuple(a.geom, b.geom) && sameTuple(a.cell, b.cell)
}
function oldSameHole(a: FillHole | null | undefined, b: FillHole | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.alpha === b.alpha && sameRoundedBox(a.shape, b.shape)
}
function oldSameFill(a: MeasuredFill, b: MeasuredFill): boolean {
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
    oldSameBitmap(a.bitmap, b.bitmap) &&
    oldSameHole(a.hole, b.hole) &&
    a.layer === b.layer
  )
}
function oldSameFills(a: readonly MeasuredFill[], b: readonly MeasuredFill[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!oldSameFill(a[i]!, b[i]!)) return false
  return true
}
const oldSame = (a: MeasureResult, b: MeasureResult): boolean =>
  oldSamePanels(a.panels, b.panels) && oldSameGroups(a.groups, b.groups) && oldSameFills(a.fills, b.fills)

/* ---------------- 假的测量结果（只比较值与引用，不碰 DOM） ---------------- */

const UNBOUNDED = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity }
const panelRecord = (): PanelRecord => ({ element: {} }) as unknown as PanelRecord
const fillRecord = (): FillRecord => ({ element: {} }) as unknown as FillRecord
const chain = { effects: [], paddingDp: 0 } as unknown as MeasuredPanel['chain']
const quality = { resolution: 1 } as unknown as NonNullable<MeasuredPanel['quality']>
const gradient = { kind: 'linear', repeating: false, geometry: [0, 0, 10, 0], colors: [[1, 0, 0, 1], [0, 0, 1, 1]], offsets: [0, 1] } as unknown as NonNullable<MeasuredFill['gradient']>
const mask: DeviceMask = { kind: 'linear', repeating: false, geometry: [0, 0, 0, 100], alphas: [1, 0], offsets: [0, 1] }
const shape: RoundedBox = { box: { x0: 0, y0: 0, x1: 80, y1: 80 }, rx: [40, 40, 40, 40], ry: [40, 40, 40, 40] }

const panel = (x: number, over: Partial<MeasuredPanel> = {}): MeasuredPanel => ({
  record: panelRecord(),
  x,
  y: 20,
  w: 100,
  h: 50,
  scissor: [x - 2, 18, 104, 54],
  clip: UNBOUNDED,
  clipRadii: [0, 0, 0, 0],
  clipRadiiY: [0, 0, 0, 0],
  clipShape: null,
  mask: null,
  light: [0, 0, 1, 0],
  fade: 1,
  tone: 1,
  visualScale: 1,
  rotation: [1, 0],
  bounds: { x0: x, y0: 20, x1: x + 100, y1: 70 },
  chain,
  layer: 0,
  ...over
})

const fill = (x: number, over: Partial<MeasuredFill> = {}): MeasuredFill => ({
  record: fillRecord(),
  x,
  y: 60,
  w: 51,
  h: 31,
  rotation: [1, 0],
  scissor: [x - 2, 58, 55, 35],
  clip: UNBOUNDED,
  clipRadii: [0, 0, 0, 0],
  clipRadiiY: [0, 0, 0, 0],
  clipShape: null,
  mask: null,
  radii: [15.5, 15.5, 15.5, 15.5],
  radiiY: [15.5, 15.5, 15.5, 15.5],
  color: [0.2, 0.78, 0.35, 1],
  gradient: null,
  layer: 0,
  ...over
})

const group = (members: MeasuredPanel[], over: Partial<MeasuredGroup> = {}): MeasuredGroup => ({
  members,
  smoothingPx: 30,
  scissor: [0, 0, 400, 100],
  layer: Math.max(...members.map((m) => m.layer)),
  ...over
})

/** 每帧重新量出来的：值相同、对象全新（元组也是新的）。记录、降级结果、渐变保持同一个引用 —— 与 measure() 相同。 */
function remeasure(m: MeasureResult): MeasureResult {
  const p = (x: MeasuredPanel): MeasuredPanel => ({
    ...x,
    scissor: [...x.scissor] as never,
    clip: { ...x.clip },
    clipRadii: [...x.clipRadii] as never,
    clipRadiiY: [...x.clipRadiiY] as never,
    clipShape: x.clipShape && { box: { ...x.clipShape.box }, rx: [...x.clipShape.rx] as never, ry: [...x.clipShape.ry] as never },
    mask: x.mask && { ...x.mask, geometry: [...x.mask.geometry] as never, alphas: [...x.mask.alphas], offsets: [...x.mask.offsets] },
    light: [...x.light] as never,
    rotation: [...x.rotation] as never,
    bounds: { ...x.bounds }
  })
  const f = (x: MeasuredFill): MeasuredFill => ({
    ...x,
    rotation: [...x.rotation] as never,
    scissor: [...x.scissor] as never,
    clip: { ...x.clip },
    radii: [...x.radii] as never,
    radiiY: [...x.radiiY] as never,
    color: [...x.color] as never,
    bitmap: x.bitmap && { ...x.bitmap, geom: [...x.bitmap.geom] as never, cell: [...x.bitmap.cell] as never },
    hole: x.hole && { ...x.hole, shape: { ...x.hole.shape, box: { ...x.hole.shape.box } } }
  }) as MeasuredFill
  const out: { -readonly [K in keyof MeasureResult]: MeasureResult[K] } = {
    panels: m.panels.map(p),
    groups: m.groups.map((g) => ({ ...g, scissor: [...g.scissor] as never, members: g.members.map(p) })),
    fills: m.fills.map(f)
  }
  if (m.glassParents) out.glassParents = m.glassParents
  return out
}

/** 可复现的伪随机（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomFrame(r: () => number): MeasureResult {
  const n = 1 + Math.floor(r() * 4)
  const panels = Array.from({ length: n }, (_, i) => panel(i * 120, { layer: Math.floor(r() * 3), tone: r() < 0.5 ? 1 : -1 }))
  const groups =
    r() < 0.7 ? [group([panel(600, { layer: Math.floor(r() * 2) }), panel(720), ...(r() < 0.5 ? [panel(840, { layer: 1 })] : [])])] : []
  const fills = Array.from({ length: Math.floor(r() * 4) }, (_, i) =>
    fill(i * 70, {
      layer: Math.floor(r() * 2),
      ...(r() < 0.3 ? { gradient } : {}),
      ...(r() < 0.3 ? { bitmap: { version: 1, geom: [0.1, 0.2, 0.001, 0.001], cell: [0.1, 0.2, 0.3, 0.25] } } : {}),
      ...(r() < 0.2 ? { hole: { shape, alpha: 0.5 } } : {})
    })
  )
  return { panels, groups, fills }
}

type Mutation = (m: MeasureResult, r: () => number) => MeasureResult
const pick = <T>(list: readonly T[], r: () => number): number => Math.floor(r() * list.length)
const editPanel =
  (over: (p: MeasuredPanel) => Partial<MeasuredPanel>): Mutation =>
  (m, r) => {
    if (m.panels.length === 0) return m
    const i = pick(m.panels, r)
    return { ...m, panels: m.panels.map((p, j) => (j === i ? { ...p, ...over(p) } : p)) }
  }
const editFill =
  (over: (f: MeasuredFill) => Partial<MeasuredFill>): Mutation =>
  (m, r) => {
    if (m.fills.length === 0) return m
    const i = pick(m.fills, r)
    return { ...m, fills: m.fills.map((f, j) => (j === i ? { ...f, ...over(f) } : f)) }
  }
const editGroup =
  (over: (g: MeasuredGroup, r: () => number) => Partial<MeasuredGroup>): Mutation =>
  (m, r) => (m.groups.length === 0 ? m : { ...m, groups: m.groups.map((g, j) => (j === 0 ? { ...g, ...over(g, r) } : g)) })
const editMember = (over: (p: MeasuredPanel) => Partial<MeasuredPanel>): Mutation =>
  editGroup((g, r) => {
    const i = pick(g.members, r)
    return { members: g.members.map((p, j) => (j === i ? { ...p, ...over(p) } : p)) }
  })

const MUTATIONS: Record<string, Mutation> = {
  无: (m) => m,
  面板x: editPanel((p) => ({ x: p.x + 0.5 })),
  面板y: editPanel((p) => ({ y: p.y + 1 })),
  面板w: editPanel((p) => ({ w: p.w - 1 })),
  面板h: editPanel((p) => ({ h: p.h + 1 })),
  面板缩放: editPanel(() => ({ visualScale: 0.9 })),
  面板旋转: editPanel(() => ({ rotation: [0.9, 0.1] })),
  面板scissor: editPanel((p) => ({ scissor: [p.scissor[0], p.scissor[1], p.scissor[2] - 1, p.scissor[3]] })),
  面板clip: editPanel(() => ({ clip: { ...UNBOUNDED, x0: 0 } })),
  面板圆角裁剪: editPanel(() => ({ clipRadii: [0, 12, 0, 0] })),
  面板椭圆裁剪: editPanel(() => ({ clipRadiiY: [0, 12, 0, 0] })),
  面板形状: editPanel((p) => ({ clipShape: p.clipShape ? null : shape })),
  面板遮罩: editPanel((p) => ({ mask: p.mask ? null : mask })),
  面板光: editPanel(() => ({ light: [30, 40, 20, 0.2] })),
  面板淡: editPanel(() => ({ fade: 0.5 })),
  面板文字: editPanel((p) => ({ tone: -p.tone })),
  面板层: editPanel((p) => ({ layer: p.layer + 1 })),
  面板降级: editPanel(() => ({ chain: { ...chain } })),
  面板质量: editPanel(() => ({ quality })),
  面板包围盒只变: editPanel((p) => ({ bounds: { ...p.bounds } })),
  换一块面板: editPanel(() => ({ record: panelRecord() })),
  少一块面板: (m, r) => (m.panels.length === 0 ? m : { ...m, panels: m.panels.filter((_, j) => j !== pick(m.panels, r)) }),
  多一块面板: (m) => ({ ...m, panels: [...m.panels, panel(999)] }),
  面板换顺序: (m) => (m.panels.length < 2 ? m : { ...m, panels: [m.panels[1]!, m.panels[0]!, ...m.panels.slice(2)] }),
  组smoothing: editGroup(() => ({ smoothingPx: 0 })),
  组scissor: editGroup((g) => ({ scissor: [g.scissor[0] + 1, g.scissor[1], g.scissor[2], g.scissor[3]] })),
  组层: editGroup((g) => ({ layer: g.layer + 1 })),
  成员动: editMember((p) => ({ x: p.x + 1 })),
  成员淡: editMember(() => ({ fade: 0.3 })),
  成员换顺序: editGroup((g) => ({ members: [g.members[1]!, g.members[0]!, ...g.members.slice(2)] })),
  成员少一块: editGroup((g) => ({ members: g.members.slice(0, -1) })),
  成员换一块: editMember(() => ({ record: panelRecord() })),
  少一组: (m) => ({ ...m, groups: [] }),
  填充x: editFill((f) => ({ x: f.x + 1 })),
  填充w: editFill((f) => ({ w: f.w + 1 })),
  填充旋转: editFill(() => ({ rotation: [0.9, 0.1] })),
  填充scissor: editFill((f) => ({ scissor: [f.scissor[0], f.scissor[1], f.scissor[2], f.scissor[3] + 1] })),
  填充clip: editFill(() => ({ clip: { ...UNBOUNDED, y1: 500 } })),
  填充遮罩: editFill((f) => ({ mask: f.mask ? null : mask })),
  填充形状: editFill((f) => ({ clipShape: f.clipShape ? null : shape })),
  填充圆角: editFill(() => ({ radii: [8, 8, 8, 8] })),
  填充椭圆角: editFill(() => ({ radiiY: [8, 8, 8, 8] })),
  填充颜色: editFill((f) => ({ color: [f.color[0], f.color[1], f.color[2], 0.9] })),
  填充渐变: editFill((f) => ({ gradient: f.gradient ? { ...f.gradient } : gradient })),
  填充位图重画: editFill((f) => ({ bitmap: f.bitmap ? { ...f.bitmap, version: f.bitmap.version + 1 } : { version: 1, geom: [0, 0, 1, 1], cell: [0, 0, 1, 1] } })),
  填充洞: editFill((f) => ({ hole: f.hole ? { ...f.hole, alpha: f.hole.alpha / 2 } : { shape, alpha: 1 } })),
  填充层: editFill((f) => ({ layer: f.layer + 1 })),
  换一块填充: editFill(() => ({ record: fillRecord() })),
  少一块填充: (m) => ({ ...m, fills: m.fills.slice(1) }),
  填充换顺序: (m) => (m.fills.length < 2 ? m : { ...m, fills: [m.fills[1]!, m.fills[0]!, ...m.fills.slice(2)] })
}

test('与 1.0 的扁平比较逐项等价：随机帧逐个改一项，「画不画」的结论一个都不变（相对上一帧建的与现比的都是）', () => {
  const r = rng(20261006)
  let compared = 0
  let changed = 0
  for (let round = 0; round < 60; round++) {
    const base = randomFrame(r)
    const before = buildScene(base, null)
    for (const [name, mutate] of Object.entries(MUTATIONS)) {
      const next = remeasure(mutate(base, r))
      const expected = !oldSame(base, next)
      const after = buildScene(next, before)
      assert.equal(after.base, before.serial)
      assert.equal(after.changed, expected, `第 ${round} 轮「${name}」：建的时候算的`)
      assert.equal(sceneChanged(before, after), expected, `第 ${round} 轮「${name}」：sceneChanged`)
      assert.equal(sceneChanged(before, buildScene(next, null)), expected, `第 ${round} 轮「${name}」：现比`)
      compared++
      if (expected) changed++
    }
  }
  assert.ok(changed > compared / 2 && changed < compared, `两种结论都要覆盖到（${changed} / ${compared}）`)
})

test('扁平数组是测量结果原样；层与 splitLayers 逐项相同', () => {
  const r = rng(7)
  for (let i = 0; i < 30; i++) {
    const m = randomFrame(r)
    const s = buildScene(m, null)
    assert.equal(s.panels, m.panels)
    assert.equal(s.groups, m.groups)
    assert.equal(s.fills, m.fills)
    assert.deepEqual(s.layers, splitLayers(m.panels, m.groups, m.fills))
    // 每一样东西恰好一个节点：单独的面板、组、组的成员、填充
    const members = m.groups.reduce((n, g) => n + g.members.length, 0)
    assert.equal(s.nodes.length, m.panels.length + m.groups.length + members + m.fills.length)
    s.nodes.forEach((n, id) => assert.equal(n.id, id))
  }
})

test('Z 序：层号从小到大；同一层先填充、再单独的面板、再合并组；成员紧跟组、与组同一个 order', () => {
  const a = panel(0, { layer: 1 })
  const b = panel(120)
  const m1 = panel(300)
  const m2 = panel(420)
  const f0 = fill(0)
  const f1 = fill(70, { layer: 1 })
  const s = buildScene({ panels: [a, b], groups: [group([m1, m2])], fills: [f0, f1] }, null)
  const what = (n: SceneNode): unknown => (n.kind === 'panel' ? n.panel : n.kind === 'fill' ? n.fill : n.group)
  assert.deepEqual(
    s.nodes.map((n) => [n.kind, n.layer, n.order]),
    [
      ['fill', 0, 0],
      ['panel', 0, 1],
      ['group', 0, 2],
      ['panel', 0, 2],
      ['panel', 0, 2],
      ['fill', 1, 3],
      ['panel', 1, 4]
    ]
  )
  assert.deepEqual(s.nodes.map(what), [f0, b, s.groups[0], m1, m2, f1, a])
  const g = s.nodes[2]!
  assert.ok(g.kind === 'group')
  assert.deepEqual(g.members, [3, 4])
  assert.deepEqual(g.children, [3, 4])
  assert.equal((s.nodes[3] as PanelNode).group, 2)
  assert.equal((s.nodes[1] as PanelNode).group, null)
})

test('节点的几何：包围盒（填充转过之后）、裁剪、不透明度、可见', () => {
  const rotated = fill(100, { w: 100, h: 20, rotation: [0, 1] }) // 转 90°：中心 (150, 70)，包围盒 20×100
  const offscreenMember = panel(500, { scissor: [0, 0, 0, 0], fade: 0.25, clip: { x0: 0, y0: 0, x1: 900, y1: 600 } })
  const member = panel(380, { fade: 0.75, clip: { x0: 10, y0: -5, x1: 800, y1: 700 } })
  const s = buildScene({ panels: [], groups: [group([member, offscreenMember])], fills: [rotated, fill(0, { color: [1, 0, 0, 0.4] })] }, null)
  const [f, f2, g, m1, m2] = s.nodes
  assert.deepEqual(f!.worldRect, { x0: 140, y0: 20, x1: 160, y1: 120 })
  assert.equal(f2!.opacity, 0.4, '填充的不透明度是颜色的 alpha（已乘 CSS 不透明度）')
  assert.deepEqual(g!.worldRect, { x0: 380, y0: 20, x1: 600, y1: 70 }, '组：成员包围盒的并集')
  assert.deepEqual(g!.clip, { x0: 0, y0: -5, x1: 900, y1: 700 }, '组：成员可见区域的并集')
  assert.equal(g!.opacity, 0.75)
  assert.equal(m1!.visible, true)
  assert.equal(m2!.visible, false, '在屏外的成员（与邻居连起来的颈部在屏上）')
})

test('脏标记：新出现的全脏；值相同的新一帧全不脏；每一项落在对应的那一类', () => {
  const p = panel(0)
  const f = fill(0, { bitmap: { version: 1, geom: [0, 0, 1, 1], cell: [0, 0, 1, 1] } })
  const g = group([panel(300), panel(420), panel(540)])
  const first: MeasureResult = { panels: [p], groups: [g], fills: [f] }
  const s0 = buildScene(first, null)
  assert.equal(s0.base, null)
  assert.equal(s0.changed, true)
  for (const n of s0.nodes) assert.equal(n.dirty, ALL_DIRTY)

  const s1 = buildScene(remeasure(first), s0)
  assert.equal(s1.changed, false)
  for (const n of s1.nodes) assert.equal(n.dirty, CLEAN, '静止的帧不为脏标记分配')

  const dirtyOf = (m: MeasureResult, kind: SceneNode['kind']): string[] => {
    const n = buildScene(m, s1).nodes.find((x) => x.kind === kind && !(x.kind === 'panel' && x.group !== null))!
    return Object.entries(n.dirty)
      .filter(([, v]) => v)
      .map(([k]) => k)
  }
  const withPanel = (over: Partial<MeasuredPanel>): MeasureResult => ({ ...remeasure(first), panels: [{ ...p, ...over }] })
  const withFill = (over: Partial<MeasuredFill>): MeasureResult => ({ ...remeasure(first), fills: [{ ...f, ...over }] })
  const withGroup = (over: Partial<MeasuredGroup>): MeasureResult => ({ ...remeasure(first), groups: [{ ...g, ...over }] })
  assert.deepEqual(dirtyOf(withPanel({ x: 3 }), 'panel'), ['transform'])
  assert.deepEqual(dirtyOf(withPanel({ rotation: [0, 1] }), 'panel'), ['transform'])
  assert.deepEqual(dirtyOf(withPanel({ visualScale: 2 }), 'panel'), ['transform'])
  assert.deepEqual(dirtyOf(withPanel({ scissor: [0, 0, 1, 1] }), 'panel'), ['layout'])
  assert.deepEqual(dirtyOf(withPanel({ mask }), 'panel'), ['layout'])
  assert.deepEqual(dirtyOf(withPanel({ layer: 1 }), 'panel'), ['layout'])
  assert.deepEqual(dirtyOf(withPanel({ chain: { ...chain } }), 'panel'), ['material'])
  assert.deepEqual(dirtyOf(withPanel({ fade: 0.5 }), 'panel'), ['material'])
  assert.deepEqual(dirtyOf(withPanel({ light: [1, 2, 3, 0.5] }), 'panel'), ['material'])
  assert.deepEqual(dirtyOf(withPanel({ x: 1, fade: 0.5 }), 'panel'), ['transform', 'material'])
  assert.deepEqual(dirtyOf(withFill({ y: 1 }), 'fill'), ['transform'])
  assert.deepEqual(dirtyOf(withFill({ clipShape: shape }), 'fill'), ['layout'])
  assert.deepEqual(dirtyOf(withFill({ color: [1, 1, 1, 1] }), 'fill'), ['material'])
  assert.deepEqual(dirtyOf(withFill({ radii: [1, 1, 1, 1] }), 'fill'), ['material'])
  assert.deepEqual(dirtyOf(withFill({ bitmap: { ...f.bitmap!, version: 2 } }), 'fill'), ['content'])
  assert.deepEqual(dirtyOf(withFill({ hole: { shape, alpha: 1 } }), 'fill'), ['content'])
  assert.deepEqual(dirtyOf(withGroup({ smoothingPx: 1 }), 'group'), ['material'])
  assert.deepEqual(dirtyOf(withGroup({ scissor: [1, 1, 1, 1] }), 'group'), ['layout'])
  const [m0, m1, m2] = g.members as [MeasuredPanel, MeasuredPanel, MeasuredPanel]
  assert.deepEqual(dirtyOf(withGroup({ members: [m0, m2, m1] }), 'group'), ['layout'], '成员换了顺序')
  assert.deepEqual(dirtyOf(withGroup({ members: [m0, m1, { ...m2, x: 900, bounds: { ...m2.bounds, x0: 900, x1: 1000 } }] }), 'group'), ['transform'], '成员动了：组的范围也变了')
  assert.deepEqual(dirtyOf(withGroup({ members: [m1, m0, m2] }), 'group'), ['transform', 'layout', 'material', 'content'], '组按第一个成员认：换了第一个就是新的组')
})

/* ---------------- 父子：从真的 measure() 来 ---------------- */

function fakeElement(left: number, parent: HTMLElement | null = null, top = 100): HTMLElement {
  return {
    isConnected: true,
    parentElement: parent,
    getBoundingClientRect: () => ({ left, top, width: 60, height: 40, right: left + 60, bottom: top + 40, x: left, y: top, toJSON: () => ({}) })
  } as unknown as HTMLElement
}

const registry = (): PanelRegistry =>
  new PanelRegistry(() => {}, {
    readFillStyle: () => ({ color: 'rgb(0, 128, 0)', currentColor: 'rgb(0, 0, 0)', radii: ['0px', '0px', '0px', '0px'] })
  })

test('父子：最近的、也是节点的玻璃祖先；隔着普通元素也算；祖先在屏外就接着往上找；根按 Z 序', () => {
  const viewport = resolveViewport(800, 600, 1)
  const reg = registry()
  const card = fakeElement(10)
  const wrapper = fakeElement(20, card) // 普通元素
  const hidden = fakeElement(-500, wrapper) // 玻璃，但在屏外：不是节点
  const button = fakeElement(30, hidden)
  const knob = fakeElement(40, button)
  const track = fakeElement(70, wrapper) // 卡片里的填充
  const loose = fakeElement(80) // 场景里的填充
  for (const el of [card, hidden, button, knob]) reg.register(el, {})
  reg.registerFill(track)
  reg.registerFill(loose)
  const s = buildScene(reg.measure(viewport), null)
  const id = (el: HTMLElement): number => s.nodes.findIndex((n) => n.kind !== 'group' && n.element === el)
  assert.equal(id(hidden), -1, '屏外的面板不是节点')
  assert.equal(s.nodes[id(card)]!.parent, null)
  assert.equal(s.nodes[id(loose)]!.parent, null)
  assert.equal(s.nodes[id(track)]!.parent, id(card), '隔着普通元素')
  assert.equal(s.nodes[id(button)]!.parent, id(card), '中间那块玻璃在屏外：接着往上找')
  assert.equal(s.nodes[id(knob)]!.parent, id(button))
  assert.equal(s.nodes[id(button)]!.layer, 2, '层号照旧（屏外的那块也算一层）')
  assert.deepEqual(s.roots, [id(loose), id(card)], '场景里的填充在卡片下面')
  assert.deepEqual(s.nodes[id(card)]!.children, [id(track), id(button)], '子节点按 Z 序')
  assert.deepEqual(s.nodes[id(button)]!.children, [id(knob)])
})

test('父子：合并组的成员挂在组下，组挂在第一个成员的玻璃祖先下；成员互相嵌套成环时组当根', () => {
  const viewport = resolveViewport(800, 600, 1)
  const reg = registry()
  const card = fakeElement(10)
  const a = fakeElement(100, card)
  const b = fakeElement(200, card)
  for (const el of [card, a, b]) reg.register(el, {})
  reg.group().setMembers([a, b])
  const s = buildScene(reg.measure(viewport), null)
  const g = s.nodes.findIndex((n) => n.kind === 'group')
  const id = (el: HTMLElement): number => s.nodes.findIndex((n) => n.kind === 'panel' && n.element === el)
  assert.equal(s.nodes[g]!.parent, id(card))
  assert.equal(s.nodes[id(a)]!.parent, g)
  assert.equal(s.nodes[id(b)]!.parent, g)
  assert.deepEqual(s.nodes[id(card)]!.children, [g])
  assert.deepEqual(s.roots, [id(card)])

  // b 写在 a 里面、又和 a 合并：b 的玻璃祖先 a 挂在组下 —— 组若挂到 a 下就成环
  const reg2 = registry()
  const outer = fakeElement(100)
  const inner = fakeElement(120, outer)
  reg2.register(outer, {})
  reg2.register(inner, {})
  reg2.group().setMembers([inner, outer])
  const s2 = buildScene(reg2.measure(viewport), null)
  const g2 = s2.nodes.findIndex((n) => n.kind === 'group')
  assert.equal(s2.nodes[g2]!.parent, null)
  assert.deepEqual(s2.roots, [g2])
  for (const n of s2.nodes) if (n.kind === 'panel') assert.equal(n.parent, g2)
})

test('相对上一帧建：base 指向上一帧；stage 里静止的页面一路不脏', () => {
  const viewport = resolveViewport(800, 600, 1)
  const reg = registry()
  const card = fakeElement(10)
  reg.register(card, {})
  reg.register(fakeElement(30, card), {})
  reg.registerFill(fakeElement(70, card))
  let prev: Scene | null = null
  for (let i = 0; i < 3; i++) {
    const s: Scene = buildScene(reg.measure(viewport), prev)
    assert.equal(s.changed, i === 0)
    if (prev) assert.equal(s.base, prev.serial)
    prev = s
  }
})
