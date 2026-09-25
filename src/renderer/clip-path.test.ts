import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseClipPath, parseLengthPct, resolveClipPath, type ParsedClipPath, type ReferenceBoxes } from './clip-path.ts'
import { fitRoundedBox } from './clipping.ts'

/** 200×100 的元素，左上角在 (100, 100)，没有边框、内外边距、圆角。 */
const ref = (over: Partial<ReferenceBoxes> = {}): ReferenceBoxes => ({
  border: { x0: 100, y0: 100, x1: 300, y1: 200 },
  borderWidths: [0, 0, 0, 0],
  padding: [0, 0, 0, 0],
  margin: [0, 0, 0, 0],
  radii: [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0]
  ],
  ...over
})

const shapeOf = (text: string): ParsedClipPath => {
  const p = parseClipPath(text)
  assert.equal(p.kind, 'shape', `${text} 应当解析得了：${JSON.stringify(p)}`)
  return (p as { value: ParsedClipPath }).value
}

/** 解算、再按 CSS 的规则放好圆角（与 clipping.ts 里走的路一样）。 */
const resolve = (text: string, r: ReferenceBoxes = ref()): ReturnType<typeof fitRoundedBox> => {
  const g = resolveClipPath(shapeOf(text), r)
  return fitRoundedBox(g.box, g.radii)
}

const near = (a: number, b: number, what: string, eps = 1e-9): void => assert.ok(Math.abs(a - b) < eps, `${what}：${a} ≠ ${b}`)

test('长度：px、百分比、0、只有加减的 calc；没有单位的非零数与乘除不认', () => {
  assert.deepEqual(parseLengthPct('10px'), { px: 10, pct: 0 })
  assert.deepEqual(parseLengthPct('-5%'), { px: 0, pct: -5 })
  assert.deepEqual(parseLengthPct('0'), { px: 0, pct: 0 })
  assert.deepEqual(parseLengthPct('calc(10% + 20px)'), { px: 20, pct: 10 })
  assert.deepEqual(parseLengthPct('calc(100% - 10px)'), { px: -10, pct: 100 })
  assert.deepEqual(parseLengthPct('calc(-10px + 50%)'), { px: -10, pct: 50 })
  assert.equal(parseLengthPct('12'), null)
  assert.equal(parseLengthPct('calc(2 * 10px)'), null)
  assert.equal(parseLengthPct('calc(10px +)'), null)
  assert.equal(parseLengthPct('1em'), null, '计算值里的 em 已经换成 px，出现了就不认')
})

test('none、空串；画不了的给出理由', () => {
  assert.deepEqual(parseClipPath('none'), { kind: 'none' })
  assert.deepEqual(parseClipPath(''), { kind: 'none' })
  for (const text of ['url("#foo")', 'path("M 0 0 L 10 10")', 'shape(from 0 0, line to 10px 10px)', 'circle(10px', 'inset(1px 2px 3px 4px 5px)', 'border-box padding-box']) {
    const p = parseClipPath(text)
    assert.equal(p.kind, 'unsupported', text)
  }
  const path = parseClipPath('path("M 0 0 L 10 10")')
  assert.ok(path.kind === 'unsupported' && path.reason.startsWith('path()'), '说出是哪个函数')
})

test('Chrome 的计算值：默认值省略、参考盒默认 border-box、fill-box 按 content-box', () => {
  assert.deepEqual(shapeOf('circle()'), {
    shape: { kind: 'circle', radius: 'closest-side', at: [{ px: 0, pct: 50 }, { px: 0, pct: 50 }] },
    box: 'border-box'
  })
  assert.deepEqual(shapeOf('circle(40px) padding-box').box, 'padding-box')
  assert.deepEqual(shapeOf('fill-box'), { shape: { kind: 'box' }, box: 'content-box' })
  assert.deepEqual(shapeOf('view-box').box, 'border-box')
  const e = shapeOf('ellipse(closest-side farthest-side at 25% 75%)').shape
  assert.deepEqual(e, { kind: 'ellipse', rx: 'closest-side', ry: 'farthest-side', at: [{ px: 0, pct: 25 }, { px: 0, pct: 75 }] })
  // 位置关键字（别的浏览器可能保留）与四个值的写法
  const k = shapeOf('circle(10px at right 10px top 20px)').shape
  assert.deepEqual(k, { kind: 'circle', radius: { px: 10, pct: 0 }, at: [{ px: -10, pct: 100 }, { px: 20, pct: 0 }] })
  const t = shapeOf('circle(at top left)').shape
  assert.deepEqual(t, { kind: 'circle', radius: 'closest-side', at: [{ px: 0, pct: 0 }, { px: 0, pct: 0 }] })
})

