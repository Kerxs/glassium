# API 参考

使用者会用到的部分都在这一页。给别的渲染器实现者与验证用的导出（光学、单位、探针比对）放在最后一节。
行为上的边界（能做什么、不能做什么、为什么）见 [limitations.md](limitations.md)。

## 最短路径

```html
<link rel="stylesheet" href="node_modules/glassium/dist/glassium.css" />  <!-- 或 import 'glassium/glassium.css' -->

<glass-card preset="regular">正文照常选中、聚焦、输入</glass-card>

<script type="module">
  import { createGlassStage, defineGlassElements } from 'glassium'

  defineGlassElements() // 组件可以先于 stage upgrade，stage 建好时统一注册
  await createGlassStage({ scene: '/bg.jpg' })
</script>
```

页面背景属于场景（R1）：`html` / `body` 与面板之间的每一层都保持背景透明，背景图交给 `scene`。

---

## 组件

八个自定义元素，`defineGlassElements()` 注册（重复调用无害），同时把 `--glass-fill` 注册成 `<color>`。
玻璃组件的材质写在 HTML 属性上。

### `<glass-card>`

静态的玻璃面板。默认圆角 24。

### `<glass-button>`

带悬停与按压反馈的玻璃按钮，默认是胶囊（`corner-radius="1frac"`）。

- 宿主就是按钮：`role="button"`、可聚焦，Enter 按下时激活、空格松开时激活。
- `disabled` 属性：变淡、`aria-disabled="true"`、不可聚焦、点击被拦下。祖先 `<fieldset disabled>` 同样生效。
- 按下时光从按下的地方亮起来，按住拖动时跟着走，松开后淡掉。减少动效时没有过渡，直接落到终点。
- **表单**：表单关联的自定义元素，行为与原生 `<button>` 相同。

  | 属性 / 属性访问器 | 说明 |
  |---|---|
  | `type` | `submit`（默认，与原生相同）、`reset`、`button` |
  | `name`、`value` | 被按下时进表单数据 |
  | `formaction`、`formmethod`、`formenctype`、`formnovalidate`、`formtarget` | 覆盖表单的对应属性 |
  | `form`（只读） | 表单归属 |

  两处与原生不同：submit 事件的 `submitter` 是一个临时的原生提交按钮（带同样的 name / value）；
  输入框里回车的隐式提交不会「按下」它。

### `<glass-container smoothing="20">`

把里面的玻璃（最多 4 块）用 smin 连成一个连续形状，一次 draw。`smoothing`（dp，默认 20）：
缝隙小于它的一半时两块连成一片，0 是硬并集。成员是 `closest('glass-container')` 为它的后代玻璃组件
（卡片、按钮、标签栏）。容器自己没有玻璃，排版交给你（常见的是 `display: flex`）。

- `morph` 属性：成员像水滴一样分出来、融回去。新加进来的成员从离它最近的成员边上、以 0.2 倍的大小出现，450ms
  长到自己的位置（略微过冲）；`dismiss(member)` → `Promise<void>`：缩回离它最近的成员再从文档里拿掉。动的是成员的
  `translate` 与 `scale`，成员自己别再写这两个属性。减少动效时直接出现、直接拿掉。

### `morphGlass(from, to, options?)` → `GlassMorph`

这一块玻璃变成那一块（SwiftUI 的 `glassEffectID`）：按钮长成一张卡片、卡片缩回按钮。两头是任意两块玻璃
（`<glass-*>` 组件，或 `stage.register` 注册的元素），不必在同一个容器里。

```js
import { morphGlass } from 'glassium'

card.classList.remove('collapsed')          // 先让 to 排版、可见（visibility: hidden 可以，display: none 不行）
await morphGlass(button, card).finished     // 按钮变成卡片；结束时按钮的 opacity 是 0
button.classList.add('collapsed')           // 接着把 from 藏起来（或拿掉）
```

一块过渡用的玻璃从 from 的位置、大小、圆角、材质插值到 to 的（形状略微过冲，`MORPH_GLASS_EASE`），from 在开头
30% 里淡出、to 在最后 30% 里淡入（`MORPH_GLASS_FADE`），投影交叉淡出淡入。

