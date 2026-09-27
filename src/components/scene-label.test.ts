import { test } from 'node:test'
import assert from 'node:assert/strict'

import { baselineIn, canvasFont, objectFitRect, sameOriginImage, videoIsClean } from './scene-label.ts'

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

test('object-fit：fill 原样返回同一个盒子；contain / cover / none / scale-down 的尺寸与 object-position 的百分比、像素', () => {
  const box = { x: 10, y: 20, w: 200, h: 100 }
  assert.equal(objectFitRect(box, 800, 500, 'fill', '50% 50%'), box, 'fill 返回同一个对象（照旧 drawImage(box)）')
  assert.deepEqual(objectFitRect(box, 800, 400, 'contain', '50% 50%'), { x: 10, y: 20, w: 200, h: 100 }, '比例一样：正好铺满')
  assert.deepEqual(objectFitRect(box, 100, 100, 'contain', '50% 50%'), { x: 60, y: 20, w: 100, h: 100 }, '方图：左右居中')
  assert.deepEqual(objectFitRect(box, 100, 100, 'cover', '50% 50%'), { x: 10, y: -30, w: 200, h: 200 }, '方图：上下各溢出 50')
  assert.deepEqual(objectFitRect(box, 100, 100, 'cover', '0% 100%'), { x: 10, y: -80, w: 200, h: 200 }, '贴底')
  assert.deepEqual(objectFitRect(box, 40, 30, 'none', '10px 5px'), { x: 20, y: 25, w: 40, h: 30 }, 'none：原尺寸，像素位置')
  assert.deepEqual(objectFitRect(box, 40, 30, 'scale-down', '50% 50%'), { x: 90, y: 55, w: 40, h: 30 }, '小图不放大')
  assert.deepEqual(objectFitRect(box, 400, 400, 'scale-down', '50% 50%'), { x: 60, y: 20, w: 100, h: 100 }, '大图按 contain 缩')
  assert.equal(objectFitRect(box, 0, 0, 'cover', '50% 50%'), box, '还没有尺寸：原样')
})

test('视频能不能画：srcObject、同源 src 可以；还没有来源的也算（不警告）；跨源的不行', () => {
  const doc = { baseURI: 'https://example.test/app/' }
  const v = (o: Record<string, unknown>): HTMLVideoElement => ({ srcObject: null, currentSrc: '', src: '', ownerDocument: doc, ...o }) as unknown as HTMLVideoElement
  assert.equal(videoIsClean(v({ srcObject: {} })), true)
  assert.equal(videoIsClean(v({ src: 'clip.mp4' })), true)
  assert.equal(videoIsClean(v({ currentSrc: 'blob:https://example.test/1' })), true)
  assert.equal(videoIsClean(v({})), true)
  assert.equal(videoIsClean(v({ currentSrc: 'https://cdn.example.org/clip.mp4' })), false)
})
