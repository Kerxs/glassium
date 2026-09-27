import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DRAG_JELLY, FLY_JELLY, JELLY_MAX, JELLY_SQUASH, Jelly, jellyScale, jellyTarget } from './jelly.ts'

test('速度 → 拉长量：随速度严格单调增加、平滑地趋近上限；方向无关', () => {
  assert.equal(jellyTarget(0), 0)
  let prev = -1
  for (let v = 0; v <= 8; v += 0.1) {
    const t = jellyTarget(v)
    assert.ok(t > prev && t < JELLY_MAX, `v = ${v}`)
    prev = t
  }
  assert.ok(Math.abs(jellyTarget(100) - JELLY_MAX) < 1e-12)
  assert.equal(jellyTarget(-0.5), jellyTarget(0.5))
  // 看得出快慢：慢拖（0.3 px/ms）只长一点，快甩（3 px/ms）长得多
  const slow = jellyTarget(0.3)
  const medium = jellyTarget(1)
  const fast = jellyTarget(3)
  assert.ok(slow > 0.08 && slow < 0.16, `慢拖 ${slow}`)
  assert.ok(medium > slow * 2, `中速 ${medium}`)
  assert.ok(fast > 0.4, `快甩 ${fast}`)
})

test('缩放：横向拉长，纵向按 sx^−0.7 收（比保面积再扁一点）；不拉长时正好是 (1, 1)', () => {
  assert.deepEqual(jellyScale(0), [1, 1])
  const [sx, sy] = jellyScale(0.3)
  assert.ok(Math.abs(sx - 1.3) < 1e-12)
  assert.ok(Math.abs(sy - Math.pow(1.3, -JELLY_SQUASH)) < 1e-12)
  assert.ok(sy < 1 / Math.sqrt(1.3), '比保面积扁')
  assert.deepEqual(jellyScale(-1), [1, 1], '负的当 0')
})

test('拖得快就拉长；松手后单调地回到 (1, 1)，不过冲、不晃', () => {
  // 手动的时钟与 rAF：一帧 16ms
  let now = 0
  let queued: ((t: number) => void) | null = null
  const g = globalThis as unknown as Record<string, unknown>
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame }
  g.requestAnimationFrame = (cb: (t: number) => void): number => {
    queued = cb
    return 1
  }
  g.cancelAnimationFrame = (): void => {
    queued = null
  }
  const frame = (): void => {
    now += 16
    const cb = queued
    queued = null
    cb?.(now)
  }
  const realNow = performance.now.bind(performance)
  performance.now = (): number => now
  try {
    const seen: [number, number][] = []
    const jelly = new Jelly((sx, sy) => seen.push([sx, sy]))
    // 1.5 px/ms 拖 200ms
    for (let i = 0; i < 12; i++) {
      jelly.move(i * 24, now)
      frame()
    }
    const peak = Math.max(...seen.map((s) => s[0]))
    assert.ok(peak > 1.25, `拖动中拉长了（${peak}）`)
    assert.ok(peak <= 1 + JELLY_MAX + 1e-9)
    // 松手：之后每一帧的 sx 都不增加、不小于 1，最后正好落在 (1, 1)，rAF 停了
    jelly.release()
    const from = seen.length
    for (let i = 0; i < 200 && queued; i++) frame()
    const after = seen.slice(from).map((s) => s[0])
    for (let i = 1; i < after.length; i++) assert.ok(after[i]! <= after[i - 1]! + 1e-12, `第 ${i} 帧又变长了`)
    assert.ok(after.every((sx) => sx >= 1), '不会缩到比原来还窄（不过冲）')
    assert.deepEqual(seen.at(-1), [1, 1])
    assert.equal(queued, null, '停下来之后不再要帧')
  } finally {
    g.requestAnimationFrame = saved.raf
    g.cancelAnimationFrame = saved.caf
    performance.now = realNow
  }
})

test('飞行的响应（FLY_JELLY）比拖动（DRAG_JELLY）跟得紧：同样的匀速移动，更早拉到同样长；松开后同样不过冲', () => {
  let now = 0
  let queued: ((t: number) => void) | null = null
  const g = globalThis as unknown as Record<string, unknown>
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame }
  g.requestAnimationFrame = (cb: (t: number) => void): number => {
    queued = cb
    return 1
  }
  g.cancelAnimationFrame = (): void => {
    queued = null
  }
  const realNow = performance.now.bind(performance)
  performance.now = (): number => now
  const frame = (): void => {
    now += 16
    const cb = queued
    queued = null
    cb?.(now)
  }
  try {
    const run = (response: typeof DRAG_JELLY): number[] => {
      now = 0
      queued = null
      const seen: number[] = []
      const jelly = new Jelly((sx) => seen.push(sx))
      // 1 px/ms 匀速走 5 帧
      for (let i = 0; i < 6; i++) {
        jelly.move(i * 16, now, response)
        frame()
      }
      jelly.release()
      for (let i = 0; i < 200 && queued; i++) frame()
      return seen
    }
    const drag = run(DRAG_JELLY)
    const fly = run(FLY_JELLY)
    assert.ok(fly[4]! > drag[4]! + 0.05, `第 5 帧：飞行 ${fly[4]} 比拖动 ${drag[4]} 长得多`)
    const boosted = run({ ...FLY_JELLY, velocityScale: 3 })
    assert.ok(boosted[4]! > fly[4]! + 0.05, `速度放大 3 倍：${boosted[4]} 比 ${fly[4]} 长`)
    assert.ok(Math.max(...boosted) <= 1 + JELLY_MAX + 1e-9, '仍不超过上限')
    assert.ok(fly.every((sx) => sx >= 1), '不过冲')
    assert.equal(fly.at(-1), 1)
  } finally {
    g.requestAnimationFrame = saved.raf
    g.cancelAnimationFrame = saved.caf
    performance.now = realNow
  }
})
