import { test } from 'node:test'
import assert from 'node:assert/strict'

// 组件类在模块求值时就要有基类。直接写 `extends HTMLElement` 的话，
// 服务端（SSR / SSG）一 import 这个包就 ReferenceError —— 这条测试钉住它。
test('在 Node 里 import 整个包不抛，defineGlassElements 是空操作', async () => {
  assert.equal(typeof globalThis.HTMLElement, 'undefined', '前提：Node 里没有 DOM')
  const mod = await import('../index.ts')
  assert.equal(typeof mod.defineGlassElements, 'function')
  assert.doesNotThrow(() => mod.defineGlassElements())
  assert.equal(mod.currentStage(), null)
})
