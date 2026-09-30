import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  // playground 是 dev server 的根：它才有 index.html。库本身没有入口页面。
  root: 'playground',
  // 资源用相对路径：构建出来的页面部署在 GitHub Pages 的 /glassium/ 子路径下（CI 的 pages 那一步），
  // 默认的 '/' 会让它们去站点根目录找 /assets/…。相对路径放在哪一层都对，本地 vite preview 也照样能开。
  base: './',
  publicDir: false,
  resolve: {
    // playground 按包名引用，和外部使用者写法一致 —— 免得 demo 里全是 ../../src。
    // 写成精确匹配的正则：字符串的键按前缀匹配，'glassium' 会把 'glassium/runtime' 也吃掉
    alias: [
      { find: /^glassium\/runtime$/, replacement: fileURLToPath(new URL('./src/runtime-entry.ts', import.meta.url)) },
      { find: /^glassium$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }
    ]
  },
  server: {
    port: 5174,
    // 必须 strict：Vite 默认会在端口被占时静默漂到 5175，
    // 而本地的预览配置（编辑器、脚本）写死了 5174，漂了就再也对不上。
    strictPort: true
  },
  build: {
    outDir: '../playground/dist',
    emptyOutDir: true,
    rollupOptions: {
      // 首页是整个展示站点（五个标签：概览、控件、设备、材质、开发者；标签的模块由 site.ts 动态引入、分包，不单列入口）。
      // 工具页各自独立：性能测试 bench.html、开发用的调试台 debug.html、把验证固化下来的 verify.html、视觉回归 regress.html、
      // 对着 iOS 26 截图调质感的 lab.html、只引 runtime 的 runtime-only.html。
      input: {
        main: fileURLToPath(new URL('./playground/index.html', import.meta.url)),
        bench: fileURLToPath(new URL('./playground/bench.html', import.meta.url)),
        debug: fileURLToPath(new URL('./playground/debug.html', import.meta.url)),
        lab: fileURLToPath(new URL('./playground/lab.html', import.meta.url)),
        verify: fileURLToPath(new URL('./playground/verify.html', import.meta.url)),
        regress: fileURLToPath(new URL('./playground/regress.html', import.meta.url)),
        'runtime-only': fileURLToPath(new URL('./playground/runtime-only.html', import.meta.url))
      }
    }
  }
})
