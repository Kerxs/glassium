import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

import { GlassPresets } from './core/material.ts'
import { MATERIAL_ATTRIBUTES } from './core/attributes.ts'
import { DEFAULT_CONFIG } from './runtime/config.ts'
import { GLASS_BEHAVIOR_ATTRIBUTES, GLASS_MATERIAL_ATTRIBUTES, RUNTIME_PRESETS } from './runtime/presets.ts'

/**
 * 写在 HTML 里的接口冻结（1.0 起）：runtime 的 `glass` / `glass-*` 属性与预设名、组件的材质属性、`configure` 的配置项。
 * 它们不是 JS 导出，api-stability.test.ts 管不到 —— 快照签在 spec/api/attributes.txt。
 *
 * - 代码里的集合必须与快照一模一样：删、改名、多出一个都算改了接口（`UPDATE_API_SNAPSHOT=1` 重写快照，写进 CHANGELOG）；
 * - 每一项都要在 docs/api.md 里出现（写成代码的样子）。
 */

const snapshotUrl = new URL('../spec/api/attributes.txt', import.meta.url)
const doc = readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8')

function current(): string[] {
  const presets = new Set([...Object.keys(RUNTIME_PRESETS), ...Object.keys(GlassPresets)])
  return [
    'attribute glass',
    ...GLASS_MATERIAL_ATTRIBUTES.map((a) => `attribute ${a}`),
    ...GLASS_BEHAVIOR_ATTRIBUTES.map((a) => `attribute ${a}`),
    ...[...presets].map((p) => `preset ${p}`),
    ...MATERIAL_ATTRIBUTES.map((a) => `component-attribute ${a}`),
    ...Object.keys(DEFAULT_CONFIG).map((k) => `config ${k}`)
  ].sort()
}

test('写在 HTML 里的接口冻结在快照里：glass-* 属性、预设名、组件的材质属性、configure 的配置项', () => {
  const now = current()
  if (process.env.UPDATE_API_SNAPSHOT === '1') writeFileSync(snapshotUrl, now.join('\n') + '\n')
  const snapshot = readFileSync(snapshotUrl, 'utf8').split(/\r?\n/).filter(Boolean)
  const added = now.filter((n) => !snapshot.includes(n))
  const removed = snapshot.filter((n) => !now.includes(n))
  assert.deepEqual({ added, removed }, { added: [], removed: [] }, '属性或配置项变了：确认是有意的就重写快照（UPDATE_API_SNAPSHOT=1），并在 CHANGELOG 里写明')
})

test('冻结的属性、预设、配置项都写进了 docs/api.md', () => {
  const missing = current()
    .map((line) => line.split(' ')[1]!)
    .filter((name) => !doc.includes(`\`${name}\``) && !doc.includes(`\`${name}=`) && !doc.includes(`${name}:`) && !doc.includes(`${name}="`))
  assert.deepEqual(missing, [])
})
