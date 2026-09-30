import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bordersOf, decorationOffsets, parseDecoration } from './paint-content.ts'

const deco = (line: string, extra: Partial<Record<string, string>> = {}) =>
  parseDecoration({
    textDecorationLine: line,
    textDecorationColor: 'rgb(0, 0, 255)',
    textDecorationThickness: 'auto',
    textDecorationStyle: 'solid',
    color: 'rgb(0, 0, 0)',
    ...extra
  } as never)

test('文字装饰：认下划线、上划线、删除线（可以几种一起），none 与不认识的返回 null', () => {
  assert.equal(deco('none'), null)
  assert.equal(deco('blink'), null)
  const u = deco('underline')!
  assert.deepEqual([u.underline, u.overline, u.lineThrough], [true, false, false])
  assert.equal(u.color, 'rgb(0, 0, 255)')
  assert.equal(u.thickness, null, 'auto 按字号算')
  const both = deco('underline line-through', { textDecorationThickness: '3px', textDecorationStyle: 'dashed' })!
  assert.deepEqual([both.underline, both.lineThrough, both.thickness, both.style], [true, true, 3, 'dashed'])
  assert.equal(deco('overline', { textDecorationColor: '' })!.color, 'rgb(0, 0, 0)', '没有装饰色时用字的颜色')
})

test('装饰线的位置：下划线在基线下面，删除线在字的中间，上划线在上面；都在这一行的矩形里', () => {
  const h = 20
  const at = decorationOffsets(h, 16, 1)
  assert.ok(at.overline < at.lineThrough && at.lineThrough < at.underline)
  assert.ok(at.overline >= 0 && at.underline <= h + 2)
  // 基线：内容区 20 比 1em（16）高，两头各多 2，再往下上伸 12.8 → 14.8；下划线 14.8 + 1.6 + 0.5
  assert.ok(Math.abs(at.underline - 16.9) < 1e-9)
  assert.ok(Math.abs(at.lineThrough - 10) < 1e-9)
})

test('边框：四边分别读；none / hidden / 宽度 0 / 透明的都不画，一条都不画时 null', () => {
  const side = (style: string, width: string, color: string) => ({ style, width, color })
  const cs = (t: ReturnType<typeof side>, r = t, b = t, l = t) =>
    ({
      borderTopStyle: t.style, borderTopWidth: t.width, borderTopColor: t.color,
      borderRightStyle: r.style, borderRightWidth: r.width, borderRightColor: r.color,
      borderBottomStyle: b.style, borderBottomWidth: b.width, borderBottomColor: b.color,
      borderLeftStyle: l.style, borderLeftWidth: l.width, borderLeftColor: l.color
    }) as never
  assert.equal(bordersOf(cs(side('none', '3px', 'rgb(0, 0, 0)'))), null, 'none 的宽度计算值不算')
  assert.equal(bordersOf(cs(side('solid', '0px', 'rgb(0, 0, 0)'))), null)
  assert.equal(bordersOf(cs(side('solid', '2px', 'rgba(0, 0, 0, 0)'))), null)
  const one = bordersOf(cs(side('none', '0px', 'rgb(0, 0, 0)'), side('none', '0px', 'red'), side('dashed', '2px', 'rgb(255, 0, 0)')))!
  assert.deepEqual(one.map((s) => s.width), [0, 0, 2, 0])
  assert.equal(one[2].style, 'dashed')
  assert.equal(bordersOf(cs(side('hidden', '4px', 'rgb(0, 0, 0)'))), null)
})
