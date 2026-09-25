import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseScrollEdge, scrollEdgeProgress, SCROLL_EDGE_RAMP } from './scroll-edge.ts'

test('scroll-edge="top"：往下滚了才有，SCROLL_EDGE_RAMP 走满', () => {
  assert.equal(scrollEdgeProgress('top', 0, 3000, 1200), 0)
  assert.equal(scrollEdgeProgress('top', SCROLL_EDGE_RAMP / 2, 3000, 1200), 0.5)
  assert.equal(scrollEdgeProgress('top', SCROLL_EDGE_RAMP, 3000, 1200), 1)
  assert.equal(scrollEdgeProgress('top', 1800, 3000, 1200), 1)
  assert.equal(scrollEdgeProgress('top', -5, 3000, 1200), 0, '橡皮筋回弹的负值')
})

test('scroll-edge="bottom"：下面还有内容时是 1，离末尾不到 SCROLL_EDGE_RAMP 时淡出，到底是 0', () => {
  // 文档 3000、视口 1200：最多滚 1800
  assert.equal(scrollEdgeProgress('bottom', 0, 3000, 1200), 1, '在顶上：下面的内容正从它底下经过')
  assert.equal(scrollEdgeProgress('bottom', 1800 - SCROLL_EDGE_RAMP / 2, 3000, 1200), 0.5)
  assert.equal(scrollEdgeProgress('bottom', 1800, 3000, 1200), 0)
  assert.equal(scrollEdgeProgress('bottom', 1810, 3000, 1200), 0, '滚过头（回弹）')
  // 文档比视口短：滚不动，下面没有内容
  assert.equal(scrollEdgeProgress('bottom', 0, 800, 1200), 0)
})

test('属性值：只认 top / bottom', () => {
  assert.equal(parseScrollEdge('top'), 'top')
  assert.equal(parseScrollEdge('bottom'), 'bottom')
  assert.equal(parseScrollEdge(''), null)
  assert.equal(parseScrollEdge('Top'), null)
  assert.equal(parseScrollEdge(null), null)
})
