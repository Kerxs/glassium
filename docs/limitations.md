# 限制与编写规则

> 这一页描述的是**架构定义**，不是待办事项。先读这三条规则，否则第一次用就会遇到
> 「玻璃完全不可见且毫无报错」。

## 三条编写规则

### R1 —— `<glass-*>` 到 stage 宿主之间的每个祖先都必须背景透明

页面背景属于**场景**，不属于 CSS。

Glassium 的画布**本身就是玻璃**：面板像素来自画布，而画布在 DOM 内容之下。面板任何一个
带不透明 `background` 的祖先，都会把画布对应区域整块盖掉。

失效表现是最难查的那一种：面板成为不透明盒子里的一个透明洞 —— **完全不可见、无报错、
无警告**。

**目前还没有针对这种情况的警告。** 计划在 T9 加上祖先检查：注册时遍历每个面板到 `<body>`，
检出非零 `background-color` alpha、任何 `background-image`，以及 `opacity < 1` / `filter` /
`transform` / `will-change`（这些创建层叠上下文，同样破坏前提），然后 `console.warn`
**点名具体元素**。在那之前，玻璃看不见时请先按这条规则逐个检查面板的祖先。

（这一段早先写的是「Glassium 内置了祖先检查」，那是 T1 按计划先写的，当时并不存在。）

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

### 画布恒为不透明，所以玻璃输出不钳 `rgb ≤ a`

（这一节早先写的是「Glassium 钳制 `min(rgb, a)`，代价是低 opacity 时高光被压平」，
并提到一个 `premultiplyViolations` 计数。钳制已在 T8 去掉，计数从未实现 —— 下面是现在的做法。）

预乘的不变式 `rgb ≤ a` 只在**画布与页面合成的那条边界**上才有意义：画布配成
`alphaMode: 'premultiplied'` 时，违反它的像素合成结果未定义。

但 Glassium 的画布上**每个像素的 alpha 都是 1**：背景 pass 写 alpha 1，玻璃用预乘混合
（`one / one-minus-src-alpha`）叠上去，`a_out = a + 1·(1 − a) = 1`。实测整张画布
1225×1352 个像素 alpha 全部是 255。所以那条边界上的约束天然成立，与 alphaMode 无关。

而在 pass 内部，玻璃片元的 `rgb > a` 不是错误，是**加性光** —— 混合方程对它处理得完全正确，
高光正是这么叠上去的。在这里钳 `min(rgb, a)` 不会防住任何东西，只会在低 opacity 时把高光压平。

**什么时候要重新考虑：** 如果将来加一个「背景半透明、让页面 CSS 背景透上来」的模式，
画布上就会出现 alpha < 1 的像素，那时候配 `'premultiplied'` 就必须保证 `rgb ≤ a`。

### GPU 设备丢失：重建一次，第二次就降级

驱动重置（笔记本睡眠唤醒、驱动更新、GPU 超时）会让 WebGPU 设备丢失，这台设备上创建的
一切同时作废。

- **第一次**：在新设备上整套重建全部 GPU 资源。面板、参数、监听器原样保留，实测约 30 ms，
  恢复后的画面与丢失前逐位相同。
- **第二次**：不再重试，降级。连续丢失通常说明驱动或 GPU 本身有问题，反复重建只会让页面
  反复卡顿。WebGL2 后端要到 T11，所以现在降到 `none`：画布露出 CSS 兜底底色，面板元素照常
  显示，只是后面没有玻璃。

两种情况都会在控制台高声报出来。`stage.debug.stats().deviceLosses` 给出次数。

（T5 到 T8 期间这里是坏的：日志写着「将尝试重新初始化」，实际上没有任何代码在重建，
画布会冻在最后一帧。）

### 第一期在 sRGB 编码空间混合，不在线性空间

线性空间严格更正确（σ=32 的模糊跨黑白阶跃当前会偏暗），但切过去会让每个已校准的数值全部
重定基。放在第二期，挂在开关后。

### WebGPU 不是到处都有，所以 WebGL2 兜底是强制项

Firefox 无 Linux、无 Intel Mac、无 Android；Chrome 的 Linux 受 GPU 门禁
（Intel Gen12+ 或 Wayland 上的 NVIDIA）；Chrome Android 受厂商门禁。caniuse 约 87%。
别信「WebGPU 已经 Baseline 了」这类说法 —— 细节上是错的。

### CI 不覆盖像素

见 [../spec/golden/README.md](../spec/golden/README.md)。
