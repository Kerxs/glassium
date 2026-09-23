import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GlassPresets, parseTint } from './material.ts'
import {
  FROST,
  frostFor,
  frostForColor,
  reduceTransparency,
  REDUCED_TRANSPARENCY,
  relativeLuminance
} from './transparency.ts'

const contrast = (l1: number, l2: number): number => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)

test('相对亮度：黑 0、白 1、Rec.709 权重', () => {
  assert.equal(relativeLuminance(0, 0, 0), 0)
  assert.ok(Math.abs(relativeLuminance(1, 1, 1) - 1) < 1e-12)
  assert.ok(Math.abs(relativeLuminance(0, 1, 0) - 0.7152) < 1e-12)
})

test('磨砂选对比度更高的那种：分界在 L ≈ 0.179，两侧各自是更好的选择', () => {
  for (let i = 0; i <= 100; i++) {
    const l = i / 100
    const pick = frostFor(l)
    const vsBlack = contrast(l, 0)
    const vsWhite = contrast(l, 1)
    assert.equal(pick, vsBlack >= vsWhite ? 'dark' : 'light', `L = ${l}`)
  }
  assert.equal(frostForColor('#fff'), 'dark')
  assert.equal(frostForColor('rgb(20, 20, 20)'), 'light')
  assert.equal(frostForColor('oklch(0.9 0.1 120)'), 'dark', '解析不了的写法当作浅色文字')
})

test('选出来的磨砂与文字的对比度至少 4.5:1（WCAG AA 正文），按磨砂自身的颜色算', () => {
  // 磨砂 alpha 0.8，底下还有 20% 的背景；这里验的是磨砂颜色本身与文字 —— 背景再糊也只会拉近一点
  for (const text of ['#ffffff', '#f5f5f5', '#dddddd', '#000000', '#222222', '#444444']) {
    const [r, g, b] = parseTint(text)
    const lt = relativeLuminance(r, g, b)
    const f = FROST[frostForColor(text)]
    const lf = relativeLuminance(f[0], f[1], f[2])
    assert.ok(contrast(lt, lf) >= 4.5, `${text} 与磨砂的对比度 ${contrast(lt, lf).toFixed(2)}`)
  }
})

test('变换：模糊有下限、色散关掉、淡的 tint 换成磨砂、显眼的 tint 保留颜色并加厚', () => {
  const regular = reduceTransparency(GlassPresets.regular, 'dark')
  assert.equal(regular.blur, REDUCED_TRANSPARENCY.minBlurDp)
  assert.equal(regular.dispersion, 0)
  assert.deepEqual(parseTint(regular.tint!), [28 / 255, 28 / 255, 32 / 255, REDUCED_TRANSPARENCY.frostAlpha])
  assert.equal(regular.refraction, GlassPresets.regular.refraction, '形状与折射保留')
  assert.equal(regular.highlight, GlassPresets.regular.highlight, '高光保留')

  const heavy = reduceTransparency({ blur: 40, tint: 'rgba(0, 90, 200, 0.5)' }, 'light')
  assert.equal(heavy.blur, 40, '本来就更糊的不动')
  const [r, g, b, a] = parseTint(heavy.tint!)
  assert.deepEqual([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)], [0, 90, 200])
  assert.equal(a, REDUCED_TRANSPARENCY.ownTintAlpha)

  // 没写 tint 的材质按默认值（0.18 白）算：够淡，换成磨砂
  assert.deepEqual(parseTint(reduceTransparency({}, 'light').tint!), [242 / 255, 242 / 255, 247 / 255, 0.8])
  // 不透明度（比如禁用态变淡）保留
  assert.equal(reduceTransparency({ opacity: 0.5 }, 'dark').opacity, 0.5)
})
