# 管线规格

光学数学见 [optics.md](optics.md)。这份文档讲**数学之外**的那一层：效果怎么排序、采样余量怎么协商、
声明式材质怎么降级成有序管线、面板参数怎么打包成 uniform。将来的渲染器要与 Glassium 画出同一块玻璃，
这一层和光学一样必须一致。

参考实现：`src/core/pipeline.ts`、`src/core/material.ts`、`src/renderer/panels.ts`。

## 1. 有序效果管线（内核）

```
GlassEffect =
  | { kind: 'colorFilter', saturation, tint: [r, g, b, a] }
  | { kind: 'blur',        sigmaDp }
  | { kind: 'lens',        heightDp, amountDp, squircle, dispersion, highlight, depthEffect }

EffectChain = { cornerRadiiDp: [TL, TR, BR, BL], effects: GlassEffect[], paddingDp, opacity }
```

**顺序固定为 colorFilter → blur → lens**，永不重排。上游 v1 用过一个扁平的属性包
（`GlassStyle` / `GlassMaterial`），作者在 1.0.0-alpha14 整块删掉，换成有序的效果 DSL，
理由有二：效果顺序有语义；各效果要协商采样余量。扁平属性包两件事都表达不了 —— 所以扁平的那层
（下面的 GlassMaterial）只作为立面存在，内核是有序链。

形状（四角半径）属于 EffectChain 而不属于 lens：模糊之后、没有 lens 的玻璃同样有形状。

### colorFilter 为什么能放在模糊之后执行

语义顺序是先调色再模糊，但实现上模糊链被所有面板**共享**（每帧的模糊趟数与面板数无关），
而各面板的 saturation / tint 各不相同。两者不矛盾：saturation 与 tint 都是逐点仿射变换，
模糊是归一化的线性卷积，二者可交换 —— `blur(colorFilter(x)) = colorFilter(blur(x))`。
所以调色在采样之后逐面板施加，结果不变。

**这条等价是共享模糊链的前提。** 将来加非仿射的调色（gamma、对比度曲线、tone mapping）就不能这么放，
要么退回逐面板模糊，要么接受近似，必须显式决定。它成立还要求两边在同一色彩空间 —— 第一期全程在
sRGB 编码空间混合。

## 2. 采样余量

```
sampleMargin(colorFilter) = 0
sampleMargin(blur)        = ceil(3 · sigmaDp)          3σ 截断
sampleMargin(lens)        = 0                           往里采样，永远读面板内部
resolveMargins(effects)   = Σ sampleMargin(e)
```

lens 为 0 是因为折射**往面板内部**采样（optics.md 第 6 节）。早期版本曾以为它该按 amount 外扩、
并据此断言上游欠补 2 倍 —— 那是错的，已撤回，经过记在 docs/porting-notes.md。

Glassium 的背景是整个视口共享的一张纹理，模糊链按整个视口做，所以 paddingDp 目前只是一个
**声明**（给将来按元素录制图层的渲染器用），WebGPU / WebGL2 两个后端都不需要逐面板外扩。

## 3. 声明式材质（立面）

```
GlassMaterial = { blur?, refraction?, distortion?, highlight?, dispersion?, saturation?,
                  tint?, opacity?, cornerRadius?, squircle?, depthEffect?, adaptive?, shadow? }
```

| 字段 | 单位 / 取值 | 默认 | 降级到 |
|---|---|---|---|
| `blur` | **σ，绝对 dp** | 8 | `blur.sigmaDp`；0 时省略这个效果 |
| `refraction` | 短边的比例 | 0.2 | `lens.heightDp = refraction · minDim · 0.5` |
| `distortion` | 短边的比例 | 0.2 | `lens.amountDp = distortion · minDim` |
| `highlight` | 0–1 | 0.6 | `lens.highlight` |
| `dispersion` | 0–1 | 0 | `lens.dispersion` |
| `saturation` | 1 = 原样 | 1.4 | `colorFilter.saturation` |
| `tint` | hex（3/4/6/8 位）或 rgb()/rgba() | `rgba(255,255,255,0.18)` | `colorFilter.tint`，alpha 是叠加强度 |
| `opacity` | 0–1 | 1 | `chain.opacity`，钳到 [0, 1] |
| `cornerRadius` | `number`（dp）/ `` `${n}frac` `` / 四个 dp | `'0.5frac'` | `chain.cornerRadiiDp` |
| `squircle` | 剖面指数，2 = 圆 | 2 | `lens.squircle`，钳到 ≥ 1 |
| `depthEffect` | 0 薄板 – 1 厚透镜 | 1 | `lens.depthEffect` |
| `adaptive` | 0–1 | 1（clear 预设是 0） | `chain.adaptive`，钳到 [0, 1]。见下面「自适应」 |
| `shadow` | 0–1 | 0.3 | `chain.shadow`，钳到 [0, 1]。见下面「投影」 |

