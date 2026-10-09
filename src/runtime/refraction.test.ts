import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bandOf, mapPixels, scaleOf } from './refraction.ts'

test('边宽：短边 × refraction × 0.5，钳在 3–48px；不折射时是 0', () => {
  assert.equal(bandOf(0, 300, 200), 0)
  assert.equal(bandOf(0.2, 300, 200), 20)
  assert.equal(bandOf(0.01, 300, 200), 3, '再窄也有 3px')
  assert.equal(bandOf(1, 400, 400), 48, '最宽 48px')
  assert.equal(scaleOf(20, 1), 32, '最远拉 边宽 × 0.8（scale 是两倍）')
  assert.equal(scaleOf(20, 0), 0)
})

test('位移图：中间不动（128）；边上沿朝外的法线拉，越靠边越多', () => {
  const w = 60
  const h = 40
  const px = mapPixels({ width: w, height: h, radius: 10, band: 8 })
  const at = (x: number, y: number): [number, number] => {
    const i = (y * w + x) * 4
    return [px[i]!, px[i + 1]!]
  }
  assert.deepEqual(at(30, 20), [128, 128], '中间不动')
  const [leftR, leftG] = at(0, 20)
  assert.ok(leftR < 60 && Math.abs(leftG - 128) <= 1, `左边往左拉：${leftR},${leftG}`)
  const [rightR] = at(w - 1, 20)
  assert.ok(rightR > 196, `右边往右拉：${rightR}`)
  const [, topG] = at(30, 0)
  assert.ok(topG < 60, `上边往上拉：${topG}`)
  const [, bottomG] = at(30, h - 1)
  assert.ok(bottomG > 196, `下边往下拉：${bottomG}`)
  // 越靠边越多
  assert.ok(at(1, 20)[0] < at(4, 20)[0] && at(4, 20)[0] < at(7, 20)[0])
  // 角上沿对角线往外：两个通道都偏
  const [cr, cg] = at(3, 3)
  assert.ok(cr < 128 && cg < 128, `左上角往左上拉：${cr},${cg}`)
})

test('位移图：没有边宽时整张不动', () => {
  const px = mapPixels({ width: 8, height: 8, radius: 4, band: 0 })
  for (let i = 0; i < px.length; i += 4) assert.deepEqual([px[i], px[i + 1], px[i + 3]], [128, 128, 255])
})
