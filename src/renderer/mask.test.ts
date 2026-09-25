import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTint } from '../core/material.ts'
import { MASK_FLOATS, maskBox, packMask, parseMask, resolveMask, sameMask, type MaskStyle } from './mask.ts'

const color = (css: string): readonly [number, number, number, number] | null => {
  try {
    return parseTint(css)
  } catch {
    return null
  }
}

/** Chrome 的默认计算值。 */
const style = (over: Partial<MaskStyle> = {}): MaskStyle => ({
  image: 'none',
  mode: 'match-source',
  size: 'auto',
  position: '0% 0%',
  origin: 'border-box',
  clip: 'border-box',
  ...over
})

const FADE = 'linear-gradient(to right, rgba(0, 0, 0, 0), rgb(0, 0, 0) 25%, rgb(0, 0, 0) 75%, rgba(0, 0, 0, 0))'

test('解析：none；一层渐变；默认的 size / position 不警告', () => {
  assert.deepEqual(parseMask(style(), color), { kind: 'none' })
  const p = parseMask(style({ image: FADE }), color)
  assert.equal(p.kind, 'mask')
  assert.ok(p.kind === 'mask')
  assert.equal(p.value.paint.kind, 'linear')
  assert.equal(p.value.luminance, false)
  assert.equal(p.value.origin, 'border-box')
  assert.equal(p.value.clip, 'border-box')
  assert.deepEqual(p.warnings, [])
  // 100% 100% 与 auto 一样铺满
  const full = parseMask(style({ image: FADE, size: '100% 100%' }), color)
  assert.ok(full.kind === 'mask' && full.warnings.length === 0)
})

test('解析：别的 size / position 警告、按铺满近似；luminance、origin、no-clip；画不了的给出理由', () => {
  const odd = parseMask(style({ image: FADE, size: '50% 100%', position: '50% 50%' }), color)
  assert.ok(odd.kind === 'mask' && odd.warnings.length === 2)
  const lum = parseMask(style({ image: FADE, mode: 'luminance', origin: 'padding-box', clip: 'no-clip' }), color)
  assert.ok(lum.kind === 'mask')
  assert.equal(lum.value.luminance, true)
  assert.equal(lum.value.origin, 'padding-box')
  assert.equal(lum.value.clip, null)
  const fill = parseMask(style({ image: FADE, origin: 'fill-box', clip: 'view-box' }), color)
  assert.ok(fill.kind === 'mask' && fill.value.origin === 'content-box' && fill.value.clip === 'border-box')
  assert.equal(parseMask(style({ image: 'url("#m")' }), color).kind, 'unsupported')
  const two = parseMask(style({ image: `${FADE}, ${FADE}` }), color)
  assert.ok(two.kind === 'unsupported' && two.reason.includes('2 层'))
  assert.equal(parseMask(style({ image: 'conic-gradient(red, blue)' }), color).kind, 'unsupported')
})

test('mask-origin 的盒子：border / padding / content', () => {
  const border = { x0: 100, y0: 100, x1: 300, y1: 200 }
  assert.deepEqual(maskBox('border-box', border, [2, 4, 6, 8], [1, 1, 1, 1]), border)
  assert.deepEqual(maskBox('padding-box', border, [2, 4, 6, 8], [1, 1, 1, 1]), { x0: 108, y0: 102, x1: 296, y1: 194 })
  assert.deepEqual(maskBox('content-box', border, [2, 4, 6, 8], [1, 2, 3, 4]), { x0: 112, y0: 103, x1: 294, y1: 191 })
})

test('解算：几何换到画布设备像素（绝对坐标）；luminance 乘亮度', () => {
  const p = parseMask(style({ image: FADE }), color)
  assert.ok(p.kind === 'mask')
  const toDevice = (x: number, y: number): readonly [number, number] => [x * 1.5, y * 1.5]
  const m = resolveMask(p.value, { x0: 100, y0: 100, x1: 500, y1: 200 }, toDevice, 1.5, 1.5)!
  assert.equal(m.kind, 'linear')
  // to right：0% 在左边中点、100% 在右边中点
  assert.deepEqual(m.geometry, [150, 225, 750, 225])
  assert.deepEqual(m.alphas, [0, 1, 1, 0])
  assert.deepEqual(m.offsets, [0, 0.25, 0.75, 1])
  // 径向 closest-side 的圆：中心、半径乘上缩放
  const radial = parseMask(style({ image: 'radial-gradient(circle closest-side, rgb(0, 0, 0) 60%, rgba(0, 0, 0, 0))' }), color)
  assert.ok(radial.kind === 'mask')
  const r = resolveMask(radial.value, { x0: 0, y0: 0, x1: 200, y1: 100 }, toDevice, 1.5, 1.5)!
  assert.deepEqual(r.geometry, [150, 75, 75, 75])
  // luminance：白 → 1，黑 → 0，alpha 也乘上
  const lum = parseMask(style({ image: 'linear-gradient(rgb(255, 255, 255), rgba(0, 0, 0, 1))', mode: 'luminance' }), color)
  assert.ok(lum.kind === 'mask')
  assert.deepEqual(resolveMask(lum.value, { x0: 0, y0: 0, x1: 10, y1: 10 }, toDevice, 1.5, 1.5)!.alphas, [1, 0])
  // 空盒子：null
  assert.equal(resolveMask(p.value, { x0: 0, y0: 0, x1: 0, y1: 10 }, toDevice, 1, 1), null)
})

test('打包：种类、色标数、方向 ÷ 长度²、倒数；没有遮罩时整段清零', () => {
  const data = new Float32Array(MASK_FLOATS + 8).fill(7)
  packMask(data, 4, { kind: 'linear', repeating: true, geometry: [10, 20, 110, 20], alphas: [0, 1, 0], offsets: [0.2, 0.2, 0.7] })
  const at = (i: number): number => data[4 + i]!
  assert.deepEqual([at(0), at(1), at(2), at(3)], [1, 3, 1, 0])
  assert.deepEqual([at(4), at(5)], [10, 20])
  assert.ok(Math.abs(at(6) - 0.01) < 1e-9 && at(7) === 0)
  assert.deepEqual([at(8), at(9), at(10)], [0, 1, 0])
  assert.deepEqual([at(16), at(17), at(18)].map((v) => Math.round(v * 10) / 10), [0.2, 0.2, 0.7])
  assert.ok(Math.abs(at(21) - 2) < 1e-6, '周期 0.5 的倒数')
  assert.ok(Math.abs(at(22) - 0.5) < 1e-6)
  assert.equal(at(24), 0, '重合的两个色标：硬边')
  assert.ok(Math.abs(at(25) - 2) < 1e-6)
  assert.equal(data[3], 7, '前面没写')
  assert.equal(data[4 + MASK_FLOATS], 7, '后面没写')
  packMask(data, 4, null)
  assert.ok(data.subarray(4, 4 + MASK_FLOATS).every((v) => v === 0))
})

test('sameMask：按值比', () => {
  const a = { kind: 'linear', repeating: false, geometry: [0, 0, 1, 1], alphas: [0, 1], offsets: [0, 1] } as const
  assert.equal(sameMask(a, { ...a }), true)
  assert.equal(sameMask(a, { ...a, alphas: [0, 0.5] }), false)
  assert.equal(sameMask(a, null), false)
  assert.equal(sameMask(null, null), true)
})
