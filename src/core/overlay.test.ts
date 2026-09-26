import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GlassPresets } from './material.ts'
import { overlayHostRule, overlayVars } from './overlay.ts'

test('材质 → CSS 玻璃：模糊是同一个 σ、饱和度与 tint 原样、opacity 乘进 tint 与亮边、投影', () => {
  const v = overlayVars({ blur: 16, saturation: 1.5, tint: 'rgba(255, 255, 255, 0.22)', highlight: 0.7, shadow: 0.45 })
  assert.equal(v['--glassium-blur'], '16px')
  assert.equal(v['--glassium-saturate'], '1.5')
  assert.equal(v['--glassium-tint'], 'rgba(255, 255, 255, 0.22)')
  assert.equal(v['--glassium-shadow'], 'rgba(0, 0, 0, 0.068)', '峰值 shadow × 0.3 × 0.5：GPU 影子的不透明度，影子是背后平均色的一半，CSS 只能画黑的')
  const half = overlayVars({ tint: '#ff000080', opacity: 0.5, highlight: 1, shadow: 1 })
  assert.equal(half['--glassium-tint'], 'rgba(255, 0, 0, 0.251)', 'tint 的 alpha 乘上 opacity')
  assert.equal(half['--glassium-shadow'], 'rgba(0, 0, 0, 0.075)')
  assert.equal(half['--glassium-rim-light'], 'rgba(255, 255, 255, 0.275)')
  assert.equal(half['--glassium-rim-side'], 'rgba(255, 255, 255, 0.124)', '左右两侧是上下的 RIM_BASE 倍')
})

test('没写的项用材质的默认值；预设照样换算；写成 :host 规则', () => {
  const d = overlayVars({})
  assert.equal(d['--glassium-blur'], '12px')
  assert.equal(d['--glassium-saturate'], '1.15')
  assert.equal(d['--glassium-tint'], 'rgba(255, 255, 255, 0.1)')
  assert.equal(overlayVars(GlassPresets.clear)['--glassium-blur'], '0px', 'clear 预设不模糊')
  const rule = overlayHostRule({ blur: 4 })
  assert.match(rule, /^:host \{ --glassium-blur: 4px; .*\}$/)
})
