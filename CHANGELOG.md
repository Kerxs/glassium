# 更新记录

格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [语义化版本](https://semver.org/lang/zh-CN/)。
0.x 期间次版本号的变化也可能不兼容；1.0 起按下面 1.0.0 那一节写的承诺，2.0 之前不破。

## [未发布]

### 性能

都是 Meshora 的客户端"每次启动卡、用着不流畅"查出来的（CPU 慢四倍的模拟下量的）：

- **管线异步编译**：WebGPU 渲染器构造时的管线改用 `createRenderPipelineAsync`，`GpuRenderer.create` 等它们建好再返回。
  以前同步建，GPU 进程编译玻璃的着色器时整个停住，页面一帧都出不来 —— 启动时卡 0.4–0.5 秒（独显上也是）。
  现在后台线程编译，页面照常出帧，玻璃先用兜底表面。运行时再要的管线（别的格式）照旧同步建。
- **能力探测不再白建 WebGL2 上下文**：`capabilities` 的 `webgl2`、`maxTextureSize`、`tier` 改成读到才查。`glassium.ready`
  结束时要读一次能力，以前每次都同步建一个 WebGL2 上下文只为读纹理上限（慢的机器上上百毫秒，堵在启动的主线程上）；
  后端已经是 WebGPU 时 `tier` 不看它们，就不建了。
- **画布当场景时不再预先查跨源**：以前把画布画到 1×1 的画布上再读一个像素，GPU 加速的画布要整张同步回 CPU，
  同样堵在启动上。画布被跨源图片污染很少见，真被污染了上传时会失败、后端警告一次（视频、视频帧、图片照旧预先查）。
- **层级检查不再惊动自己**：命中测试时临时切画布的 `pointer-events`，stage 看 style 变化的观察器没排除它 ——
  每次检查都让所有面板的样式缓存作废、再画一帧，页面不动时也一直在重读样式、重画。
- **只改文字不重扫背景**：runtime 看到文字节点变了（数字刷新之类）就把所有玻璃后面重新扫一遍（几十次 `elementsFromPoint`），
  每秒刷新一遍状态的页面会一直在扫。只改文字的变化现在只重画收进场景的那块内容，不重扫背景。

### 变化

- **CSS 画的玻璃也有液态玻璃的边**（overlay、对话框 / popover 里、`backend: 'css'`）：以前只有一像素的亮边和投影，
  看着是一块平的磨砂板。折射还是做不了，近似出它的样子：边上一圈由亮到透的光带（宽度跟着 `refraction`，折射带越深玻璃看着越厚，
  3–18px）、左右一红一蓝两条色边（强度跟着 `dispersion`，没有色散就没有）、顶上一道淡淡的高光（跟着 `highlight`）。
  都乘 `opacity`；减少透明度、不支持 `backdrop-filter` 时换成实底，高光也去掉。新的 CSS 自定义属性：`--glassium-band`、
  `--glassium-band-light`、`--glassium-disp-red`、`--glassium-disp-blue`、`--glassium-sheen`。按 Meshora 的需要做的（弹窗、安卓客户端）。

## [1.1.1] — 2026-10-08

补丁版本：都是 [Meshora](https://github.com/Kerxs/meshora) 的客户端用的时候要的 —— CSS 画玻璃时标签栏也有液态玻璃透镜，
GPU 玻璃生效时元素自己的默认底色换成透明。公开接口不变。

### 新增

- **`<glass-tab-bar>` 在 CSS 画玻璃时也有透镜**（`backend: 'css'`、对话框 / popover 里）：以前按住、拖动只是一块浅色鼓起来，
  底下的字原样不动。现在按住时各格的内容由一张 2D 画布画（css-lens.ts）：透镜外原样，透镜里换成选中色、中间放大、
  越靠左右两边越压缩、到边上与透镜外接上（凸透镜的边缘），边上带一圈红蓝色散；气泡变成透明的，一圈细亮边、上亮下暗、
  左右一红一蓝、底下一点投影。透镜的形状每帧从气泡读（按压的缩放、果冻、飞过去都跟着），只在按住到松手后过渡走完时出帧。
  静止的气泡也多了上沿一道亮边。GPU 画的时候不变。按 Meshora 的需要做的（安卓客户端底部的标签栏）。

### 变化

- **GPU 玻璃生效时，元素自己的底色换成透明**（runtime 样式表里一条优先级 0 的规则）：GPU 玻璃画在页面底下，元素的底色会把它
  整块盖住 —— 以前 `<button glass>` 要自己写 `background: transparent` 去掉浏览器的默认底色（Meshora 就写了一条）。
  作者自己写的底色照样盖过这一条；CSS 画的玻璃（没生效、overlay）不受影响。

### 文档

- limitations.md：CSS 画的玻璃套 CSS 画的玻璃、里层伸到外层外面时会透出下面的内容（Chromium），以及怎么避开。

## [1.1.0] — 2026-10-07

次版本：新增 `backend: 'css'`，修了收背景的两处问题 —— 都是 [Meshora](https://github.com/Kerxs/meshora) 的客户端用的时候撞上的。公开接口只加不改。

### 新增

- **`configure({ backend: 'css' })`**：不建 GPU stage，所有玻璃（`[glass]` 与组件）照材质用 CSS 画 —— 与 overlay 玻璃同一套画法
  （模糊、饱和度、着色、亮边、投影，没有折射）。触屏设备上用得着：那里的滚动由合成线程直接做，画在页面底下的 GPU 玻璃
  会慢一两帧、落在文字后面；也省掉了每帧量一遍玻璃。这时 `capabilities.renderer` 是 `'css'`，`ready` 不去查 WebGPU。

### 修复

- **用 CSS 画的玻璃（`overlay`）把它后面的东西收进了场景**：收背景、收内容的扫描照样拿 overlay 玻璃做命中测试，
  把它后面写了背景的元素挪进 GPU 场景（画到页面最底下、DOM 背景清掉）—— 对话框的遮罩跑到正文底下、对话框里着色按钮的
  底色被清成透明。现在自己或祖先写了 `overlay`、或者已被标成 overlay 的玻璃都不拿来做这两种扫描（`drawnWithCss`）；
  页面的根背景照旧按「有没有玻璃」收（只剩 CSS 玻璃时画布上不露出内置场景）。
- **别的玻璃的兜底表面被当成背景收进了场景**：卡片里的着色按钮还没生效时，runtime 的样式表照材质给它画了一层 CSS 表面；
  卡片第一次扫描时把这层当成挡在后面的背景收走，按钮生效之后底下一直垫着一块颜色。现在玻璃元素自己
  （写了 `glass`、有 runtime 编号、已经生效）一概不收（`isGlassElement`）。

## [1.0.1] — 2026-10-06

补丁版本：滚动卡顿的修复、验证页的两处修复，加上一项内部重构。公开接口、HTML 属性、`stats()` 字段都没变。

### 修复

- **滚动一卡一卡**：runtime 收背景、收内容的扫描在每个滚动帧对所有玻璃重做命中测试（首页十几块玻璃，每帧约 150 次
  `elementsFromPoint`）。现在滚动帧只扫相对页面动了的玻璃（吸顶、固定定位的）—— 跟着页面一起滚的玻璃下面的内容不会换；
  滚动停下 150ms 后补一次全量扫描。首页每帧的命中测试 150 → 29 次、1.7 → 0.4 ms，收进场景的块不变。
- **verify.html 在 WebGL2 上偶发失败**（1.0.0 起就有）：`deterministic`、`local-quality` 偶尔差一个像素 1 级。查清了是驱动噪声
  —— 送进 GPU 的调用流逐字节相同，NVIDIA + ANGLE（D3D11）给出两种结果（docs/calibration.md「WebGL2 帧间差 1 级」）。
  这两项「同一画面重画应当相同」的比较在 WebGL2 上容许至多 2 个像素差 1 级，并写进详情；WebGPU 照旧逐位比。
- **verify.html 的 `scene-reuse` 在页面可见时失败**：给填充换色之后让出了一下，rAF 在跑时会先画掉新颜色的那一帧，
  接下来那一帧反倒沿用了场景。改成换色后紧接着画。只影响验证页，不影响库。

### 变化

- 删掉了用不上的文件：组件目录里两个转发文件（`components/attributes.ts`、`components/morph-glass.ts`，包的 `exports`
  本来就不允许深路径引用，对使用者没有影响；它们的测试挪到了真身旁边）、旧地址的跳转页（`demo.html`、`runtime.html`、`devices.html`、`playground.html`；
  旧链接现在是 404，站点入口是首页的 `#overview`、`#devices`、`#editor`）、早期的开发记录
  `docs/progress.md`（内容在 CHANGELOG 与 calibration.md 里）。旧版本的标签与 Release 删了，下面旧版本的链接改指当时的提交。

### 内部

- **只读的场景**（`src/renderer/scene.ts`，内部，公开接口不变）：每帧量到的面板、合并组、填充编成有类型的 `Scene`
  （节点带父子、层、Z 序、包围盒、裁剪、不透明度、transform / layout / material / content 四类脏标记），作为渲染器的正式输入
  （`FrameInput.scene`）。「静止时不画」改为读场景的脏标记，结论与之前逐项相同（有对照测试）；`stage.debug.scene()` 从场景读；
  两个后端的分层改读 `scene.layers`。像素、`stats()`、draw 数不变（verify、regress、bench 对照过）。
  `inspectFrame` 的参数类型放宽成 `InspectableFrame`（视口 + 三个扁平数组，1.0 时传的对象照样能传）。

## [1.0.0] — 2026-09-30

第一个稳定版。路线（docs/architecture.md「路线」）做完了能在开发机上做完、验证得了的部分；有意不做、做不了的写在各节里
（可变的场景图对象、顶层里的 GPU 玻璃、画布的脏区域、Firefox / Safari / 移动端的实测）。

**兼容承诺**（2.0 之前不破）：docs/api.md 里标（稳定）的导出（`spec/api/stable.txt`）；写在 HTML 里的 `glass` / `glass-*`
属性、预设名、组件的材质属性、`configure` 的配置项（`spec/api/attributes.txt`）；`stats()` 已有的字段；`glassium.css` 的兜底表面。
标（进阶）的导出、画出来的像素（调校会让外观细微地变）、控制台信息不在承诺里。已废弃的 `glass(preset, overrides)` 1.x 里照旧能用。

### 新增

- **接口冻结补全**：交互、动画、质量与资源、检查器的 37 个接口从「进阶」转成稳定（`ElementMotion`、`everyFrame`、`PressInteraction`、
  `GlassBinding`、`AdaptiveQuality`、`FrameMonitor`、`QualityController`、`allocateQuality`、`ResourceUsage`、`GpuPasses`、
  `SceneSnapshot`、`hitStacksBehind` ……）；写在 HTML 里的接口签进 `spec/api/attributes.txt`，有测试核对，api.md 补了逐项的属性表。
- **verify 多了三项**：`atlas-upload`（图集局部上传）、`content-border-decoration`（边框与装饰线进场景）、`accessibility`
  （画布不进无障碍树、玻璃元素还是它自己、收进场景的字还在 DOM 里、高对比度时退回 CSS 并还原）；`absorb-background`
  加了「摘出文档」一例。
- **GPU 时间分账**：`stats().gpuPasses` —— 一帧的 GPU 时间按段拆成场景、模糊、玻璃、层（WebGPU 的 timestamp-query，
  在段与段之间打时间戳）；调试面板的「GPU」一行跟着显示。`passesFrom` 是时间戳到分账的算法。
- **`glassium/runtime` 入口**：只有 runtime（`<div glass>`、`glass()`、`configure`、内容进场景、果冻与飞行、变形、时间轴……），
  不注册、不带 `<glass-*>` 组件 —— 打包压缩之后 gzip 约 98 KB（完整入口约 117 KB）。导出是完整入口的子集、同一个对象。
  示例页 `/runtime-only.html` 自己查一遍（玻璃生效、组件没注册）。
- Playground 的「给出代码」多了零配置的写法（`<div glass glass-*>`，圆角写成 CSS）；JavaScript 的写法换成
  `glass(element, { preset, material })`（原来给的是已废弃的 `glass(preset, overrides)` + `stage.register`）。

### 变化

- **内容进场景时画边框与文字装饰**：DOM Renderer 收的块里，元素的边框（四边一样时带圆角，虚线、点线近似）与
  下划线 / 上划线 / 删除线（祖先上写的也算）画进场景。原来边框留在 DOM 里盖在玻璃上面，装饰线在 DOM 里被设成透明、
  场景里又没画 —— 等于消失。
- **位图图集只传画过的格子**：图集记着每一格画在哪个版本，后端只把上次之后画过的那几块传进纹理（WebGPU 的
  `copyExternalImageToTexture` 带原点、WebGL2 的 `texSubImage2D` + `UNPACK_SKIP_*`），清空重排、长大时才整张传。
  玻璃后面播着视频、分段控件按住拖动时，每帧传的从整张图集（1024² 起）降到变了的那一格。`stats().atlasUploadPixels` 记累计像素。
- **站点合成一个页面**：顶部一条玻璃导航，五个标签 —— 概览（零配置）、控件、设备、材质（原 Playground）、开发者（工具页与文档的入口）；
  地址带 `#标签`。整页一个 stage，同一时间只有当前标签的内容在文档里，各标签显示时换上自己的场景。旧地址 `runtime.html`、
  `devices.html`、`playground.html`、`demo.html` 跳到对应的标签（地址参数照带）；工具页（verify、regress、bench、debug、lab、
  runtime-only）各自独立，顶上有回到站点的链接。
- runtime 用到的几样挪出了组件目录：画内容进 2D 画布（`renderer/paint-content.ts`）、材质属性的解析（`core/attributes.ts`）、
  变形（`interaction/morph.ts`）；组件目录里原来的文件照旧能引（转发）。runtime 启动时注册组件改由完整入口注入。

### 修复

- runtime 收进场景的背景元素被摘出文档之后（单页应用换页、切走的标签）一直留在收进去的名单里、填充不注销：
  现在下一次扫描就放掉（摘掉属性，挂回来时按那时的样式重新收）。

## [0.4.0] — 2026-09-29

统一的交互与动画（任意元素的果冻、飞行、变形，一条时间轴），合成器的脏状态（只动了玻璃的帧不重建场景），GPU 计时与显存的账、
预算，视觉回归与兼容性矩阵，调试面板的检查器，API 冻结。公开接口没有不兼容的改动。

### 新增

- **任意元素的果冻与飞行**：`glass-jelly` / `interaction: { jelly: true }` —— 元素怎么动的都行（拖、CSS 过渡、JS 动画），
  玻璃顺着速度拉长、停下圆回去；`glass-glide` / `interaction: { glide: true }` —— 元素一下子换了位置，玻璃抬起、飞过去、
  落下，尺寸一起过渡。只动玻璃，元素与里面的字不变形；滚动不算动；减少动效时不动。`ElementMotion`。
- **统一的时间轴**：`nextFrame` / `cancelFrame` / `everyFrame` / `flushFrame`。按压、旋钮、果冻、飞行、变形都排在一个 rAF 上，
  stage 画之前先跑，动画这一帧写的值这一帧就画；减少动效时时间一步跳到头。自己的动画也可以排在上面。
- **局部质量**：整页吃紧时先降最贵的那几块 runtime 玻璃（`allocateQuality`，成本 = 面积 × 模糊 × 色散的估计），整页后降；
  `glass(el, { quality: 0.6 })` / `glass-quality` 把一块写死。`GlassPanel.setQuality`、`combineQuality`、`AdaptiveQuality` 的 `locals`。
- `GlassPanel.setPresentation`（`PanelPresentation`、`presentRect`）：玻璃相对元素的盒子挪、缩，元素不动。
- `glassium.morph(from, to)`：`morphGlass` 两头的材质也能从 runtime 的玻璃上取。
- **只动了玻璃的帧不重建场景**：场景、第 0 层的填充、模糊链都没变（果冻、飞行、拖动、按压的补间）时沿用上一帧的，
  只画背景与玻璃 —— draw 从 2 + 2(K−1) + N 降到 1 + N、模糊 0 趟，像素逐位相同。`stats().sceneReused` / `sceneReuses`，
  `stage.debug.setSceneReuse(false)` 关掉。有嵌套玻璃（更高的层）的页面也沿用：层改过的那一块先从备份拷回、局部重建。
- **零配置的静止页面不再每帧都画**：内置 gradient 场景被页面根背景（不透明、铺满）整个盖住时，它随时间漂也看不见，不算变化。
- **GPU 计时**：WebGPU 有 `timestamp-query` 时量每帧的 GPU 时间（`stats().gpuMs`、`StageFrame.gpuMs`、调试面板），
  自适应质量按它判断 GPU 吃不吃紧（`OVER_GPU` / `COMFORT_GPU`，`FrameWindow.gpuRatio`）。
- **显存预算与驱逐**：`createGlassStage({ memoryBudget })` / `stage.setMemoryBudget(bytes)` / `configure({ memoryBudget })` ——
  超了先放闲着的纹理（层的来源与备份），还超就把场景的像素预算一次降两成，到保底清晰度为止（`stats().memoryScale`、
  `memoryOverBudget`）；去掉预算就回到原样。连着 600 帧没有层时后端自己放掉层的纹理（`IDLE_LAYER_FRAMES`）。
- **资源账**：`stats().gpuMemory`（显存估计：模糊链、草稿、层的来源与备份、图集、场景纹理、画布；调试面板按项列出）。
- **在框架里用**：docs/frameworks.md（React / Vue / Svelte 的写法、TypeScript 的属性声明、SSR、常见问题）。
- **调试面板三页**：概览、场景（场景检查器与材质检查器：上一帧的每一块玻璃与填充，点一行或「选取」页面上的元素，框出它、
  列出材质、效果链、质量系数、呈现变换）、资源（显存每一项、创建计数）。`stage.debug.scene()`（`SceneSnapshot`）。
- **API 冻结**：api.md 里（稳定）的几节 —— 新增 Runtime（`glassium`、`glass`、`configure`、能力、预设、`nextFrame` …）——
  的名字签在 `spec/api/stable.txt`，测试核对；改冻结的接口要连快照一起改。
- **视觉回归**：`/regress.html` 九个标准场景缩成 48×32 与基准比（带容差，按后端 + GPU 存在 `spec/golden/baselines.json`，
  本机两个后端的基准已签入；`?regress.perturb=` 反向对照）。
- **兼容性**：docs/compatibility.md —— 四级退化、实测过的格子、按平台能力推断的格子、新设备上的验法。
- **性能测试页**：1 / 10 / 50 / 100 块、两层、填充、裁剪遮罩、大模糊、每帧挪一块、每帧都变的场景；每组量「整帧」与「实际」
  两遍，加上 GPU 时间、显存、沿用比例（docs/benchmark.md 有这台机器的结果）。
- 示例页 `/runtime.html` 加了「动起来的玻璃」一节（拖动的果冻、飞过去的选中块、展开收起的变形）；验证页新增 element-motion、
  local-quality、scene-reuse、memory-budget（`?verify.noreuse` 整轮不沿用场景，查问题用）。

### 变化

- 组件与 runtime 的动画（按压、旋钮、果冻、飞行、变形）都改走统一的时间轴，时序与之前相同；减少动效时正在走的动画一步落地。
- WebGPU 设备在适配器支持时多要一个 `timestamp-query` 特性（GPU 计时用），不支持时照常建。
- 验证页的 deterministic 一项关掉沿用场景、每帧整帧画（验重建本身是不是确定的）。

### 修复

- `glassium.ready` 在 import 之后马上读（runtime 还没开始扫描）时，不等 stage 就 resolve，`renderer` 报 `none`、`tier` 却是 3；
  现在先等第一次扫描。
- `morphGlass` / `glassium.morph` 的 to 原来被 CSS 的 `opacity: 0` 藏着时，走完还是看不见；现在终点写成 `opacity: 1`。

## [0.3.0] — 2026-09-27

Glassium 从组件库转向 **Web Liquid Glass 渲染运行时**（docs/architecture.md）：`import 'glassium'` 之后 `<div glass>` 就是玻璃。
组件照旧可用，改成建在同一个 runtime 上。

### 新增

- **零配置**：`import 'glassium'` 在浏览器里自动启动，接管页面上的 `[glass]`（`glass="tinted"` 选预设，`glass-blur` 之类覆盖材质），
  第一次出现 `[glass]` 才建 stage；`configure({ auto: false })` 关掉。包的 `sideEffects` 加上了 `dist/index.js`。
- **`glass(element, options)`** → `GlassHandle`（update / destroy），`glassOf(el)`；Default Glass 与 default / clear / tinted / frosted 预设；
  圆角跟着 CSS 的 border-radius；可交互的元素默认有悬停、按压、焦点反馈（`PressInteraction`，`<glass-button>` 用的也是它）。
- **`glassium` 命名空间**（默认导出、`window.glassium`）：`configure`、`capabilities`（tier 按能力定）、`ready`、`start`、`stage`、
  `debug.enable()` 调试面板。
- **背景自动收进场景**：`[glass]` 后面挡着的元素的 CSS 背景（纯色、一层渐变、一层同源图片）画进场景、原背景换成透明，
  页面的根背景做场景底色。填充多了 `paint`、`back` 两个选项。
- **自适应质量**：`AdaptiveQuality`、`FrameMonitor`、`QualityController`、`factorsFor`；`stage.setQuality`、`stage.onFrame`。
  runtime 建的 stage 默认自适应（掉帧快降、宽裕慢升、不振荡、结果记在 localStorage），后端不因为掉帧切换。
- **DOM Renderer**：`[glass]` 后面的内容块（文字、`<img>`、内联 SVG、`<canvas>`、`<video>`）画进场景、DOM 那一份变透明，
  玻璃折射、放大得到；块里变了只重画这一块，视频按 `requestVideoFrameCallback` 出一帧画一次，画布按缩略指纹变了才画；
  跨源的内容只警告、不污染场景；不在玻璃后面了就还给 DOM。`configure({ absorbContent })`、`contentBlocks()`、`contentStats()`、
  `glassium.debug.info()`、`hitStacksBehind()`；`paintContent` 多了 `PaintOptions`（背景色、画布与视频、`object-fit`）。
- 零配置示例页 `/runtime.html`（加了一段文字、图片、画布、视频和跟着指针走的放大镜）；验证页新增 glass-attribute、
  absorb-background、adaptive-quality、dom-renderer。

### 变化

- 组件的注册路径抽成 `GlassBinding`，与 runtime 共用；jelly / glide / motion 挪到 `src/interaction/`。
- 旧的 `glass(preset, overrides)`（返回材质）照旧能用，标为废弃。
- `VERSION` 挪到 `src/version.ts`（入口照旧导出）。
- 切换时的飞行快了：抬起 70 → 40ms，飞 300–560 → 180–300ms（跳一格约 0.2 秒）。
- 切换时看得见果冻：飞行的果冻不再平滑速度、形状跟得更紧（拉得最长的时候在中段），纵向压扁得更明显（`sx^−0.7`，
  原来 `1/√sx`，拖动也一样）。开关的旋钮行程短，速度放大 3 倍再算果冻。
- 飞行时只轻轻鼓起：新的 `--glass-fly-scale`（默认 1.2），不再鼓到长按的大小。
- 长按的放大收小一点：标签栏 1.7 → 1.45（高 × 0.94），分段控件、滑块、开关 1.6 → 1.4。

## [0.2.0] — 2026-09-27

按 iOS 27 实机截图再调一轮（docs/calibration.md「iOS 27 截图」）。**默认外观与交互又变了**：白底上多了外线，按住时的
透镜大得多，用户切换时选中块会飞过去 —— 要接近 0.1.0 的大小，写 `--glass-press-scale`（见下面「变化」）。

### 变化（不兼容）

- 玻璃最外一圈多了一道半透明的深灰外线（左右深、上下浅）：白底上的旋钮、标签栏终于看得见边界；暗底上几乎看不见。
  亮边从外线里面开始。CSS 画的玻璃多一圈 0.5px 的深灰外描边。
- 标签栏的气泡：静止时是一层 0.2 的中灰（白底的栏上比栏暗一点，深色的栏上亮一点），按住时的透镜比栏还高（见下一条）。
- 按住的旋钮影子更深一点（0.2 → 0.3）。
- 按住时放大得多得多：标签栏 1.12 → 1.7 × 1.6，分段控件 1.15 → 1.6，滑块、开关 1.25 → 1.6。
  都可以用 `--glass-press-scale` 改。
- 果冻按速度平滑地饱和（最多 +45%，原来 +22% 而且一般的拖动就顶到上限）：慢拖只长一点，快甩长得多。
- 外线左右更深一点（混的比例 0.5 → 0.6，上下不变）；按住时的体光（上暗下亮）不进外线 —— 按住的滑块旋钮下沿的外线
  不再比上沿浅。

### 新增

- 拖动时的果冻：分段控件的选中块、标签栏的气泡、滑块与开关的旋钮顺着拖动的速度横向拉长、纵向收一点，
  停下来平滑地回到原样，不晃。减少动效时关掉。
- 分段控件、标签栏按住拖动时，透镜里的字与图标都换成选中那一段的颜色（透镜外还是原色）。
- `registerBitmapFill(element, painter, { anchor })`：painter 在锚点元素的盒子里画，填充自己的盒子只决定露出哪一块 ——
  一张画好不动的内容只在一个跟着旋钮走、会缩放的窗口里露出来，不用每帧重画。
- `registerBitmapFill` 的 `oversample`（画得更细，透镜放大之后不虚）与 `hole`（另一块填充画的地方这一块让出来）。
  透镜里的字用了这两个：放大 1.2 倍不发虚；原色的那一份在透镜里挖掉，边缘不再有一丝灰。
- 切换时玻璃「飞」过去（glide.ts）：分段控件、标签栏点别的段 / 格（方向键、拖完松手也是），开关点一下，选中块先原地
  鼓起成透镜，顺着速度拉长着飞到新位置，落地后缩回。飞行时宿主带 `data-flying`。程序改值、减少动效时不飞。
- 首页：控制中心多两块胶囊（屏幕镜像、家庭）与一排圆按钮，设置多一组「文字」（滑块与开关），锁屏的丝带有了投影与明暗。

### 修复

- 位图填充的盒子比锚点大（标签栏按住时透镜比栏高）时，会采样到图集里旁边的格子；现在格子外按透明。

## [0.1.0] — 2026-09-26

外观按 iOS 26 真机截图重调（docs/calibration.md「质感对照」）。**默认外观变了**，升级之后玻璃会与 0.0.1 不一样 ——
要回到原来的样子，按下面「变化」一节里的旧值把材质写出来。

### 变化（不兼容）

- 亮边改成一整圈：上下两条最亮（双面）、左右约一半，没有暗边；宽度 1.5dp → 1dp（不窄于 1.5 个设备像素）。
  CSS 画的玻璃同样。
- 投影：更淡、更紧，只在玻璃正下方露出来，两侧没有；形状（σ、偏移、往里缩）随短边按比例定；颜色是玻璃背后的
  平均色压暗，不是纯黑。
- 默认值与预设：更透、白色少一点、饱和度回到接近原样（截图上玻璃里外的色度几乎不变），边缘折射更强。
  regular（= 默认值）：blur 8 → 12、refraction 0.2 → 0.25、distortion 0.2 → 0.3、highlight 0.6 → 0.9、
  saturation 1.4 → 1.15、tint 白 0.18 → 0.1、shadow 0.3 → 0.35。其余预设同方向调整。
- 开关、滑块按住时的透镜：倒角窄、最边上位移大、不放大、有体光（里面上暗下亮）、几乎没有白色、不模糊。

### 新增

- 材质 `magnify`（属性 `magnify`）：玻璃里的内容放大 1 + magnify 倍。
- 材质 `bodyLight`（属性 `body-light`）：玻璃里面上暗下亮，像一颗厚玻璃珠。
- `<glass-segmented>`、`<glass-tab-bar>` 按住时把文字与图标画进场景，选中块 / 气泡的透镜放大它们、在边缘扭弯；
  透镜下面垫一块浅色（`--glass-segmented-lens`、`--glass-tab-bar-lens`），所以透镜里是亮的、字照样鲜艳。平时照旧是 DOM。
- `stage.registerBitmapFill(element, painter)`：位图填充，painter 用 2D 画布画的内容进场景（上面那项就是它）。

### 修复

- `morphGlass`：两头在 `transform: scale` 的祖先里时，结束的那一刻圆角、模糊、亮边不再跳（按两头各自的视觉缩放换算）。
- 合并组的影子颜色按各成员背后的平均色混合（原来取第一个成员的）：相距足够远时与各自单独绘制逐位相同。

## [0.0.1] — 2026-09-25

第一个公开版本。

### 渲染

- GPU 画的玻璃：折射（圆角矩形 SDF 的边缘透镜，squircle、depth effect）、真正的逐通道色散、不对称的亮边与暗边、
  共享的多级模糊链、饱和度与 tint、投影、按压处的光。
- 后端阶梯：WebGPU → WebGL2 → CSS 兜底（没有 GPU、强制配色时组件显示可读的 CSS 表面）。两个 GPU 后端整帧逐像素
  对得上（差异 < 0.1% 的像素、最大差 2/255），设备丢失时自动重建。
- 场景：内置的程序化场景，或者 `stage.setScene()` 的图片 / 视频 / 画布（按 object-fit 铺满）。
- 玻璃叠玻璃（最多四层）、合并（smin，一组最多四块）、`<glass-fill>` 画进场景的纯色与渐变填充。
- 可选的线性光混合（`blendSpace: 'linear'`）。
- 跟着 DOM 走：滚动、`transform`（平移、缩放、旋转）、CSS `opacity`、`overflow` 裁剪（含圆角与椭圆角）、
  `clip-path` 的基本形状、`mask-image` 的渐变。
- 静止时不画；减少动效、减少透明度、更高对比度都有反应。

### 组件（Custom Elements）

- `<glass-card>`、`<glass-button>`（表单关联、按压动画）、`<glass-container>`（合并；`morph` 时成员像水滴一样分出来、
  融回去）、`<glass-fill>`。
- `<glass-switch>`、`<glass-slider>`、`<glass-segmented>`：行为与原生控件相同（键盘、表单、`input` / `change`）。
- `<glass-tab-bar>`（`minimize="scroll"`）、`<glass-nav-bar>`（`large-title`）、`<glass-toolbar>`。
- `morphGlass(from, to)`：一块玻璃变成另一块。
- `scroll-edge`：浮在正文上的玻璃，正文滚到它底下时淡入磨砂。
- 模态对话框、popover 里的玻璃（以及写了 `overlay` 的）自动改用 CSS 画。

### 已知的边界

玻璃折射的是 Glassium 自己画的场景，不是它背后的 DOM；盖在 DOM 上的玻璃没有折射。完整的列表在
[docs/limitations.md](docs/limitations.md)，先读开头那三条编写规则。

[未发布]: https://github.com/Kerxs/glassium/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/Kerxs/glassium/releases/tag/v1.1.1
[1.1.0]: https://github.com/Kerxs/glassium/releases/tag/v1.1.0
[1.0.1]: https://github.com/Kerxs/glassium/releases/tag/v1.0.1
[1.0.0]: https://github.com/Kerxs/glassium/releases/tag/v1.0.0
[0.4.0]: https://github.com/Kerxs/glassium/tree/ebbbdd9f83c37a8bacbdcb11b343d86684514772
[0.3.0]: https://github.com/Kerxs/glassium/tree/d8f5be53c182395513a5d62c1172d732ad474373
[0.2.0]: https://github.com/Kerxs/glassium/tree/7ecb67174db54b13551a822635b053bc31d33cbf
[0.1.0]: https://github.com/Kerxs/glassium/tree/1c726dc370ce13cabadfbd2f28e338ef04806f3a
[0.0.1]: https://github.com/Kerxs/glassium/tree/247b312e69cc9fca79a174446ae6b20f64bad8c0