| 选项 | 说明 | 默认 |
|---|---|---|
| `duration` | 毫秒 | 450（`MORPH_GLASS_MS`） |
| `fromMaterial` / `toMaterial` | 两头的材质 | 元素的 `material`（组件有；`register` 注册的元素要自己传） |

返回的 `GlassMorph`：`finished`（走完、`finish()`、`cancel()` 时 resolve）、`seek(p)`（停在进度 p、不再自己走 ——
跟着手指拖，或者验证用）、`finish()`（跳到终点）、`cancel()`（拿掉过渡玻璃，两头回到开始之前的不透明度）。
减少动效、没有 stage 时直接换。`cubicBezier(x1, y1, x2, y2)` 是 CSS 同名缓动的 JS 版（返回 `t => y`）。
边界见 [limitations.md](limitations.md)。

### `<glass-fill>`

画进场景的圆角矩形，纯色或渐变：玻璃看得见它（开关的轨道、滑块的进度条、卡片后面的色块、彩色的渐变底）。
样式全在 CSS 里：

| CSS | 说明 |
|---|---|
| `--glass-fill` | 颜色或渐变。注册成不继承的 `<color> \| <image>`，初始透明。纯色可以过渡；`currentcolor` 取元素的 `color`。渐变见下 |
| 盒子、`transform`、`opacity`、裁剪祖先 | 与玻璃面板一样每帧跟着 |
| `border-radius` | 圆角与椭圆角（`50%` 在长方形上是椭圆，`20px / 8px` 这类也行） |

**别写 `background`**：颜色画在场景里，元素自己在 stage 生效时是透明的。没有玻璃时 glassium.css 把 `--glass-fill`
画成 CSS 背景。里面的内容照常是 DOM。

渐变：`linear-gradient()`、`radial-gradient()` 与两种 `repeating-`，几何按 CSS 的规则解算（方向与角、四种大小关键字、
`at` 位置、色标位置的补法），在预乘的 sRGB 里插值 —— 与浏览器画同一个 CSS 渐变一致，透明的一头不发黑。
最多 5 个色标（多的留前 4 个与最后一个，警告一次）；颜色提示（单独的 `30%`）按没写处理；`conic-gradient()`
不支持（按透明处理，警告一次）。线性光模式下也是在 sRGB 里插完再换成线性值。

```html
<glass-fill style="--glass-fill: linear-gradient(120deg, #ff5f6d, #ffc371 40%, #2e9bff); border-radius: 22px">…</glass-fill>
<glass-fill style="--glass-fill: radial-gradient(circle at 30% 40%, #fff, transparent)">…</glass-fill>
```

### `<glass-switch>`

开关：轨道是填充、旋钮是玻璃。按下时旋钮鼓起来、变成透明的透镜（透过它看得见轨道），松开时切换。

- 宿主就是开关：`role="switch"`、`aria-checked`、可聚焦。空格（与 Enter）切换；点一下切换，也可以拖动旋钮，
  松开时按旋钮停在哪一半决定。
- 用户切换时派发 `input` 与 `change`（冒泡）；click 里 `preventDefault()` 就不切换；程序改 `checked` 不派发。
- **表单**：表单关联的自定义元素，与 checkbox 相同。

  | 属性 / 属性访问器 | 说明 |
  |---|---|
  | `checked` | 开着（反映成属性）。表单重置回到第一次进文档时的状态 |
  | `name`、`value` | 开着时进表单数据，`value` 默认 `"on"` |
  | `disabled` | 禁用（祖先 `<fieldset disabled>` 同样生效）：变淡、不可聚焦、点不动 |
  | `form`、`labels`（只读） | 表单归属、关联的 `<label>` |

- CSS：`--glass-switch-on`（默认 `#34c759`）、`--glass-switch-off`（默认 `rgba(120, 120, 128, 0.32)`），可以写在任何祖先上。
  默认 64×28，宽高可以改（旋钮高 = 宿主高 − 4px，宽高比 13:8）。`::part(track)`、`::part(thumb)` 可以从外面选中。
