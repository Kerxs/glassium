# Glassium

Web / TypeScript 的 Liquid Glass 渲染框架。GPU 折射、色散、边缘高光，WebGPU 优先、WebGL2 兜底。

> **状态：第一期（T1–T12）完成，还没有发布到 npm —— 现在只能从源码用。**
> 下面「现在能做到什么」一节是逐条对照代码写的，不是路线图。

---

## 先说它做不到什么

这一节放在最前面，因为它描述的是**架构定义**，不是待办事项。

### 玻璃折射的是 Glassium 的场景，不是它背后的任意 DOM

Glassium 自己持有一块渲染面（一张画布），场景和玻璃都画在这块面上。玻璃面板采样的是
Glassium 自己渲染的纹理。**面板背后的正文文字、图片、iframe 不参与折射。**

这不是没做完，是 Web 平台今天就不允许别的做法：

- `backdrop-filter: url(#svg)` 是唯一能对实时 DOM 背景做几何位移的途径，而它**只有 Chromium 支持**。
  WebKit bug 245510 自 2022 年开着，实现 PR 至今未合；Firefox 从未实现。更糟的是 Safari 会
  **解析成功但静默不渲染**，所以 `@supports` 探测不出来。
- HTML-in-Canvas（`drawElementImageToTexture`）能把实时 DOM 直接送进 GPU 纹理，但它是
  Chromium 的 origin trial，另外两家都是 "no signal"，而且出于隐私它**排除 SVG 与 `url()` 背景图** ——
  你折射到的背景和用户看到的背景不是同一个。
- html2canvas 一类的 DOM 重栅格化每次约 50–90ms，且自述「永远不会完整支持 CSS」。

换来的是 SVG 路线拿不到的东西：浮点精度位移（SVG 位移贴图被 8bit 通道锁死在 ±128px/轴，
有可见色阶）、真正的逐通道色散、任意动画扭曲场、以及一次 pass 内合并多块玻璃。

要让玻璃底下有颜色（开关的轨道、滑块的进度条、卡片后面的色块），用 `<glass-fill>`：
它的颜色由 Glassium 画进场景，玻璃看得见它（见「用法」）。

**编写规则见 [docs/limitations.md](docs/limitations.md)。** 不读那三条，第一次用就会遇到
「玻璃完全不可见且毫无报错」。

### 第一期明确不做

- 盖在 DOM 内容**之上**的玻璃没有折射：对话框、popover 里的玻璃（以及写了 `overlay` 的）改用 CSS 画 ——
  浏览器模糊下面的一切，材质的其余部分照搬（见下）。折射要读 DOM 的像素，平台不允许。
- `GlassBottomBar`、`GlassNavigation`。（`<glass-switch>`、`<glass-slider>`、`<glass-segmented>`、`<glass-tab-bar>` 做了，见下。）
- 两个不相干的形状之间的变形（`glassEffectID` 那种「这一块变成那一块」）。合并做了；成员分出来、融回去做了（见下）。
- 逐面板不同的 backdrop。
- Android / iOS 渲染器 —— 只交付 `spec/` 里的平台中立契约。
- npm 发布、semver。（库的构建产物已经有了：ESM + 类型声明，见「用法」。）

### CI 不覆盖像素

CI 跑 `npm run typecheck`、`npm test`、生成物同一性与一次生产构建 —— 只证明数学、类型与打包是对的。
GitHub runner 没有 GPU，软件 WebGPU 与真实驱动的像素差距大到任何阈值都失去意义，所以**没有 golden-image 测试**。
GPU 输出由 `playground/verify.html` 在浏览器里逐项验证（光学探针与 CPU 实现逐像素比对、区域哈希的 A/B、
颜色层面的性质），标题栏读作 `PASS n/n`，手工跑。视口（DPR、画布大小）在一轮中途变了的话那一轮不算数，
页面自己重跑。绿色徽章不等于像素已验证 ——
理由与将来要补什么见 [spec/golden/README.md](spec/golden/README.md)。

---

## 现在能做到什么

- [x] **T1** 仓库骨架、许可、类型与测试门禁
- [x] **T2** 光学核心的 CPU 参考实现（`src/core/optics.ts`）与单位/分辨率策略
      （`src/core/units.ts`），178 条平台中立符合性向量
      （`spec/conformance/optics.json`）。实测数字见
      [docs/calibration.md](docs/calibration.md)