- 两条缩放规则照抄上游 playground（`refractionHeight = frac · minDim · 0.5`、`refractionAmount = frac · minDim`），
  默认值也取上游 playground 的 0.2 —— 在上游 playground 的默认配置上，两边的采样偏移场逐点相同
  （`src/core/upstream.test.ts`）。
- `'Nfrac'` 圆角 = `N · minDim / 2`，与上游 playground 的 `RoundedRectangle(256.dp / 2 · frac)` 同一个映射。
- 圆角先解算、再把每个角钳到 `minDim / 2`。
- **无操作的效果省略**：saturation = 1 且 tint 的 alpha = 0 时没有 colorFilter；blur = 0 时没有 blur；
  heightDp 或 amountDp 为 0 时没有 lens。不是为了省那一点开销，是为了让 `chain.effects` 读起来就是
  「这块玻璃实际做了什么」。
- tint 解析不了时**抛错**，不静默当成黑色（组件属性在解析时就报并忽略，不会传到这一步）。
- blur 的量纲是绝对 dp 而折射是比例：模糊的观感是绝对的（8dp 在大面板和小按钮上一样柔），
  折射必须随尺寸缩放。

### 预设

| 预设 | blur | refraction | distortion | saturation | tint α | highlight | depthEffect | shadow |
|---|---|---|---|---|---|---|---|---|
| ultraThin | 2 | 0.10 | 0.10 | 1.15 | 0.10 | 0.4 | 0.3 | 0.15 |
| thin | 4 | 0.14 | 0.14 | 1.25 | 0.14 | 0.5 | 0.6 | 0.20 |
| regular | 8 | 0.20 | 0.20 | 1.40 | 0.18 | 0.6 | 1 | 0.30 |
| thick | 16 | 0.30 | 0.28 | 1.50 | 0.22 | 0.7 | 1 | 0.45 |
| clear | 0 | 0.20 | 0.22 | 1.10 | 0 | 0.8 | 1 | 0 |

tint 的颜色都是白色。clear 对应 Apple 的 Clear 变体：更透、没有自适应（adaptive 0），只该用在媒体内容上。
其余预设都自适应。

### 自适应

玻璃看起来有多亮：在模糊链第 4 级上取面板中心与四个象限中心五个点的平均，经过这块玻璃自己的调色
（saturation、tint），算相对亮度 L。文字深浅按面板元素的计算颜色判断（与减少透明度选磨砂是同一个规则）。

- 浅色文字：要求 L ≤ 0.30（与白字 3:1）。超出时整块玻璃的 sRGB 颜色乘 `(0.30 / L)^(1/2.2)`。
- 深色文字：要求 L ≥ 0.10（与黑字 3:1）。不足时整块玻璃往白混，比例按编码后的明度（L 的 1/2.2 次方）算。
- 强度按 `adaptive` 在「不处理」与「完全处理」之间插值；没超出时乘数是 1、混合比例是 0，逐位不变。
- 纱是**整块一样**的，不按像素：按像素压的话会把玻璃里的图像压平。合并组逐个成员按单独绘制时的算法各算一份，
  按 smin 的 h 混合 —— 没有发生混合的像素与单独绘制逐位相同。
- 亮边（高光）加在纱之后，不被压暗。

### 旋转

面板自己与祖先的 CSS 变换，线性部分按 `rotate · scale · transform`（每个元素）、外层在左合成成一个 2×2 矩阵，
拆成旋转角与两个轴的缩放（`src/renderer/pose.ts`）；两列不正交（倾斜）、带旋转的镜像、3D 的画不了。
有旋转时 `rect` 是转之前的矩形：中心 = 包围盒的中心（任何仿射变换下矩形的像的中心都是它包围盒的中心），
尺寸 = 布局尺寸 × 缩放；scissor 与合并组的范围按包围盒算。

着色器里像素先转进面板坐标系：`local = Rᵀ(p − center)`，形状、剖面都在那里算；折射方向与法线转回屏幕：
`dir = R · dir_local`。光源方向、投影的偏移是屏幕上的（投影的偏移转进面板坐标系再挪）。
`pose = (1, 0)` 时两次转换都是「乘 1 加 0」，结果逐位不变。

### 投影

