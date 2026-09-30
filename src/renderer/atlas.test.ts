import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ATLAS_GUTTER, ATLAS_MAX_UPLOAD_RECTS, LabelAtlas, ShelfAllocator, bitmapUv, mergeDirtyRects, rasterFit } from './atlas.ts'

type Cell = { x: number; y: number; w: number; h: number }

/** 两格（连同空隙）不重叠。 */
function apart(a: Cell, b: Cell, g: number): boolean {
  return a.x + a.w + g <= b.x - g || b.x + b.w + g <= a.x - g || a.y + a.h + g <= b.y - g || b.y + b.h + g <= a.y - g
}

test('货架式分配：格子不重叠、四周留空隙、都在图集里', () => {
  const alloc = new ShelfAllocator(256, 256)
  const cells: Cell[] = []
  const sizes = [
    [100, 20],
    [40, 30],
    [60, 20],
    [120, 18],
    [30, 50],
    [90, 20]
  ] as const
  for (const [w, h] of sizes) {
    const at = alloc.allocate(w, h)
    assert.ok(at, `${w}×${h} 放得下`)
    cells.push({ ...at, w, h })
  }
  for (const c of cells) {
    assert.ok(c.x >= ATLAS_GUTTER && c.y >= ATLAS_GUTTER, '左上留空隙')
    assert.ok(c.x + c.w + ATLAS_GUTTER <= 256 && c.y + c.h + ATLAS_GUTTER <= 256, '右下留空隙、不出界')
  }
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) assert.ok(apart(cells[i]!, cells[j]!, ATLAS_GUTTER), `${i} 与 ${j} 重叠`)
  }
})

test('矮的格子放进已有的一排（挑最矮的够高的那排），不新开一排', () => {
  const alloc = new ShelfAllocator(256, 256)
  const tall = alloc.allocate(50, 40)!
  const short = alloc.allocate(50, 10)!
  assert.equal(short.y, tall.y, '放在同一排')
  const low = alloc.allocate(200, 10)! // 第一排剩下的不够宽：新开一排
  assert.ok(low.y > tall.y)
  const small = alloc.allocate(20, 8)! // 两排都放得下：挑矮的那排
  assert.equal(small.y, low.y)
})

test('放不下返回 null；比图集还大、尺寸不是正数也是 null；reset 之后从头来', () => {
  const alloc = new ShelfAllocator(64, 64)
  assert.equal(alloc.allocate(80, 10), null)
  assert.equal(alloc.allocate(0, 10), null)
  assert.equal(alloc.allocate(10, -1), null)
  assert.ok(alloc.allocate(62, 30))
  assert.ok(alloc.allocate(62, 30))
  assert.equal(alloc.allocate(62, 30), null, '满了')
  alloc.reset()
  assert.deepEqual(alloc.allocate(62, 30), { x: ATLAS_GUTTER, y: ATLAS_GUTTER })
})

test('Node 里没有 2D 画布：LabelAtlas.create 返回 null（位图填充就不画），不抛', () => {
  if (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined') return
  assert.equal(LabelAtlas.create(), null)
})

test('rasterFit：默认按设备像素画，oversample 画得更细，超过一格的上限整体缩小', () => {
  assert.deepEqual(rasterFit(200, 40, 1024), { fit: 1, pxW: 200, pxH: 40 })
  assert.deepEqual(rasterFit(200.4, 40.2, 1024), { fit: 1, pxW: 201, pxH: 41 }, '向上取整')
  assert.deepEqual(rasterFit(200, 40, 1024, 1.5), { fit: 1.5, pxW: 300, pxH: 60 })
  assert.deepEqual(rasterFit(200, 40, 1024, 0.5), { fit: 1, pxW: 200, pxH: 40 }, 'oversample 小于 1 按 1')
  const big = rasterFit(2048, 100, 1024)
  assert.equal(big.fit, 0.5)
  assert.equal(big.pxW, 1024)
  const both = rasterFit(800, 100, 1024, 2)
  assert.equal(both.fit, 1024 / 800, 'oversample 也不超过上限')
  assert.equal(both.pxW, 1024)
})

test('bitmapUv：没有锚点时 uv 原点是格子的左上角', () => {
  const [u, v, du, dv] = bitmapUv({ x: 10, y: 20 }, { x: 300, y: 400 }, 300, 400, 1, 1024, 512)
  assert.equal(u, 10 / 1024)
  assert.equal(v, 20 / 512)
  assert.equal(du, 1 / 1024)
  assert.equal(dv, 1 / 512)
})

test('bitmapUv：有锚点时 uv 原点挪到盒子盖住的那一块（按 fit 换成图集像素）', () => {
  // 锚点（一排字）在 (100, 50)，透镜的盒子在 (160, 44)：右 60、上 6 个设备像素
  const cell = { x: 8, y: 30 }
  const anchor = { x: 100, y: 50 }
  const [u, v, du, dv] = bitmapUv(cell, anchor, 160, 44, 1, 1024, 1024)
  assert.equal(u * 1024, 8 + 60)
  assert.equal(v * 1024, 30 - 6, '盒子比锚点高：uv 在格子上面（那里是空隙，采样到透明）')
  assert.equal(du, dv)
  // 盒子里第 k 个设备像素取样到锚点画面里的同一处：u + k·du = cell.x + (box.x + k − anchor.x)·fit
  const fit = 1.5
  const g = bitmapUv(cell, anchor, 160, 44, fit, 1024, 1024)
  for (const k of [0, 10, 37.5]) {
    assert.ok(Math.abs((g[0] + k * g[2]) * 1024 - (cell.x + (160 + k - anchor.x) * fit)) < 1e-9)
    assert.ok(Math.abs((g[1] + k * g[3]) * 1024 - (cell.y + (44 + k - anchor.y) * fit)) < 1e-9)
  }
})

test('局部上传：相接的块并起来，隔开的分开，裁在图集里', () => {
  const r = mergeDirtyRects(
    [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 10, y: 0, w: 10, h: 10 }, // 与第一块相接
      { x: 100, y: 100, w: 20, h: 20 },
      { x: 1020, y: 5, w: 20, h: 4 } // 伸出图集右边
    ],
    1024,
    1024
  )
  assert.deepEqual(r, [
    { x: 0, y: 0, w: 20, h: 10 },
    { x: 100, y: 100, w: 20, h: 20 },
    { x: 1020, y: 5, w: 4, h: 4 }
  ])
  assert.deepEqual(mergeDirtyRects([], 1024, 1024), [])
  assert.deepEqual(mergeDirtyRects([{ x: 2000, y: 0, w: 5, h: 5 }], 1024, 1024), [], '完全在外面的丢掉')
})