- [x] **T3** 有序效果管线（`src/core/pipeline.ts`）与声明式材质立面
      （`src/core/material.ts`）。内核是 `colorFilter → blur → lens` 的有序链并
      协商采样余量，立面保留了 `blur/refraction/distortion/...` 那组参数名
- [x] **T4** WGSL 唯一真源（`src/shaders/optics.wgsl.ts`）与 WGSL→GLSL ES 3.0
      重写器（`src/shaders/translate-glsl.ts`）。生成物签入、CI 校验重生成同一性；
      重写器**看不懂就抛**，不产出「能跑但微妙不对」的着色器

- [x] **T5** 画布宿主、分辨率策略与帧循环（`src/renderer/stage.ts`）。三层宿主、
      WebGPU device 单例、降级阶梯、`prefers-reduced-motion` 彻底停循环。
      **还没有玻璃**——只有一层渐变场景，用来验证管线通不通

- [x] **T6** 模糊金字塔与 colorFilter（`src/renderer/blur.ts`）。6 级 mip 链，
      每帧 10 趟且**与面板数量无关**；σ 扫描实测单调、级边界无突变。
      顺带把 calibration 场景（棋盘格 + 硬对角线 + 黑白阶跃）从 T12 提前过来 ——
      线性渐变几乎是高斯模糊的不动点，没有高频图案就验不了模糊

- [x] **T7** 第一块真正的玻璃（`src/shaders/glass.wgsl.ts`、`src/renderer/panels.ts`）。
      `stage.register(element, material)` 把 DOM 元素注册成面板，逐面板 256B uniform、
      动态偏移、一条管线一个 pass。几何折射，**还没有色散和高光**（T8）。
      GPU 与 CPU 逐像素比对 23.8 万个纹素：**零个 NaN**，偏移 p99 在 1e-4 以下；
      DOM 对齐误差 **0**（修掉了一个滚动条导致的 7.5px 错位）

- [x] **T8** 色散与高光（重写版，不是移植）。色散在四个角上方向一致 —— 实测径向场上
      R − B 四个角都是 +5.70/255，没有一个像素反向；高光只点亮朝光一侧并补上暗边 ——
      右下扇区一个发亮的像素都没有。关掉两者时与 T7 **整帧逐位相同**（SHA-256 一致）

- [x] **T9** `<glass-card>` / `<glass-button>` 组件（`src/components/`）与层级检查
      （`src/renderer/layering.ts`）。材质写在 HTML 属性上，组件与手动 `stage.register()`
      画出的整帧**逐位相同**；按钮的悬停与按压只改 uniform —— 实测动画全程管线与
      bind group 一个都没新建，松开后画面逐位回到按下前。R1 被违反时控制台点名具体元素。
      顺带撤回了一条错误的规划结论：画布从 `z-index: 0` 改回 `-1`，内容不再需要包进
      `z-index: 1` 的容器，见 [docs/limitations.md](docs/limitations.md)

- [x] **T10** `<glass-container>`：几块玻璃用 smin 连成一个连续形状（`src/core/merge.ts`、
      `src/shaders/glass-group.wgsl.ts`）。**一组一次 draw call**，与成员数无关；
      GPU 与 CPU 逐像素比对 1.9 万个纹素，零个非有限值，采样偏移最大误差 1.4e-5 像素。
      相距足够远的成员画出来与各自单独绘制**逐位相同**；颈部两侧方向相对处位移按一致度衰减，
      不会在中线上翻出接缝。这是 backdrop-filter 结构上做不到的事（上游 issue #104）

- [x] **T11** WebGL2 后端（`src/webgl2/`）。光学用 WGSL 真源生成的 GLSL，面板 uniform 用同一份字节
      （std140 与 WGSL 布局逐字节相同，启动时核对）。**两个后端的整帧逐像素比对：96.6 万个像素里
      只有 1 个差 1/255**；WebGL2 上的光学探针同样零个非有限值、p99 在 1e-5 像素量级。
      后端阶梯 WebGPU → WebGL2 → CSS 兜底：启动时按这个顺序选，运行中 WebGPU 第二次丢失也降到 WebGL2