- 可以放进 `<glass-card>`（它在卡片上面一层，见 limitations.md 的 R2）；别放在不透明的 CSS 背景上（R1）。
  要一块纯色底板，用 `<glass-fill>`（它也在场景里，画在轨道下面）。

### `<glass-slider>`

滑块：轨道与进度是填充、旋钮是玻璃（与 `<glass-switch>` 同一个旋钮，拖动时变成透镜）。

- 宿主就是滑块：`role="slider"`、`aria-valuenow` / `aria-valuemin` / `aria-valuemax`、可聚焦。方向键走一档，
  PageUp / PageDown 走十分之一，Home / End 到两头。
- 按在轨道上跳到那里并可以接着拖；按在旋钮上从原处拖，不跳。
- 值变了就派发 `input`；松手（或一次键盘操作）之后值与按下时不同就派发 `change`；程序改 `value` 不派发。
- **表单**：表单关联的自定义元素，与 range 相同。

  | 属性 / 属性访问器 | 说明 |
  |---|---|
  | `value`（属性访问器） | 当前值，字符串；设置时规整到范围与档上。`valueAsNumber` 是数 |
  | `value`（HTML 属性）、`defaultValue` | 初始值，表单重置回到它；不写时是范围的中点 |
  | `min`、`max`、`step` | 默认 0 / 100 / 1；`step="any"` 连续。值落到最近的一档（从 min 起算），与原生的规则相同 |
  | `name` | 当前值进表单数据 |
  | `disabled` | 禁用（祖先 `<fieldset disabled>` 同样生效） |
  | `form`、`labels`（只读） | 表单归属、关联的 `<label>` |

- CSS：`--glass-slider-fill`（进度，默认 `#007aff`）、`--glass-slider-track`（默认 `rgba(120, 120, 128, 0.2)`）。
  默认 200×28，宽度可以改；轨道 6px 高、旋钮 38×24。`::part(track)`、`::part(progress)`、`::part(thumb)`。
- 放在哪里与 `<glass-switch>` 相同：可以放进 `<glass-card>`，别放在不透明的 CSS 背景上。

### `<glass-segmented>`

分段控件：底是填充，选中的段下面垫一块玻璃旋钮（与开关、滑块同一个）。每个子元素是一段，值取它的 `value`
属性，没有就取文字。

- 语义是单选组：宿主 `role="radiogroup"`，每段 `role="radio"` 与 `aria-checked`；只有选中的那段可以 Tab 到，
  方向键在段之间移动并选中（到头回绕），Home / End 到两头，空格选中当前段。
- 点一段选中它；按住选中的那段可以拖动旋钮，松手时选中旋钮中心所在的段。按住时旋钮变成透镜。
- 用户换选中时派发 `input` 与 `change`；程序改 `value` / `selectedIndex` 不派发。
- **表单**：`name` 与选中的值进表单数据；`value` 属性是初始值（对不上时选第一段），表单重置回到它；`disabled`
  与祖先 `<fieldset disabled>` 让它禁用。属性访问器：`value`、`selectedIndex`、`defaultValue`、`segments`、
  `form`、`labels`。
- CSS：`--glass-segmented-track`（底色，默认 `rgba(120, 120, 128, 0.24)`）。高 32px，段宽由内容决定（给宿主定宽时
  平分）。选中的段带 `aria-checked="true"`，可以据此换文字颜色（它压在白色旋钮上）。`::part(track)`、`::part(thumb)`。
- 放在哪里与 `<glass-switch>` 相同。

### `<glass-tab-bar value="home">`

标签栏：一条玻璃胶囊（材质属性与 `<glass-card>` 相同，默认胶囊），选中那一格下面垫一个玻璃气泡。气泡写在栏里面，
在栏的上面一层（见 limitations.md 的 R2），看得见栏；换选中时滑过去、宽度跟着变，按住时变成透镜，可以按住拖到别的格上
再松手。每个子元素是一格（按钮也行，默认外观会被去掉），值取它的 `value` 属性，没有就取文字。

- 语义是标签页：宿主 `role="tablist"`，每一格 `role="tab"` 与 `aria-selected`，roving tabindex；方向键移动并选中
  （到头回绕），Home / End。`aria-controls` 之类由你写。
