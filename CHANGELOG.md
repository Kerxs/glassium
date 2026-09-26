# 更新记录

格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [语义化版本](https://semver.org/lang/zh-CN/)。
0.x 期间次版本号的变化也可能不兼容。

## [未发布]

按 iOS 27 实机截图再调一轮（docs/calibration.md「iOS 27 截图」）。外观又有变化。

### 变化（不兼容）

- 玻璃最外一圈多了一道半透明的深灰外线（左右深、上下浅）：白底上的旋钮、标签栏终于看得见边界；暗底上几乎看不见。
  亮边从外线里面开始。CSS 画的玻璃多一圈 0.5px 的深灰外描边。
- 标签栏的气泡：静止时是一层 0.2 的中灰（白底的栏上比栏暗一点，深色的栏上亮一点），按住时的透镜变大到 1.35 × 1.28 倍
  （比栏还高）。
- 按住的旋钮影子更深一点（0.2 → 0.3）。

### 新增

- 拖动时的果冻：分段控件的选中块、标签栏的气泡、滑块与开关的旋钮顺着拖动的速度横向拉长、纵向收一点，
  停下来平滑地回到原样，不晃。减少动效时关掉。
- 分段控件、标签栏按住拖动时，透镜里的字与图标都换成选中那一段的颜色（透镜外还是原色）。
- `registerBitmapFill(element, painter, { anchor })`：painter 在锚点元素的盒子里画，填充自己的盒子只决定露出哪一块 ——
  一张画好不动的内容只在一个跟着旋钮走、会缩放的窗口里露出来，不用每帧重画。

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

[未发布]: https://github.com/Kerxs/glassium/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Kerxs/glassium/releases/tag/v0.1.0
[0.0.1]: https://github.com/Kerxs/glassium/releases/tag/v0.0.1
