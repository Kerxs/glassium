# 更新记录

格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [语义化版本](https://semver.org/lang/zh-CN/)。
0.x 期间次版本号的变化也可能不兼容。

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

[0.0.1]: https://github.com/Kerxs/glassium/releases/tag/v0.0.1
