import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as full from './index.ts'
import * as runtime from './runtime-entry.ts'

const srcDir = dirname(fileURLToPath(import.meta.url))

/** 从一个源文件出发，沿着相对 import（静态的、import() 动态的、export … from 都算）走到的全部源文件。 */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length > 0) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1]!)
      if (existsSync(target)) stack.push(target)
    }
  }
  return seen
}

const rel = (f: string): string => relative(srcDir, f).split(sep).join('/')

test('glassium/runtime 入口不带组件：它的 import 图里没有 src/components/ 下的任何文件', () => {
  const graph = [...importGraph(resolve(srcDir, 'runtime-entry.ts'))].map(rel)
  const components = graph.filter((f) => f.startsWith('components/'))
  assert.deepEqual(components, [], `runtime 入口引到了组件：${components.join('、')}`)
  assert.ok(graph.includes('runtime/glassium.ts') && graph.includes('renderer/stage.ts'), '图里应该有 runtime 与 stage')
  // 反向对照：完整入口是带组件的
  const fullGraph = [...importGraph(resolve(srcDir, 'index.ts'))].map(rel)
  assert.ok(fullGraph.includes('components/register.ts'), '完整入口应该带组件')
})

test('glassium/runtime 的导出是完整入口的子集：同名的是同一个对象', () => {
  for (const [name, value] of Object.entries(runtime)) {
    assert.ok(name in full, `完整入口没有 ${name}`)
    assert.equal((full as Record<string, unknown>)[name], value, `${name} 在两个入口里不是同一个对象`)
  }
  assert.equal(runtime.default, full.default, '默认导出是同一个 glassium')
})