- [x] **T12** 验证与文档。`playground/verify.html` 把前面手工做过的验证固化成一页，
      WebGPU 上 **PASS 14/14**、WebGL2 上 **PASS 13/13**；它第一次跑就抓到校准场景的两条硬边
      在某些视口尺寸下正好压着像素中心（与渲染器无关），已修。与上游 playground 做了源码与数学层面
      的对照：默认配置下的折射**逐像素相同**，其余差异逐项列出（docs/calibration.md）。
      数学规格 [spec/optics.md](spec/optics.md)、管线规格 [spec/pipeline.md](spec/pipeline.md)、
      架构 [docs/architecture.md](docs/architecture.md)

第一期之后加的：

- [x] **裁剪**（`src/renderer/clipping.ts`）。面板在滚动容器里被滚出可见区域时，玻璃跟着裁掉；
      按包含块链找裁剪祖先，absolute / fixed 的规则与浏览器一致。容器的 `border-radius` 也跟：圆角外的玻璃
      在着色器里抹掉（没有裁剪的面板逐位不变）。clip-path 不跟，见 [docs/limitations.md](docs/limitations.md)
- [x] **帧开销实测**。每多一块面板主线程约多 1.7 µs；GPU 每帧约 0.25 ms，与面板数基本无关（高端独显），
      见 [docs/calibration.md](docs/calibration.md)
- [x] **用户场景**：`stage.setScene()`（`src/renderer/scene-source.ts`）。玻璃后面画你自己的图片、视频或画布，
      按 `object-fit` 的语义（cover / contain / fill）铺满视口。静态图先由浏览器高质量缩放到场景分辨率、
      **只上传一次**；视频用 `requestVideoFrameCallback` **只在出新帧时上传**（实测 240Hz 下 2 秒 481 帧、
      上传 60 次，正好是视频的 30fps）；换场景时旧场景一直画到新的就绪，不闪。
      没有 GPU 时 URL / `<img>` / Blob 场景退成画布的 CSS 背景，页面照样有这张图
- [x] **静止时不画**（`src/renderer/idle.ts`）。每帧照样量面板，但这一帧画出来与上一帧逐像素相同时
      就不提交，浏览器继续显示上一帧。静态背景加不动的卡片：实测 1.5 秒 **0 帧**；滚动一下画 2 帧，
      按钮悬停只在补间期间画；视频场景只在出新帧时画
- [x] **旋转**：自己或祖先 `rotate` 时玻璃跟着转（以前只能按轴对齐的包围盒画，还会报警告）。形状在面板自己的
      坐标系里算，折射方向与法线转回屏幕。转 37° 的圆与不转的圆逐像素相同（12.96 万个像素里 12 个差 1/255）。
      倾斜与 3D 变换仍然画不了，照旧警告
- [x] **跟着 transform: scale 缩放**：自己或祖先缩放时，圆角、模糊、亮边、投影这些以 dp 计的量也跟着缩，
      缩放动画里玻璃与 DOM 一致。`scale(0.5)` 里的大卡片与直接画的小卡片逐位相同
- [x] **投影**：材质文档一直写着「玻璃越厚，投下的阴影越深」，渲染器却没有。现在玻璃往下投一圈柔和的影子
      （`shadow`，预设从 ultraThin 0.15 到 thick 0.45，clear 为 0），跟着裁剪与不透明度走。实测纯白背景上
      卡片正下方 255 → 220、正上方 255 → 236；`shadow="0"` 时与之前逐位相同
- [x] **自适应**：Apple 的 Regular 玻璃会随背后内容调整、保证上面的内容可读，Glassium 之前只在文档里提过
      「clear 没有自适应」，实际上谁都没有。现在默认守住与文字至少 3:1 的对比度：浅色字下背后太亮时整块玻璃压暗，
      深色字下太暗时提亮（`adaptive`，clear 预设为 0）。实测白底白字 1.000 → 0.292、黑底深色字 0.027 → 0.095
- [x] **玻璃跟着 CSS 的 opacity 淡**：元素（或它的祖先）的 opacity 乘进玻璃的不透明度，每帧读计算样式 ——
      渐隐渐显的菜单、提示条、对话框直接可用。实测外层 opacity 0.5 时玻璃的改变量正好减半（0.500）
- [x] **按压处的光**：Apple 玻璃 `.interactive()` 的那种反馈 —— 按下时从按下的地方亮起来，按住拖动时跟着走，
      松开后随按压的补间淡掉（`GlassPanel.setLight()`，`<glass-button>` 自动用它）。没按下时逐位不变