- 用户换选中时派发 `input` 与 `change`；程序改 `value` / `selectedIndex` 不派发。`value` 属性是初始值（对不上时选第一格）。
  属性访问器：`value`、`selectedIndex`、`tabs`。不是表单控件。
- CSS：`--glass-tab-bar-selected`（选中那一格的文字颜色，默认 `#0a84ff`）。`::part(bubble)`。
- 透镜放大的是底下的玻璃，不是格子里的图标文字 —— 那些是 DOM，画在最上面。
- `minimize="scroll"`：页面往下滚时缩起来 —— 没选中的格收成 0 宽、淡出，栏只剩选中那一格，气泡淡出；往上滚、
  回到顶部时展开（iOS 26 的 `tabBarMinimizeBehavior(.onScrollDown)`）。往一个方向累计滚 32px 才切换，手指的小幅
  抖动不会让它来回闪。缩着的时候点一下只展开（不换选中）；键盘焦点移进来也展开。`minimized` 属性可读可写。
  看的是整个文档的滚动（window）。宽度的过渡靠 CSS 的 `interpolate-size`，不支持它的浏览器直接切换。
  写了 minimize 的栏，格上会带 `width: max-content; overflow: hidden`。

### `<glass-nav-bar large-title>`

导航栏：两侧各一个玻璃胶囊装按钮，中间是标题。

```html
<glass-nav-bar large-title>
  <button slot="leading" aria-label="返回">‹</button>
  <h1>设置</h1>
  <button slot="trailing" aria-label="搜索">⌕</button>
  <button slot="trailing" aria-label="更多">⋯</button>
</glass-nav-bar>
```

- `slot="leading"` / `slot="trailing"` 的按钮排进左 / 右的胶囊（同一侧共用一个，iOS 26 的分组；按钮的默认外观去掉）。
  没有按钮的一侧不画胶囊。其余子元素是标题。
- 材质属性写在栏上，两个胶囊一起用（与 `<glass-card>` 相同；`corner-radius` 默认 `1frac`，胶囊形）。
- 宿主是 `display: contents`：栏那一行（`::part(bar)`，`position: sticky; top: 0`）与大标题（`::part(large-title)`）都排在
  宿主的父元素里 —— 滚动时栏贴在视口顶上，大标题跟着正文滚走。要对齐正文那一栏就给这两个 part 写 `padding-inline`。
- `large-title`：标题大字写在栏下面；滚进栏底下时，栏中间淡入一行小标题（标题文字的副本，`aria-hidden`）。
- 正文滚到栏底下时，按「底下压了多少正文」（栏贴住之后再滚了多远，16px 走完，`NAV_EDGE_RAMP`）淡入栏后面的一条模糊
  渐隐（`::part(edge)`）与胶囊上的磨砂 —— GPU 玻璃盖不住滚上来的 DOM 文字，这两层用 CSS 的 `backdrop-filter`。
- 宿主上的 `data-scrolled`（底下压着正文）、`data-collapsed`（大标题整个滚进了栏底下）；同名的只读属性
  `scrolled`、`collapsed`。`update()` 按当前滚动位置重算（你自己挪了布局之后用）。
- CSS：`--glass-nav-bar-height`（默认 52px）、`--glass-nav-bar-edge`（渐隐往下多出来的一截，默认 24px）。
  `::part(bar)`、`::part(edge)`、`::part(leading)`、`::part(trailing)`、`::part(title)`、`::part(inline-title)`、
  `::part(large-title)`。
- 纯函数 `edgeProgress(barTop, naturalTop)`、`largeTitleProgress(barBottom, titleTop, titleHeight)`、
  `inlineTitleOpacity(progress)` 是上面这几个量的算法。
- 看的是整个文档的滚动（window）。

### 盖在 DOM 上的玻璃（`overlay`）

