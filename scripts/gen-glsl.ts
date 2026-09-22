/**
 * 从 src/shaders/optics.wgsl.ts 生成 GLSL ES 3.0 版本。
 *
 * 用法：node scripts/gen-glsl.ts
 *
 * 生成物签入仓库。理由有两条：WebGL2 后端不需要运行时构建步骤；以及实际发给驱动的
 * GLSL 是可以直接 diff 和阅读的 —— 着色器出问题时，能看到确切的源码比什么都重要。
 *
 * 改了 WGSL 却忘了跑这个脚本的话，src/shaders/generated.test.ts 会失败，CI 也会。
 *
 * 翻译与模块渲染都在 src/shaders/translate-glsl.ts 里，这个脚本只负责写文件 ——
 * 这样测试可以重算一遍产物而不碰工作区。
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { OPTICS_WGSL } from '../src/shaders/optics.wgsl.ts'
import {
  findResidualWgsl,
  renderModule,
  translateWgslToGlsl
} from '../src/shaders/translate-glsl.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'shaders', 'generated', 'optics.glsl.ts')

const glsl = translateWgslToGlsl(OPTICS_WGSL)

const residue = findResidualWgsl(glsl)
if (residue.length > 0) {
  // 自检失败说明重写器漏掉了某个构造却没抛 —— 那比抛错更危险，
  // 因为产出的 GLSL 可能恰好能编译。宁可在这里硬失败。
  console.error(`[Glassium] 生成的 GLSL 里仍残留 WGSL 痕迹：${residue.join(', ')}`)
  process.exit(1)
}

writeFileSync(OUT, renderModule(glsl), 'utf8')

const fnCount = (glsl.match(/^\w[\w\s]*\s\w+\(/gm) ?? []).length
console.log(`写入 ${OUT}`)
console.log(`共 ${glsl.split('\n').length} 行，${fnCount} 个函数`)
