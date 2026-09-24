# 架构

一句话：**Glassium 自己持有一块画布，场景和玻璃都画在上面；玻璃折射的是 Glassium 的场景，
不是它背后的任意 DOM。** 为什么只能这样，见 [limitations.md](limitations.md) 的「为什么玻璃折射不了任意 DOM」。

## 三层宿主

```
L2  #glassium-overlay        z-index: 3      预留给玻璃盖在 DOM 之上（GlassDialog / GlassSheet），第一期为空
L1  DOM 内容                  照常排版         文字、命中测试、焦点、输入法、无障碍全归 DOM
L0  canvas[data-glassium-scene]  position: fixed; inset: 0; z-index: -1   场景与玻璃
```

- 面板是 DOM 元素，负责占位与内容；stage 每帧量它的矩形，在它正后方的画布上画玻璃。
  滚动、缩放、布局变化都自动跟上，不监听任何事件。
- 画布在 `z-index: -1`：画在根背景之上、所有常规流内容之下。T5 到 T9 期间是 0，理由写错了，
  已撤回（limitations.md「画布为什么在 z-index: -1」）。
- 面板和画布之间的每一层都必须背景透明（R1）。违反时 `src/renderer/layering.ts` 在控制台点名元素。

## 模块

```
src/core/          纯数学与数据，没有 DOM、没有 GPU，全部在 Node 里测
  optics.ts          光学的 CPU 参考实现（移植自上游，带 Apache 头）
  merge.ts           多块玻璃的 smin 合并
  pipeline.ts        有序效果管线与采样余量
  material.ts        声明式材质 → 有序管线；预设
  units.ts           dp / CSS px / 设备像素；分辨率策略
  scene.ts           用户场景怎么铺进视口（object-fit 的 uv 变换、预缩放尺寸、CSS 兜底）
  transparency.ts    减少透明度时的材质变换（磨砂、按文字颜色选深浅）

src/shaders/       着色器源（字符串）
  optics.wgsl.ts     光学的 WGSL 唯一真源（带 Apache 头）
  generated/         由它机械生成的 GLSL ES 3.0，签入，CI 校验重生成同一性
  translate-glsl.ts  WGSL → GLSL 的 token 重写器：看不懂就抛
  scene / blur / glass / glass-group.wgsl.ts   入口与绑定，手写

src/renderer/      与后端无关的一层
  stage.ts           画布、帧循环、监听器、后端阶梯、设备丢失与降级
  backend.ts         渲染后端接口，一帧的输入输出
  gpu.ts             WebGPU 后端
  panels.ts          面板注册表、合并组、测量、uniform 打包
  blur.ts            模糊链（级数、σ ↔ 级别）
  layering.ts        面板与画布之间有什么：命中测试 + 点名警告
  clipping.ts        面板的裁剪祖先（按包含块链）与裁剪矩形
  scene-source.ts    用户场景：图片 / 视频 / 画布 → 每帧交给后端的场景图（缩放、上传时机、CSS 兜底）
  verify.ts          GPU 探针与 CPU 实现的逐像素比对工具

src/webgpu/        设备单例、能力探测、创建计数
src/webgl2/        WebGL2 后端与它的 GLSL 入口
src/components/    <glass-card> / <glass-button> / <glass-container>，glassium.css
```

依赖只往下走：components → renderer → core；shaders 只被后端引用。`src/core` 与 `src/shaders`
不碰任何浏览器全局，所以整个包在 Node 里 import 是安全的（SSR），有测试钉住。

## stage 与后端

stage 是**外壳**：画布、面板注册表、调试参数、帧循环、监听器 —— 与 GPU 无关，跨设备存活。
后端持有一台设备 / 一个上下文上的全部 GPU 资源，可以整体丢弃、整体重建。

```
启动：   WebGPU ──失败──▶ WebGL2 ──失败──▶ none（CSS 兜底底色 + 组件的兜底表面）
运行中：  某个后端第一次丢失 → 在同一后端上重建（面板与参数原样保留）
         第二次丢失       → 往下降一级；一块画布只能有一种上下文，所以换一块新画布
```

两个后端吃同一份 `FrameInput`、同一份 uniform 字节、同一套光学（GLSL 由 WGSL 机械生成），
本机实测整帧逐像素比对 96.6 万个像素只差 1 个、1/255。

## 一帧

```
测量  所有面板一次 getBoundingClientRect（帧内之后不再碰布局），读一遍 CSS 上的实际不透明度
打包  Panel / Group → uniform（256B / 768B 步长）
场景  内置程序化场景，或用户的图片 / 视频 / 画布（按 object-fit 铺）→ 模糊链第 0 级
填充  <glass-fill> 的纯色圆角矩形画进第 0 级（之前先拷一份没有填充的场景）
模糊  每级两趟，2 × (K − 1) 趟，与面板数无关（共享链）
上屏  背景，再按画布分辨率画一遍填充
面板  每块一次 draw：全屏三角形 + 裁剪矩形，片元里用 SDF 算几何
组    每组一次 draw，与成员数无关
层    写在玻璃里面的东西逐层：把画布上那一块采回场景目标、局部重建模糊链，再画这一层（layers.ts）
```

测量之后先比一次：这一帧的全部输入（视口、背景参数、场景、每块面板的矩形与降级结果……）与上一帧
相同，就不画 —— 浏览器继续显示上一帧（`src/renderer/idle.ts`）。静态页面因此没有持续的 GPU 开销；
测量照做，滚动与布局变化下一帧就能发现。

