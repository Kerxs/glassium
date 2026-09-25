import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as glassium from './index.ts'

/**
 * 包入口导出的名字：值从模块本身拿（改名导出也对）；类型只能从源码里认 —— 逐个 `export { … }` / `export type { … }`
 * 块拆开，每一项去掉 `type ` 前缀，有 `as` 时取别名。
 */
function exportedNames(src: string): string[] {
  const names = new Set(Object.keys(glassium))
  for (const block of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    const typeOnly = Boolean(block[1])
    for (const raw of block[2]!.split(',')) {
      const item = raw.replace(/\/\/.*$/gm, '').trim()
      if (!item) continue
      const isType = typeOnly || item.startsWith('type ')
      const name = item.replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim()
      if (isType && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  return [...names]
}

test('每一个导出都写进了 docs/api.md', () => {
  const doc = readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8')
  const names = exportedNames(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))
  const mentioned = (name: string): boolean => new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/\$/g, '\\$')}([^A-Za-z0-9_$]|$)`).test(doc)
  const missing = names.filter((n) => !mentioned(n))
  assert.deepEqual(missing, [], `docs/api.md 里没写：${missing.join('、')}`)
  assert.ok(names.length > 150, `导出的名字应该有一百多个，认出来 ${names.length} 个 —— 认法坏了？`)
})

test('导出名的认法：export type { … }、改名、行内的 type', () => {
  const src = `export { a, type B, c as d, type E as F } from 'x'\nexport type { G, H as I } from 'y'`
  const names = exportedNames(src)
  for (const n of ['B', 'F', 'G', 'I']) assert.ok(names.includes(n), n)
  for (const n of ['E', 'H']) assert.ok(!names.includes(n), `${n} 是改名之前的名字`)
})
