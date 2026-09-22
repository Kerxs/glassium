# 限制与编写规则

> 这一页描述的是**架构定义**，不是待办事项。先读这三条规则，否则第一次用就会遇到
> 「玻璃完全不可见且毫无报错」。

## 三条编写规则

### R1 —— `<glass-*>` 到 stage 宿主之间的每个祖先都必须背景透明

页面背景属于**场景**，不属于 CSS。

Glassium 的画布**本身就是玻璃**：面板像素来自画布，而画布在 DOM 内容之下。面板任何一个
带不透明 `background` 的祖先，都会把画布对应区域整块盖掉。

失效表现是最难查的那一种：面板成为不透明盒子里的一个透明洞 —— **完全不可见、无报错、
无警告**。所以 Glassium 内置了祖先检查（`src/renderer/ancestry.ts`），注册时遍历每个面板到
`<body>`，检出非零 `background-color` alpha、任何 `background-image`，以及
`opacity < 1` / `filter` / `transform` / `will-change`（这些创建层叠上下文，同样破坏前提），
然后 `console.warn` **点名具体元素**。

看到这类警告不要忽略它 —— 它是你唯一的线索。

### R2 —— 面板折射 Glassium 场景与 z-order 在其下的面板，永不折射 DOM

玻璃背后的正文文字、图片、iframe **不参与折射**。这不是没做完，理由见下一节。

### R3 —— 每文档一个 stage，须在首个面板 upgrade 前创建

面板是声明式子元素，不做命令式定位。浏览器的 GPU 上下文上限约 16 个，多 stage 会很快耗尽；
而且多块画布之间无法互相采样，`<glass-container>` 的合并也就失效了。

---

## 为什么玻璃折射不了任意 DOM

Web 平台今天不允许。四条独立理由，任何一条单独成立即可：

**1. 唯一能对实时 DOM 背景做几何位移的途径只有一家实现。**
`backdrop-filter` 的十个内置滤镜函数没有一个能做几何位移，折射只能经 `url()` + `feDisplacementMap`。
而 SVG 引用滤镜用在 `backdrop-filter` 上：Chromium 可以；WebKit 在
`RenderLayerBacking::updateBackdropFilters()` 里对 `hasReferenceFilter()` 短路且**没有软件兜底**，
bug 245510 自 2022-09-21 开着、实现 PR 至今未合；Firefox 从未实现，只在 106 里做了「优雅降级」
（渲染未滤镜的帧）。

更糟的是**探测不出来**：Safari 会把 `backdrop-filter: url(#x)` 解析成功但静默不渲染，
所以 `@supports` 返回 true。MDN 的 browser-compat-data 也没有这个子特性的条目
（请求它的 issue 被 closed as not planned）。

**2. 就算只面向 Chromium，SVG 路线也有硬天花板。**
位移贴图是 8bit 通道，所以位移被量化且锁死在 ±128px/轴，有可见色阶；没有超采样；
warp 场是静态的 —— 跟手的透镜、涟漪、缓动进出的扭曲**无法表达**，几乎每次尺寸或形状变化
都要重建整张位移贴图。

**3. 唯一能把实时 DOM 送进 GPU 纹理的途径还没落地。**
HTML-in-Canvas（`drawElementImageToTexture`）是 Chromium 的 origin trial，Gecko 与 WebKit
都是 "no signal"。而且出于隐私，它**排除 SVG、`url()` 背景图、跨源内容与次像素抗锯齿** ——
你折射到的背景和用户看到的背景不是同一个。图标消失、hero 图消失。这是正确性问题，
不是精细度问题。

**4. 通用兜底全是 DOM 重栅格化。**
html2canvas 自述「不是截图，而是按 DOM 属性重建一份表示」「永远不会完整支持 CSS」。
真实库的实测数字：单次快照中位数约 55ms，即约 18fps —— 那是快照，不是实时；
CSS 动画不参与折射；`position: fixed` 被忽略。

### 换来了什么

自持渲染面拿到的是 SVG 路线结构上拿不到的东西：

- **浮点精度位移**，没有 ±128px 上限，没有色阶
- **真正的逐通道色散**（不是单次采样近似）
- **任意动画扭曲场** —— 跟手透镜、涟漪，无需重建任何贴图
- **一次 pass 内合并多块玻璃**（`smin`）—— 这正是 Apple `GlassEffectContainer` 做的事，
  也是上游 issue #104 开着的缺口
- 任意形状，不限于预计算过的那几种

---

## 其它已知限制

### 预乘钳制会在低 opacity 下压平高光

画布用 `alphaMode: 'premultiplied'`（规范不允许 `'unpremultiplied'`；`'opaque'` 会把 alpha
清成 1 并硬遮挡下方一切）。预乘的不变式要求逐通道 `rgb ≤ a`，否则合成结果**未定义**，
而加性边光加 tint 在低 opacity 下极易违反。

Glassium 在写出前钳制 `min(rgb, vec3(a))`。后果是 opacity 越低、高光越早被压平。
这是 `alphaMode` 的固有后果，不是 bug。`debug.stats().premultiplyViolations` 把它变成一个数 ——
非零意味着高光模型在过驱。

### 第一期在 sRGB 编码空间混合，不在线性空间

线性空间严格更正确（σ=32 的模糊跨黑白阶跃当前会偏暗），但切过去会让每个已校准的数值全部
重定基。放在第二期，挂在开关后。

### WebGPU 不是到处都有，所以 WebGL2 兜底是强制项

Firefox 无 Linux、无 Intel Mac、无 Android；Chrome 的 Linux 受 GPU 门禁
（Intel Gen12+ 或 Wayland 上的 NVIDIA）；Chrome Android 受厂商门禁。caniuse 约 87%。
别信「WebGPU 已经 Baseline 了」这类说法 —— 细节上是错的。

### CI 不覆盖像素

见 [../spec/golden/README.md](../spec/golden/README.md)。
