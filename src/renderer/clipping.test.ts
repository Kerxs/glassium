import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clipAxesOf, clippingAncestors, intersect, isFixedContainingBlock, union, UNBOUNDED, type ClipStyle } from './clipping.ts'

const plain: ClipStyle = {
  position: 'static',
  overflowX: 'visible',
  overflowY: 'visible',
  contain: 'none',
  transform: 'none',
  perspective: 'none',
  filter: 'none',
  backdropFilter: 'none',
  willChange: 'auto'
}
const st = (o: Partial<ClipStyle>): ClipStyle => ({ ...plain, ...o })
const scroller = st({ overflowX: 'auto', overflowY: 'auto' })
const indices = (r: { index: number }[]): number[] => r.map((c) => c.index)

test('常规流的面板被每个裁剪祖先裁', () => {
  // 面板 → [div, 滚动容器, div, 另一个 overflow:hidden]
  const chain = [plain, scroller, plain, st({ overflowX: 'hidden', overflowY: 'hidden' })]
  assert.deepEqual(indices(clippingAncestors('static', chain)), [1, 3])
  assert.deepEqual(indices(clippingAncestors('relative', chain)), [1, 3])
  assert.deepEqual(indices(clippingAncestors('sticky', chain)), [1, 3])
})

test('absolute 的面板跳过它和包含块之间那些不定位的裁剪祖先', () => {
  // 面板(absolute) → [不定位的 overflow:hidden, 定位了的滚动容器, overflow:hidden]
  const chain = [
    st({ overflowX: 'hidden', overflowY: 'hidden' }),
    st({ position: 'relative', overflowX: 'auto', overflowY: 'auto' }),
    st({ overflowX: 'hidden', overflowY: 'hidden' })
  ]
  // 0 不在包含块链上，裁不到；1 是包含块，裁；从 1（relative）往上是常规流，2 也裁
  assert.deepEqual(indices(clippingAncestors('absolute', chain)), [1, 2])
})

test('fixed 的面板只被建立固定定位包含块的祖先裁', () => {
  const chain = [scroller, st({ position: 'relative', overflowX: 'hidden', overflowY: 'hidden' }), st({ transform: 'matrix(1, 0, 0, 1, 0, 0)', overflowX: 'hidden', overflowY: 'hidden' })]
  assert.deepEqual(indices(clippingAncestors('fixed', chain)), [2], '普通滚动容器与定位祖先都裁不到 fixed')
  assert.deepEqual(indices(clippingAncestors('fixed', [scroller, plain])), [])
})

test('单轴裁剪与 contain: paint', () => {
  assert.deepEqual(clipAxesOf(st({ overflowX: 'clip' })), { x: true, y: false })
  assert.deepEqual(clipAxesOf(st({ overflowY: 'hidden', overflowX: 'auto' })), { x: true, y: true })
  assert.deepEqual(clipAxesOf(st({ contain: 'paint' })), { x: true, y: true })
  assert.deepEqual(clipAxesOf(st({ contain: 'content' })), { x: true, y: true })
  assert.deepEqual(clipAxesOf(plain), { x: false, y: false })
})

test('哪些属性建立固定定位包含块', () => {
  assert.equal(isFixedContainingBlock(plain), false)
  assert.equal(isFixedContainingBlock(st({ filter: 'blur(2px)' })), true)
  assert.equal(isFixedContainingBlock(st({ willChange: 'transform' })), true)
  assert.equal(isFixedContainingBlock(st({ willChange: 'opacity' })), false, 'will-change: opacity 不算')
  assert.equal(isFixedContainingBlock(st({ contain: 'layout' })), true)
})

test('矩形求交与求并，±∞ 表示那个轴不裁', () => {
  const a = { x0: 0, y0: 0, x1: 100, y1: 50 }
  assert.deepEqual(intersect(a, UNBOUNDED), a)
  assert.deepEqual(intersect(a, { x0: -Infinity, y0: 20, x1: Infinity, y1: 40 }), { x0: 0, y0: 20, x1: 100, y1: 40 })
  assert.deepEqual(union(a, { x0: 90, y0: 10, x1: 150, y1: 30 }), { x0: 0, y0: 0, x1: 150, y1: 50 })
})