test('inset：一到四个值按 margin 的规则展开；round 后面是 border-radius 的简写', () => {
  const s = shapeOf('inset(10px round 10px 20px 30px 40px / 5px 6px 7px 8px)').shape
  assert.ok(s.kind === 'inset')
  assert.deepEqual(s.insets.map((l) => l.px), [10, 10, 10, 10])
  assert.deepEqual(
    s.radii.map(([x, y]) => [x.px, y.px]),
    [
      [10, 5],
      [20, 6],
      [30, 7],
      [40, 8]
    ]
  )
  const two = shapeOf('inset(10px 20px round 20px 10px)').shape
  assert.ok(two.kind === 'inset')
  assert.deepEqual(two.insets.map((l) => l.px), [10, 20, 10, 20])
  assert.deepEqual(two.radii.map(([x]) => x.px), [20, 10, 20, 10], '两个值：TL = BR、TR = BL')
})

test('inset 的圆角百分比按参考盒算（不按 inset 出来的矩形），再按 CSS 的规则缩放 —— 与 Chrome 的命中测试一致', () => {
  // 200×100 上 inset(0 50% 0 0 round 50%)：矩形 100×100；半径按参考盒是 100×50，上边 100 + 100 > 100 → 缩一半，50×25。
  // Chrome 里 (104, 130) 在里面（y 已经过了角的范围 125），(110, 103) 在外面 —— 按 inset 矩形算的话是半径 50 的圆，
  // (104, 130) 离圆心 (150, 150) 50.2，会在外面
  const r = resolve('inset(0px 50% 0px 0px round 50%)')
  assert.deepEqual(r.box, { x0: 100, y0: 100, x1: 200, y1: 200 })
  assert.deepEqual(r.rx, [50, 50, 50, 50])
  assert.deepEqual(r.ry, [25, 25, 25, 25])
  // 左右加起来超过宽：宽是 0，左边不动
  const collapsed = resolve('inset(0px 60% 0px 60%)')
  assert.equal(collapsed.box.x1 - collapsed.box.x0, 0)
  assert.equal(collapsed.box.x0, 220)
})

test('rect()、xywh() 与 Chrome 换成的 inset() 解算出同一个形状', () => {
  assert.deepEqual(resolve('rect(10px 90% 80px 0 round 8px)'), resolve('inset(10px 10% calc(100% - 80px) 0px round 8px)'))
  assert.deepEqual(
    resolve('xywh(10px 20px 50% 40% round 4px)'),
    resolve('inset(20px calc(50% - 10px) calc(60% - 20px) 10px round 4px)')
  )
  assert.deepEqual(resolve('rect(auto auto 50% auto)').box, { x0: 100, y0: 100, x1: 300, y1: 150 }, 'auto 是那条边本身')
})