形状由渲染器定：同一个圆角矩形往下挪 4 dp，在它外面按 σ = 10 dp 的高斯衰减（里面是峰值），峰值 alpha =
`shadow × 0.5`，再乘裁剪覆盖率与不透明度。玻璃外面的像素输出预乘的黑；抗锯齿那一圈边上影子垫在玻璃下面
（`alpha = 玻璃 alpha + 影子 × (1 − 玻璃 alpha)`）。有投影时 scissor 往外扩 2.5σ + 偏移。
shadow = 0 时该丢弃的片元照样丢弃、其余加 0，逐位不变。合并组把各成员挪过之后的 SDF 用同一个 smin 折叠，
深浅与 σ 按 h 混合。

## 4. 单位

**1 dp = 1 CSS 像素**，不设换算系数。density 1.0 下的 Android dp 按定义就是一个 CSS 像素；
凭空造一个缩放常数会让上游的每个数值都无从追溯。换算到画布设备像素时用
`compositeWidth / cssWidth`（画布的像素数是取整过的，直接乘 DPR 会在 1.5 这类倍率下累积错位）。

## 5. uniform 布局

一块面板一个 `Panel` 结构体（176 字节），按 **256 字节**的步长排进一条 uniform buffer，
每次 draw 只换动态偏移。一个合并组一个 `Group`（720 字节），按 **768 字节**步长排。
WGSL 的 uniform 布局与 GLSL 的 std140 在这两个结构体上逐字节相同，两个后端用同一份打包字节。

| 偏移 | Panel 字段 | 内容 |
|---|---|---|
| 0 | `rect: vec4` | x, y, w, h（画布设备像素） |
| 16 | `radii: vec4` | TL, TR, BR, BL（画布设备像素） |
| 32 | `tint: vec4` | rgb + 叠加强度 |
| 48 | `heightPx` | |
| 52 | `amountPx` | |
| 56 | `blurLevel` | 模糊链的浮点 mip 级（由场景像素下的 σ 算出） |
| 60 | `saturation` | |
| 64 | `squircle` | |
| 68 | `depthEffect` | |
| 72 | `dispersion` | |
| 76 | `highlight` | |
| 80 | `opacity` | |
| 84 | `debugMode` | 0 关、1 sdf、2 mask、3 grad、4 displacement |
| 88 | `rimPx` | 1.5 dp 换算成设备像素 |
| 92 | `adapt` | 自适应强度，带文字深浅的符号：> 0 浅色文字、< 0 深色文字、0 关掉 |
| 96 | `clip: vec4` | 裁剪祖先围出的可见区域 x0, y0, x1, y1（画布设备像素）；没有裁剪的方向写 ±65536，不写 ±∞ |
| 112 | `clipRadii: vec4` | 可见区域四角的圆角 TL, TR, BR, BL（画布设备像素） |
| 128 | `light: vec4` | 按压处的光：中心 x、y 与高斯 σ（画布设备像素，σ = 0.4 × 短边），强度（× 0.2；0 = 没有） |
| 144 | `shadow: vec4` | 投影：峰值 alpha（shadow × 0.5）、σ、向下的偏移（画布设备像素）、空 |
| 160 | `pose: vec4` | 旋转：cos θ、sin θ（屏幕坐标，y 向下），空，空。没有旋转是 (1, 0) |

`Group` = 16 字节的头（成员数、k（画布设备像素）、debugMode、空）+ 4 个紧挨着的 `Panel`。

片元的覆盖率 = 形状的覆盖率 × 裁剪区域的覆盖率。后者用「到四条边的距离」算圆角矩形的 SDF：
`e = (max(x0 − p.x, p.x − x1), max(y0 − p.y, p.y − y1)) + r`，`sd = |max(e, 0)| + min(max(e.x, e.y), 0) − r`，
r 按像素落在哪个象限取角。不用「到中心的偏移减半宽」：区域一边是 ±65536 时中心在几万像素之外，f32 在那个
量级上的精度不够；到边的距离是精确的。没有裁剪时它恰好是 1.0，乘上去逐位不变。合并组取成员裁剪覆盖率的最大值。
探针不乘裁剪 —— 它验的是光学。

按压处的光加在亮边的加性光上：`lit = 高光项 + strength · exp(−|p − c|² / 2σ²)`。强度为 0 时加的是 0，逐位不变。
合并组把成员各自的光斑相加（只有被按下的那块有光）。

填充一块一个 `Fill`（96 字节，同样 256 字节步长）：`rect`、`radii`、`color`（未预乘的 rgb + alpha，alpha 已乘
CSS 上的不透明度）、`clip`、`clipRadii`、`pose`，六个 vec4，含义与 Panel 的同名字段相同。另有一个 16 字节的 `Dest`
（画到哪里）：`scale`（一个目标像素是几个画布设备像素：场景目标是 画布 ÷ 场景，画布本身是 1）、`aa`（抗锯齿过渡的
宽度 = 一个目标像素）。片元：`px = 片元位置 · scale`，形状与面板一样在画布设备像素里算，
`a = color.a · clamp(0.5 − sd / aa) · clamp(0.5 − clipSd / aa)`，输出预乘色。

