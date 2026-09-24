/**
 * 库构建的最后一步：tsc 不管 CSS，把组件的兜底样式抄进 dist/。
 * 使用者这样引：`import 'glassium/glassium.css'`，或 <link> 到它。
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const from = resolve(root, 'src/components/glassium.css')
const to = resolve(root, 'dist/glassium.css')
mkdirSync(dirname(to), { recursive: true })
copyFileSync(from, to)
console.log(`[build:lib] ${from} → ${to}`)
