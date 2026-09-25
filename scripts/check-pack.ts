/**
 * 发布之前看一眼要进包的文件：`npm pack --dry-run --json` 列出来，逐条核对。
 *
 * 该有的：入口（JS 与类型声明）、兜底样式、许可与归属声明（Apache-2.0 §4 要求随附）、更新记录。
 * 不该有的：测试、TS 源码、playground、声明文件的 map（包里没有源码，那些 map 指向不存在的文件）。
 * `package.json` 的 exports / types / main 指向的文件也得真的在包里。
 *
 * CI 里在 `npm ci`（会触发 prepare → build:lib）之后跑；本地先 `npm run build:lib`。
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// --ignore-scripts：只列文件，不再跑一遍 prepare。整条命令交给 shell（Windows 上 npm 是 npm.cmd，不经 shell 起不来）；
// 参数是写死的，没有注入的问题
const out = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8' })
const [report] = JSON.parse(out) as [{ files: { path: string; size: number }[]; size: number; unpackedSize: number }]
const files = new Set(report.files.map((f) => f.path.replace(/\\/g, '/')))

const problems: string[] = []
const must = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'dist/index.js', 'dist/index.d.ts', 'dist/glassium.css']
for (const f of must) if (!files.has(f)) problems.push(`缺 ${f}`)

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  main: string
  types: string
  exports: Record<string, string | Record<string, string>>
  private?: boolean
}
if (pkg.private) problems.push('package.json 还写着 private: true，npm 不让发布')
const targets = [pkg.main, pkg.types, ...Object.values(pkg.exports).flatMap((e) => (typeof e === 'string' ? [e] : Object.values(e)))]
for (const t of targets) {
  const path = t.replace(/^\.\//, '')
  if (!files.has(path)) problems.push(`package.json 指向的 ${t} 不在包里`)
}

for (const f of files) {
  if (/\.test\.(ts|js)$/.test(f) || /\.test\.d\.ts$/.test(f)) problems.push(`测试进了包：${f}`)
  else if (f.startsWith('src/') || f.startsWith('playground/') || f.startsWith('scripts/')) problems.push(`不该进包：${f}`)
  else if (f.endsWith('.d.ts.map')) problems.push(`声明文件的 map 进了包（没有源码，它指向的文件不存在）：${f}`)
}

const kb = (n: number): string => `${(n / 1024).toFixed(0)} kB`
console.log(`[check-pack] ${files.size} 个文件，压缩后 ${kb(report.size)}，解压后 ${kb(report.unpackedSize)}`)
if (problems.length > 0) {
  for (const p of problems) console.error(`[check-pack] ${p}`)
  process.exit(1)
}
console.log('[check-pack] 通过')
