import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_GRADIENT_STOPS, parseFillPaint, resolvePaint, resolveStopOffsets, splitTopLevel, type Rgba } from './gradient.ts'
import { parseTint } from './material.ts'

// 测试用的颜色解析：hex / rgb() 交给 parseTint，外加几个具名颜色（浏览器里由 parseFillColor 负责）
const NAMED: Record<string, Rgba> = { red: [1, 0, 0, 1], blue: [0, 0, 1, 1], white: [1, 1, 1, 1], transparent: [0, 0, 0, 0] }
const color = (css: string): Rgba | null => {
  const named = NAMED[css.toLowerCase()]
  if (named) return named
  try {
    return parseTint(css)
  } catch {
    return null
  }
}
const parse = (text: string) => parseFillPaint(text, color)
const near = (a: readonly number[], b: readonly number[], eps = 1e-6): boolean =>
  a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) <= eps)

test('按顶层拆：括号里的逗号与空白不算', () => {
  assert.deepEqual(splitTopLevel('to right, rgb(255, 0, 0) 10%, blue', ','), ['to right', 'rgb(255, 0, 0) 10%', 'blue'])
  assert.deepEqual(splitTopLevel('rgb(255, 0, 0)   20px 60%', ' '), ['rgb(255, 0, 0)', '20px', '60%'])
  assert.deepEqual(splitTopLevel('a,,b', ','), ['a', '', 'b'])
})

test('纯色照旧；conic、url、写错的返回 null', () => {
  assert.deepEqual(parse('rgb(255, 0, 0)')?.paint, { kind: 'solid', color: [1, 0, 0, 1] })
  assert.equal(parse('conic-gradient(red, blue)'), null)
  assert.equal(parse('url(x.png)'), null)
  assert.equal(parse('linear-gradient(red, nope)'), null)
  assert.equal(parse('linear-gradient(red,, blue)'), null)
})

test('Chrome 给的计算值：角度单位、to 两个方向、展开的双位置色标、颜色提示', () => {
  const turn = parse('linear-gradient(0.25turn, rgb(255, 0, 0) 10%, rgb(0, 0, 255) 20px, rgb(0, 0, 255) 60%)')!
  assert.equal(turn.paint.kind, 'linear')
  if (turn.paint.kind !== 'linear') return
  assert.ok('angle' in turn.paint.direction && Math.abs(turn.paint.direction.angle - 90) < 1e-9)
  assert.deepEqual(turn.paint.stops.map((s) => s.position), [{ value: 10, unit: '%' }, { value: 20, unit: 'px' }, { value: 60, unit: '%' }])

  const rad = parse('linear-gradient(1rad, rgba(255, 0, 0, 0.5), rgb(0, 255, 0))')!.paint
  assert.ok(rad.kind === 'linear' && 'angle' in rad.direction && Math.abs(rad.direction.angle - 180 / Math.PI) < 1e-9)

  const corner = parse('linear-gradient(to right top, red, 30%, blue)')!
  assert.ok(corner.paint.kind === 'linear' && 'corner' in corner.paint.direction)
  if (corner.paint.kind === 'linear' && 'corner' in corner.paint.direction) {
    assert.deepEqual(corner.paint.direction.corner, [1, -1])
  }
  assert.equal(corner.warnings.length, 1) // 颜色提示
  assert.ok(corner.paint.kind === 'linear' && corner.paint.stops.length === 2)

  const plain = parse('linear-gradient(red, blue)')!.paint
  assert.ok(plain.kind === 'linear' && 'angle' in plain.direction && plain.direction.angle === 180) // 默认 to bottom
  assert.equal(parse('repeating-linear-gradient(to right, red 0px, blue 20px)')!.paint.kind, 'linear')
  assert.ok((parse('repeating-linear-gradient(to right, red 0px, blue 20px)')!.paint as { repeating: boolean }).repeating)
})

test('径向：形状、大小关键字、显式半径、位置关键字', () => {
  const a = parse('radial-gradient(circle at 30% 40%, rgb(255, 255, 255), transparent)')!.paint
  assert.ok(a.kind === 'radial' && a.shape === 'circle' && a.size === 'farthest-corner')
  if (a.kind === 'radial') assert.deepEqual(a.at, [{ value: 30, unit: '%' }, { value: 40, unit: '%' }])
  const b = parse('radial-gradient(farthest-side at left top, red, blue)')!.paint
  assert.ok(b.kind === 'radial' && b.shape === 'ellipse' && b.size === 'farthest-side')
  if (b.kind === 'radial') assert.deepEqual(b.at, [{ value: 0, unit: '%' }, { value: 0, unit: '%' }])
  const c = parse('radial-gradient(200px 100px, red, blue)')!.paint
  assert.ok(c.kind === 'radial' && c.shape === 'ellipse' && Array.isArray(c.size) && c.size.length === 2)
  const d = parse('radial-gradient(circle closest-corner, red, blue)')!.paint
  assert.ok(d.kind === 'radial' && d.shape === 'circle' && d.size === 'closest-corner')
  const e = parse('radial-gradient(red, blue)')!.paint
  assert.ok(e.kind === 'radial' && e.shape === 'ellipse' && e.size === 'farthest-corner')
  // 圆的半径不能是百分比
  assert.equal(parse('radial-gradient(circle 50%, red, blue)'), null)
})

