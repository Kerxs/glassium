import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeAncestors,
  analyzeHitStack,
  cssAlpha,
  describeElement,
  describeProblem,
  problemKey,
  rotateDistorts,
  transformDistorts,
  type LayerStyle
} from './layering.ts'

test('cssAlpha 认得 getComputedStyle 会给出的各种写法', () => {
  const cases: [string, number][] = [
    ['rgba(0, 0, 0, 0)', 0],
    ['transparent', 0],
    ['rgb(255, 255, 255)', 1],
    ['rgba(255, 255, 255, 0.5)', 0.5],
    ['rgb(255 255 255 / 0.25)', 0.25],
    ['color(srgb 1 1 1 / 0.3)', 0.3],
    ['oklch(0.5 0.1 200 / 50%)', 0.5],
    ['color(display-p3 1 0 0)', 1],
    ['', 0]
  ]
  for (const [css, alpha] of cases) assert.equal(cssAlpha(css), alpha, css)
})

test('transformDistorts：平移、缩放、翻转无害，旋转、倾斜、透视有问题', () => {
  assert.equal(transformDistorts('none'), false)
  assert.equal(transformDistorts('matrix(1, 0, 0, 1, 10, 20)'), false, '平移')
  assert.equal(transformDistorts('matrix(2, 0, 0, 0.5, 0, 0)'), false, '缩放')
  assert.equal(transformDistorts('matrix(-1, 0, 0, 1, 0, 0)'), false, '水平翻转')
  assert.equal(transformDistorts('matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)'), true, '旋转 45°')
  assert.equal(transformDistorts('matrix(1, 0, 0.5, 1, 0, 0)'), true, '倾斜')
  const identity3d = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 40, 5, 1]
  assert.equal(transformDistorts(`matrix3d(${identity3d.join(', ')})`), false, '3D 平移')
  const perspective = [...identity3d]
  perspective[11] = -0.01
  assert.equal(transformDistorts(`matrix3d(${perspective.join(', ')})`), true, '透视')
  const rotateX = [1, 0, 0, 0, 0, 0.866, 0.5, 0, 0, -0.5, 0.866, 0, 0, 0, 0, 1]
  assert.equal(transformDistorts(`matrix3d(${rotateX.join(', ')})`), true, '绕 X 轴旋转')
  assert.equal(transformDistorts('rotate(45deg)'), true, '看不懂的写法当成有问题')
})

test('rotateDistorts：独立的 rotate 属性（transform 的计算值里没有它）', () => {
  assert.equal(rotateDistorts('none'), false)
  assert.equal(rotateDistorts('0deg'), false)
  assert.equal(rotateDistorts('45deg'), true)
  assert.equal(rotateDistorts('x 45deg'), true)
})

test('describeElement：tag#id.class，类名多了截断', () => {
  assert.equal(describeElement({ tagName: 'MAIN', id: '', classList: ['content'] }), 'main.content')
  assert.equal(describeElement({ tagName: 'GLASS-CARD', id: 'hero', classList: [] }), 'glass-card#hero')
  assert.equal(
    describeElement({ tagName: 'DIV', id: 'x', classList: ['a', 'b', 'c', 'd', 'e'] }),
    'div#x.a.b.c…'
  )
})

// —— 命中栈分析 ——
// 用普通对象当元素。栈是命中测试顺序：最上层在前。

interface Fake {
  readonly name: string
  readonly parent: Fake | null
  readonly style: Partial<LayerStyle>
}
const clear: LayerStyle = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  opacity: '1',
  filter: 'none',
  transform: 'none',
  rotate: 'none'
}
const el = (name: string, parent: Fake | null, style: Partial<LayerStyle> = {}): Fake => ({ name, parent, style })
const styleOf = (e: Fake): LayerStyle => ({ ...clear, ...e.style })
const contains = (outer: Fake, inner: Fake): boolean => {
  for (let e: Fake | null = inner; e; e = e.parent) if (e === outer) return true
  return false
}

test('夹在面板与画布之间、画了背景的祖先被点名', () => {
  const html = el('html', null)
  const body = el('body', html, { backgroundColor: 'rgb(255, 255, 255)' })
  const canvas = el('canvas', body)
  const content = el('main.content', body, { backgroundColor: 'rgb(255, 255, 255)' })
  const card = el('glass-card', content)
  const text = el('p', card)

  const found = analyzeHitStack([text, card, content, canvas, body, html], card, canvas, contains, styleOf)
  assert.ok(found)
  assert.equal(found.length, 1)
  const p = found[0]!
  assert.equal(p.kind, 'covered')
  if (p.kind !== 'covered') return
  assert.equal(p.element, content)
  assert.equal(p.relation, 'ancestor')
  assert.equal(p.alpha, 1)
})

test('画在画布下面的背景不报 —— 这是沿祖先链查会误报的情形', () => {
  // 命中栈里排在画布之后的元素画在画布下面，被画布整块盖住，对玻璃无害。
  const html = el('html', null)
  const body = el('body', html, { backgroundColor: 'rgb(255, 255, 255)' })
  const canvas = el('canvas', body)
  const content = el('main.content', body)
  const card = el('glass-card', content)
  assert.deepEqual(analyzeHitStack([card, content, canvas, body, html], card, canvas, contains, styleOf), [])
})

