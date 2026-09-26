import { test } from 'node:test'
import assert from 'node:assert/strict'

import { baselineIn, canvasFont, sameOriginImage } from './scene-label.ts'

test('画布的 font：斜体、小型大写、粗细、字号、字体族与计算样式一致；normal 省掉', () => {
  const base = { fontStyle: 'normal', fontVariant: 'normal', fontWeight: '600', fontSize: '13px', fontFamily: 'system-ui, sans-serif' }
  assert.equal(canvasFont(base), '600 13px system-ui, sans-serif')
  assert.equal(canvasFont({ ...base, fontStyle: 'italic' }), 'italic 600 13px system-ui, sans-serif')
  assert.equal(canvasFont({ ...base, fontVariant: 'small-caps' }), 'small-caps 600 13px system-ui, sans-serif')
})

test('基线：内容区与字体的上伸 + 下伸一样高时正好在上伸处；不一样高时两头平分差值', () => {
  assert.equal(baselineIn(10, 16, 12, 4), 22)
  assert.equal(baselineIn(10, 20, 12, 4), 24, '高出 4px：上下各让 2px')
  assert.equal(baselineIn(0, 14, 12, 4), 11, '矮 2px：上下各收 1px')
})

test('同源的图片才画：相对路径、同源绝对路径、data: 与 blob: 可以；跨源、坏的 URL 不行', () => {
  const base = 'https://example.test/app/page.html'
  assert.equal(sameOriginImage('icons/a.png', base), true)
  assert.equal(sameOriginImage('https://example.test/b.png', base), true)
  assert.equal(sameOriginImage('data:image/png;base64,AAAA', base), true)
  assert.equal(sameOriginImage('blob:https://example.test/1234', base), true)
  assert.equal(sameOriginImage('https://cdn.example.org/b.png', base), false)
  assert.equal(sameOriginImage('http://example.test/b.png', base), false, '协议不同也是跨源')
  assert.equal(sameOriginImage('http://[', base), false)
})
