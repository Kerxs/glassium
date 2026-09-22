import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  // playground 是 dev server 的根：它才有 index.html。库本身没有入口页面。
  root: 'playground',
  publicDir: false,
  resolve: {
    alias: {
      // playground 按包名引用，和外部使用者写法一致 —— 免得 demo 里全是 ../../src
      glassium: fileURLToPath(new URL('./src/index.ts', import.meta.url))
    }
  },
  server: {
    port: 5174,
    // 必须 strict：Vite 默认会在端口被占时静默漂到 5175，
    // 而 .claude/launch.json 里写死了 5174，漂了就再也对不上。
    strictPort: true
  },
  build: {
    outDir: '../playground/dist',
    emptyOutDir: true
  }
})
