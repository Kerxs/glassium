import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GlassPresets } from '../core/material.ts'
import { parseMaterialAttributes } from './attributes.ts'

const from = (attrs: Record<string, string>) =>
  parseMaterialAttributes((name) => (name in attrs ? attrs[name]! : null))

test('没有属性时得到空材质（由 lowerMaterial 的默认值兜底）', () => {
  const r = from({})
  assert.deepEqual(r.material, {})
  assert.deepEqual(r.problems, [])
})

test('preset 打底，其余属性逐项覆盖', () => {
  const r = from({ preset: 'thick', blur: '4' })
  assert.equal(r.material.blur, 4, '显式属性覆盖预设')
  assert.equal(r.material.refraction, GlassPresets.thick.refraction, '未覆盖的字段保留预设值')
})

test('preset 同时接受 camelCase 与 kebab-case', () => {
  assert.equal(from({ preset: 'ultraThin' }).material.blur, GlassPresets.ultraThin.blur)
  assert.equal(from({ preset: 'ultra-thin' }).material.blur, GlassPresets.ultraThin.blur)
})

test('数值属性与 kebab-case 字段名', () => {
  const r = from({ refraction: '0.3', 'depth-effect': '0.5', opacity: '.8' })
  assert.equal(r.material.refraction, 0.3)
  assert.equal(r.material.depthEffect, 0.5)
  assert.equal(r.material.opacity, 0.8)
})

test('带单位的数字被报出来并忽略，而不是悄悄变成默认值', () => {
  // blur="8px" 静默吞掉的话，会被当成「模糊没生效」查半天
  const r = from({ blur: '8px', refraction: '0.2' })
  assert.equal(r.material.blur, undefined, '写错的属性不进材质')
  assert.equal(r.material.refraction, 0.2, '同一元素上别的属性照常生效')
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0]!, /blur="8px"/)
})

test('严格数字：空串、半截的科学计数法都不算', () => {
  for (const bad of ['', ' ', '1e', 'abc', '1..2', 'NaN', 'Infinity']) {
    assert.equal(from({ blur: bad }).problems.length, 1, `"${bad}" 应当被拒`)
  }
  for (const [good, v] of [['8', 8], ['0.5', 0.5], ['.5', 0.5], ['1e1', 10], ['-2', -2]] as const) {
    assert.equal(from({ blur: good }).material.blur, v, `"${good}" 应当被接受`)
  }
})

test('corner-radius 三种写法', () => {
  assert.equal(from({ 'corner-radius': '16' }).material.cornerRadius, 16)
  assert.equal(from({ 'corner-radius': '0.5frac' }).material.cornerRadius, '0.5frac')
  assert.deepEqual(from({ 'corner-radius': '4 32 8 28' }).material.cornerRadius, [4, 32, 8, 28])
})

test('corner-radius 写错时报出来', () => {
  for (const bad of ['4 32 8', 'round', '4 32 8 x', '16px']) {
    const r = from({ 'corner-radius': bad })
    assert.equal(r.material.cornerRadius, undefined)
    assert.equal(r.problems.length, 1, `"${bad}" 应当被报出来`)
  }
})

test('不认识的 preset 报出来，但不影响其余属性', () => {
  const r = from({ preset: 'frosted', blur: '6' })
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0]!, /preset="frosted"/)
  assert.equal(r.material.blur, 6)
})

test('tint 能解析的原样传下去，解析不了的报出来并忽略', () => {
  assert.equal(from({ tint: '#fff3' }).material.tint, '#fff3')
  assert.equal(from({ tint: 'rgba(0, 170, 255, 0.2)' }).material.tint, 'rgba(0, 170, 255, 0.2)')

  // 具名颜色不支持（见 parseTint）。这里不拦的话，它会在 attributeChangedCallback
  // 里经 setMaterial → lowerMaterial 抛出来，整份材质都应用不上。
  const r = from({ tint: 'red', blur: '6' })
  assert.equal(r.material.tint, undefined)
  assert.equal(r.material.blur, 6, '同一元素上别的属性照常生效')
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0]!, /tint="red"/)
})
