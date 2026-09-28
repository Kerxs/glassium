import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GlassPresets } from '../core/material.ts'
import { tierOf } from './capabilities.ts'
import { configure, fixedQuality, getConfig, resetConfig, DEFAULT_CONFIG } from './config.ts'
import { cornerRadiusFromCss, GLASS_BEHAVIOR_ATTRIBUTES, isInteractiveElement, parseGlassAttributes, runtimePreset, RUNTIME_PRESETS } from './presets.ts'

test('预设：default 就是 regular，空串是 default，旧名字与大小写都认，不认识返回 null', () => {
  assert.deepEqual(RUNTIME_PRESETS.default, GlassPresets.regular)
  assert.equal(runtimePreset(''), RUNTIME_PRESETS.default)
  assert.equal(runtimePreset('clear'), RUNTIME_PRESETS.clear)
  assert.deepEqual(runtimePreset('ultrathin'), GlassPresets.ultraThin)
  assert.deepEqual(runtimePreset(' Thick '), GlassPresets.thick)
  assert.equal(runtimePreset('nope'), null)
  assert.notEqual(RUNTIME_PRESETS.tinted.tint, GlassPresets.regular.tint, 'tinted 多一层颜色')
  assert.ok(RUNTIME_PRESETS.frosted.blur! > GlassPresets.thick.blur!, 'frosted 比 thick 更模糊')
})

test('glass 属性：值是预设，glass-* 逐项覆盖；错的报出来、按 default', () => {
  const attrs: Record<string, string> = { glass: 'tinted', 'glass-blur': '20', 'glass-corner-radius': '12' }
  const p = parseGlassAttributes((n) => attrs[n] ?? null)
  assert.equal(p.preset, 'tinted')
  assert.equal(p.material.blur, 20)
  assert.equal(p.material.tint, RUNTIME_PRESETS.tinted.tint)
  assert.deepEqual(p.overrides, { blur: 20, cornerRadius: 12 })
  assert.equal(p.explicitRadius, true)
  assert.deepEqual(p.problems, [])

  const bad = parseGlassAttributes((n) => ({ glass: 'shiny', 'glass-blur': '8px' } as Record<string, string>)[n] ?? null)
  assert.equal(bad.preset, '')
  assert.equal(bad.material.blur, RUNTIME_PRESETS.default.blur)
  assert.equal(bad.problems.length, 2)
  assert.match(bad.problems[0]!, /glass="shiny"/)
  assert.match(bad.problems[1]!, /^glass-blur="8px"/)

  const empty = parseGlassAttributes((n) => (n === 'glass' ? '' : null))
  assert.deepEqual(empty.material, RUNTIME_PRESETS.default)
  assert.equal(empty.explicitRadius, false)
})

test('CSS 圆角 → 玻璃圆角：像素照抄、四角同一个百分比换成比例（最多 0.5）、混写按 0', () => {
  assert.equal(cornerRadiusFromCss(['12px', '12px', '12px', '12px']), 12)
  assert.deepEqual(cornerRadiusFromCss(['4px', '32px', '8px', '28px']), [4, 32, 8, 28])
  assert.equal(cornerRadiusFromCss(['50%', '50%', '50%', '50%']), '0.5frac')
  assert.equal(cornerRadiusFromCss(['80%', '80%', '80%', '80%']), '0.5frac')
  assert.equal(cornerRadiusFromCss(['20%', '20%', '20%', '20%']), '0.2frac')
  assert.deepEqual(cornerRadiusFromCss(['10px 6px', '10px', '50%', '0px']), [10, 10, 0, 0], '椭圆角取水平半径，混写的百分比按 0')
  assert.equal(cornerRadiusFromCss(['0px', '0px', '0px', '0px']), 0)
})