模态 `<dialog>`、打开的 popover、全屏元素里的玻璃，以及写了 `overlay` 属性的玻璃，stage 自动改用 CSS 画（带上
`data-glassium-overlay`，不上 GPU）：`backdrop-filter` 模糊下面的一切，材质的模糊、饱和度、tint、亮边、投影照搬，
没有折射。组件把材质写成自己影子样式里的 CSS 变量：`--glassium-blur`、`--glassium-saturate`、`--glassium-tint`、
`--glassium-rim-light`、`--glassium-rim-dark`、`--glassium-shadow`（`overlayVars(material)` 算的就是这些）。

### 浮在正文上的玻璃（`scroll-edge`）

卡片、按钮、标签栏写 `scroll-edge="bottom"`（浮在视口底边，比如底部的标签栏、右下角的浮动按钮）或 `scroll-edge="top"`
（浮在顶边）：正文从它底下经过时，影子树里的一层磨砂（`::part(frost)`，CSS 的 `backdrop-filter`）按滚动淡入 ——
GPU 玻璃画在最底下，盖不住滚上来的 DOM 文字。

- `bottom`：下面还有没滚到的内容时是 1，离文档末尾不到 16px（`SCROLL_EDGE_RAMP`）时淡出，到底是 0。页面底下要给它
  留出位置（padding-bottom），否则滚到底时最后几行照样压在它上面。
- `top`：往下滚了 16px 之内淡入；回到顶上是 0。
- 磨砂是 DOM，画布上的 GPU 玻璃照画（在磨砂底下、被它模糊）。看的是整个文档的滚动（window）。
- `scrollEdgeProgress(edge, scrollY, scrollHeight, viewportHeight)` 是它的算法。`<glass-nav-bar>` 自带一套（按栏有没有
  贴住算），不用写这个属性。

### 材质属性

三个玻璃组件都认，与 `GlassMaterial` 一一对应。写错的属性在控制台报一次并被忽略。

| 属性 | 取值 | 默认 |
|---|---|---|
| `preset` | `ultraThin` / `thin` / `regular` / `thick` / `clear`（也认 kebab-case） | —（用默认值） |
| `blur` | 模糊 σ，dp | 8 |
| `refraction` | 折射带的深度，短边的比例 | 0.2 |
| `distortion` | 位移的幅度，短边的比例 | 0.2 |
| `highlight` | 亮边强度，0–1 | 0.6 |
| `dispersion` | 色散，0–1 | 0 |
| `saturation` | 1 = 原样 | 1.4 |
| `tint` | hex（3/4/6/8 位）或 `rgb()` / `rgba()`；alpha 是叠加强度 | `rgba(255,255,255,0.18)` |
| `opacity` | 玻璃的不透明度，0–1（还会乘上元素在 CSS 上的实际不透明度） | 1 |
| `corner-radius` | `16`、`0.5frac`（短边的比例）或四个数 `4 32 8 28`（TL TR BR BL） | card 24、button `1frac`、其余 `0.5frac` |
| `squircle` | 倒角剖面指数，2 = 圆 | 2 |
| `depth-effect` | 0 薄板 – 1 厚透镜 | 1 |
| `adaptive` | 自适应，0–1：背后太亮 / 太暗时蒙一层纱，守住与文字 3:1 的对比度 | 1（`clear` 预设 0） |
| `shadow` | 投影深浅，0–1：玻璃往下投一圈柔和的影子 | 0.3（预设越厚越深，`clear` 为 0） |

### CSS

`glassium.css` 放进 `<head>`：没有玻璃时（upgrade 之前、stage 没建好、没有 GPU、强制配色）给组件一层可读的兜底表面。
玻璃生效时组件带上 `data-glassium-active` 属性，兜底表面随之去掉。所有选择器都在 `:where()` 里，优先级为 0。
兜底表面的圆角来自 CSS 的 `border-radius`，不来自 `corner-radius`。

玻璃与填充跟着 DOM 的裁剪走：`overflow` 不是 visible 的祖先（连同它的 `border-radius`，椭圆角也算），以及面板自己
或祖先的 `clip-path` —— `inset()`、`circle()`、`ellipse()`、`rect()`、`xywh()`、盒子关键字；`polygon()` 按外接矩形。
`url()`、`path()` 与 `mask` 不跟（前两个会警告）。详见 [limitations.md](limitations.md)「裁剪」一节。

