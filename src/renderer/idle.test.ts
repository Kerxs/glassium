import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ResolvedViewport } from '../core/units.ts'
import type { BackdropState, SceneImage } from './backend.ts'
import { unchangedFrame, type FrameSnapshot } from './idle.ts'
import type { MeasuredGroup, MeasuredPanel, PanelRecord } from './panels.ts'

// 比较只看值与引用，不碰 DOM：假对象就够了
const viewport = (over: Partial<ResolvedViewport> = {}): ResolvedViewport =>
  ({
    cssWidth: 800,
    cssHeight: 600,
    dpr: 1.5,
    compositeWidth: 1200,
    compositeHeight: 900,
    sceneWidth: 900,
    sceneHeight: 675,
    ...over
  }) as ResolvedViewport

const backdrop = (sceneMode: number): BackdropState => ({
  blurDp: 0,
  saturation: 1,
  tint: [1, 1, 1, 0],
  sceneMode,
  radialCenterCss: [0, 0],
  radialRadius: 0.5
})

const record = { element: {} } as unknown as PanelRecord
const chain = { effects: [], paddingDp: 0 } as unknown as MeasuredPanel['chain']

const panel = (over: Partial<MeasuredPanel> = {}): MeasuredPanel => ({
  record,
  x: 10,
  y: 20,
  w: 100,
  h: 50,
  scissor: [0, 0, 120, 80],
  clip: { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity },
  clipRadii: [0, 0, 0, 0],
  light: [0, 0, 1, 0],
  chain,
  ...over
})

const image = (over: Partial<SceneImage> = {}): SceneImage => ({
  source: {} as SceneImage['source'],
  width: 900,
  height: 675,
  version: 0,
  dynamic: false,
  uvScale: [1, 1],
  uvOffset: [0, 0],
  background: [0, 0, 0],
  ...over
})

const calibration = backdrop(1)

const frame = (over: Partial<FrameSnapshot> = {}): FrameSnapshot => ({
  time: 1,
  viewport: viewport(),
  backdrop: calibration,
  sceneImage: null,
  panels: [panel()],
  groups: [],
  panelDebugMode: 'off',
  ...over
})

test('没有上一帧：一律要画', () => {
  assert.equal(unchangedFrame(null, frame()), false)
})

test('值相同的新对象（每帧重新量出来的）算相同', () => {
  assert.equal(unchangedFrame(frame(), frame()), true)
})

test('内置 gradient 场景随时间漂移：时间变了就要画；静态场景与时间无关', () => {
  const gradient = backdrop(0)
  assert.equal(unchangedFrame(frame({ backdrop: gradient, time: 1 }), frame({ backdrop: gradient, time: 2 })), false)
  assert.equal(unchangedFrame(frame({ time: 1 }), frame({ time: 2 })), true)
  // reduced-motion 下时间冻结在 0：gradient 也不动
  assert.equal(unchangedFrame(frame({ backdrop: gradient, time: 0 }), frame({ backdrop: gradient, time: 0 })), true)
})

test('有用户场景时内置场景不画，时间无关', () => {
  const gradient = backdrop(0)
  const img = image()
  assert.equal(
    unchangedFrame(
      frame({ backdrop: gradient, sceneImage: img, time: 1 }),
      frame({ backdrop: gradient, sceneImage: { ...img }, time: 2 })
    ),
    true
  )
})

test('用户场景：dynamic 每帧都画；版本号、源、铺法变了要画', () => {
  const img = image()
  assert.equal(unchangedFrame(frame({ sceneImage: img }), frame({ sceneImage: { ...img, dynamic: true } })), false)
  assert.equal(unchangedFrame(frame({ sceneImage: img }), frame({ sceneImage: { ...img, version: 1 } })), false)
  assert.equal(unchangedFrame(frame({ sceneImage: img }), frame({ sceneImage: { ...img, source: {} as SceneImage['source'] } })), false)
  assert.equal(unchangedFrame(frame({ sceneImage: img }), frame({ sceneImage: { ...img, uvScale: [1, 0.5] } })), false)
  assert.equal(unchangedFrame(frame({ sceneImage: img }), frame({ sceneImage: null })), false)
})

test('面板：动了、换了降级结果、换了裁剪、多一块少一块都要画', () => {
  assert.equal(unchangedFrame(frame(), frame({ panels: [panel({ y: 21 })] })), false)
  assert.equal(unchangedFrame(frame(), frame({ panels: [panel({ chain: { ...chain } })] })), false)
  assert.equal(unchangedFrame(frame(), frame({ panels: [panel({ scissor: [0, 0, 120, 79] })] })), false)
  assert.equal(
    unchangedFrame(frame(), frame({ panels: [panel({ clip: { x0: 0, y0: -Infinity, x1: Infinity, y1: Infinity } })] })),
    false
  )
  assert.equal(unchangedFrame(frame(), frame({ panels: [panel({ clipRadii: [0, 12, 0, 0] })] })), false)
  assert.equal(unchangedFrame(frame(), frame({ panels: [panel({ light: [30, 40, 20, 0.2] })] })), false, '按压处的光')
  assert.equal(unchangedFrame(frame(), frame({ panels: [] })), false)
  assert.equal(unchangedFrame(frame(), frame({ panels: [panel({ record: { element: {} } as unknown as PanelRecord })] })), false)
})

test('合并组：成员、smoothing、裁剪矩形', () => {
  const group = (over: Partial<MeasuredGroup> = {}): MeasuredGroup => ({
    members: [panel(), panel({ x: 140 })],
    smoothingPx: 36,
    scissor: [0, 0, 300, 80],
    ...over
  })
  assert.equal(unchangedFrame(frame({ groups: [group()] }), frame({ groups: [group()] })), true)
  assert.equal(unchangedFrame(frame({ groups: [group()] }), frame({ groups: [group({ smoothingPx: 0 })] })), false)
  assert.equal(
    unchangedFrame(frame({ groups: [group()] }), frame({ groups: [group({ members: [panel(), panel({ x: 141 })] })] })),
    false
  )
})

test('视口、背景参数、调试视图', () => {
  assert.equal(unchangedFrame(frame(), frame({ viewport: viewport({ dpr: 2 }) })), false)
  assert.equal(unchangedFrame(frame(), frame({ viewport: viewport({ sceneWidth: 899 }) })), false)
  // 背景参数比引用：setBackdrop 每次都换一个新对象，值相同也画一次 —— 保守，但只多画一帧
  assert.equal(unchangedFrame(frame(), frame({ backdrop: backdrop(1) })), false)
  assert.equal(unchangedFrame(frame(), frame({ panelDebugMode: 'sdf' })), false)
})