- [x] **`<glass-button>` 进表单**：表单关联的自定义元素，行为与原生 `<button>` 相同 —— 默认提交、
      `name` / `value` 只在被按下时进表单数据、`type="reset"`、`formaction` 一类的覆盖属性、
      祖先 `<fieldset disabled>`、click 里 `preventDefault()` 能拦下。两处例外见
      [docs/limitations.md](docs/limitations.md)
- [x] **减少透明度、更高对比度**（`prefers-reduced-transparency`、`prefers-contrast: more`，`src/core/transparency.ts`）。
      玻璃换成更实的磨砂：模糊至少 24dp、关掉色散、按文字颜色选深色或浅色磨砂（保证与文字的对比度 ≥ 4.5:1），
      形状与高光保留；更高对比度时组件再描一圈边。实测卡片内部的图案起伏从 ±22.7 降到 ±0，关掉之后逐位复原。
      加上减少动效与强制配色，四个系统设置都有反应
- [x] **填充 `<glass-fill>`**（`src/renderer/fills.ts`、`src/shaders/fill.wgsl.ts`）：玻璃只折射场景，DOM 的背景它看不见 ——
      开关的轨道、滑块的进度条这类「玻璃底下的纯色形状」一直没法做。填充是 CSS 摆位、Glassium 画进场景的纯色圆角矩形：
      盒子、圆角、变换、裁剪、不透明度都来自 CSS，颜色来自 `--glass-fill`（注册成可以过渡的 `<color>`）。
      玻璃折射它、模糊它、按它的亮度调自适应；直接看到的部分按画布分辨率另画一遍，边缘与 DOM 一样锐利 ——
      场景压到画布 0.6 倍时，边缘 1 个像素以外与没有填充时逐像素相同。颜色过渡到一半时画出来的就是那一刻的计算值
- [x] **开关 `<glass-switch>`**（`src/components/glass-switch.ts`）：iOS 26 的样子 —— 轨道是填充、旋钮是玻璃。
      平时旋钮是白的，按下时鼓起来变成透明的透镜，透过它看得见底下的轨道（实测旋钮中心从 247/253/248 变成轨道的绿
      29/212/75；轨道不是填充时只看得到灰色的场景），松开时切换。行为与原生 `<input type="checkbox" switch>` 相同：
      `role="switch"`、空格切换、可以拖动旋钮、`input` / `change`、表单关联、`<label>`、fieldset 禁用、表单重置
- [x] **滑块 `<glass-slider>`**（`src/components/glass-slider.ts`）：轨道与进度是填充、旋钮是玻璃，拖动时旋钮变成透镜，
      左半边透出蓝色进度（0/132/255）、右半边透出轨道。行为与原生 `<input type="range">` 相同：`role="slider"`、
      方向键 / PageUp / Home / End、按在轨道上跳过去、按在旋钮上不跳、拖动时 `input`、松手 `change`、
      `min` / `max` / `step`（`any`）按原生的规则规整（小数档不带浮点尾巴）、表单关联与重置
- [x] **玻璃叠玻璃**（`src/renderer/layers.ts`）：写在一块玻璃里面的玻璃看得见外面那块 —— 卡片里的按钮、
      卡片里开关的旋钮不再在卡片上开洞。画这一层之前把画布上已经画好的那一块采回场景目标、只在那一块里重建模糊链。
      实测红卡片里那块玻璃的中心是 236/89/89，不嵌套时是灰洞 149/149/149；没有嵌套的帧逐位不变（`8aca3e92…`）。
      最多四层
- [x] **变形：水滴一样分出来、融回去**（`<glass-container morph>`）：新加进来的成员从离它最近的成员边上、以一滴的大小
      出现，一边长大一边移到自己的位置 —— 离得近时 smin 把它和邻居连着，颈部拉长、断开；`container.dismiss(member)`
      反过来缩回去再拿掉。实测一滴的中心正落在邻居的边上（496.0, 528.0），那里画着玻璃。动的是 `translate` / `scale`，
      玻璃跟得上；减少动效时直接出现、直接拿掉
- [x] **盖在 DOM 上的玻璃**（`src/core/overlay.ts`）：模态 `<dialog>`、打开的 popover、全屏元素里的玻璃在浏览器的顶层，
      画在整页之上 —— GPU 玻璃在那里被整页内容盖住，以前是一块透明的框。现在 stage 自动把它们（连同写了 `overlay`
      属性的、以及它们里面的玻璃与填充）标成 `data-glassium-overlay`、改用 CSS 画：`backdrop-filter` 模糊下面的一切
      （包括正文文字），材质的模糊（CSS 的 `blur()` 就是 σ）、饱和度（同一套亮度权重）、tint、亮边、投影照搬，没有折射。
      原生的 `<dialog>` 里直接写 `<glass-card>` 就行。顺带修了：没打开的 `<glass-card popover>` 以前照样显示
