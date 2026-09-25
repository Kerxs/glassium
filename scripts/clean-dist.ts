/**
 * 库构建的第一步：清掉旧的 dist/。tsc 是增量写的 —— 删掉或改名的模块，它上一次的产物会一直留在 dist 里，
 * 跟着发布出去。
 */

import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
rmSync(dist, { recursive: true, force: true })
console.log(`[build:lib] 清掉 ${dist}`)
