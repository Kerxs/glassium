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

三个自定义元素，`defineGlassElements()` 注册（重复调用无害）。材质写在 HTML 属性上。

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
缝隙小于它的一半时两块连成一片，0 是硬并集。成员是 `closest('glass-container')` 为它的后代玻璃组件。
容器自己没有玻璃，排版交给你（常见的是 `display: flex`）。

### 材质属性

三个组件都认，与 `GlassMaterial` 一一对应。写错的属性在控制台报一次并被忽略。

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
| `onDegrade(reason)` | 降级时回调（`{ from, to, detail }`），在 console.warn 之后 | |

## `GlassStage`

| 成员 | 说明 |
|---|---|
| `backend` | `'webgpu'` / `'webgl2'` / `'none'`。设备第二次丢失之后会往下降 |
| `active` | 此刻是不是真的在画玻璃（没有 GPU、强制配色时为 false） |
| `canvas` | 画布。降级时会换一块新的，别缓存 |
| `register(element, material?)` → `GlassPanel` | 把任意元素注册成玻璃面板（组件背后就是它）。材质写错在这里就抛 |
| `group({ smoothing? })` → `GlassGroup` | 建一个合并组（`<glass-container>` 背后就是它） |
| `setScene(source, options?)` → `Promise` | 换场景，见下 |
| `refreshScene()` | 非 dynamic 的画布、ImageData 内容变了：下一帧重新上传 |
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
| `drawCalls`、`blurPasses`、`blurLevels` | 上一帧的 draw 数 = 2 + 模糊趟数 + 单独绘制的面板 + 组数；模糊趟数 = 2 × (级数 − 1) |
| `panels`、`groups` | 上一帧画了的面板（含组员）与组 |
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
