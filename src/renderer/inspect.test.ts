import { test } from 'node:test'
import assert from 'node:assert/strict'

import { inspectFrame } from './inspect.ts'
import type { FrameSnapshot } from './idle.ts'
import type { MeasuredPanel } from './panels.ts'
import type { MeasuredFill } from './fills.ts'
import { sceneRows, detailLines } from '../debug/rows.ts'

const element = (tag: string, cls = ''): HTMLElement => ({ tagName: tag.toUpperCase(), id: '', classList: cls ? [cls] : [] }) as unknown as HTMLElement

test('场景检查器：面板、合并组的成员、填充换成 CSS 像素，带材质、层、呈现变换；表格与详情', () => {
  const card = element('div', 'card')
  const member = element('glass-button')
  const fillEl = element('glass-fill')
  const chain = { cornerRadiiDp: [8, 8, 8, 8], effects: [{ kind: 'blur', sigmaDp: 6 }], paddingDp: 0, opacity: 1, adaptive: 0, shadow: 0.5, magnify: 0, bodyLight: 0 }
  const panel = (el: HTMLElement, over: Partial<MeasuredPanel> = {}): MeasuredPanel =>
    ({
      record: { element: el, material: { blur: 6 }, presentation: { dx: 2, dy: 0, sx: 1.2, sy: 0.9 } },
      x: 300, y: 150, w: 600, h: 300, rotation: [1, 0], visualScale: 1, fade: 0.5, layer: 0, chain, quality: undefined,
      ...over
    }) as unknown as MeasuredPanel
  const frame = {
    viewport: { cssWidth: 800, cssHeight: 600, compositeWidth: 1600, compositeHeight: 1200, dpr: 2, sceneWidth: 800, sceneHeight: 600 },
    panels: [panel(card)],
    groups: [{ members: [panel(member, { layer: 1 })], smoothingPx: 10, scissor: [0, 0, 1, 1], layer: 1 }],
    fills: [{ record: { element: fillEl }, x: 0, y: 0, w: 200, h: 100, color: [1, 0, 0, 1], gradient: null, layer: 0 } as unknown as MeasuredFill]
  } as unknown as FrameSnapshot
  assert.equal(inspectFrame(null), null)
  const s = inspectFrame(frame)!
  assert.equal(s.glasses.length, 2)
  assert.deepEqual(s.glasses[0]!.rect, [150, 75, 300, 150], '设备像素 → CSS 像素')
  assert.equal(s.glasses[0]!.group, null)
  assert.equal(s.glasses[1]!.group, 0)
  assert.equal(s.glasses[1]!.layer, 1)
  assert.deepEqual(s.glasses[0]!.presentation, { dx: 2, dy: 0, sx: 1.2, sy: 0.9 })
  assert.equal(s.fills[0]!.kind, 'color')
  const { rows, elements } = sceneRows(s)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], ['1', '玻璃', 'div.card', '0', '300×150', '淡 0.50 · 呈现变换'])
  assert.equal(rows[1]![1], '组 1')
  assert.equal(rows[2]![5], 'rgba(255, 0, 0, 1.00)')
  assert.deepEqual(elements, [card, member, fillEl])
  const lines = detailLines(s, card)
  assert.ok(lines[0]!.startsWith('div.card · 层 0'))
  assert.ok(lines.some((l) => l.startsWith('blur sigmaDp 6.000')))
  assert.ok(lines.some((l) => l.startsWith('呈现变换 dx 2.0')))
  assert.deepEqual(detailLines(s, element('p')), ['不在上一帧里（屏外、藏起来了，或者不是玻璃）'])
})
