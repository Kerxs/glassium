import { test } from 'node:test'
import assert from 'node:assert/strict'

import { defaultValue, parseRange, ratioOf, snapValue } from './glass-slider.ts'

test('属性 → 取值范围：与原生 range 的默认值相同', () => {
  assert.deepEqual(parseRange(null, null, null), { min: 0, max: 100, step: 1 })
  assert.deepEqual(parseRange('10', '5', null), { min: 10, max: 10, step: 1 }, 'max 小于 min 时当作 min')
  assert.deepEqual(parseRange('0', '1', 'any'), { min: 0, max: 1, step: 0 }, 'step="any" 是连续的')
  assert.deepEqual(parseRange('0', '1', '0'), { min: 0, max: 1, step: 1 }, 'step 0 或负数按默认的 1')
  assert.deepEqual(parseRange('abc', '', '-2'), { min: 0, max: 0, step: 1 }, '空串当 0（Number("") 是 0），写错的用默认值')
})

test('规整：钳进范围、落到最近的一档（从 min 起算）、max 不在档上时取不超过它的那一档', () => {
  const r = { min: 0, max: 100, step: 1 }
  assert.equal(snapValue(42.4, r), 42)
  assert.equal(snapValue(42.5, r), 43)
  assert.equal(snapValue(-5, r), 0)
  assert.equal(snapValue(250, r), 100)
  assert.equal(snapValue(7, { min: 1, max: 10, step: 3 }), 7, '档是 1、4、7、10')
  assert.equal(snapValue(9, { min: 1, max: 10, step: 3 }), 10)
  assert.equal(snapValue(9.9, { min: 0, max: 10, step: 4 }), 8, '档是 0、4、8：最近的 12 超过 max，取 8')
  assert.equal(snapValue(3.3, { min: 0, max: 10, step: 0 }), 3.3, '连续')
  assert.equal(snapValue(NaN, r), 50, '不是数时取中点')
  assert.equal(snapValue(5, { min: 5, max: 5, step: 1 }), 5, '空范围')
})

test('规整：小数档不带出浮点尾巴（0.1 的倍数不是 0.30000000000000004）', () => {
  assert.equal(snapValue(0.3, { min: 0, max: 1, step: 0.1 }), 0.3)
  assert.equal(snapValue(0.7, { min: 0, max: 1, step: 0.1 }), 0.7)
  assert.equal(snapValue(1.005, { min: 0.005, max: 2, step: 0.01 }), 1.005, 'min 的小数位也算')
  assert.equal(snapValue(0.00251, { min: 0, max: 1, step: 2.5e-3 }), 0.0025, '科学计数法写的 step')
})

test('初始值是中点；位置按范围算', () => {
  assert.equal(defaultValue({ min: 0, max: 100, step: 1 }), 50)
  assert.equal(defaultValue({ min: 0, max: 5, step: 1 }), 3, '中点 2.5 落到档上：四舍五入到 3（与原生相同）')
  assert.equal(ratioOf(25, { min: 0, max: 100, step: 1 }), 0.25)
  assert.equal(ratioOf(5, { min: 5, max: 5, step: 1 }), 0)
})