- [x] **标签栏 `<glass-tab-bar>`**（`src/components/glass-tab-bar.ts`）：iOS 26 那条浮着的玻璃胶囊。选中那一格下面的气泡
      是写在栏里面的玻璃（第 1 层），看得见栏 —— 实测气泡中心 181 = 栏 149 × 0.7 + 白 × 0.3，不分层时是 165（它只看得到
      场景）。按住变成透镜、可以拖到别的格上松手；`tablist` / `tab` 语义、roving tabindex、方向键回绕。选择逻辑与分段控件
      共用（`segments.ts`）
- [x] **分段控件 `<glass-segmented>`**（`src/components/glass-segmented.ts`）：底是填充，选中的段下面垫同一个玻璃旋钮，
      换选中时滑过去、宽度跟着变；按住变成透镜，可以按住拖到别的段上松手。单选组语义（`radiogroup` / `radio`、
      roving tabindex、方向键回绕、Home / End）、`input` / `change`、表单关联与重置

GPU 设备丢失时会在新设备上整套重建（实测约 30 ms，恢复后画面逐位相同），第二次丢失则降到
WebGL2（WebGL2 的上下文丢失同理，第二次降到 CSS 兜底）。T5 到 T8 期间这一点是坏的：
日志说会重新初始化，实际上画布会冻住 —— 现已修复，见 [docs/limitations.md](docs/limitations.md)。

**216 条测试全绿**，playground 可跑（`npm run dev`），只用公开 API 搭的示例页在 `/demo.html`，
逐项自动验证在 `/verify.html`
（现在 WebGPU 上 **PASS 35/35**、WebGL2 上 **PASS 34/34**）。

T5 顺带把两个计划阶段悬着的硬件问题测掉了，结果记在
[docs/calibration.md](docs/calibration.md)：`minUniformBufferOffsetAlignment` 实测 256
（256B stride 假设成立），以及 WGSL 的**动态层索引采样可用**（模糊分档不必退回静态绑定）。

第一期的十二项都在上面。还没做的（DPR 2 的实测、与上游渲染结果的像素级截图对比）
列在 [docs/calibration.md](docs/calibration.md) 的「待补」里。

与上游的偏离逐条记在 [docs/porting-notes.md](docs/porting-notes.md)：色散的象限变号、
高光缺暗边、以及 `radiusAt` 传错坐标系导致四角半径塌缩。规划阶段有两条结论后来被证明是错的，
都在原处撤回并说明了原因：「上游的采样余量欠补 2 倍」（porting-notes）与
「画布不能放在 z-index: -1」（limitations）。

---

## 用法

```html
<!-- 兜底样式放进 <head>：没有玻璃时（upgrade 之前、没有 GPU、高对比度）给组件一层可读的表面 -->
<link rel="stylesheet" href="node_modules/glassium/dist/glassium.css" />

<glass-card preset="regular" corner-radius="24">
  <h2>标题</h2>
  <p>正文照常选中、聚焦、输入 —— 内容全在 DOM 里。</p>
</glass-card>
<glass-button preset="thick" dispersion="0.3">确定</glass-button>

<!-- 缝隙小于 smoothing 的一半时，两块玻璃连成一片（一次 draw） -->
<glass-container smoothing="24" style="display: flex; gap: 10px">
  <glass-button>左</glass-button>
  <glass-button>右</glass-button>
</glass-container>

<script type="module">
  import { createGlassStage, defineGlassElements } from 'glassium'

  defineGlassElements() // 组件可以先于 stage upgrade，stage 建好时统一注册
  await createGlassStage()
</script>
```

属性与 `GlassMaterial` 一一对应：`preset`（ultraThin / thin / regular / thick / clear）、
`blur`（dp）、`refraction`、`distortion`、`highlight`、`dispersion`、`saturation`、`tint`
（hex 或 rgb()/rgba()）、`opacity`、`corner-radius`（`16`、`0.5frac` 或四个数 `4 32 8 28`）、
`squircle`、`depth-effect`、`adaptive`、`shadow`。写错的属性会在控制台报出来并被忽略，不会让整块面板失效。

