import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  clipAxesOf,
  clippingAncestors,
  EMPTY_CLIP,
  fitRoundedBox,
  intersect,
  isFixedContainingBlock,
  NO_CLIP,
  packClipExtras,
  parseCornerRadius,
  roundClip,
  scaleRadii,
  union,
  UNBOUNDED,
  type ClipShape,
  type ClipStyle,
  type RoundedBox
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
  // 内圆角两个轴各算各的：水平 16 − 4 = 12、竖直 16 − 2 = 14 —— 椭圆角
  assert.deepEqual(c.rx, [12, 12, 12, 12])
  assert.deepEqual(c.ry, [14, 14, 14, 14])
  assert.equal(c.shape, null, '角都落在交集的角上：不用单独算')
})

test('四边边框一样宽：内圆角仍是圆角（两个半径相等 —— 着色器走原来的算法）', () => {
  const c = roundClip([shape({ borderWidths: [4, 4, 4, 4] })])
  assert.deepEqual(c.rx, [12, 12, 12, 12])
  assert.deepEqual(c.ry, [12, 12, 12, 12])
})

test('边框比圆角厚：内圆角是 0（直角）；只有一个轴厚也是直角', () => {
  const thick = roundClip([shape({ borderWidths: [20, 20, 20, 20] })])
  assert.deepEqual([thick.rx, thick.ry], [[0, 0, 0, 0], [0, 0, 0, 0]])
  const oneAxis = roundClip([shape({ borderWidths: [20, 4, 20, 4] })])
  assert.deepEqual([oneAxis.rx, oneAxis.ry], [[0, 0, 0, 0], [0, 0, 0, 0]])
})

test('只裁一个轴的祖先没有角', () => {
  const c = roundClip([shape({ x: false })])
  assert.deepEqual(c.box, { x0: -Infinity, y0: 100, x1: Infinity, y1: 200 })
  assert.deepEqual(c.rx, [0, 0, 0, 0])
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
  assert.deepEqual(c.rx, [16, 0, 0, 16])
  // 外层右边两个角在 284–300，够不着截到 250 的交集：不用单独算
  assert.equal(c.shape, null)
})

test('圆角被别的裁剪从中间截断：整个圆角区域交给着色器单独算', () => {
  // 外层 100–300 带圆角 40；内层把右边截到 290 —— 外层右边两个角的圆弧（260–300）有一截落在交集里
  const outer = shape({
    radii: [
      [40, 40],
      [40, 40],
      [40, 40],
      [40, 40]
    ]
  })
  const inner = shape({ border: { x0: 50, y0: 50, x1: 290, y1: 400 }, radii: [[0, 0], [0, 0], [0, 0], [0, 0]] })
  const c = roundClip([inner, outer])
  assert.deepEqual(c.box, { x0: 100, y0: 100, x1: 290, y1: 200 })
  assert.deepEqual(c.rx, [40, 0, 0, 40], '左边两个角仍落在交集的角上')
  assert.deepEqual(c.shape, { box: { x0: 100, y0: 100, x1: 300, y1: 200 }, rx: [40, 40, 40, 40], ry: [40, 40, 40, 40] })
})

test('几个圆角区域都要单独算时挑面积最小的', () => {
  const big = shape({ border: { x0: 0, y0: 0, x1: 400, y1: 400 }, radii: [[60, 60], [60, 60], [60, 60], [60, 60]] })
  const small: RoundedBox = { box: { x0: 350, y0: 350, x1: 450, y1: 450 }, rx: [50, 50, 50, 50], ry: [50, 50, 50, 50] }
  // 交集 350–400：两个区域的角都没落在交集的角上（大的右下角在 400,400 —— 落上了；小的左上角在 350,350 —— 也落上了）
  const c = roundClip([big], [small])
  assert.deepEqual(c.box, { x0: 350, y0: 350, x1: 400, y1: 400 })
  // 交集的右下角是大的右下角，左上角是小的左上角：都吸收了，四角半径按交集的一半封顶（25）
  assert.deepEqual(c.rx, [25, 0, 25, 0])
  assert.equal(c.shape, null)
  // 再加一个直角的裁剪截到 395：两个圆角区域都有圆角落在交集里、又不在交集的角上 —— 挑面积小的（小圆）
  const cut = shape({ border: { x0: 0, y0: 0, x1: 395, y1: 395 }, radii: [[0, 0], [0, 0], [0, 0], [0, 0]] })
  const near: RoundedBox = { ...small, box: { x0: 330, y0: 330, x1: 430, y1: 430 } }
  const d = roundClip([big, cut], [near])
  assert.deepEqual(d.box, { x0: 330, y0: 330, x1: 395, y1: 395 })
  assert.deepEqual(d.shape?.box, near.box, '面积小的那个单独算')
})

