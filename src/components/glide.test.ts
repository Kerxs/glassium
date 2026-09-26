import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GLIDE_LIFT_MS, Glide, glideAt, glideDuration, glideEase, type GlideBox } from './glide.ts'

test('缓动：两头落在端点、单调、中段最快', () => {
  assert.equal(glideEase(0), 0)
  assert.equal(glideEase(1), 1)
  assert.equal(glideEase(-1), 0)
  assert.equal(glideEase(2), 1)
  let prev = -1
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const v = glideEase(t)
    assert.ok(v >= prev)
    prev = v
  }
  const speed = (t: number): number => (glideEase(t + 0.01) - glideEase(t)) / 0.01
  assert.ok(speed(0.495) > speed(0.1) * 3, '中段比起飞快得多')
  assert.ok(speed(0.495) > speed(0.89) * 3, '中段比落地快得多')
})

test('时长：远的久一点，夹在 300–560ms', () => {
  assert.equal(glideDuration(0), 300)
  assert.equal(glideDuration(100), 330)
  assert.equal(glideDuration(-100), 330)
  assert.equal(glideDuration(10000), 560)
})

test('位置：抬起时原地不动，之后从旧值走到新值（宽度一起变）', () => {
  const from = { x: 10, w: 80 }
  const to = { x: 210, w: 60 }
  assert.deepEqual(glideAt(from, to, 0), from)
  assert.deepEqual(glideAt(from, to, GLIDE_LIFT_MS), from)
  const mid = glideAt(from, to, GLIDE_LIFT_MS + glideDuration(200) / 2)
  assert.ok(Math.abs(mid.x - 110) < 1e-9 && Math.abs(mid.w - 70) < 1e-9)
  assert.deepEqual(glideAt(from, to, GLIDE_LIFT_MS + glideDuration(200)), to)
})

test('Glide：逐帧回调、落地时正好在终点并调 onDone；cancel 停在当前位置、不落地', () => {
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
    const frames: GlideBox[] = []
    let done = 0
    const glide = new Glide((b) => frames.push(b), () => done++)
    glide.start({ x: 0, w: 50 }, { x: 100, w: 50 })
    assert.ok(glide.active)
    for (let i = 0; i < 100 && queued; i++) frame()
    assert.equal(done, 1)
    assert.equal(glide.active, false)
    assert.deepEqual(frames.at(-1), { x: 100, w: 50 })
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i]!.x >= frames[i - 1]!.x, '单调地往前飞')

    // 飞到一半 cancel：停在那里，不调 onDone
    frames.length = 0
    glide.start({ x: 0, w: 50 }, { x: 300, w: 50 })
    for (let i = 0; i < 15; i++) frame()
    const stopped = glide.cancel()
    assert.ok(stopped && stopped.x > 0 && stopped.x < 300, `停在半路（${stopped?.x}）`)
    assert.equal(done, 1)
    assert.equal(queued, null)
    assert.equal(glide.cancel(), null, '没在飞时 cancel 返回 null')
  } finally {
    g.requestAnimationFrame = saved.raf
    g.cancelAnimationFrame = saved.caf
    performance.now = realNow
  }
})
