import { test } from 'node:test'
import assert from 'node:assert/strict'

import { levelRegion, unionRegion } from './layers.ts'

test('几块场景矩形的并集包围盒；没有是 null', () => {
  assert.equal(unionRegion([]), null)
  assert.deepEqual(unionRegion([[10, 20, 30, 40]]), [10, 20, 30, 40])
  assert.deepEqual(unionRegion([[10, 20, 30, 40], [0, 50, 5, 5], [35, 0, 10, 10]]), [0, 0, 45, 60])
})

test('按级缩小的重建范围随区域单调：并集那一块在每一级都盖住各块自己的（复原层改过的地方靠这一条）', () => {
  const a: [number, number, number, number] = [100, 80, 60, 40]
  const b: [number, number, number, number] = [300, 200, 30, 90]
  const u = unionRegion([a, b])!
  for (let k = 1; k < 7; k++) {
    const w = Math.max(1, 1024 >> k)
    const h = Math.max(1, 768 >> k)
    const ru = levelRegion(u, k, w, h)
    for (const r of [a, b]) {
      const rr = levelRegion(r, k, w, h)
      assert.ok(rr[0] >= ru[0] && rr[1] >= ru[1] && rr[0] + rr[2] <= ru[0] + ru[2] && rr[1] + rr[3] <= ru[1] + ru[3], `第 ${k} 级`)
    }
  }
})