test('clip-path 的圆：盒子 = 外接正方形、四角是半径；在交集里面时角正好落上，不用单独算', () => {
  const circle = fitRoundedBox({ x0: 150, y0: 110, x1: 230, y1: 190 }, [[40, 40], [40, 40], [40, 40], [40, 40]])
  const c = roundClip([], [circle])
  assert.deepEqual(c.box, circle.box)
  assert.deepEqual(c.rx, [40, 40, 40, 40])
  assert.equal(c.shape, null)
  // 被 overflow 的祖先从中间截断（右边截到 200）：圆整个单独算，交集是直角
  const cut = roundClip([shape({ border: { x0: 0, y0: 0, x1: 200, y1: 400 }, radii: [[0, 0], [0, 0], [0, 0], [0, 0]] })], [circle])
  assert.deepEqual(cut.box, { x0: 150, y0: 110, x1: 200, y1: 190 })
  // 左边两个角落在交集的角上，按交集的半宽封顶（25）；圆本身整个单独算，形状是准的
  assert.deepEqual(cut.rx, [25, 0, 0, 25])
  assert.deepEqual(cut.shape, circle)
})

test('交集是空的（circle(0%)、整个被滚出了容器）：什么都看不见', () => {
  const point = fitRoundedBox({ x0: 150, y0: 150, x1: 150, y1: 150 }, [[0, 0], [0, 0], [0, 0], [0, 0]])
  assert.equal(roundClip([], [point]), EMPTY_CLIP)
  const apart = roundClip([shape(), shape({ border: { x0: 400, y0: 100, x1: 500, y1: 200 } })])
  assert.equal(apart, EMPTY_CLIP)
  // 空的区域与任何矩形求交还是空的，求并不改变对方
  const b = { x0: 1, y0: 2, x1: 3, y1: 4 }
  assert.deepEqual(union(EMPTY_CLIP.box, b), b)
  const i = intersect(EMPTY_CLIP.box, b)
  assert.ok(!(i.x1 > i.x0))
})

test('fitRoundedBox：按 CSS 的规则缩放；有一个半径是 0 的角是直角', () => {
  const r = fitRoundedBox({ x0: 0, y0: 0, x1: 100, y1: 40 }, [[80, 30], [80, 30], [0, 10], [10, 0]])
  // 上边 80 + 80 > 100：一起乘 100/160
  assert.deepEqual(r.rx, [50, 50, 0, 0])
  assert.deepEqual(r.ry, [18.75, 18.75, 0, 0])
})

test('packClipExtras：竖直半径、倒数（0 写 0）、形状；没有形状时写「不裁」', () => {
  const data = new Float32Array(40).fill(7)
  packClipExtras(data, 0, 12, [2, 0, 4, 8], [2, 0, 5, 8], { box: { x0: 1, y0: 2, x1: 3, y1: Infinity }, rx: [10, 10, 10, 10], ry: [5, 5, 5, 5] })
  assert.deepEqual([...data.subarray(0, 4)], [2, 0, 5, 8])
  assert.deepEqual([...data.subarray(4, 8)], [0.5, 0, 0.25, 0.125])
  assert.deepEqual([...data.subarray(8, 12)], [0.5, 0, 0.2, 0.125].map(Math.fround))
  assert.deepEqual([...data.subarray(12, 16)], [1, 2, 3, 65536])
  assert.deepEqual([...data.subarray(16, 20)], [10, 10, 10, 10])
  assert.deepEqual([...data.subarray(24, 28)], [0.1, 0.1, 0.1, 0.1].map(Math.fround))
  packClipExtras(data, 0, 12, [0, 0, 0, 0], [0, 0, 0, 0], null)
  assert.deepEqual([...data.subarray(12, 16)], [-65536, -65536, 65536, 65536])
  assert.ok(data.subarray(16, 32).every((v) => v === 0))
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
  assert.deepEqual(roundClip([tiny]).rx, [5, 5, 5, 5])
})

test('没有裁剪祖先：不裁', () => {
  assert.deepEqual(roundClip([]), NO_CLIP)
})
