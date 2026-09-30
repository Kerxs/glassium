import { test } from 'node:test'
import assert from 'node:assert/strict'

import { passesFrom } from './gpu-timer.ts'

test('GPU 分账：相邻时间戳之差；没打的点并进下一段；负的差按 0；首尾不对返回 null', () => {
  const ms = 1e6
  const r = passesFrom([0, 1 * ms, 3 * ms, 4.5 * ms, 5 * ms])!
  assert.equal(r.total, 5)
  assert.deepEqual(r.passes, { scene: 1, blur: 2, glass: 1.5, layers: 0.5 })
  // 沿用场景：scene 与 blur 两个点挨着
  assert.deepEqual(passesFrom([0, 0, 0, 2 * ms, 2 * ms])!.passes, { scene: 0, blur: 0, glass: 2, layers: 0 })
  // 没打 blur：模糊那一段并进玻璃
  assert.deepEqual(passesFrom([0, ms, -1, 3 * ms, 3 * ms])!.passes, { scene: 1, blur: 0, glass: 2, layers: 0 })
  // 量化出来的倒退
  assert.equal(passesFrom([0, 2 * ms, 1.9 * ms, 3 * ms, 3 * ms])!.passes.blur, 0)
  assert.equal(passesFrom([5, 1, 2, 3, 4]), null)
  assert.equal(passesFrom([-1, 1, 2, 3, 4]), null)
})
