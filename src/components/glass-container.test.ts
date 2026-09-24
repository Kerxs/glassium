import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dropletOffset } from './glass-container.ts'

const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h })

test('水滴从哪里出来：邻居的边上离新成员中心最近的那一点', () => {
  // A 在左（430–486），B 在右（498–554），同一行：从 A 的右边缘中点出来
  assert.deepEqual(dropletOffset(box(430, 1000, 56, 56), box(498, 1000, 56, 56)), [486 - 526, 1028 - 1028])
  // B 在 A 的正下方：从 A 的下边缘
  assert.deepEqual(dropletOffset(box(0, 0, 100, 40), box(20, 60, 60, 40)), [0, 40 - 80])
  // 斜对角：从 A 的角上
  assert.deepEqual(dropletOffset(box(0, 0, 10, 10), box(20, 20, 10, 10)), [10 - 25, 10 - 25])
  // 新成员的中心就在邻居里面（重叠着放）：原地
  assert.deepEqual(dropletOffset(box(0, 0, 100, 100), box(40, 40, 20, 20)), [0, 0])
})
