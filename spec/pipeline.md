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
                  tint?, opacity?, cornerRadius?, squircle?, depthEffect? }
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

| 预设 | blur | refraction | distortion | saturation | tint α | highlight | depthEffect |
|---|---|---|---|---|---|---|---|
| ultraThin | 2 | 0.10 | 0.10 | 1.15 | 0.10 | 0.4 | 0.3 |
| thin | 4 | 0.14 | 0.14 | 1.25 | 0.14 | 0.5 | 0.6 |
| regular | 8 | 0.20 | 0.20 | 1.40 | 0.18 | 0.6 | 1 |
| thick | 16 | 0.30 | 0.28 | 1.50 | 0.22 | 0.7 | 1 |
| clear | 0 | 0.20 | 0.22 | 1.10 | 0 | 0.8 | 1 |

tint 的颜色都是白色。clear 对应 Apple 的 Clear 变体：更透、没有自适应，只该用在媒体内容上。

## 4. 单位

**1 dp = 1 CSS 像素**，不设换算系数。density 1.0 下的 Android dp 按定义就是一个 CSS 像素；
凭空造一个缩放常数会让上游的每个数值都无从追溯。换算到画布设备像素时用
`compositeWidth / cssWidth`（画布的像素数是取整过的，直接乘 DPR 会在 1.5 这类倍率下累积错位）。

## 5. uniform 布局

一块面板一个 `Panel` 结构体（96 字节），按 **256 字节**的步长排进一条 uniform buffer，
每次 draw 只换动态偏移。一个合并组一个 `Group`（400 字节），按 **512 字节**步长排。
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
| 92 | `_pad` | |

`Group` = 16 字节的头（成员数、k（画布设备像素）、debugMode、空）+ 4 个紧挨着的 `Panel`。

两处都有测试直接从 WGSL 源里解析结构体、按对齐规则算偏移，再核对打包代码写的位置
（`src/renderer/panels.test.ts`、`src/renderer/groups.test.ts`）；WebGL2 后端启动时再用
`UNIFORM_BLOCK_DATA_SIZE` 核对一遍 std140 的大小。

## 6. 一帧

```
测量  所有面板一次性 getBoundingClientRect → 画布设备像素；visibility:hidden / opacity:0 的跳过
      组的成员从单独绘制的列表里拿出来；每组的裁剪矩形 = 成员并集外扩 k/4 + 2px
打包  Panel / Group → uniform
场景  内置场景或用户场景（第 7 节），画进模糊链的第 0 级
模糊  每级两趟，共 2 × (K − 1) 趟 —— 与面板数量无关
上屏  背景（按调试参数采样模糊链）
面板  每块一次 draw（全屏三角形 + 裁剪矩形），预乘混合
组    每组一次 draw，与成员数无关
```

帧内之后不再碰布局（读写交错会触发强制同步布局）。drawCalls = 2 + 模糊趟数 + 单独绘制的面板数 + 组数。

测量之后、打包之前比较一次：这一帧画出来与上一帧逐像素相同，就整帧不画，屏幕上保留上一帧。
判断是保守的，只看决定像素的输入 —— 视口各级分辨率与 DPR；背景参数（按对象引用）；场景（内置
gradient 随时间变，用户场景 dynamic 的每帧都变，其余比源、版本号与铺法）；每块面板的矩形、裁剪与
降级结果（按对象引用，材质或尺寸变了会换新对象）；合并组的成员、k 与裁剪矩形；调试视图。
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