---

## `createGlassStage(options?)` → `Promise<GlassStage>`

每文档一个（R3）。第二次调用警告并返回同一个。拿不到任何 GPU 后端时也照常返回（`backend: 'none'`，页面照常工作，只是没有玻璃）。

| 选项 | 说明 | 默认 |
|---|---|---|
| `scene` | 初始场景（见「场景」）。加载完成之前画 `sceneOptions.background` 的纯色；不等它加载完就返回 | 内置场景 |
| `sceneOptions` | 同 `setScene` 的第二个参数 | |
| `backend` | `'auto'`（WebGPU → WebGL2 → CSS 兜底）、`'webgpu'`、`'webgl2'`（指定了就只试那一个） | `'auto'` |
| `host` | 画布挂到哪里 | `document.body` |
| `maxPixels` | 场景的像素预算 | 1 300 000 |
| `minSceneRatio` | 场景分辨率的下限（相对设备像素） | 0.5 |
| `alphaMode` | 画布的 alphaMode | `'opaque'` |
| `blendSpace` | 模糊与调色在哪个空间里做：`'srgb'` 或 `'linear'`（线性光，见下面「混合空间」）。写错时 Promise reject | `'srgb'` |
| `onDegrade(reason)` | 降级时回调（`{ from, to, detail }`），在 console.warn 之后 | |

## `GlassStage`

| 成员 | 说明 |
|---|---|
| `backend` | `'webgpu'` / `'webgl2'` / `'none'`。设备第二次丢失之后会往下降 |
| `active` | 此刻是不是真的在画玻璃（没有 GPU、强制配色时为 false） |
| `canvas` | 画布。降级时会换一块新的，别缓存 |
| `register(element, material?)` → `GlassPanel` | 把任意元素注册成玻璃面板（组件背后就是它）。材质写错在这里就抛 |
| `group({ smoothing? })` → `GlassGroup` | 建一个合并组（`<glass-container>` 背后就是它） |
| `registerFill(element)` → `SceneFill` | 把任意元素注册成填充（`<glass-fill>` 背后就是它）：颜色取它的 `--glass-fill`。返回 `{ element, unregister() }` |
| `setScene(source, options?)` → `Promise` | 换场景，见下 |
| `refreshScene()` | 非 dynamic 的画布、ImageData 内容变了：下一帧重新上传 |
| `blendSpace` | 现在的混合空间 |
| `setBlendSpace(space)` | 换混合空间，下一帧生效（模糊链换一种纹理格式重新分配一次）。写错就抛 |
| `requestRender()` | 请求重画一帧（通常不需要：变化会自己触发） |
| `dispose()` | 销毁：画布移除、设备释放、监听器解绑。之后可以再建 |
| `debug` | 调试与验证用，见下 |

### `GlassPanel`（`register` 的返回值）

| 成员 | 说明 |
|---|---|
| `element` | 注册的元素 |
| `setMaterial(material)` | 换材质。写错就抛 |
| `setLight({ x, y, strength } \| null)` | 按压处的光。x、y 是相对元素左上角的 CSS 像素，strength 0–1 |
| `unregister()` | 注销 |

### `GlassGroup`

| 成员 | 说明 |
|---|---|
| `setMembers(elements)` | 成员元素，按顺序。前 4 个参与合并，其余单独绘制（警告一次） |
| `setSmoothing(dp)` | smin 的平滑半径 |
| `dissolve()` | 解散，成员回到各自单独绘制 |

### `debug`