test('可交互的元素：按钮、链接、表单控件、可聚焦的、交互角色', () => {
  const el = (localName: string, attrs: Record<string, string> = {}) => ({
    localName,
    getAttribute: (n: string) => attrs[n] ?? null,
    hasAttribute: (n: string) => n in attrs
  })
  assert.equal(isInteractiveElement(el('button')), true)
  assert.equal(isInteractiveElement(el('a', { href: '#' })), true)
  assert.equal(isInteractiveElement(el('a')), false, '没有 href 的 a 不是链接')
  assert.equal(isInteractiveElement(el('input')), true)
  assert.equal(isInteractiveElement(el('div')), false)
  assert.equal(isInteractiveElement(el('div', { tabindex: '0' })), true)
  assert.equal(isInteractiveElement(el('div', { tabindex: '-1' })), false)
  assert.equal(isInteractiveElement(el('div', { role: 'button' })), true)
  assert.equal(isInteractiveElement(el('div', { role: 'region' })), false)
})

test('档位按能力定：实际用上的后端优先，没建 stage 时按能用上的最好的估', () => {
  assert.equal(tierOf({ webgpu: true, webgl2: true, backdropFilter: true, renderer: 'webgpu' }), 3)
  assert.equal(tierOf({ webgpu: true, webgl2: true, backdropFilter: true, renderer: 'webgl2' }), 2)
  assert.equal(tierOf({ webgpu: true, webgl2: true, backdropFilter: true, renderer: 'css' }), 1)
  assert.equal(tierOf({ webgpu: false, webgl2: false, backdropFilter: false, renderer: 'css' }), 0)
  assert.equal(tierOf({ webgpu: null, webgl2: true, backdropFilter: true, renderer: 'none' }), 2)
  assert.equal(tierOf({ webgpu: false, webgl2: false, backdropFilter: true, renderer: 'none' }), 1)
})

test('configure：合并、非法值报一次并忽略；固定档的质量值', () => {
  resetConfig()
  const warns: unknown[] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => void warns.push(a)
  try {
    configure({ quality: 'low', absorbBackgrounds: false })
    assert.equal(getConfig().quality, 'low')
    assert.equal(getConfig().absorbBackgrounds, false)
    assert.equal(getConfig().auto, true)
    configure({ quality: 2 as unknown as 'low', backend: 'metal' as unknown as 'auto', nope: 1 } as never)
    assert.equal(getConfig().quality, 'low', '非法的质量不改')
    assert.equal(getConfig().backend, 'auto')
    assert.equal(warns.length, 3)
  } finally {
    console.warn = warn
    resetConfig()
  }
  assert.deepEqual(getConfig(), DEFAULT_CONFIG)
  assert.equal(fixedQuality('auto'), null)
  assert.equal(fixedQuality('high'), 1)
  assert.equal(fixedQuality('medium'), 0.7)
  assert.equal(fixedQuality('low'), 0.4)
  assert.equal(fixedQuality(0.55), 0.55)
})

test('glass-jelly / glass-glide 写了就开、="false" 关、没写是 undefined；glass-quality 要 0–1 或 auto', () => {
  const parse = (attrs: Record<string, string>) => parseGlassAttributes((n) => (n === 'glass' ? '' : attrs[n] ?? null))
  const on = parse({ 'glass-jelly': '', 'glass-glide': 'true', 'glass-quality': '0.6' })
  assert.equal(on.jelly, true)
  assert.equal(on.glide, true)
  assert.equal(on.quality, 0.6)
  assert.deepEqual(on.problems, [])
  const off = parse({ 'glass-jelly': 'false' })
  assert.equal(off.jelly, false)
  assert.equal(off.glide, undefined)
  assert.equal(off.quality, undefined)
  assert.equal(parse({ 'glass-quality': 'auto' }).quality, undefined)
  const bad = parse({ 'glass-quality': '2' })
  assert.equal(bad.quality, undefined)
  assert.equal(bad.problems.length, 1)
  assert.deepEqual([...GLASS_BEHAVIOR_ATTRIBUTES], ['glass-jelly', 'glass-glide', 'glass-quality'])
})
