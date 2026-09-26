import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lowerMaterial, parseTint } from '../core/material.ts'
import { SEGMENT_THUMB_PRESSED, THUMB_PRESSED, THUMB_REST, thumbMaterial } from './thumb.ts'

test('旋钮材质：能量 0 是静止（白旋钮），1 是按下（透镜），出界的钳住', () => {
  const rest = thumbMaterial(0)
  const pressed = thumbMaterial(1)
  assert.equal(rest.blur, THUMB_REST.blur)
  assert.equal(rest.refraction, THUMB_REST.refraction)
  assert.equal(parseTint(rest.tint!)[3], THUMB_REST.whiteness)
  assert.equal(pressed.distortion, THUMB_PRESSED.distortion)
  assert.equal(parseTint(pressed.tint!)[3], THUMB_PRESSED.whiteness)
  assert.deepEqual(thumbMaterial(-1), rest)
  assert.deepEqual(thumbMaterial(2), pressed)
  // 中途是线性插值
  const half = thumbMaterial(0.5)
  assert.ok(Math.abs(half.highlight! - (THUMB_REST.highlight + THUMB_PRESSED.highlight) / 2) < 1e-12)
  assert.ok(Math.abs(parseTint(half.tint!)[3] - (THUMB_REST.whiteness + THUMB_PRESSED.whiteness) / 2) < 1e-12)
})

test('旋钮材质能降级（在调用处就会抛的那种错一个都没有），静止是白的、按下几乎透明', () => {
  for (const e of [0, 0.25, 0.5, 1]) {
    const chain = lowerMaterial(thumbMaterial(e), [39, 24])
    assert.equal(chain.adaptive, 0, '旋钮上没有文字，不要自适应的纱')
    assert.deepEqual(chain.cornerRadiiDp, [12, 12, 12, 12], '胶囊：半径是短边的一半')
  }
  assert.ok(THUMB_REST.whiteness > 0.9 && THUMB_PRESSED.whiteness < 0.1)
})

test('滑块、开关按住时不放大、有体光；分段控件的选中块按住时放大', () => {
  const plain = thumbMaterial(1)
  assert.equal(plain.magnify, 0, '截图上滑块旋钮里的轨道与外面一样粗')
  assert.equal(plain.bodyLight, 1)
  assert.equal(thumbMaterial(0).bodyLight, 0, '静止的白旋钮没有体光')
  const segment = thumbMaterial(1, SEGMENT_THUMB_PRESSED)
  assert.ok(segment.magnify! > 0.1, '字被放大')
  assert.equal(segment.bodyLight, 1)
  assert.deepEqual(thumbMaterial(0, SEGMENT_THUMB_PRESSED), thumbMaterial(0), '静止时两者一样')
})
