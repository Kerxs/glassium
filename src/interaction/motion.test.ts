import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GlassPresets, lowerMaterial, MATERIAL_DEFAULTS, parseTint } from '../core/material.ts'
import { approach, dimmed, ENERGY, modulate, targetEnergy } from './motion.ts'

const idle = { hover: false, pressed: false, focusVisible: false, disabled: false }

test('能量目标：按下 > 悬停 = 键盘聚焦 > 静止，禁用一律静止', () => {
  assert.equal(targetEnergy(idle), ENERGY.rest)
  assert.equal(targetEnergy({ ...idle, hover: true }), ENERGY.hover)
  assert.equal(targetEnergy({ ...idle, focusVisible: true }), ENERGY.hover)
  assert.equal(targetEnergy({ ...idle, hover: true, pressed: true }), ENERGY.pressed)
  assert.equal(targetEnergy({ ...idle, pressed: true, disabled: true }), ENERGY.rest)
})

test('approach：dt = 0 不动，dt = τ 走掉 1 − 1/e，很久之后到达', () => {
  assert.equal(approach(0, 1, 0, 70), 0)
  assert.ok(Math.abs(approach(0, 1, 70, 70) - (1 - Math.exp(-1))) < 1e-12)
  assert.ok(Math.abs(approach(0, 1, 70 * 30, 70) - 1) < 1e-12)
  assert.equal(approach(0.3, 1, 16, 0), 1, 'τ ≤ 0 直接到目标，不除零')
  assert.equal(approach(0.3, 1, -5, 70), 0.3, '负的 dt（时钟回拨）当 0')
})

test('approach 与帧率无关：两步各走 dt/2 等于一步走 dt', () => {
  const oneStep = approach(0.1, 0.9, 33, 70)
  const twoSteps = approach(approach(0.1, 0.9, 16.5, 70), 0.9, 16.5, 70)
  assert.ok(Math.abs(oneStep - twoSteps) < 1e-12)
})

test('能量为 0 时，调制后的材质降级结果与基础材质逐位相同', () => {
  // 静止的按钮必须和同材质的普通面板画出完全一样的像素。
  // 这里比的是 lowerMaterial 的输出 —— 那就是送进 GPU 的全部数值。
  for (const base of [{}, GlassPresets.thick, { ...GlassPresets.clear, cornerRadius: '1frac' as const }]) {
    for (const size of [[180, 64], [360, 220]] as const) {
      assert.deepEqual(lowerMaterial(modulate(base, 0), size), lowerMaterial(base, size))
    }
  }
})

test('按下时折射更深、位移更强、高光更亮，且高光不超过 1', () => {
  const base = GlassPresets.regular
  const pressed = modulate(base, 1)
  assert.ok(pressed.refraction! > base.refraction)
  assert.ok(pressed.distortion! > base.distortion)
  assert.ok(pressed.highlight! > base.highlight)
  assert.ok(modulate({ highlight: 1 }, 1).highlight! <= 1)
  // 能量越界时钳住，不会外推出负的折射
  assert.equal(modulate(base, -3).refraction, base.refraction)
  assert.equal(modulate(base, 7).refraction, modulate(base, 1).refraction)
})

test('没写的参数按默认值调制，而不是当成 0', () => {
  const pressed = modulate({}, 1)
  assert.ok(Math.abs(pressed.refraction! - MATERIAL_DEFAULTS.refraction * 1.5) < 1e-12)
  assert.ok(Math.abs(pressed.highlight! - (MATERIAL_DEFAULTS.highlight + (1 - MATERIAL_DEFAULTS.highlight) * 0.6)) < 1e-12)
})

test('按下时整块玻璃提亮：只抬 tint 的 alpha，颜色不变', () => {
  const base = GlassPresets.thick // tint rgba(255,255,255,0.22)
  const [r0, g0, b0, a0] = parseTint(base.tint)
  const [r1, g1, b1, a1] = parseTint(modulate(base, 1).tint!)
  assert.ok(Math.abs(a1 - (a0 + (1 - a0) * 0.1)) < 1e-12)
  assert.ok(Math.abs(r1 - r0) < 1e-12 && Math.abs(g1 - g0) < 1e-12 && Math.abs(b1 - b0) < 1e-12)
  // 能量为 0 时 tint 原样返回（连字符串都不变），这是「静止时逐位相同」的一部分
  assert.equal(modulate(base, 0).tint, base.tint)
  // 没写 tint 时从默认值出发
  assert.ok(parseTint(modulate({}, 1).tint!)[3] > parseTint(MATERIAL_DEFAULTS.tint)[3])
})

test('禁用态只压材质的 opacity', () => {
  assert.equal(dimmed({}).opacity, 0.5)
  assert.equal(dimmed({ opacity: 0.8 }).opacity, 0.4)
  assert.equal(dimmed(GlassPresets.thick).refraction, GlassPresets.thick.refraction)
})
