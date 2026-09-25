import { test } from 'node:test'
import assert from 'node:assert/strict'

import { edgeProgress, inlineTitleOpacity, largeTitleProgress, NAV_EDGE_RAMP } from './glass-nav-bar.ts'

test('滚动边缘：栏还在本来的位置（没贴住、或刚贴住）时是 0；贴住之后正文再滚 NAV_EDGE_RAMP 到 1', () => {
  // 栏在页面 600 处、没滚到：栏与本来的位置重合
  assert.equal(edgeProgress(600, 600), 0)
  // 滚了 100：两个一起往上走，还是重合
  assert.equal(edgeProgress(500, 500), 0)
  // 贴住（栏停在 0），本来的位置继续往上走
  assert.equal(edgeProgress(0, 0), 0)
  assert.equal(edgeProgress(0, -NAV_EDGE_RAMP / 2), 0.5)
  assert.equal(edgeProgress(0, -NAV_EDGE_RAMP), 1)
  assert.equal(edgeProgress(0, -400), 1)
  // 取整误差：栏比本来的位置还靠上一点点，不出负数
  assert.equal(edgeProgress(0, 0.3), 0)
})

test('大标题：整个在栏下沿之下是 0，整个过了栏下沿是 1；小标题过一半开始淡入', () => {
  // 栏下沿 52，大标题 52–93（高 41）
  assert.equal(largeTitleProgress(52, 52, 41), 0)
  assert.equal(largeTitleProgress(52, 60, 41), 0, '还在下面（页面刚往下拉）')
  near(largeTitleProgress(52, 31.5, 41), 0.5)
  assert.equal(largeTitleProgress(52, 11, 41), 1)
  assert.equal(largeTitleProgress(52, -300, 41), 1)
  // 大标题是空的（高 0）：过了就是 1
  assert.equal(largeTitleProgress(52, 60, 0), 0)
  assert.equal(largeTitleProgress(52, 40, 0), 1)
  assert.equal(inlineTitleOpacity(0), 0)
  assert.equal(inlineTitleOpacity(0.5), 0)
  near(inlineTitleOpacity(0.75), 0.5)
  assert.equal(inlineTitleOpacity(1), 1)
})

function near(a: number, b: number): void {
  assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`)
}