test('局部上传：并完又碰到别的块时接着并；块太多并成外接矩形；面积太大整张传', () => {
  // 第三块把前两块连起来
  const chain = mergeDirtyRects(
    [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 30, y: 0, w: 10, h: 10 },
      { x: 5, y: 0, w: 30, h: 10 }
    ],
    1024,
    1024
  )
  assert.deepEqual(chain, [{ x: 0, y: 0, w: 40, h: 10 }])
  const many = Array.from({ length: ATLAS_MAX_UPLOAD_RECTS + 1 }, (_, i) => ({ x: i * 50, y: 0, w: 10, h: 10 }))
  assert.deepEqual(mergeDirtyRects(many, 1024, 1024), [{ x: 0, y: 0, w: ATLAS_MAX_UPLOAD_RECTS * 50 + 10, h: 10 }])
  assert.equal(mergeDirtyRects([{ x: 0, y: 0, w: 1024, h: 600 }], 1024, 1024), null)
})

test('dirtySince：只给出之后画过的格子；清空、长大、记录太旧时整张（null）', () => {
  // Node 里没有 2D 画布：换一个什么都不画的替身
  const g = globalThis as { OffscreenCanvas?: unknown }
  const had = g.OffscreenCanvas
  const noop = (): void => undefined
  g.OffscreenCanvas = class {
    width: number
    height: number
    constructor(w: number, h: number) {
      this.width = w
      this.height = h
    }
    getContext(): unknown {
      return { save: noop, restore: noop, setTransform: noop, clearRect: noop, beginPath: noop, rect: noop, clip: noop }
    }
  }
  try {
    const atlas = LabelAtlas.create(256)!
    const a = atlas.allocate(20, 10)!
    atlas.draw(a, 1, noop)
    const v1 = atlas.version
    const b = atlas.allocate(30, 10)!
    atlas.draw(b, 1, noop)
    const G = ATLAS_GUTTER
    assert.deepEqual(atlas.dirtySince(v1), [{ x: b.x - G, y: b.y - G, w: b.w + 2 * G, h: b.h + 2 * G }], '只有 b')
    assert.deepEqual(atlas.dirtySince(atlas.version), [], '版本没变：什么都不传')
    // 同一格画两次：并成一块
    atlas.draw(b, 1, noop)
    assert.equal(atlas.dirtySince(v1)!.length, 1)
    // 放不下：清空重排 —— 之前的版本都要整张传
    const before = atlas.version
    atlas.allocate(250, 250)
    assert.equal(atlas.dirtySince(before), null)
    // （250×250 占满了这张图集，这一格又清空一次）
    const c = atlas.allocate(8, 8)
    assert.ok(c)
    const after = atlas.version
    atlas.draw(c!, 1, noop)
    assert.equal(atlas.dirtySince(after)!.length, 1, '清空之后传过的版本：照旧只传新画的')
    // 记录只留最近的几笔
    const old = atlas.version
    for (let i = 0; i < 70; i++) atlas.draw(c!, 1, noop)
    assert.equal(atlas.dirtySince(old), null)
  } finally {
    g.OffscreenCanvas = had
  }
})