三处都有测试直接从 WGSL 源里解析结构体、按对齐规则算偏移，再核对打包代码写的位置
（`src/renderer/panels.test.ts`、`src/renderer/groups.test.ts`、`src/renderer/fills.test.ts`）；WebGL2 后端启动时再用
`UNIFORM_BLOCK_DATA_SIZE` 核对一遍 std140 的大小。

## 6. 一帧

```
测量  所有面板一次性 getBoundingClientRect → 画布设备像素；visibility:hidden / opacity:0 的跳过
      组的成员从单独绘制的列表里拿出来；每组的裁剪矩形 = 成员并集外扩 k/4 + 2px
打包  Panel / Group → uniform
场景  内置场景或用户场景（第 7 节），画进模糊链的第 0 级
填充  有填充时：先把第 0 级拷到草稿纹理的第 0 级（「没有填充的场景」），再把每块填充画进第 0 级
模糊  每级两趟，共 2 × (K − 1) 趟 —— 与面板数量无关
上屏  背景（按调试参数采样模糊链；有填充且调试参数是原样时，采样那份没有填充的场景）
填充  按画布分辨率再画一遍（调试参数调过色或模糊过时不画：背景里已经有了）
面板  每块一次 draw（全屏三角形 + 裁剪矩形），预乘混合
组    每组一次 draw，与成员数无关
层    更高的层（写在玻璃里面的玻璃与填充）逐层：
        这一层所有东西的包围盒外扩 3σ（场景像素，σ 取模糊链最粗的一级）→ 这一块
        画布上的这一块拷出来 → 重采样回模糊链的第 0 级 → 这一层的填充画进去 → 这一块里重建模糊链（scissor，不清屏）
        → 这一层的填充按画布分辨率画到画布上 → 这一层的面板与组
```

以上面板、组、填充都只含第 0 层的；层号是渲染树里玻璃祖先的个数（最多 3）。

帧内之后不再碰布局（读写交错会触发强制同步布局）。drawCalls = 2 + 模糊趟数 + 单独绘制的面板数 + 组数 + 2 × 填充数。
没有填充时不拷贝、不多画，整帧与加填充之前逐位相同（`8aca3e92…`）。

测量之后、打包之前比较一次：这一帧画出来与上一帧逐像素相同，就整帧不画，屏幕上保留上一帧。
判断是保守的，只看决定像素的输入 —— 视口各级分辨率与 DPR；背景参数（按对象引用）；场景（内置
gradient 随时间变，用户场景 dynamic 的每帧都变，其余比源、版本号与铺法）；每块面板的矩形、裁剪与
降级结果（按对象引用，材质或尺寸变了会换新对象）；合并组的成员、k 与裁剪矩形；每块填充的矩形、裁剪、圆角
与颜色；调试视图。
回读与探针请求、画布重新分配、换后端之后的第一帧一律画。

## 7. 用户场景

场景可以是一张图（或视频的当前帧、画布的当前内容），按 CSS `object-fit` 的语义铺进视口。
铺法在 CPU 上算成一个仿射变换，着色器里只做一次乘加（`src/core/scene.ts`）：

```
图片 uv = 视口 uv · k + (0.5 − 0.5·k)        视口 uv 与图片 uv 都是左上原点、y 向下
r = (视口宽 / 视口高) / (图片宽 / 图片高)
cover    k = r ≥ 1 ? (1, 1/r) : (r, 1)        盖满，多出来的裁掉
contain  k = r ≥ 1 ? (r, 1) : (1, 1/r)        装得下，空出来的是底色
fill     k = (1, 1)                            拉伸，不保持比例
```

中心是不动点；cover 与 contain 下两个方向的像素比例相同（不变形），有测试钉住。

片元：`c = 采样(clamp(uv, 0, 1))`，`rgb = mix(底色, c.rgb, c.a)`；uv 落在 [0, 1] 之外时直接输出底色。
纹理第 0 行是图片顶部（两个后端都不翻转上传），颜色不预乘。输出不透明（alpha = 1），与内置场景相同。

静态图先缩到「视口里用得到的像素数」再上传：cover 时一边正好等于场景目标、另一边更大；contain 时装得下；
fill 时就是目标大小；不放大。大图直接上传、在着色器里双线性缩小会闪摩尔纹。

上传时机：静态源在源对象或版本号变化时传一次；动态源每帧传；视频按新帧递增版本号。
后端报告每帧有没有上传（`FrameResult.sceneUploads`），stage 累加进 `stats().sceneUploads` ——
与 `pipelineCreations` 同一类判据：静态场景稳定之后必须走平。
