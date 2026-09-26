import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lowerMaterial, parseTint } from '../core/material.ts'
import { bubbleMaterial } from './glass-tab-bar.ts'
import { SEGMENT_THUMB_PRESSED } from './thumb.ts'

test('气泡材质：静止时是一块亮一点的玻璃（不自己模糊，它看得见栏），按下时与分段控件的选中块同一套数', () => {
  const rest = bubbleMaterial(0)
  const pressed = bubbleMaterial(1)
  assert.equal(rest.blur, 0, '气泡在栏上面一层，看到的已经是模糊过的栏')
  assert.deepEqual(parseTint(rest.tint!), [128 / 255, 128 / 255, 128 / 255, 0.2], '静止：0.2 的中灰')
  assert.equal(parseTint(pressed.tint!)[3], SEGMENT_THUMB_PRESSED.whiteness, '两头精确落在端点上')
  assert.equal(pressed.refraction, SEGMENT_THUMB_PRESSED.refraction)
  assert.equal(pressed.distortion, SEGMENT_THUMB_PRESSED.distortion)
  assert.equal(pressed.magnify, SEGMENT_THUMB_PRESSED.magnify)
  assert.equal(pressed.bodyLight, SEGMENT_THUMB_PRESSED.bodyLight)
  assert.deepEqual(bubbleMaterial(-3), rest)
  assert.deepEqual(bubbleMaterial(7), pressed)
  for (const e of [0, 0.5, 1]) {
    const chain = lowerMaterial(bubbleMaterial(e), [64, 40])
    assert.equal(chain.adaptive, 0)
    assert.deepEqual(chain.cornerRadiiDp, [20, 20, 20, 20], '胶囊')
  }
})