模糊链能共享，是因为调色（saturation / tint）是逐点仿射、与模糊可交换 —— 这条等价是整个设计的承重墙，
详见 [../spec/pipeline.md](../spec/pipeline.md)。

## 组件

- 属性 → 材质（`attributes.ts`）：写错的属性报一次并忽略，不让整块面板失效。
- 组件可以早于 stage upgrade：`createGlassStage()` 要等 GPU，组件先等着，stage 建好（或重建）时统一注册。
- 没有玻璃时（upgrade 前、没有 GPU、高对比度）组件显示 `glassium.css` 的兜底表面；
  玻璃生效时组件带上 `data-glassium-active`，表面去掉。
- `<glass-button>` 的反馈只改材质的数值（uniform），不建管线、不建 bind group —— 有计数器在设备上钉住。
- `<glass-container>` 按元素指定成员，每帧解析；成员照旧各自注册、各有材质。
- `<glass-fill>` 不是玻璃：它注册成填充（`registerFill`），颜色取 CSS 的 `--glass-fill`，由 stage 画进场景。
  几何测量与面板共用同一段代码（包围盒、旋转、缩放、裁剪祖先、CSS 上的不透明度）。
- `<glass-switch>` 在影子树里放一块填充（轨道）和一块玻璃（旋钮），自己注册这两样；`<glass-slider>` 多一块填充
  （进度）；`<glass-segmented>` 的旋钮垫在选中的段下面，位置与宽度按那一段的布局写成 CSS 变量、过渡交给 CSS。
按下时旋钮的材质从白色玻璃插值到透明的透镜（`thumb.ts`，三者共用），大小与位置交给 CSS（`scale`、
  `translate` 独立属性），玻璃每帧跟着量。滑块的位置写成影子树里元素上的 `--_ratio`，不写宿主的 `style`
  （那是作者或框架的）。
- `<glass-tab-bar>` 的栏本身是 `GlassElement`（材质属性同卡片），气泡在影子树里、自己注册成玻璃 —— 写在栏里面，
  所以落在第 1 层。选择逻辑（角色、roving tabindex、指针拖动、键盘、旋钮的位置）与分段控件共用 `segments.ts`；
  旋钮第一次放到位时关掉过渡，免得页面一加载它就从宽 0 的地方长出来。
- 盖在 DOM 上的玻璃（`core/overlay.ts`）：stage 测量时判断每块玻璃与填充是不是在顶层里（模态对话框、打开的 popover、
  全屏元素）、写了 `overlay`、或者玻璃祖先是这样的 —— 是的话标上 `data-glassium-overlay`、不画 GPU 玻璃。组件把材质写成
  自己影子样式表里的 `:host { --glassium-* }`，影子样式里的 `:host([data-glassium-overlay])` 规则按它们画 CSS 玻璃。
  对话框的 `open`、`popover`、`overlay` 属性变化与 `toggle`、`fullscreenchange` 事件都会请求重画。
- 组件与 stage 的连接（stage 出现、换了、停用时重新注册，维护 `data-glassium-active`）在 `stage-link.ts`；
  `GlassElement` 是同一个模式的早期写法。
- `<glass-button>` 是表单关联的自定义元素，提交借一个临时的原生提交按钮当 submitter。
- 按下 `<glass-button>` 时光从按下的地方亮起来：面板句柄上单独一条 `setLight()`（交互状态，不是材质），
  强度跟着按压能量的补间走。

四个系统设置都有反应：减少动效停帧循环（组件的补间直接落到终点），强制配色停用 stage、换 CSS 兜底表面，
减少透明度与更高对比度给所有面板的材质多加一道磨砂变换（注册表级的 MaterialFilter，组件与手动注册的面板一视同仁；
更高对比度时 CSS 另外给组件描边）。

## 验证

四层，由便宜到贵：

| 层 | 验什么 | 在哪 |
|---|---|---|
| CPU 单元测试 | 数学的性质（SDF 对暴力解、梯度的转向率恒等式、smin 的精确梯度、合并的逐位性质……） | `npm test`，CI |
| 符合性向量 | 238 条输入 / 输出，给将来的其它渲染器 | `spec/conformance/optics.json`，CI 校验重生成同一性 |
| GPU 探针 | 着色器与 CPU 实现逐像素一致：零个非有限值、采样偏移 p99 < 1e-4 px | `stage.debug.probeOptics()` / `probeGroup()` |
| verify.html | 上面一层加上颜色层面的性质、逐位等价、两个后端的整帧比对 | 浏览器里手工跑，标题栏读作 PASS n/n |

**CI 不覆盖像素**：GitHub 的 runner 没有 GPU，软件光栅化与真实驱动的差距大到任何阈值都没意义。
理由与将来要补什么见 [../spec/golden/README.md](../spec/golden/README.md)。

逐位等价的判据用 SHA-256 做 A/B，而且**只在同一页面、同一视口里比**：先渲染一种写法、回读，
就地换成另一种写法、再回读。跨会话比哈希不可靠 —— 视口尺寸、DPR 每次打开都可能不同，
测试场景本身在某些尺寸上也有取值不定的像素（calibration.md「verify.html」一节）。

## 约定借自哪里

工作区里的 meshora（MIT）：单 GPU 上下文、动态 import、`prefers-reduced-motion` 下彻底停循环、
像素预算与分辨率地板、着色器起不来时退回 CSS 而不是白屏、`z-index: -1` 的背景画布。
没有共享代码，不构成衍生作品。

光学数学移植自上游 AndroidLiquidGlass（Apache-2.0），逐条偏离见 [porting-notes.md](porting-notes.md)。