玻璃底下要有颜色时用 `<glass-fill>`：颜色写在 `--glass-fill` 上（不是 `background`），由 Glassium 画进场景，
玻璃折射它。可以用 CSS 过渡：

```html
<style>
  .track { width: 51px; height: 31px; border-radius: 999px; --glass-fill: #e9e9eb; transition: --glass-fill 0.25s; }
  .track.on { --glass-fill: #34c759; }
</style>
<glass-fill class="track"></glass-fill>
```

开关、滑块、分段控件是现成的：`<glass-switch name="wifi" checked></glass-switch>`、
`<glass-slider name="volume" value="40"></glass-slider>`、
`<glass-segmented name="view" value="list"><span value="grid">网格</span><span value="list">列表</span></glass-segmented>`，颜色用 `--glass-switch-on` / `--glass-switch-off`、
`--glass-slider-fill` / `--glass-slider-track` 改。放进 `<glass-card>` 也行（玻璃叠玻璃，见下），但别放在不透明的
CSS 背景上（R1）—— 要一块纯色底板就用 `<glass-fill>`。

不用组件也行：`stage.register(element, material)` 可以把任意元素注册成玻璃面板，
`stage.registerFill(element)` 注册填充。
全部公开接口见 [docs/api.md](docs/api.md)。

### 背景：场景

页面背景属于**场景**（R1），不属于 CSS —— 要放背景图，交给 stage：

```js
const stage = await createGlassStage({ scene: '/bg.jpg' }) // 加载完成之前画底色，不闪内置图案

await stage.setScene(videoElement)                                  // 视频：有新帧才上传
await stage.setScene(canvas, { dynamic: true })                     // 每帧重画的画布：每帧上传
await stage.setScene(file, { fit: 'contain', background: '#111' }) // <input type="file"> 选中的 File
await stage.setScene(null)                                          // 回到内置场景
```

`fit` 与 CSS 的 `object-fit` 同义，默认 cover。跨源的图片与视频需要 CORS，否则浏览器不允许把它传进
GPU —— 这种情况 `setScene` 当场 reject 并说明原因。上传时机、减少动效、没有 GPU 时怎么办见
[docs/limitations.md](docs/limitations.md)「用户场景」。

### 安装

没有发布到 npm。作为 git 依赖安装（`npm install <仓库地址>`）时，`prepare` 会把 `src/` 编成 `dist/`：
ESM + 类型声明，不打包、不压缩（交给你的打包器）。之后按包名引用：

```js
import { createGlassStage, defineGlassElements } from 'glassium'
import 'glassium/glassium.css' // 或者 <link> 到 node_modules/glassium/dist/glassium.css
```

类型声明里用到 WebGPU 的类型，所以 `@webgpu/types` 是依赖（只有类型，没有运行时代码）。
在仓库里自己构建：`npm run build:lib`。playground 里的 `glassium` 是 Vite 的别名，直接指向 `src/index.ts`。

---

## 开发

```bash
npm ci
npm run dev         # playground，http://localhost:5174；示例页 /demo.html；验证页 /verify.html
npm run typecheck
npm test
```

需要 Node ≥ 20 构建，但 `npm test` 需要 **Node ≥ 22.6**：测试直接跑带类型标注的 `.ts`，
靠的是 Node 原生类型擦除，没有测试框架依赖。本机实测环境是 Node 24.20.0。

---

## 来源与许可

Glassium 以 **Apache License 2.0** 发布。

光学数学移植自 [`Kyant0/AndroidLiquidGlass`](https://github.com/Kyant0/AndroidLiquidGlass)
（`io.github.kyant0:backdrop`，Apache-2.0，Copyright 2025 Kyant），并作了修改 ——
色散与高光是重写而非移植，`radiusAt` 修正了坐标系，逐条理由见 [docs/porting-notes.md](docs/porting-notes.md)。

值得先知道的一件事：上游**已经不是 Android 专属**了。它的默认分支是 `kmp`，内部改名为
Backdrop，用 Compose Multiplatform 覆盖了 Android / iOS / macOS / 桌面 JVM / JS / Wasm。
如果你的项目在 Kotlin 生态里，**应该直接用上游，不要用 Glassium**。Glassium 填的是另一个
空白：原生 Web/TypeScript，不经 Kotlin/Wasm。

第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
