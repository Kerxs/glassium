# Glassium

Web / TypeScript 的 Liquid Glass 渲染框架。GPU 折射、色散、边缘高光，WebGPU 优先、WebGL2 兜底。

> **状态：第一期开发中。还不能用。** 下面「现在能做到什么」一节是逐条对照代码写的，不是路线图。

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

**编写规则见 [docs/limitations.md](docs/limitations.md)。** 不读那三条，第一次用就会遇到
「玻璃完全不可见且毫无报错」。

### 第一期明确不做

- 玻璃盖在 DOM 内容**之上**（`GlassDialog`、`GlassSheet`）。层叠槽位已预留，东西没建。
- `GlassSlider`、`GlassSwitch`、`GlassTabBar`、`GlassBottomBar`、`GlassNavigation`。
- 形状变形过渡（多块玻璃的**合并**做了，**变形**没做）。
- 逐面板不同的 backdrop。
- Android / iOS 渲染器 —— 只交付 `spec/` 里的平台中立契约。
- npm 发布、`.d.ts` 产出、semver。

### CI 不覆盖像素

`npm run typecheck` + `npm test` 只证明数学和类型是对的。GitHub runner 没有 GPU，软件
WebGPU 与真实驱动的像素差距大到任何阈值都失去意义，所以**没有 golden-image 测试**。
GPU 输出靠 `stage.debug.probeOptics()` + `compareOptics()` 与 CPU 实现逐像素比对，
手工在浏览器里跑（T12 会把它做成 `playground/verify.html` 页面）。绿色徽章不等于像素已验证 ——
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

GPU 设备丢失时会在新设备上整套重建（实测约 30 ms，恢复后画面逐位相同），第二次丢失则降到
WebGL2（WebGL2 的上下文丢失同理，第二次降到 CSS 兜底）。T5 到 T8 期间这一点是坏的：
日志说会重新初始化，实际上画布会冻住 —— 现已修复，见 [docs/limitations.md](docs/limitations.md)。

**153 条测试全绿**，playground 可跑（`npm run dev`）。

T5 顺带把两个计划阶段悬着的硬件问题测掉了，结果记在
[docs/calibration.md](docs/calibration.md)：`minUniformBufferOffsetAlignment` 实测 256
（256B stride 假设成立），以及 WGSL 的**动态层索引采样可用**（模糊分档不必退回静态绑定）。

（其余任务完成后逐条勾上。没勾的就是没有。）

与上游的偏离逐条记在 [docs/porting-notes.md](docs/porting-notes.md)：色散的象限变号、
高光缺暗边、以及 `radiusAt` 传错坐标系导致四角半径塌缩。早期版本还声称上游的采样余量
欠补 2 倍 —— 那是错的，已在同一份文档里撤回并说明原因。

---

## 用法

```html
<!-- 兜底样式放进 <head>：没有玻璃时（upgrade 之前、没有 GPU、高对比度）给组件一层可读的表面 -->
<link rel="stylesheet" href="glassium/src/components/glassium.css" />

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
`squircle`、`depth-effect`。写错的属性会在控制台报出来并被忽略，不会让整块面板失效。

不用组件也行：`stage.register(element, material)` 可以把任意元素注册成玻璃面板。

还不是 npm 包（第一期不发布），上面的 `glassium` 指的是 `src/index.ts`，
playground 里是 Vite 的别名。

---

## 开发

```bash
npm ci
npm run dev         # playground，http://localhost:5174
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
