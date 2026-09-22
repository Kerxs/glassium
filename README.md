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
GPU 输出由 `playground/verify.html` 手工验证。绿色徽章不等于像素已验证 ——
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

**72 条测试全绿**，playground 可跑（`npm run dev`）。玻璃本身从 T7 开始。

T5 顺带把两个计划阶段悬着的硬件问题测掉了，结果记在
[docs/calibration.md](docs/calibration.md)：`minUniformBufferOffsetAlignment` 实测 256
（256B stride 假设成立），以及 WGSL 的**动态层索引采样可用**（模糊分档不必退回静态绑定）。

（其余任务完成后逐条勾上。没勾的就是没有。）

移植过程中在上游发现并修正的问题，逐条记在
[docs/porting-notes.md](docs/porting-notes.md)：色散的象限变号、高光缺暗边、
采样余量欠补 2 倍、以及 `radiusAt` 传错坐标系导致四角半径塌缩。

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
色散、高光、采样余量三处是重写而非移植，逐条理由见 [docs/porting-notes.md](docs/porting-notes.md)。

值得先知道的一件事：上游**已经不是 Android 专属**了。它的默认分支是 `kmp`，内部改名为
Backdrop，用 Compose Multiplatform 覆盖了 Android / iOS / macOS / 桌面 JVM / JS / Wasm。
如果你的项目在 Kotlin 生态里，**应该直接用上游，不要用 Glassium**。Glassium 填的是另一个
空白：原生 Web/TypeScript，不经 Kotlin/Wasm。

第三方声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
