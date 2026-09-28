import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ElementMotion, ELEMENT_FLY_SCALE, jellyScale2, noteScroll, type MotionBox } from './element-motion.ts'
import { GLIDE_LIFT_MS, glideDuration } from './glide.ts'
import { JELLY_MAX } from './jelly.ts'
import type { PanelPresentation } from '../renderer/panels.ts'
import { simulateReducedMotion } from '../renderer/stage.ts'

const box = (x: number, y = 0, w = 100, h = 50): MotionBox => ({ x, y, w, h })

function recorder(): { list: (PanelPresentation | null)[]; readonly last: PanelPresentation | null } {
  const list: (PanelPresentation | null)[] = []
  return {
    list,
    get last() {
      return list.length ? list[list.length - 1]! : null
    }
  }
}

test('两个方向的果冻：只横着动就是 jelly.ts 的那条曲线；斜着动两边都拉一点', () => {
  const [sx, sy] = jellyScale2(0.3, 0)
  assert.equal(sx, 1.3)
  assert.ok(Math.abs(sy - Math.pow(1.3, -0.7)) < 1e-12)
  assert.deepEqual(jellyScale2(0, 0), [1, 1])
  const [dx, dy] = jellyScale2(0.2, 0.2)
  assert.ok(Math.abs(dx - dy) < 1e-12 && dx < 1.2 && dx > 1, '斜着：两边一样、比单向拉得少')
})

test('元素匀速移动：玻璃顺着方向拉长、垂直方向收；停下来单调地回到元素的盒子（写 null），不过冲', () => {
  const out = recorder()
  const m = new ElementMotion(null, (p) => out.list.push(p), { jelly: true, glide: false })
  let t = 0
  for (let i = 0; i <= 10; i++) m.step((t = i * 16), box(i * 16)) // 1 px/ms 向右
  const moving = out.last!
  assert.ok(moving.sx > 1.1 && moving.sy < 1, `横向拉长 ${moving.sx}、纵向收 ${moving.sy}`)
  assert.ok(moving.sx <= 1 + JELLY_MAX + 1e-9)
  assert.equal(moving.dx, 0, '不飞：位置就是元素的')
  // 停下之后：形状还在追速度的那一两帧会再长一点（与 jelly.ts 一样），过了峰值就单调地回去、不低于 1
  const after: number[] = []
  for (let i = 0; i < 200 && out.last !== null; i++) {
    m.step((t += 16), box(160))
    if (out.last) after.push(out.last.sx)
  }
  const peak = after.indexOf(Math.max(...after))
  assert.ok(peak <= 3, `峰值在停下之后的前几帧（第 ${peak} 帧）`)
  for (let i = peak + 1; i < after.length; i++) assert.ok(after[i]! <= after[i - 1]! + 1e-12 && after[i]! >= 1, '过了峰值单调地回去、不过冲')
  assert.equal(out.last, null, '停稳之后回到元素的盒子')
})

test('跳一大段：没开飞行时当瞬移（不拉长）；开了飞行就从旧位置飞过去、中段鼓起、落地回到 null', () => {
  const still = recorder()
  const a = new ElementMotion(null, (p) => still.list.push(p), { jelly: true, glide: false })
  a.step(0, box(0))
  a.step(16, box(300))
  assert.equal(still.list.length, 0, '瞬移：什么都不写')

  const out = recorder()
  const m = new ElementMotion(null, (p) => out.list.push(p), { jelly: true, glide: true })
  m.step(0, box(0))
  m.step(16, box(300))
  assert.ok(m.flying)
  assert.equal(out.last!.dx, -300, '起飞时玻璃还在原地（相对新盒子 −300）')
  const total = GLIDE_LIFT_MS + glideDuration(300)
  let t = 16
  let maxLift = 0
  let lastDx = -300
  while (m.flying && t < 2000) {
    t += 16
    m.step(t, box(300))
    const p = out.last
    if (!p) break
    assert.ok(p.dx >= lastDx - 1e-9, '一路往新位置飞')
    lastDx = p.dx
    maxLift = Math.max(maxLift, Math.min(p.sx, 10), p.sy)
  }
  assert.ok(t <= 16 + total + 16, `飞了 ${t - 16}ms（应约 ${total}）`)
  assert.ok(maxLift > 1.02 && maxLift <= ELEMENT_FLY_SCALE * (1 + JELLY_MAX) + 1e-9, `飞的时候鼓起 ${maxLift}`)
  for (let i = 0; i < 200 && out.last !== null; i++) m.step((t += 16), box(300))
  assert.equal(out.last, null, '落地、果冻圆回去之后回到元素的盒子')
})

test('滚动的那一帧不算动；减少动效时回到元素的盒子、不动', () => {
  const out = recorder()
  const m = new ElementMotion(null, (p) => out.list.push(p), { jelly: true, glide: true })
  m.step(0, box(0))
  noteScroll()
  m.step(16, box(0, -400)) // 页面滚了 400
  assert.equal(out.list.length, 0, '滚动：不飞、不拉长')

  m.step(32, box(20, -400))
  assert.ok(out.last && out.last.sx > 1)
  simulateReducedMotion(true)
  try {
    m.step(48, box(40, -400))
    assert.equal(out.last, null)
    m.step(64, box(400, -400))
    assert.equal(out.last, null, '减少动效：跳了也不飞')
  } finally {
    simulateReducedMotion(null)
  }
})
