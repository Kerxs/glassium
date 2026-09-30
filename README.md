# Glassium

面向 Web 的 Liquid Glass（液态玻璃）渲染运行时。让任意 DOM 元素获得同一套可自适应的液态玻璃：折射、色散、亮边、融合
由 GPU 画（WebGPU，没有时 WebGL2，再不行是 CSS 玻璃，最后是普通 DOM），质量按实测帧时间自己调。

```html
<script type="module">import 'glassium'</script>

<div glass>Hello World</div>
<button glass>Continue</button>
<div glass="tinted" glass-blur="20">…</div>
<div class="puck" glass glass-jelly>拖我</div>   <!-- 动起来时玻璃顺着速度拉长 -->
<div class="indicator" glass glass-glide></div>  <!-- 换位置时玻璃飞过去 -->
```

不用选后端、不用写着色器、不用把页面背景挪走：玻璃后面的 CSS 背景由 runtime 自动收进场景，玻璃折射得到。
元素还是它自己 —— 语义、焦点、键盘、读屏都不变，玻璃只是画在它后面。建在同一个 runtime 上的组件（开关、滑块、分段控件、
标签栏……）照旧可用。

**在线看**：[kerxs.github.io/glassium](https://kerxs.github.io/glassium/) —— 一个页面、五个标签：
[概览](https://kerxs.github.io/glassium/#overview)（一个普通网页，只写了 glass 属性）·
[控件](https://kerxs.github.io/glassium/#controls)（设置、控制中心、标签栏、锁屏四个场景里的控件，都能操作）·
[设备](https://kerxs.github.io/glassium/#devices)（iPhone 与 Mac）·
[材质](https://kerxs.github.io/glassium/#editor)（调材质、拿代码）·
[开发者](https://kerxs.github.io/glassium/#dev)（验证、回归、性能测试、调试台）

- **真的折射**：边缘的透镜按圆角矩形的距离场弯折背景，浮点精度，没有 SVG 位移贴图的 ±128px 与色阶。
- **逐通道色散**、一整圈的亮边（上下最亮）与白底上看得见的淡灰外线、按压时的放大与体光、按压处的光、投影、
  按背景亮度自适应的可读性 —— 外观按 iOS 26 / 27 真机截图的实测调（[docs/calibration.md](docs/calibration.md)）。
- 分段控件、标签栏按住时，文字与图标画进场景，被选中块 / 气泡的透镜放大、在边缘扭弯，透镜里换成选中色；
  拖动时透镜顺着速度拉长（果冻），停下来平滑地回去；点别的格、点开关时玻璃鼓起、拉长着飞过去再落下。
- **玻璃连成一片**：`<glass-container>` 里的几块玻璃用 smin 融成一个形状，一次 draw；成员可以像水滴一样分出来、融回去。
- **任意元素都能动**：`glass-jelly` 让元素动起来时玻璃拉长、`glass-glide` 让它换位置时玻璃飞过去、
  `glassium.morph(a, b)` 让一块变成另一块 —— 只动玻璃，字不变形；动画都在同一条时间轴上，与画同一帧。
- **跟着 DOM 走**：滚动、transform（平移 / 缩放 / 旋转）、CSS opacity、overflow 裁剪、clip-path、mask-image 都跟。
- **完整的控件**：开关、滑块、分段控件、标签栏、导航栏、工具栏 —— 行为与原生控件相同（键盘、表单、无障碍）。
- **退得下来**：WebGPU → WebGL2 → CSS 兜底；减少动效、减少透明度、更高对比度、强制配色都有反应。

## 先知道：玻璃折射的是 Glassium 自己画的场景

Glassium 持有一张画布，玻璃折射的是这张画布上的场景 —— **不是玻璃背后的 DOM 像素**（浏览器不让脚本读任意 DOM 的像素：
能对实时 DOM 做几何位移的 `backdrop-filter: url(#svg)` 只有 Chromium 支持，读 DOM 像素的 HTML-in-Canvas 还只是 origin trial）。

runtime 替你把看得见的背景搬进场景：`[glass]` 后面挡着的元素的 CSS 背景（纯色、一层渐变、一层同源图片）与页面的根背景
自动画进场景，原来的 CSS 背景换成透明 —— 看上去没变。正文文字、`<img>`、iframe、视频还不参与折射（后续版本的 DOM Renderer）。

用组件（`<glass-*>`）直接写时照旧是三条编写规则（[docs/limitations.md](docs/limitations.md) 开头有详细说明）：

1. **玻璃到 `<body>` 之间的祖先背景必须透明**（或者 `configure({ absorbForComponents: true })` 让 runtime 收）。写了不透明
   背景的祖先会把玻璃整块盖住 —— Glassium 会在控制台点名是哪个元素。
2. **玻璃折射的是场景和它下面的玻璃，不是 DOM。** 玻璃底下要有颜色（开关的轨道、卡片后面的色块）就用 `<glass-fill>`。
3. **每个页面一个 stage。**

盖在正文上的玻璃（对话框、popover、浮动的菜单）改用 CSS 画：浏览器模糊下面的一切，没有折射。

## 安装

```bash
npm install glassium
```

ESM + 类型声明，不打包、不压缩（交给你的打包器）。没有运行时依赖（`@webgpu/types` 只有类型）。

两个入口：

| 入口 | 有什么 | 打包、压缩之后（gzip） |
|---|---|---|
| `glassium` | runtime（`<div glass>`、`glass()`……）+ 全部组件（`<glass-switch>`、`<glass-tab-bar>`……） | 约 117 KB |
| `glassium/runtime` | 只有 runtime，不注册、不带组件 —— 只用 `<div glass>` 的页面用它 | 约 98 KB |

两个可以同时引（共用同一套模块），`glassium/runtime` 的导出是完整入口的子集。

## 快速开始

```js
import 'glassium' // 自动启动：页面上的 [glass] 变成玻璃；<glass-*> 组件也注册好了
```

```html
<nav glass="clear">…</nav>
<div class="card" glass>…</div>
<button glass>保存</button>
```

要的时候再往下一层（[docs/api.md](docs/api.md) 的「Runtime」一节）：

```js
import glassium, { glass } from 'glassium'

glassium.configure({ quality: 'auto' })          // 自适应质量（默认）；也可以 'high' / 'medium' / 'low' / 0–1
const handle = glass(el, { preset: 'frosted', material: { blur: 20 }, interaction: { press: true } })
await glassium.ready
console.log(glassium.capabilities)               // { webgpu, webgl2, backdropFilter, tier, renderer, … }
glassium.debug.enable()                          // 右下角的调试面板：后端、质量、帧时间、面板数……
```

### 组件

页面上写组件，脚本里建一个 stage（用组件时不需要 `[glass]`）：

```html
<style>
  html, body { background: transparent; margin: 0 } /* 规则 1：页面背景交给 stage */
</style>

<glass-card preset="regular" corner-radius="24" style="margin: 40px; padding: 24px">
  <h2>Glassium</h2>
  <glass-switch name="wifi" checked></glass-switch>
</glass-card>

<glass-container smoothing="24" style="display: flex; gap: 10px; margin: 40px">
  <glass-button>左</glass-button>
  <glass-button>右</glass-button>
</glass-container>
```

用打包器（Vite、webpack……）时：

```js
import 'glassium/glassium.css' // 兜底样式：upgrade 之前、没有 GPU、高对比度时组件有一层可读的表面
import { createGlassStage, defineGlassElements } from 'glassium'

defineGlassElements() // 注册全部组件（import 'glassium' 在浏览器里也会自动注册，写上无妨）
await createGlassStage({ scene: '/wallpaper.jpg' }) // 背景图；不写就是内置的程序化场景
```

不用打包器时，`dist/` 就是浏览器能直接加载的 ES 模块（相对路径 import，没有运行时依赖），从 CDN 引。零配置：

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/glassium@1.0.0/dist/index.js"></script>
<div glass>Hello World</div>
```

用组件：

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/glassium@1.0.0/dist/glassium.css" />
<script type="module">
  import { createGlassStage, defineGlassElements } from 'https://cdn.jsdelivr.net/npm/glassium@1.0.0/dist/index.js'

  defineGlassElements()
  await createGlassStage()
</script>
```

兜底样式最好在 `<head>` 里用 `<link>` 引，赶在脚本之前生效。组件可以先于 stage upgrade，stage 建好时统一接上。

## 组件

| 元素 | 用来做什么 |
|---|---|
| `<glass-card>` | 玻璃面板，内容是普通 DOM |
| `<glass-button>` | 按钮：按下时鼓起来、光从按下的地方亮起；表单关联，行为与 `<button>` 相同 |
| `<glass-container>` | 把里面的玻璃（最多 4 块）连成一个形状；`morph` 时成员像水滴一样分出来、融回去 |
| `<glass-fill>` | 画进背景的纯色或渐变块（`--glass-fill`），玻璃看得见它 |
| `<glass-switch>` `<glass-slider>` `<glass-segmented>` | 开关、滑块、分段控件：轨道是填充、旋钮是玻璃，按住时旋钮变成透镜 |
| `<glass-tab-bar>` | 标签栏：选中那一格下面垫一个玻璃气泡；`minimize="scroll"` 往下滚时缩起 |
| `<glass-nav-bar>` `<glass-toolbar>` | 导航栏（`large-title`）与底部工具栏：两侧的按钮各自一个玻璃胶囊 |

材质写在属性上，与 `GlassMaterial` 一一对应：`preset`（`ultraThin` / `thin` / `regular` / `thick` / `clear`）、
`blur`、`refraction`、`distortion`、`highlight`、`dispersion`、`saturation`、`tint`、`opacity`、`corner-radius`、
`squircle`、`depth-effect`、`adaptive`、`shadow`。写错的属性在控制台报出来并被忽略。浮在正文上的玻璃写
`scroll-edge="top|bottom"`，正文滚到它底下时淡入磨砂。

## JavaScript

```js
import { createGlassStage, glass, morphGlass } from 'glassium'

const stage = await createGlassStage({ scene: '/bg.jpg' })
await stage.setScene(videoElement)                         // 背景换成视频（有新帧才上传）
glass(someDiv, { preset: 'thin', interaction: { jelly: true } })  // 任意元素变成玻璃（动起来时拉长）
await morphGlass(button, menu).finished                    // 按钮变成菜单
```

全部公开接口（stage 的选项与方法、组件的属性 / 事件 / CSS、材质、调试与验证）见 **[docs/api.md](docs/api.md)**。

## 浏览器

后端自动选：WebGPU 可用时用 WebGPU，否则 WebGL2，都没有时组件显示 CSS 兜底表面（页面照常工作，只是没有玻璃）。
两个 GPU 后端逐像素对得上（同一帧 < 0.1% 的像素不同、最大差 2/255）。

实测的环境是 Windows 上的 Chromium（Edge / Chrome，NVIDIA 独显，WebGPU 与 WebGL2 都跑）；别的浏览器与设备还没有逐项
验证过。GPU 的输出没有进 CI（GitHub 的机器没有 GPU），由 `playground/verify.html` 在浏览器里逐项验证，
现在是 WebGPU **PASS 46/46**、WebGL2 **PASS 45/45**（横屏 1280×720、竖屏 820×1200 都是）。

## 文档

| | |
|---|---|
| [docs/api.md](docs/api.md) | API 参考 |
| [docs/limitations.md](docs/limitations.md) | 编写规则与边界（先读开头三条） |
| [docs/benchmark.md](docs/benchmark.md) | 性能：面板数与帧开销 |
| [docs/compatibility.md](docs/compatibility.md) | 兼容性：四级退化、实测与推断的格子、新设备上怎么验 |
| [docs/frameworks.md](docs/frameworks.md) | 在 React、Vue、Svelte 里用：属性怎么写、TypeScript 声明、命令式写法、SSR |
| [docs/architecture.md](docs/architecture.md)、[spec/](spec/) | 架构、光学与管线规格（给实现别的渲染器的人） |
| [docs/calibration.md](docs/calibration.md) | 每一项功能的实测数字与反向对照 |
| [CHANGELOG.md](CHANGELOG.md) | 版本更新 |

## Playground、示例与验证

在线版在 https://kerxs.github.io/glassium/ ，跟着 `main` 分支：每次推送、CI 全部通过之后自动部署。也可以在本地跑：

```bash
git clone https://github.com/Kerxs/glassium.git && cd glassium
npm ci
npm run dev   # http://localhost:5174
```

在线版和本地一样。展示站点是一个页面（[`/`](https://kerxs.github.io/glassium/)），顶部五个标签，地址带 `#标签`：

- [`#overview`](https://kerxs.github.io/glassium/#overview)：概览（零配置）—— 一个普通网页（背景色、渐变、背景图），
  只写了 `import 'glassium'` 与 `glass` 属性；可以切质量档位、打开调试面板
- [`#controls`](https://kerxs.github.io/glassium/#controls)：控件 —— 照着 iOS 27 实机截图搭的四个场景（设置、控制中心、应用列表与标签栏、锁屏），
  控件都能操作；只用公开 API，壁纸、分组、图块是 `<glass-fill>`，列表标题与锁屏壁纸用位图填充画进场景
- [`#devices`](https://kerxs.github.io/glassium/#devices)：设备 —— iPhone 与 Mac 的界面：清透的玻璃图标、照片在玻璃标签栏底下滚动、
  控制中心、从按钮变形出来的面板（`morphGlass`）
- [`#editor`](https://kerxs.github.io/glassium/#editor)：材质 —— 调材质、换背景、看调试视图，右边给出对应的 HTML 与 JS
- [`#dev`](https://kerxs.github.io/glassium/#dev)：开发者 —— 下面这些工具页与文档的入口

整页只有一个 stage，切到哪个标签只有那个标签的内容在文档里（其余不画）。开发 Glassium 本身用的工具页各自独立（自己建 stage、固定视口）：

- [`/bench.html`](https://kerxs.github.io/glassium/bench.html)：性能测试（面板数与帧开销，结果见 [docs/benchmark.md](docs/benchmark.md)）
- [`/regress.html`](https://kerxs.github.io/glassium/regress.html)：视觉回归（标准场景与基准比，见 [spec/golden/README.md](spec/golden/README.md)）
- [`/debug.html`](https://kerxs.github.io/glassium/debug.html)：调试台（给开发 Glassium 本身用：统计、校准场景、各种模拟开关）
- [`/verify.html`](https://kerxs.github.io/glassium/verify.html)：逐项验证，结果写进标题栏（`PASS n/n`）；`?glassium.backend=webgl2` 换后端；
  视口至少要 820×720
- [`/runtime-only.html`](https://kerxs.github.io/glassium/runtime-only.html)：只引 `glassium/runtime` 的页面，自己查一遍玻璃生效、组件没注册
- [`/lab.html`](https://kerxs.github.io/glassium/lab.html)：质感对照（对着真机截图调质感的实验页）

## 开发

```bash
npm run typecheck
npm test           # Node ≥ 22.6：测试直接跑带类型标注的 .ts，没有测试框架依赖
npm run build:lib  # src/ → dist/
```

## 来源与许可

**Apache License 2.0**。光学数学移植自 [`Kyant0/AndroidLiquidGlass`](https://github.com/Kyant0/AndroidLiquidGlass)
（Apache-2.0，Copyright 2025 Kyant）并作了修改 —— 色散与高光是重写的，逐条见 [docs/porting-notes.md](docs/porting-notes.md)。
上游已经用 Compose Multiplatform 覆盖了 Android / iOS / 桌面 / Wasm；项目在 Kotlin 生态里的话应该直接用上游。
Glassium 填的是原生 Web / TypeScript 这一块。第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