test('色标位置的补法（CSS Images 3 §3.4.3）', () => {
  const s = (p: [number, '%' | 'px'] | null) => ({ color: [0, 0, 0, 1] as Rgba, position: p ? { value: p[0], unit: p[1] } : null })
  // 两头默认 0% 与 100%，中间等分
  assert.ok(near(resolveStopOffsets([s(null), s(null), s(null), s(null)], 100), [0, 1 / 3, 2 / 3, 1]))
  // 比前面小的抬上去
  assert.ok(near(resolveStopOffsets([s([50, '%']), s([20, '%']), s(null)], 100), [0.5, 0.5, 1]))
  // px 按渐变线长度换算；中间没写的在前后之间等分
  assert.ok(near(resolveStopOffsets([s([10, 'px']), s(null), s([90, 'px'])], 200), [0.05, 0.25, 0.45]))
})

test('线性渐变的几何：边、角度、角', () => {
  const lin = (text: string, w: number, h: number) => resolvePaint(parse(text)!.paint, w, h)!
  // to right：从左边中点到右边中点
  assert.ok(near(lin('linear-gradient(to right, red, blue)', 200, 100).geometry, [0, 50, 200, 50]))
  // 默认 to bottom
  assert.ok(near(lin('linear-gradient(red, blue)', 200, 100).geometry, [100, 0, 100, 100]))
  // 45deg 在正方形上：长度 = 100·(sin45 + cos45)，过中心
  const g = lin('linear-gradient(45deg, red, blue)', 100, 100).geometry
  const half = (100 * Math.SQRT2) / 2
  assert.ok(near(g, [50 - half * Math.SQRT1_2, 50 + half * Math.SQRT1_2, 50 + half * Math.SQRT1_2, 50 - half * Math.SQRT1_2], 1e-9))
  // to right top 在 200×100 上：方向 (h, −w)/|…|，长度 = 2wh/√(w²+h²)，50% 的垂线过另外两个角
  const c = lin('linear-gradient(to right top, red, blue)', 200, 100).geometry
  const n = Math.hypot(200, 100)
  const L = (2 * 200 * 100) / n
  assert.ok(near(c, [100 - ((100 / n) * L) / 2, 50 + ((200 / n) * L) / 2, 100 + ((100 / n) * L) / 2, 50 - ((200 / n) * L) / 2], 1e-9))
  // 右上角恰好在 100% 那条垂线上：(角 − 起点) · 方向 = L
  const [sx, sy] = [c[0], c[1]]
  assert.ok(Math.abs((200 - sx) * (100 / n) + (0 - sy) * (-200 / n) - L) < 1e-9)
})

test('径向渐变的几何：四种大小关键字、显式半径', () => {
  const rad = (text: string, w: number, h: number) => resolvePaint(parse(text)!.paint, w, h)!.geometry
  // 200×100、中心：圆 farthest-corner = 到角的距离
  assert.ok(near(rad('radial-gradient(circle, red, blue)', 200, 100), [100, 50, Math.hypot(100, 50), Math.hypot(100, 50)]))
  // 椭圆 farthest-corner：与 farthest-side（100, 50）同样 2:1，放大到过角 —— rx = √2·100
  assert.ok(near(rad('radial-gradient(red, blue)', 200, 100), [100, 50, 100 * Math.SQRT2, 50 * Math.SQRT2], 1e-9))
  // closest-side 圆：到最近边
  assert.ok(near(rad('radial-gradient(circle closest-side at 30% 50%, red, blue)', 200, 100), [60, 50, 50, 50]))
  // farthest-side 椭圆、at left top
  assert.ok(near(rad('radial-gradient(farthest-side at left top, red, blue)', 200, 100), [0, 0, 200, 100]))
  // closest-corner 圆、at 30% 40%：最近的角是左上 (60, 40)
  assert.ok(near(rad('radial-gradient(circle closest-corner at 30% 40%, red, blue)', 200, 100), [60, 40, Math.hypot(60, 40), Math.hypot(60, 40)]))
  // 显式
  assert.ok(near(rad('radial-gradient(200px 100px, red, blue)', 400, 400), [200, 200, 200, 100]))
  assert.ok(near(rad('radial-gradient(circle 30px at 10px 20px, red, blue)', 400, 400), [10, 20, 30, 30]))
})

test('色标太多：留前几个与最后一个，并警告', () => {
  const stops = Array.from({ length: 8 }, (_, i) => `rgb(${i * 30}, 0, 0)`).join(', ')
  const parsed = parse(`linear-gradient(${stops})`)!
  assert.equal(parsed.warnings.length, 1)
  const r = resolvePaint(parsed.paint, 100, 100)!
  assert.equal(r.colors.length, MAX_GRADIENT_STOPS)
  assert.ok(near(r.colors[MAX_GRADIENT_STOPS - 1]!, [210 / 255, 0, 0, 1], 1e-9)) // 最后一个留着
  assert.equal(r.offsets[MAX_GRADIENT_STOPS - 1], 1)
})

test('只有一个色标：两头同色', () => {
  const r = resolvePaint(parse('linear-gradient(red)')!.paint, 10, 10)!
  assert.deepEqual(r.colors, [[1, 0, 0, 1], [1, 0, 0, 1]])
  assert.deepEqual(r.offsets, [0, 1])
})
