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
    emptyOutDir: true,
    rollupOptions: {
      // 首页是展示页（iPhone 与 Mac 上的液态玻璃，只用公开 API）；调材质、拿代码的 playground.html；
      // 性能测试 bench.html；开发用的调试台 debug.html；把验证固化下来的 verify.html。
      // demo.html 只是跳转页：旧的示例页并进了首页，旧链接跳过去
      input: {
        main: fileURLToPath(new URL('./playground/index.html', import.meta.url)),
        playground: fileURLToPath(new URL('./playground/playground.html', import.meta.url)),
        demo: fileURLToPath(new URL('./playground/demo.html', import.meta.url)),
        bench: fileURLToPath(new URL('./playground/bench.html', import.meta.url)),
        debug: fileURLToPath(new URL('./playground/debug.html', import.meta.url)),
        verify: fileURLToPath(new URL('./playground/verify.html', import.meta.url))
      }
    }
  }
})
