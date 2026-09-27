import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cssAlpha, placeImage, planBackground, type BackgroundStyle } from './background.ts'

const style = (over: Partial<BackgroundStyle>): BackgroundStyle => ({
  color: 'rgba(0, 0, 0, 0)',
  image: 'none',
  size: 'auto',
  position: '0% 0%',
  repeat: 'repeat',
  attachment: 'scroll',
  ...over
})

test('alpha：rgb 不透明、rgba 读第四个、transparent 是 0', () => {
  assert.equal(cssAlpha('rgb(1, 2, 3)'), 1)
  assert.equal(cssAlpha('rgba(1, 2, 3, 0.4)'), 0.4)
  assert.equal(cssAlpha('rgb(1 2 3 / 50%)'), 0.5)
  assert.equal(cssAlpha('transparent'), 0)
  assert.equal(cssAlpha('rgba(0, 0, 0, 0)'), 0)
})

test('背景 → 怎么画：没有、纯色、渐变、同源图、画不了的', () => {
  assert.deepEqual(planBackground(style({})), { kind: 'none' })
  assert.deepEqual(planBackground(style({ color: 'rgb(61, 220, 151)' })), { kind: 'color', paint: 'rgb(61, 220, 151)' })
  const g = 'linear-gradient(135deg, rgb(255, 138, 91) 0%, rgb(25, 130, 196) 100%)'
  assert.deepEqual(planBackground(style({ image: g })), { kind: 'gradient', paint: g, droppedColor: false })
  assert.deepEqual(planBackground(style({ image: g, color: 'rgb(0, 0, 0)' })), { kind: 'gradient', paint: g, droppedColor: false }, '色标全不透明：底色被盖住，不算丢')
  const see = 'radial-gradient(circle, rgba(0, 0, 0, 0.5), transparent)'
  assert.equal((planBackground(style({ image: see, color: 'rgb(0, 0, 0)' })) as { droppedColor: boolean }).droppedColor, true)
  assert.deepEqual(planBackground(style({ image: 'url("http://x/a.png")', color: 'rgb(1, 1, 1)' })), {
    kind: 'image',
    url: 'http://x/a.png',
    color: 'rgb(1, 1, 1)'
  })
  assert.equal(planBackground(style({ image: `url("a.png"), ${g}` })).kind, 'unsupported')
  assert.equal(planBackground(style({ image: g, attachment: 'fixed' })).kind, 'unsupported')
  assert.equal(planBackground(style({ image: 'conic-gradient(red, blue)' })).kind, 'unsupported')
})

test('图的位置：cover / contain / auto / 长度 / 百分比位置 / 分轴平铺', () => {
  // 盒子 400×200，图 800×500
  const cover = placeImage(400, 200, 800, 500, 'cover', '50% 50%', 'no-repeat')
  assert.deepEqual([cover.w, cover.h], [400, 250])
  assert.deepEqual([cover.x, cover.y], [0, -25])
  const contain = placeImage(400, 200, 800, 500, 'contain', '50% 50%', 'no-repeat')
  assert.deepEqual([contain.w, contain.h], [320, 200])
  assert.deepEqual([contain.x, contain.y], [40, 0])
  const auto = placeImage(400, 200, 80, 50, 'auto', '0px 0px', 'repeat')
  assert.deepEqual([auto.x, auto.y, auto.w, auto.h, auto.repeatX, auto.repeatY], [0, 0, 80, 50, true, true])
  const len = placeImage(400, 200, 80, 50, '40px auto', '10px 100%', 'repeat-x')
  assert.deepEqual([len.w, len.h, len.x, len.y, len.repeatX, len.repeatY], [40, 25, 10, 175, true, false])
  const two = placeImage(400, 200, 80, 50, '50% 50%', '0% 0%', 'no-repeat repeat')
  assert.deepEqual([two.w, two.h, two.repeatX, two.repeatY], [200, 100, false, true])
  const y = placeImage(400, 200, 80, 50, 'auto', '0% 0%', 'repeat-y')
  assert.deepEqual([y.repeatX, y.repeatY], [false, true])
})
