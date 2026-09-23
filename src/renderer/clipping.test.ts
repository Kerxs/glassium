import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  clipAxesOf,
  clippingAncestors,
  intersect,
  isFixedContainingBlock,
  NO_CLIP,
  parseCornerRadius,
  roundClip,
  scaleRadii,
  union,
  UNBOUNDED,
  type ClipShape,
  type ClipStyle
} from './clipping.ts'

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

// —— 圆角 ——

const shape = (over: Partial<ClipShape> = {}): ClipShape => ({
  border: { x0: 100, y0: 100, x1: 300, y1: 200 },
  borderWidths: [0, 0, 0, 0],
  radii: [
    [16, 16],
    [16, 16],
    [16, 16],
    [16, 16]
  ],
  x: true,
  y: true,
  ...over
})

test('圆角的计算值：单值、双值（椭圆）、百分比', () => {
  assert.deepEqual(parseCornerRadius('12px'), [
    { value: 12, percent: false },
    { value: 12, percent: false }
  ])
  assert.deepEqual(parseCornerRadius('12px 8px'), [
    { value: 12, percent: false },
    { value: 8, percent: false }
  ])
  assert.deepEqual(parseCornerRadius('50%'), [
    { value: 50, percent: true },
    { value: 50, percent: true }
  ])
  assert.deepEqual(parseCornerRadius('0px'), [
    { value: 0, percent: false },
    { value: 0, percent: false }
  ])
})

test('圆角缩放：相邻两角之和超过边长时一起按比例缩小', () => {
  // 200×40 的胶囊写 9999px：短边 40 决定比例，四角都成 20
  const pill = scaleRadii(
    [
      [9999, 9999],
      [9999, 9999],
      [9999, 9999],
      [9999, 9999]
    ],
    200,
    40
  )
  for (const [x, y] of pill) {
    assert.ok(Math.abs(x - 20) < 1e-9 && Math.abs(y - 20) < 1e-9)
  }
  // 放得下时不动
  assert.deepEqual(scaleRadii(shape().radii, 200, 100), shape().radii)
})

test('一个带圆角的祖先：区域就是它的 padding box，四角是内圆角（外圆角减边框宽）', () => {
  const c = roundClip([shape({ borderWidths: [2, 4, 2, 4] })])
  assert.deepEqual(c.box, { x0: 104, y0: 102, x1: 296, y1: 198 })
  // 内圆角：水平 16 − 4 = 12、竖直 16 − 2 = 14，画成圆角取短的 12
  assert.deepEqual(c.radii, [12, 12, 12, 12])
})

test('边框比圆角厚：内圆角是 0（直角）', () => {
  assert.deepEqual(roundClip([shape({ borderWidths: [20, 20, 20, 20] })]).radii, [0, 0, 0, 0])
})

test('只裁一个轴的祖先没有角', () => {
  const c = roundClip([shape({ x: false })])
  assert.deepEqual(c.box, { x0: -Infinity, y0: 100, x1: Infinity, y1: 200 })
  assert.deepEqual(c.radii, [0, 0, 0, 0])
})

test('交集的角只在正好是某个圆角祖先的角时才是圆的', () => {
  // 外层 100–300 带圆角；内层没有圆角、把右边截到 250：左边两个角还是外层的圆角，右边两个是直角
  const outer = shape()
  const inner = shape({
    border: { x0: 50, y0: 50, x1: 250, y1: 400 },
    radii: [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0]
    ]
  })
  const c = roundClip([inner, outer])
  assert.deepEqual(c.box, { x0: 100, y0: 100, x1: 250, y1: 200 })
  assert.deepEqual(c.radii, [16, 0, 0, 16])
})

test('圆角不超过区域短边的一半', () => {
  const tiny = shape({
    border: { x0: 0, y0: 0, x1: 20, y1: 10 },
    radii: [
      [8, 8],
      [8, 8],
      [8, 8],
      [8, 8]
    ]
  })
  // CSS 缩放先把 8 缩到 5（竖直方向 8 + 8 > 10），再不超过 5
  assert.deepEqual(roundClip([tiny]).radii, [5, 5, 5, 5])
})

test('没有裁剪祖先：不裁', () => {
  assert.deepEqual(roundClip([]), NO_CLIP)
})
