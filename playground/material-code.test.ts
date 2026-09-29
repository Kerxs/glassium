import { test } from 'node:test'
import assert from 'node:assert/strict'

import { attributesOf, fmt, htmlSnippet, jsSnippet, overridesOf, runtimeOverridesOf, runtimeSnippet, stateFromPreset, type EditorState } from './material-code.ts'

const edit = (s: EditorState, over: Omit<Partial<EditorState>, 'values'> & { values?: Partial<EditorState['values']> }): EditorState => ({
  ...s,
  ...over,
  values: { ...s.values, ...over.values }
})

test('刚选的预设：HTML 只有 preset，JS 就是那个预设', () => {
  const s = stateFromPreset('glass-card', 'regular')
  assert.deepEqual(attributesOf(s), [['preset', 'regular']])
  // JS 的基准不知道卡片的 24dp 圆角：要写出来
  assert.deepEqual(overridesOf(s), [['cornerRadius', 24]])
  assert.equal(jsSnippet(s).split('\n').at(-1), "glass(element, { preset: 'regular' })")
  // 按钮默认胶囊，JS 那边 '1frac' 也要写（MATERIAL_DEFAULTS 是 0.5frac）
  const b = stateFromPreset('glass-button', 'thick')
  assert.deepEqual(attributesOf(b), [['preset', 'thick']])
  assert.deepEqual(overridesOf(b), [['cornerRadius', '1frac']])
})

test('改过的项才写；数字最多两位小数', () => {
  const s = edit(stateFromPreset('glass-card', 'thin'), { values: { blur: 12.25, dispersion: 0.3 } })
  assert.deepEqual(attributesOf(s), [
    ['preset', 'thin'],
    ['blur', '12.25'],
    ['dispersion', '0.3']
  ])
  assert.equal(fmt(0.30000000000000004), '0.3')
  assert.equal(fmt(2), '2')
})

test('tint：与预设一样不写，改了写成 rgba()', () => {
  const s = stateFromPreset('glass-card', 'regular')
  assert.deepEqual(s.tint, [255, 255, 255, 0.1])
  const red = edit(s, { tint: [255, 60, 60, 0.45] })
  assert.deepEqual(attributesOf(red).at(-1), ['tint', 'rgba(255, 60, 60, 0.45)'])
  assert.deepEqual(overridesOf(red)[0], ['tint', 'rgba(255, 60, 60, 0.45)'])
})

test('圆角：卡片改成胶囊写 1frac，按钮改成 20 写 20；没有预设时对照默认值', () => {
  assert.deepEqual(attributesOf(edit(stateFromPreset('glass-card', null), { cornerRadius: 'pill' })), [['corner-radius', '1frac']])
  assert.deepEqual(attributesOf(edit(stateFromPreset('glass-button', null), { cornerRadius: 20 })), [['corner-radius', '20']])
  const plain = stateFromPreset('glass-card', null)
  assert.deepEqual(attributesOf(plain), [])
  assert.equal(jsSnippet(plain).includes('border-radius（24px）'), true, '圆角交给 CSS')
})

test('代码片段的样子', () => {
  const s = edit(stateFromPreset('glass-button', 'clear'), { values: { shadow: 0.2 } })
  assert.equal(htmlSnippet(s), '<glass-button preset="clear" shadow="0.2" style="width: 180px; height: 64px">按钮</glass-button>')
  assert.equal(
    jsSnippet(s),
    [
      "import { glass } from 'glassium'",
      '',
      '// 圆角取元素 CSS 的 border-radius（999px）',
      "glass(element, { preset: 'clear', material: { shadow: 0.2 } })"
    ].join('\n')
  )
  assert.equal(
    runtimeSnippet(s),
    '<button glass="clear" glass-shadow="0.2" style="width: 180px; height: 64px; border-radius: 999px">按钮</button>'
  )
})

test('零配置的基准是 runtime 的预设：不写预设时是 regular（不是材质的默认值）', () => {
  // 编辑器「没有预设」= MATERIAL_DEFAULTS，runtime 的 glass="" = regular：两者是同一组值（默认值就是 regular），所以什么都不用写；
  // 改过的项对照的是 regular，不是组件的默认值
  const plain = stateFromPreset('glass-card', null)
  assert.deepEqual(runtimeOverridesOf(plain), [])
  assert.ok(runtimeSnippet(plain).startsWith('<div glass=""'))
  const clearish = { ...plain, values: { ...plain.values, refraction: 0.5 } }
  assert.deepEqual(runtimeOverridesOf(clearish), [{ key: 'refraction', attr: 'refraction', value: 0.5 }])
  const regular = stateFromPreset('glass-card', 'regular')
  assert.deepEqual(runtimeOverridesOf(regular), [], 'regular 预设：什么都不用写')
  assert.ok(runtimeSnippet(regular).includes('border-radius: 24px'))
})
