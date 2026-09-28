import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cancelFrame, everyFrame, flushFrame, nextFrame, pendingFrames, REDUCED_MOTION_SKIP, setFrameSource, setTimelineReducedMotion } from './timeline.ts'

/** 假的 rAF：记下排了几次、排着的是谁，手动出帧。 */
function fakeSource(): { requests: number; frame(t: number): void; readonly queued: boolean } {
  let queued: ((t: number) => void) | null = null
  const s = {
    requests: 0,
    frame(t: number): void {
      const cb = queued
      queued = null
      cb?.(t)
    },
    get queued(): boolean {
      return queued !== null
    }
  }
  setFrameSource({
    request: (cb) => {
      s.requests++
      queued = cb
      return 1
    },
    cancel: () => {
      queued = null
    }
  })
  return s
}

test('时间轴：多个动画一帧只排一个 rAF；回调里再排的留到下一帧；cancel 掉最后一个就不再排', () => {
  const src = fakeSource()
  try {
    const seen: string[] = []
    nextFrame((t) => seen.push(`a${t}`))
    nextFrame((t) => {
      seen.push(`b${t}`)
      nextFrame((u) => seen.push(`c${u}`))
    })
    assert.equal(src.requests, 1, '两个动画一个 rAF')
    src.frame(16)
    assert.deepEqual(seen, ['a16', 'b16'])
    src.frame(32)
    assert.deepEqual(seen, ['a16', 'b16', 'c32'], '回调里排的在下一帧')
    const id = nextFrame(() => seen.push('never'))
    assert.ok(src.queued)
    cancelFrame(id)
    assert.equal(src.queued, false, '没有排着的回调了：rAF 也撤掉')
    assert.equal(pendingFrames(), 0)
  } finally {
    setFrameSource(null)
  }
})

test('时间轴：stage 与自己的 rAF 在同一帧都来时只跑一遍；stage 先跑就撤掉自己的 rAF', () => {
  const src = fakeSource()
  try {
    let runs = 0
    nextFrame(() => runs++)
    flushFrame(100) // stage 的帧循环先来
    assert.equal(runs, 1)
    assert.equal(src.queued, false, 'stage 跑过了：自己的 rAF 撤掉')
    nextFrame(() => runs++)
    src.frame(116)
    flushFrame(116) // 同一帧 stage 又来
    assert.equal(runs, 2, '同一个时间戳只跑一遍')
  } finally {
    setFrameSource(null)
  }
})

test('时间轴：减少动效时回调拿到的时间跳到很远以后（按时间走的动画一步到头）；帧观察者照常拿真实时间、不自己排帧', () => {
  const src = fakeSource()
  try {
    let reduced = true
    setTimelineReducedMotion(() => reduced)
    let got = 0
    nextFrame((t) => (got = t))
    src.frame(50)
    assert.equal(got, 50 + REDUCED_MOTION_SKIP)
    reduced = false

    const observed: number[] = []
    const stop = everyFrame((t) => observed.push(t))
    assert.equal(src.queued, false, '帧观察者不自己排帧')
    flushFrame(200)
    flushFrame(216)
    assert.deepEqual(observed, [200, 216], '搭 stage 帧循环的车，每帧都跑')
    stop()
    flushFrame(232)
    assert.equal(observed.length, 2)
  } finally {
    setTimelineReducedMotion(() => false)
    setFrameSource(null)
  }
})

test('时间轴：一个回调抛了不影响同一帧别的回调', () => {
  fakeSource()
  const error = console.error
  console.error = () => {}
  try {
    let ran = false
    nextFrame(() => {
      throw new Error('boom')
    })
    nextFrame(() => (ran = true))
    flushFrame(300)
    assert.equal(ran, true)
  } finally {
    console.error = error
    setFrameSource(null)
  }
})
