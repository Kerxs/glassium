import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MINIMIZE_THRESHOLD, initialMinimize, nextMinimize, type MinimizeState } from './minimize.ts'

const run = (ys: readonly number[], start = 0): MinimizeState[] => {
  let s = initialMinimize(start)
  return ys.map((y) => (s = nextMinimize(s, y)))
}

test('往下滚累计超过阈值才缩起；往上滚累计超过阈值展开', () => {
  const states = run([10, 20, 30, 50, 80, 60, 40, 30])
  assert.deepEqual(
    states.map((s) => s.minimized),
    [false, false, false, true, true, true, false, false]
  )
})

test('展开时从滚到过的最高处算：先往上走，锚点跟着上去', () => {
  // 从 200 开始往上到 150，再往下：从 150 数，到 180 差 30 不缩，到 183 差 33 缩起
  const s = run([150, 180, 183], 200)
  assert.deepEqual(s.map((x) => x.minimized), [false, false, true])
  assert.equal(s[0]!.anchor, 150)
})

test('缩着时从滚到过的最低处算：接着往下滚，锚点跟着下去', () => {
  const s = run([100, 400, 380, 368, 367])
  // 400 是最深处：380（差 20）、368（差 32，不超过）都还缩着，367（差 33）展开
  assert.deepEqual(s.map((x) => x.minimized), [true, true, true, true, false])
})

test('回到顶部附近总是展开；没变时返回同一个对象', () => {
  let s = nextMinimize(initialMinimize(0), 200)
  assert.equal(s.minimized, true)
  s = nextMinimize(s, 5)
  assert.equal(s.minimized, false)
  assert.equal(nextMinimize(s, 5), s)
  assert.equal(nextMinimize(s, 5 + MINIMIZE_THRESHOLD / 2), s, '往下没超过阈值：原样')
})