test('circle：百分比半径按 √(w² + h²) / √2；closest-side / farthest-side 看四条边 —— 与 Chrome 的命中测试一致', () => {
  // 200×100 上 circle(50%)：r = 79.06。Chrome 里圆心左边 79 在里面、80 在外面
  const half = resolve('circle(50%)')
  const r = (half.box.x1 - half.box.x0) / 2
  near(r, (0.5 * Math.hypot(200, 100)) / Math.SQRT2, 'circle(50%) 的半径')
  assert.ok(r > 79 && r < 80)
  assert.deepEqual(half.rx, half.ry, '圆：两个半径相等')
  near(half.rx[0], r, '四角半径 = 半径', 1e-9)
  // 默认 closest-side at center：短边的一半
  const closest = resolve('circle()')
  assert.deepEqual(closest.box, { x0: 150, y0: 100, x1: 250, y1: 200 })
  // farthest-side at calc(100% - 10px) 20px：圆心 (290, 120)，最远的是左边 190
  const far = resolve('circle(farthest-side at calc(100% - 10px) 20px)')
  assert.deepEqual(far.box, { x0: 100, y0: -70, x1: 480, y1: 310 })
})

test('ellipse：两个半径分别按宽、高算，closest-side / farthest-side 只看各自那个轴', () => {
  const e = resolve('ellipse(closest-side farthest-side at 25% 75%)')
  // 圆心 (150, 175)；水平最近 50，竖直最远 75
  assert.deepEqual(e.box, { x0: 100, y0: 100, x1: 200, y1: 250 })
  assert.deepEqual(e.rx, [50, 50, 50, 50])
  assert.deepEqual(e.ry, [75, 75, 75, 75])
  const pct = resolve('ellipse(40% 30%)')
  assert.deepEqual(pct.box, { x0: 120, y0: 120, x1: 280, y1: 180 })
})

test('只写盒子关键字：那个盒子带 border-radius 的形状 —— 与 Chrome 的命中测试一致', () => {
  const rounded = ref({
    borderWidths: [10, 10, 10, 10],
    padding: [5, 5, 5, 5],
    margin: [20, 20, 20, 20],
    radii: [
      [40, 40],
      [40, 40],
      [40, 40],
      [40, 40]
    ]
  })
  // padding-box：内圆角 30（Chrome 里离角圆心 28.3 的点在里面、39.6 的在外面）
  const pad = resolve('padding-box', rounded)
  assert.deepEqual(pad.box, { x0: 110, y0: 110, x1: 290, y1: 190 })
  assert.deepEqual(pad.rx, [30, 30, 30, 30])
  assert.deepEqual(resolve('border-box', rounded).rx, [40, 40, 40, 40])
  const content = resolve('content-box', rounded)
  assert.deepEqual(content.box, { x0: 115, y0: 115, x1: 285, y1: 185 })
  assert.deepEqual(content.rx, [25, 25, 25, 25])
  const margin = resolve('margin-box', rounded)
  assert.deepEqual(margin.box, { x0: 80, y0: 80, x1: 320, y1: 220 })
  assert.deepEqual(margin.rx, [60, 60, 60, 60])
  // 没有圆角时 margin-box 也不加（只加在不为 0 的角上）
  assert.deepEqual(resolve('margin-box', ref({ margin: [20, 20, 20, 20] })).rx, [0, 0, 0, 0])
})

test('形状写在别的参考盒上：百分比与位置跟着那个盒子', () => {
  const r = ref({ borderWidths: [10, 10, 10, 10] })
  // padding box 180×80：circle() 的半径 40、圆心在 padding box 中间
  assert.deepEqual(resolve('circle() padding-box', r).box, { x0: 160, y0: 110, x1: 240, y1: 190 })
})

test('polygon：按外接矩形近似，并说明是近似', () => {
  const p = parseClipPath('polygon(evenodd, 0px 0px, 100% 0px, 50% 100%)')
  assert.equal(p.kind, 'shape')
  assert.ok(p.kind === 'shape' && p.approximate?.includes('外接矩形'))
  const tri = resolve('polygon(10px 0px, 100% 20px, 50% 100%)')
  assert.deepEqual(tri.box, { x0: 110, y0: 100, x1: 300, y1: 200 })
  assert.deepEqual(tri.rx, [0, 0, 0, 0])
  const exact = parseClipPath('circle(10px)')
  assert.ok(exact.kind === 'shape' && exact.approximate === null)
})