| 成员 | 说明 |
|---|---|
| `stats()` → `GlassStats` | 见下表 |
| `checkLayers()` | 立即检查所有面板与画布之间有什么，返回全部问题（R1） |
| `probe` | 当前后端的能力探测结果 |
| `setBackdrop({ blurDp?, saturation?, tint?, scene?, radialCenter?, radialRadius? })` | 背景的调试参数；`scene` 是内置场景：`calibration` / `gradient` / `radial` / `flat` |
| `setPixelBudget(maxPixels \| null)` | 临时换像素预算（null 恢复）。验证「场景分辨率低于画布」时的行为用 |
| `readback(region?)` → `Promise<{ region, rgba }>` | 回读画布像素（一律 RGBA 顺序） |
| `renderNow()` | 立刻同步画一帧（总是画，不管有没有变化）。面板隐藏、rAF 暂停时验证用 |
| `simulateContextLoss()` | 模拟一次设备 / 上下文丢失 |
| `setPanelDebug(mode)` | 面板调试视图：`off` / `sdf` / `mask` / `grad` / `displacement` |
| `probeOptics(index?)`、`probeGroup(index?)` | 光学探针，交给 `compareOptics` / `compareGroupOptics` 与 CPU 实现比对 |

### `GlassStats`

| 字段 | 说明 |
|---|---|
| `backend`、`viewport` | 当前后端、解析后的各级分辨率 |
| `fps`、`frames`、`skippedFrames` | 最近一秒实际画了几帧、画了的总帧数、因为与上一帧逐像素相同而没画的帧数 |
| `drawCalls`、`blurPasses`、`blurLevels` | 上一帧的 draw 数 = 2 + 模糊趟数 + 单独绘制的面板 + 组数 + 2 × 填充数（+ 每个更高的层一次重采样）；模糊趟数 = 2 × (级数 − 1)，每个更高的层再加一轮局部的 |
| `panels`、`groups`、`fills` | 上一帧画了的面板（含组员）、组、填充 |
| `cpuMs` | 上一帧主线程耗时：`measure`（量面板）与 `total` |
| `pipelineCreations`、`bindGroupCreations`、`targetAllocations` | 创建计数，预热后应当走平 |
| `deviceLosses` | 意外丢失的次数 |
| `scene`、`sceneUploads` | 当前场景类型（`builtin` / `image` / `canvas` / `video`）与累计上传次数 |
| `reducedMotion`、`forcedColors`、`reducedTransparency`、`moreContrast` | 四个系统设置的当前状态 |

---

## 场景

`setScene(source, options?)`：玻璃后面画什么。传 `null` 回到内置场景。

`source` 可以是：图片 URL、`Blob` / `File`、`<img>`、`ImageBitmap`、`ImageData`（按图片处理：缩到场景分辨率、只上传一次）；
`<canvas>`、`OffscreenCanvas`、`VideoFrame`（原样上传）；`<video>`（有新帧才上传）。

| 选项 | 说明 | 默认 |
|---|---|---|
| `fit` | `cover` / `contain` / `fill`，与 CSS 的 object-fit 同义 | `cover` |
| `background` | 留白、透明处、初始场景加载完成之前的底色（CSS 颜色） | 黑 |
| `dynamic` | 内容会自己变：画布设了就每帧上传；视频默认是（设 false 停在当前帧）；图片不看这一项 | 视频 true，其余 false |

返回的 Promise 在新场景可以画时 resolve（之前一直画旧场景，不闪）；加载失败时 reject；被后一次调用取代时
reject 一个 `name === 'AbortError'` 的 DOMException。跨源的图片与视频要有 CORS，否则当场 reject。
没有 GPU 时，URL / `<img>` / Blob 场景写成画布的 CSS 背景。

## 混合空间（`blendSpace`）

模糊、调色（saturation、tint）、自适应在哪个空间里做。

| | `'srgb'`（默认） | `'linear'` |
|---|---|---|
| 做法 | 直接在 sRGB 编码值上做 | 在线性光里做：模糊链用 sRGB 格式的纹理存（写入时硬件编码、采样时先解码再过滤），CSS 颜色先换成线性值 |
| 黑白阶跃模糊之后的中点 | 128（发灰） | 180（亮的一侧不被压暗） |
| 灰 128 上叠 0.4 的 `rgb(255, 64, 0)` | 178 / 102 / 76 | 192 / 108 / 101 |
| 自适应 | 按 2.2 次方近似，大致到目标亮度 | 精确到目标亮度（白字 0.3、深色字 0.1） |
| 已校准的数值 | 全部按它量 | 要另量一套 |

