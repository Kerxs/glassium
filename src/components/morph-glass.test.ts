import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cubicBezier, MORPH_GLASS_EASE } from './morph-glass.ts'

test('cubic-bezier：两头、线性、CSS 的 ease 在 0.5 处', () => {
  const linear = cubicBezier(0, 0, 1, 1)
  for (const t of [0, 0.1, 0.37, 0.5, 0.9, 1]) assert.ok(Math.abs(linear(t) - t) < 1e-6)
  const ease = cubicBezier(0.25, 0.1, 0.25, 1)
  assert.equal(ease(0), 0)
  assert.equal(ease(1), 1)
  // 浏览器里 cubic-bezier(0.25, 0.1, 0.25, 1) 在 0.5 处约 0.8024
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 1e-3, `ease(0.5) = ${ease(0.5)}`)
})

test('变形的形状缓动：两头精确、途中略微回弹（超过 1）、单调走到回弹顶点', () => {
  assert.equal(MORPH_GLASS_EASE(0), 0)
  assert.equal(MORPH_GLASS_EASE(1), 1)
  let peak = 0
  for (let i = 1; i < 100; i++) peak = Math.max(peak, MORPH_GLASS_EASE(i / 100))
  assert.ok(peak > 1 && peak < 1.1, `回弹顶点 ${peak}`)
})

test('cubic-bezier：x 的控制点贴边（导数接近 0）时二分兜底', () => {
  const f = cubicBezier(1, 0, 1, 1) // x'(0) = 3，x'(1) 接近 0
  let prev = -1
  for (let i = 0; i <= 50; i++) {
    const v = f(i / 50)
    assert.ok(v >= prev - 1e-9)
    prev = v
  }
})
