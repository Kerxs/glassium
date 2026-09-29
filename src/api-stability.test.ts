import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

import * as glassium from './index.ts'

/**
 * API 冻结：docs/api.md「全部导出」里标着（稳定）的那几节，第一列写的名字就是冻结的公开接口，快照签在 spec/api/stable.txt。
 *
 * - 文档里稳定的名字必须与快照一模一样：删、改名、悄悄多出一个都算改了冻结的接口 —— 要改就连快照一起改
 *   （`UPDATE_API_SNAPSHOT=1 node --test src/api-stability.test.ts` 重写快照），改动在提交里看得见；
 * - 快照里的每个名字都必须还从包入口导出（值从模块本身取，类型从 index.ts 的源码里认）。
 */

const docUrl = new URL('../docs/api.md', import.meta.url)
const snapshotUrl = new URL('../spec/api/stable.txt', import.meta.url)

/** 「全部导出」里标着（稳定）的各节表格第一列的名字。 */
export function stableNamesFromDoc(doc: string): string[] {
  const part = doc.slice(doc.indexOf('## 全部导出'))
  const names = new Set<string>()
  let stable = false
  for (const line of part.split('\n')) {
    if (line.startsWith('### ')) {
      stable = line.includes('（稳定）')
      continue
    }
    if (line.startsWith('## ') && !line.startsWith('## 全部导出')) break
    if (!stable || !line.startsWith('|') || line.startsWith('|---') || line.startsWith('| 导出')) continue
    const first = line.split('|')[1] ?? ''
    for (const m of first.matchAll(/`([^`]+)`/g)) {
      const name = /^[A-Za-z_$][\w$]*/.exec(m[1]!)?.[0]
      if (name) names.add(name)
    }
  }
  return [...names].sort()
}

/** 包入口导出的名字（值与类型；与 api-docs.test.ts 同一种认法）。 */
function exportedNames(src: string): Set<string> {
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
  return names
}

test('稳定的接口冻结在快照里：文档里的稳定名字与 spec/api/stable.txt 一模一样，并且都还导出', () => {
  const fromDoc = stableNamesFromDoc(readFileSync(docUrl, 'utf8'))
  assert.ok(fromDoc.length > 60, `认出来 ${fromDoc.length} 个稳定的名字 —— 认法坏了？`)
  if (process.env.UPDATE_API_SNAPSHOT === '1') {
    mkdirSync(new URL('.', snapshotUrl), { recursive: true })
    writeFileSync(snapshotUrl, fromDoc.join('\n') + '\n')
  }
  const snapshot = readFileSync(snapshotUrl, 'utf8').split(/\r?\n/).filter(Boolean)
  const added = fromDoc.filter((n) => !snapshot.includes(n))
  const removed = snapshot.filter((n) => !fromDoc.includes(n))
  assert.deepEqual({ added, removed }, { added: [], removed: [] }, '稳定接口变了：确认是有意的就重写快照（UPDATE_API_SNAPSHOT=1），并在 CHANGELOG 里写明')
  const exported = exportedNames(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))
  const missing = snapshot.filter((n) => !exported.has(n))
  assert.deepEqual(missing, [], `冻结了的接口不再导出：${missing.join('、')}`)
})

test('稳定名字的认法：只认（稳定）的节、只认第一列、调用写法取函数名', () => {
  const doc = [
    '## 全部导出',
    '### 组件（稳定）',
    '| 导出 | 说明 |',
    '|---|---|',
    '| `A`、`b(x, y)` | `notThis` |',
    '### 光学（进阶）',
    '| `C` | x |',
    '### 材质（稳定）',
    '| `glass(preset, overrides?)`、`D` | y |',
    '## 下一章',
    '| `E` | z |'
  ].join('\n')
  assert.deepEqual(stableNamesFromDoc(doc), ['A', 'D', 'b', 'glass'])
})
