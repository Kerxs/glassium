import { test } from 'node:test'
import assert from 'node:assert/strict'

import { JELLY_MAX, Jelly, jellyScale, jellyTarget } from './jelly.ts'

test('速度 → 拉长量：随速度单调增加、有上限；方向无关', () => {
  assert.equal(jellyTarget(0), 0)
  let prev = -1
  for (let v = 0; v <= 5; v += 0.1) {
    const t = jellyTarget(v)
    assert.ok(t >= prev && t <= JELLY_MAX)
    prev = t
  }
  assert.equal(jellyTarget(100), JELLY_MAX)
  assert.equal(jellyTarget(-0.5), jellyTarget(0.5))
})

test('缩放：横向拉长，纵向按 1/√sx 收一点；不拉长时正好是 (1, 1)', () => {
  assert.deepEqual(jellyScale(0), [1, 1])
  const [sx, sy] = jellyScale(0.21)
  assert.ok(Math.abs(sx - 1.21) < 1e-12)
  assert.ok(Math.abs(sy - 1 / 1.1) < 1e-12)
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
    assert.ok(peak > 1.15, `拖动中拉长了（${peak}）`)
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