两种模式都一样的：玻璃最后编码回 sRGB 再合到画布上 —— 抗锯齿的边、投影与 DOM 一样在编码空间里混合；
画布上按画布分辨率画的填充、CSS 画的玻璃（对话框、popover 里，见「盖在 DOM 上的玻璃」）不受影响。
切换一次多分配一次模糊链；第一次切到 `'linear'` 时多建 5 条管线，之后来回切不再建。

`srgbToLinear(c)`、`linearToSrgb(c)` 是同一条公式的 CPU 版（0–1 的单个通道）。

## 材质（JS）

| 导出 | 说明 |
|---|---|
| `GlassMaterial` | 上面「材质属性」表的 camelCase 版（`cornerRadius`、`depthEffect`……） |
| `GlassPresets` | 五个预设 |
| `glass(preset, overrides?)` | `{ ...preset, ...overrides }` |
| `MATERIAL_DEFAULTS` | 默认值（冻结） |
| `lowerMaterial(material, [w, h])` | 材质 → 有序效果管线（`colorFilter → blur → lens`）。调试或实现别的渲染器时用 |
| `parseTint(css)` | tint 的解析；解析不了就抛 |

## 系统设置

| 设置 | Glassium 的反应 | 查询 / 模拟 |
|---|---|---|
| 减少动效 | 不启动帧循环（只在变化时画一帧）；组件的补间直接落到终点 | `prefersReducedMotion()` / `simulateReducedMotion(on \| null)` |
| 强制配色（高对比度） | stage 停用，画布隐藏，组件显示兜底表面 | `simulateForcedColors(on \| null)` |
| 减少透明度 | 玻璃换成磨砂（按文字颜色选深浅） | `prefersReducedTransparency()` / `simulateReducedTransparency(on \| null)` |
| 更高对比度 | 同样换成磨砂，组件描一圈边（CSS） | `prefersMoreContrast()` / `simulateMoreContrast(on \| null)` |

`simulate*` 传 `null` 回到读真实的媒体查询。它们模拟的是 stage 的反应；CSS 里对应的媒体查询要靠真实的系统设置验。

## 其它

| 导出 | 说明 |
|---|---|
| `currentStage()`、`onStageChange(listener)` | 当前的 stage；订阅它的出现、销毁、降级、设置变化（返回取消订阅的函数） |
| `describeElement(el)`、`describeProblem(problem, name)` | 把元素、层级问题写成一句话（`checkLayers()` 的结果） |
| `simulateNoWebGpu(on)` | 让探测表现为 `navigator.gpu` 不存在，验降级阶梯 |
| `simulateDeviceLoss()`、`deviceLossCount()` | 设备丢失的模拟与计数 |
| `VERSION` | `'0.0.0'`（还没有发布） |

---

## 给渲染器实现者与验证用

| 模块 | 导出 |
|---|---|
| 光学（`core/optics.ts`，移植自上游） | `sdRoundedRect`、`gradSdRoundedRect`、`radiusAt`、`refractionDirection`、`refractionProfile`、`circleMap`、`squircleMap`、`spectralWeights`、`highlightTerms`、`rimMask`、`smin`、`sminGradient`…… |
| 合并 | `evalMergedOptics`、`memberOptics`、`mergeBleed`、`MAX_GROUP_MEMBERS` |
| 管线 | `resolveMargins`、`sampleMargin`、`assertCanonicalOrder`、`EffectChain`、`GlassEffect` |
| 单位与分辨率 | `resolveViewport`、`describeViewport`、`dpToCssPx`、`cssToDevicePx`…… |
| 场景的铺法 | `sceneUvTransform`、`sceneBitmapSize`、`sceneCssBackground` |
| 减少透明度 | `reduceTransparency`、`frostFor`、`frostForColor`、`relativeLuminance`、`FROST` |
| 着色器源 | `OPTICS_WGSL`（唯一真源）、`OPTICS_GLSL`（机械生成） |
| 验证 | `compareOptics`、`compareGroupOptics`、`joinProbeAndColors`、`summarizeBySector` |

数学与管线的规格见 [../spec/optics.md](../spec/optics.md)、[../spec/pipeline.md](../spec/pipeline.md)。
