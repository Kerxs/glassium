import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertBlendSpace, linearToSrgb, srgbToLinear } from './color.ts'

test('sRGB ↔ 线性光：端点、中灰与互逆', () => {
  assert.equal(srgbToLinear(0), 0)
  assert.equal(srgbToLinear(1), 1)
  assert.ok(Math.abs(srgbToLinear(0.5) - 0.21404) < 1e-5)
  assert.ok(Math.abs(linearToSrgb(0.21404) - 0.5) < 1e-5)
  for (let i = 0; i <= 100; i++) {
    const c = i / 100
    assert.ok(Math.abs(linearToSrgb(srgbToLinear(c)) - c) < 1e-9, `c = ${c}`)
  }
  // 负数按 0 算
  assert.equal(srgbToLinear(-0.2), 0)
  assert.equal(linearToSrgb(-0.2), 0)
})

test('8 位的 sRGB 值解码再编码回来逐个相同（sRGB 格式的纹理存线性值不丢级）', () => {
  for (let i = 0; i < 256; i++) {
    assert.equal(Math.round(linearToSrgb(srgbToLinear(i / 255)) * 255), i, `第 ${i} 级`)
  }
})

test('分段处两边接得上，整体单调', () => {
  const knee = 0.04045
  assert.ok(Math.abs(knee / 12.92 - ((knee + 0.055) / 1.055) ** 2.4) < 1e-7)
  let prev = -1
  for (let i = 0; i <= 1000; i++) {
    const v = srgbToLinear(i / 1000)
    assert.ok(v > prev)
    prev = v
  }
})

test('线性光里模糊黑白阶跃：中点是 180 而不是 128（验证页 linear-light 的预期值）', () => {
  // calibration 场景的阶跃两侧：0.04 与 0.96
  const dark = srgbToLinear(0.04)
  const light = srgbToLinear(0.96)
  const mid = linearToSrgb((dark + light) / 2) * 255
  assert.ok(Math.abs(mid - 180.2) < 0.1, `中点 ${mid}`)
  assert.ok(Math.abs(((0.04 + 0.96) / 2) * 255 - 127.5) < 1e-9)
})

test('大于 1 的线性值照曲线外推（高光），不钳', () => {
  assert.ok(linearToSrgb(1.5) > 1)
  assert.ok(Math.abs(linearToSrgb(1) - 1) < 1e-12)
})

test('blendSpace 写错在调用处就抛', () => {
  assertBlendSpace('srgb')
  assertBlendSpace('linear')
  assert.throws(() => assertBlendSpace('sRGB'), TypeError)
  assert.throws(() => assertBlendSpace(undefined), TypeError)
})
