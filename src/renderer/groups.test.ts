import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_GROUP_MEMBERS, mergeBleed } from '../core/merge.ts'
import { resolveViewport } from '../core/units.ts'
import {
  GLASS_GROUP_WGSL,
  GROUP_CAPACITY,
  GROUP_STRIDE,
  GROUP_STRIDE_FLOATS,
  GROUP_STRUCT_BYTES
} from '../shaders/glass-group.wgsl.ts'
import { PANEL_STRUCT_BYTES } from '../shaders/glass.wgsl.ts'
import {
  DEFAULT_SMOOTHING_DP,
  PANEL_STRUCT_FLOATS,
  PanelRegistry,
  packGroup,
  packPanel,
  type MeasuredGroup
} from './panels.ts'

/* ------------------------------------------------------------------ *
 * struct Group 的布局与 packGroup 必须对齐
 * ------------------------------------------------------------------ */

test('struct Group：16B 的头之后紧挨着 4 个 Panel，放得进 512B 的槽位', () => {
  const m = /struct Group \{([\s\S]*?)\n\}/.exec(GLASS_GROUP_WGSL)
  assert.ok(m, 'GLASS_GROUP_WGSL 里找不到 struct Group')
  const fields = m[1]!
    .split('\n')
    // 类型里可能有逗号（array<Panel, 4>），所以取到「行尾那个逗号（后面只剩注释）」为止
    .map((l) => /^\s*(\w+)\s*:\s*(.*?),\s*(?:\/\/.*)?$/.exec(l))
    .filter((f): f is RegExpExecArray => f !== null)
    .map((f) => [f[1], f[2]!.replace(/\s+/g, '')])
  assert.deepEqual(fields, [
    ['header', 'vec4f'],
    ['members', `array<Panel,${GROUP_CAPACITY}>`]
  ])
  // Panel 的大小是 16 的倍数，所以 uniform 数组的步长就是它本身，不需要补齐
  assert.equal(PANEL_STRUCT_BYTES % 16, 0)
  assert.equal(GROUP_STRUCT_BYTES, 16 + GROUP_CAPACITY * PANEL_STRUCT_BYTES)
  assert.ok(GROUP_STRUCT_BYTES <= GROUP_STRIDE)
  assert.equal(GROUP_STRIDE % 256, 0, '动态偏移要按 256B 对齐')
  assert.equal(GROUP_CAPACITY, MAX_GROUP_MEMBERS, '着色器的数组长度必须与 CPU 侧的上限一致')
})

// —— 测量 ——

function fakeElement(left: number, top: number, width: number, height: number): HTMLElement {
  return {
    isConnected: true,
    getBoundingClientRect: () => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({})
    })
  } as unknown as HTMLElement
}

test('组里的面板不再单独绘制；一组一个裁剪矩形 = 并集外扩 k/4 + 2px', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  const a = fakeElement(100, 100, 120, 56)
  const b = fakeElement(232, 100, 120, 56)
  const c = fakeElement(100, 300, 200, 100)
  // 没有投影：这里验的是合并的外扩；投影的外扩在 panels.test.ts 里单独验
  registry.register(a, { shadow: 0 })
  registry.register(b, { shadow: 0 })
  registry.register(c, { shadow: 0 })
  registry.group({ smoothing: 24 }).setMembers([a, b])

  const { panels, groups } = registry.measure(viewport)
  assert.equal(panels.length, 1, '只剩 c 单独绘制')
  assert.equal(panels[0]!.record.element, c)
  assert.equal(groups.length, 1)
  const g = groups[0]!
  assert.deepEqual(g.members.map((m) => m.record.element), [a, b], '成员按给定顺序')
  assert.equal(g.smoothingPx, 24)
  const bleed = mergeBleed(24) + 2 // 8
  assert.deepEqual(g.scissor, [100 - bleed, 100 - bleed, 252 + 2 * bleed, 56 + 2 * bleed])
})

test('超过 4 块时前 4 块合并，其余单独绘制，并且只警告一次', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  const els = [0, 1, 2, 3, 4].map((i) => fakeElement(10 + i * 70, 10, 60, 40))
  for (const el of els) registry.register(el, {})
  registry.group().setMembers(els)

  const warnings: string[] = []
  const warn = console.warn
  console.warn = (msg: unknown) => void warnings.push(String(msg))
  try {
    const first = registry.measure(viewport)
    registry.measure(viewport)
    assert.equal(first.groups[0]!.members.length, 4)
    assert.equal(first.panels.length, 1)
    assert.equal(first.panels[0]!.record.element, els[4])
  } finally {
    console.warn = warn
  }
  assert.equal(warnings.length, 1, '同一组只警告一次')
  assert.match(warnings[0]!, /最多合并 4 块/)
})