test('不是祖先的重叠元素同样挡得住 —— 这是沿祖先链查会漏报的情形', () => {
  const body = el('body', null)
  const canvas = el('canvas', body)
  const content = el('main.content', body)
  const card = el('glass-card', content)
  const backdrop = el('div.page-bg', content, { backgroundImage: 'linear-gradient(red, blue)' })

  const found = analyzeHitStack([card, backdrop, content, canvas, body], card, canvas, contains, styleOf)
  assert.ok(found)
  assert.equal(found.length, 1)
  const p = found[0]!
  assert.ok(p.kind === 'covered' && p.relation === 'overlap' && p.image && p.element === backdrop)
})

test('面板自身的背景也算', () => {
  const body = el('body', null)
  const canvas = el('canvas', body)
  const card = el('glass-card', body, { backgroundColor: 'rgba(255, 255, 255, 0.3)' })
  const found = analyzeHitStack([card, canvas, body], card, canvas, contains, styleOf)
  assert.ok(found)
  const p = found[0]!
  assert.ok(p.kind === 'covered' && p.relation === 'self')
  if (p.kind === 'covered') assert.equal(p.alpha, 0.3)
})

test('画布画在面板上面时报 canvas-above', () => {
  // 面板所在的层比画布还低，比如它或它的祖先有负的 z-index
  const body = el('body', null)
  const canvas = el('canvas', body)
  const card = el('glass-card', body)
  assert.deepEqual(analyzeHitStack([canvas, card, body], card, canvas, contains, styleOf), [
    { kind: 'canvas-above', panel: card }
  ])
})

test('面板或画布不在命中栈里时判断不了，返回 null', () => {
  const body = el('body', null)
  const canvas = el('canvas', body)
  const card = el('glass-card', body)
  assert.equal(analyzeHitStack([canvas, body], card, canvas, contains, styleOf), null)
  assert.equal(analyzeHitStack([card, body], card, canvas, contains, styleOf), null)
})

test('祖先链：filter、旋转被点名；平移与 opacity 不报（玻璃跟着 CSS 的不透明度一起淡）', () => {
  const body = el('body', null)
  const fade = el('section.fade', body, { opacity: '0.5' })
  const tilt = el('div.tilt', fade, { transform: 'matrix(0.965926, 0.258819, -0.258819, 0.965926, 0, 0)' })
  const shift = el('div.shift', tilt, { transform: 'matrix(1, 0, 0, 1, 0, 12)' })
  const card = el('glass-card', shift, { filter: 'drop-shadow(rgba(0, 0, 0, 0.3) 0px 4px 12px)' })

  const found = analyzeAncestors([card, shift, tilt, fade], card, styleOf)
  const summary = found.map((p) => `${p.kind}:${p.kind === 'canvas-above' ? '' : p.element.name}`)
  assert.deepEqual(summary, ['filter:glass-card', 'transform:div.tilt'])
  assert.equal(found[0]!.kind !== 'canvas-above' && found[0]!.relation, 'self')
})

test('警告文本点名具体元素', () => {
  const body = el('body', null)
  const content = el('main.content', body, { backgroundColor: 'rgb(255, 255, 255)' })
  const card = el('glass-card#hero', content)
  const name = (e: Fake): string => e.name

  const covered = describeProblem(
    { kind: 'covered', panel: card, element: content, relation: 'ancestor', alpha: 1, image: false, value: 'rgb(255, 255, 255)' },
    name
  )
  assert.match(covered, /glass-card#hero 的祖先 main\.content 有不透明背景/)
  assert.match(covered, /R1/)

  const tinted = describeProblem(
    { kind: 'covered', panel: card, element: content, relation: 'ancestor', alpha: 0.25, image: false, value: 'rgba(0, 0, 0, 0.25)' },
    name
  )
  assert.match(tinted, /半透明（alpha 0\.25）/)

  assert.match(describeProblem({ kind: 'canvas-above', panel: card }, name), /glass-card#hero 被画布盖住了/)
  assert.match(
    describeProblem({ kind: 'filter', panel: card, element: card, relation: 'self', value: 'blur(2px)' }, name),
    /^\[Glassium\] glass-card#hero 有 filter: blur\(2px\)/
  )
})

test('去重键：同一元素同一问题相同，值变了算新问题', () => {
  const body = el('body', null)
  const card = el('glass-card', body)
  const name = (e: Fake): string => e.name
  const a = problemKey({ kind: 'filter', panel: card, element: body, relation: 'ancestor', value: 'blur(2px)' }, name)
  const b = problemKey({ kind: 'filter', panel: card, element: body, relation: 'ancestor', value: 'blur(2px)' }, name)
  const c = problemKey({ kind: 'filter', panel: card, element: body, relation: 'ancestor', value: 'blur(3px)' }, name)
  assert.equal(a, b)
  assert.notEqual(a, c)
})
