import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lensMap } from './css-lens.ts'

test('lensMap：中心放大 m 倍，边上回到 ±1，与透镜外接上', () => {
  for (const m of [1, 1.1, 1.2, 1.5]) {
    assert.equal(lensMap(0, m), 0)
    assert.ok(Math.abs(lensMap(1, m) - 1) < 1e-12, `m=${m} 右边`)
    assert.ok(Math.abs(lensMap(-1, m) + 1) < 1e-12, `m=${m} 左边`)
    const slope = (lensMap(0.01, m) - lensMap(-0.01, m)) / 0.02
    assert.ok(Math.abs(slope - 1 / m) < 1e-6, `m=${m} 中心的斜率是 1/m`)
  }
})

test('lensMap：单调，不把内容翻过来；不放大时是恒等', () => {
  let last = -Infinity
  for (let i = -100; i <= 100; i++) {
    const v = lensMap(i / 100, 1.2)
    assert.ok(v > last)
    last = v
    assert.ok(Math.abs(lensMap(i / 100, 1) - i / 100) < 1e-12)
  }
})
