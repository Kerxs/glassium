import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BASE_CSS } from './styles.ts'

test('GPU 玻璃生效时清掉元素自己的底色（浏览器给 button 的默认底色），优先级 0、CSS 画的玻璃不清', () => {
  const rule = /:where\(\[glass\]\[data-glassium-active\]:not\(\[data-glassium-overlay\]\)\)\s*\{\s*background-color: transparent;\s*\}/
  assert.match(BASE_CSS, rule)
  // 兜底表面与 overlay 那条照旧
  assert.match(BASE_CSS, /:where\(\[glass\]:not\(\[data-glassium-active\]\), \[glass\]\[data-glassium-overlay\]\)/)
})