test('还没注册的成员先被忽略，注册之后自动加入', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  const a = fakeElement(10, 10, 100, 50)
  const b = fakeElement(120, 10, 100, 50)
  registry.register(a, {})
  registry.group().setMembers([a, b])
  assert.equal(registry.measure(viewport).groups[0]!.members.length, 1)
  registry.register(b, {})
  assert.equal(registry.measure(viewport).groups[0]!.members.length, 2)
})

test('一块面板只属于一个组：先到先得', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  const a = fakeElement(10, 10, 100, 50)
  const b = fakeElement(120, 10, 100, 50)
  const c = fakeElement(230, 10, 100, 50)
  for (const el of [a, b, c]) registry.register(el, {})
  registry.group().setMembers([a, b])
  registry.group().setMembers([b, c])
  const { groups } = registry.measure(viewport)
  assert.deepEqual(groups.map((g) => g.members.map((m) => m.record.element)), [[a, b], [c]])
})

test('解散之后成员回到单独绘制；默认平滑半径是 DEFAULT_SMOOTHING_DP', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  const a = fakeElement(10, 10, 100, 50)
  const b = fakeElement(120, 10, 100, 50)
  registry.register(a, {})
  registry.register(b, {})
  const group = registry.group()
  group.setMembers([a, b])
  assert.equal(registry.measure(viewport).groups[0]!.smoothingPx, DEFAULT_SMOOTHING_DP)
  group.setSmoothing(-5)
  assert.equal(registry.measure(viewport).groups[0]!.smoothingPx, 0, '负数钳到 0（硬并集）')
  group.dissolve()
  const after = registry.measure(viewport)
  assert.equal(after.groups.length, 0)
  assert.equal(after.panels.length, 2)
})

test('成员完全在屏外也参与合并；整组在屏外才剔除', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  const onScreen = fakeElement(10, 10, 100, 50)
  const offScreen = fakeElement(-200, 10, 100, 50)
  registry.register(onScreen, {})
  registry.register(offScreen, {})
  registry.group().setMembers([onScreen, offScreen])
  assert.equal(registry.measure(viewport).groups[0]!.members.length, 2)

  const registry2 = new PanelRegistry(() => {})
  const x = fakeElement(-500, 10, 100, 50)
  const y = fakeElement(-300, 10, 100, 50)
  registry2.register(x, {})
  registry2.register(y, {})
  registry2.group().setMembers([x, y])
  assert.equal(registry2.measure(viewport).groups.length, 0)
})

// —— 打包 ——

test('packGroup：头是 (成员数, k, 调试模式, 0)，成员与 packPanel 写出的内容逐字相同', () => {
  const viewport = resolveViewport(800, 600, 1)
  const registry = new PanelRegistry(() => {})
  const a = fakeElement(100, 100, 120, 56)
  const b = fakeElement(232, 100, 120, 56)
  registry.register(a, { tint: '#336699', blur: 6 })
  registry.register(b, { highlight: 0.9, cornerRadius: [2, 4, 6, 8] })
  registry.group({ smoothing: 30 }).setMembers([a, b])
  const group: MeasuredGroup = registry.measure(viewport).groups[0]!

  const data = new Float32Array(GROUP_STRIDE_FLOATS * 3).fill(7) // 预先填脏数据
  packGroup(data, 1, group, viewport, 6, 'mask')
  const o = GROUP_STRIDE_FLOATS
  assert.deepEqual([...data.subarray(o, o + 4)], [2, 30, 2, 0])

  for (let i = 0; i < 2; i++) {
    const single = new Float32Array(PANEL_STRUCT_FLOATS)
    packPanel(single, 0, group.members[i]!, viewport, 6, 'mask')
    const at = o + 4 + i * PANEL_STRUCT_FLOATS
    assert.deepEqual([...data.subarray(at, at + PANEL_STRUCT_FLOATS)], [...single.subarray(0, PANEL_STRUCT_FLOATS)])
  }
  // 不用的成员槽位清零，前后相邻的组槽位不被写脏
  const unused = data.subarray(o + 4 + 2 * PANEL_STRUCT_FLOATS, o + 4 + 4 * PANEL_STRUCT_FLOATS)
  assert.ok(unused.every((v) => v === 0))
  assert.ok(data.subarray(0, o).every((v) => v === 7))
  assert.ok(data.subarray(2 * o).every((v) => v === 7))
})
