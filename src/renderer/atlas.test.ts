import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ATLAS_GUTTER, LabelAtlas, ShelfAllocator } from './atlas.ts'

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
