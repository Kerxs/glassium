# 光学规格

这份文档用文字写清 Glassium 的光学数学，给**将来的其它渲染器**（Android / iOS / 原生桌面）照着实现。
它和 `spec/conformance/optics.json`（238 条数值向量）是一对：这里说「算什么、为什么」，
向量说「算出来必须是多少」。两者冲突时以向量为准，并且那是这份文档的 bug。

参考实现：`src/core/optics.ts`（CPU）、`src/shaders/optics.wgsl.ts`（WGSL 真源）、
`src/core/merge.ts`（合并）。数学的出处与每一处偏离见 [../docs/porting-notes.md](../docs/porting-notes.md)。

## 约定

| 项 | 约定 |
|---|---|
| 坐标 | 画布设备像素，**左上原点，y 向下**；片元位置取像素中心（+0.5） |
| 中心化坐标 | `c = px − (rect.xy + rect.wh / 2)`，面板中心为原点 |
| 半尺寸 | `h = rect.wh / 2` |
| 四角半径 | 顺序固定为 **TL, TR, BR, BL**，各自钳到 `min(w, h) / 2` |
| 有符号距离 | 形状内部为负、外部为正、边界为 0，单位像素 |
| 符号函数 | `x ≥ 0` 取 +1，否则 −1 —— **不用 `sign()`**：x 恰为 0 时两者不同，而面板中心线正好落在那里 |
| 归一化 | `safeNormalize(v)`：`|v| ≤ 1e-6` 时返回 (0, −1)，否则 `v / |v|` |

## 1. 圆角矩形的有符号距离

按象限取角半径（**参数是中心化坐标**）：

```
radiusAt(c, radii) =
  c.x ≥ 0 ? (c.y ≤ 0 ? radii.TR : radii.BR)
          : (c.y ≤ 0 ? radii.TL : radii.BL)
```

上游在这里传的是左上原点的原始坐标，于是 `c.x ≥ 0` 恒真，四角半径实际塌缩成右下角 ——
四角相同时看不出来。这是上游的 bug，不是风格差异。

```
q        = |c| − (h − r)
sd(c)    = length(max(q, 0)) − r + min(max(q.x, q.y), 0)
```

## 2. 距离场的解析梯度

闭式解，不用有限差分（更便宜，也没有差分噪声）：

```
q       = |c| − (h − r)
s       = (c.x ≥ 0 ? 1 : −1,  c.y ≥ 0 ? 1 : −1)
m       = max(q, 0)
若 q.x ≥ 0 或 q.y ≥ 0（落在内缩矩形 h − r 之外，角弧与边的外侧都算）：
    |m| ≤ 1e-6 → (0, −1)          ← 退化
    否则      → s · m / |m|
否则（在内缩矩形之内）：
    q.y ≤ q.x → (s.x, 0)
    否则      → (0, s.y)
```

内缩矩形之内那一支取的是**最近那条边**的法线，两个方向在 `q.x = q.y` 的对角线上跳变 ——
那条线在折射带之外（带只有 heightPx 宽），不影响画面，但比较实现时要知道它在那里（见第 12 节）。

## 3. 法线场用放大的角半径

```
gradRadius = min(1.5 · r, min(h.x, h.y))
```

折射方向与高光法线都用 `gradRadius` 求梯度，**不用** SDF 自己的 `r`。这让方向场绕角的转弯分摊到
更长的弧上：在离放大后的角心 `gradRadius − 深度` 处，转向率恰为它的倒数。形状 150×90 半尺寸、
半径 40、深度 9.6px 时峰值转向率 1.0× 为 0.0329/px、1.5× 为 0.0198/px，平缓 1.66 倍。

## 4. 折射方向

```
g   = gradSdRoundedRect(c, h, gradRadius)
dir = depthEffect == 0 ? safeNormalize(g)
                       : safeNormalize(g + depthEffect · safeNormalize(c))
```

`depthEffect` 把轮廓法线与「由中心指向外」的径向量混合：0 像一片倒角的薄板，1 像一整块厚透镜。
`dir` 指向**外侧**。

## 5. 折射剖面

```
squircleMap(x, n) = 1 − (1 − xⁿ)^(1/n)        n = 2 时就是 circleMap(x) = 1 − √(1 − x²)

displacement(sd) =
  heightPx ≤ 0 或 amountPx == 0 或 −sd ≥ heightPx  →  0         ← 边缘带外直通
  否则  →  squircleMap(clamp(1 − (−min(sd, 0)) / heightPx, 0, 1), n) · amountPx
```

折射只发生在边缘带（`−heightPx < sd ≤ 0`），带内越靠边界位移越大，在边界处斜率发散（circleMap
在 x → 1 时导数趋于无穷）。`clamp` 写在调用处而不是 `squircleMap` 里，为的是让 `sqrt` 的定义域
约束一眼可见 —— 负数开方在真实驱动上是 NaN，一个 NaN 会经混合扩散把整块面板抹掉。

## 6. 采样：往里走

```
sample = px − dir · displacement
```

`dir` 指向外侧，减掉它就是**往面板内部**采样 —— 视线在凸面倾斜处向法线偏折，落点更靠近中心。
上游写成 `coord + d · grad`，其中 `d` 因为 `refractionAmount` 在 Lens.kt 里取了负号而为负，
方向相同。所以折射读到的永远是面板内部的像素，**折射不需要采样余量**。

## 7. 色散

```
w = (1 − k, 1, 1 + k)                   k = dispersion，0 关闭
R = chain(px − dir · displacement · w.r)
G = chain(px − dir · displacement · w.g)
B = chain(px − dir · displacement · w.b)
```

三个通道沿**同一个方向**往里采，长度不同：**蓝最长、红最短**（波长越短折射率越高、偏折越大）。
所以边缘每一点上蓝都比红采得更靠里，四个角的关系完全一致。`k = 0` 时必须走单次采样的分支，
与无色散的输出逐位相同。

上游按 `(c.x · c.y) / (h.x · h.y)` 调制色散 —— 一个鞍面，逐象限变号，彩边方向在相邻两角之间翻转。

## 8. 高光

```
L        = (−√½, −√½)                  光源方向，左上 45°，屏幕坐标
n        = safeNormalize(gradSdRoundedRect(c, h, gradRadius))
ndl      = n · L
lit      = max(ndl, 0)^GLOSS           GLOSS = 2
dark     = max(−ndl, 0)^GLOSS
rim(sd)  = 1 − smoothstep(0, rimPx, −sd)          rimPx = 1.5 dp（换算到设备像素）
lit'     = lit  · rim(sd) · highlight
dark'    = dark · rim(sd) · highlight · DARK_RIM  DARK_RIM = 0.35
```

只有朝光的一侧发亮，背光的一侧给出一道暗边。上游是 `pow(abs(n · L), falloff)`，
`abs()` 让两侧等亮，等于两个光源；也没有暗边项。

## 9. 调色与合成

```
luma(c)      = 0.2126 R + 0.7152 G + 0.0722 B            Rec.709
saturated    = mix(luma, rgb, saturation)
filtered     = mix(saturated, tint.rgb, tint.a)          tint.a 是叠加强度，不是透明度
coverage     = clamp(0.5 − sd, 0, 1)                     1px 抗锯齿
a            = coverage · opacity
输出（预乘）  = ((filtered · (1 − dark') + lit') · a,  a)
```

混合方程：`one / one-minus-src-alpha`（预乘）。**不钳 `rgb ≤ a`**：画布上每个像素的 alpha 都是 1，
而 pass 内部 `rgb > a` 就是加性光，混合方程处理得正确（理由见 docs/limitations.md）。

`saturation` 与 `tint` 都是逐点仿射，与模糊（归一化的线性卷积）可交换，所以可以在采样之后施加 ——
这是模糊链能被所有面板共享的前提。

## 10. 多块玻璃合并

```
smin(a, b, k):
  k ≤ 0 → (min(a, b), a ≤ b ? 1 : 0)
  h = clamp(0.5 + 0.5 · (b − a) / k, 0, 1)
  → (b·(1 − h) + a·h − k·h·(1 − h), h)

sminGradient(ga, gb, h) = gb·(1 − h) + ga·h          对这个多项式 smin 是精确梯度
```

成员按顺序折叠（第一个成员是初值）：

```
(sd, h)  = smin(成员.sd, 累积.sd, k)
方向     = sminGradient(成员.dir, 累积.dir, h)          不归一化
法线     = sminGradient(成员.normal, 累积.normal, h)
逐成员参数（tint、height、amount、blurLevel、saturation、squircle、dispersion、
          highlight、opacity、rimPx）= 累积·(1 − h) + 成员·h
blended |= 0 < h < 1
```

折叠完：

```
agreement    = blended ? |方向| : 1
方向         = blended ? safeNormalize(方向) : 方向
法线         = blended ? safeNormalize(法线) : 法线
displacement = profile(sd, height, amount, squircle) · agreement
```

- 颈部两侧成员的方向相对，混合后向量变短，`agreement` 让那里的位移衰减到 0，而不是在中线上翻转。
- h 恰为 0 或 1 的像素（两个 sd 相差 ≥ k）原样取自最近的成员 —— 相距足够远的成员与单独绘制**逐位相同**。
  为此混合必须写成 `a·(1 − h) + b·h`，**不能**用会被编成 `a + h·(b − a)` 的 lerp（h = 1 时不精确）。
- 缝隙宽 g 的两块玻璃，缝中点 sd = g/2 − k/4：**g < k/2 时颈部闭合**。
- 合并形状落在「成员并集外扩 k/4」之内，绘制的裁剪矩形按这个外扩。

## 11. 模糊链

一张 K 级 mip 纹理：第 0 级是锐利场景，第 k 级（k ≥ 1）的屏幕 σ 是 `2 · 2^(k−1)` 场景像素，
所以 K = 6 覆盖到 σ = 32。每级由上一级做一趟水平（兼 2× 降采样）、一趟垂直的 5 抽头高斯：

```
局部 σ = 0.866 目标纹素          √(σ² − (σ/2)²) = σ·√3/2，按方差相加
权重   = exp(−i² / (2σ²))，i ∈ {−2, −1, 0, 1, 2}，归一化
```

连续的 σ 靠硬件在相邻两级之间三线性插值，级别按：

```
level(σ) = σ ≤ 2 ? σ / 2 : 1 + log2(σ / 2)       再钳到 [0, K − 1]
```

低段是线性的：纯对数会让 σ ≤ 1 全部钳到第 0 级，也就是完全不模糊。

## 12. 数值判据

- CPU 实现对 `spec/conformance/optics.json`：容差 1e-6。
- GPU 实现对 CPU 实现（逐像素探针）：**零个非有限值**，采样偏移 `dir · displacement` 的 p99 < 1e-4 像素。
  最大误差允许出现在紧贴边界的像素上 —— circleMap 的斜率在那里发散，f32 的舍入被放大。
- 不直接比较 `dir`：内缩矩形之内有一条 `q.x = q.y` 的线（方形面板上就是对角线），梯度在那里
  从 (±1, 0) 跳到 (0, ±1)，f32 与 f64 会落到不同的一侧，但那里远在折射带之外、位移恰为 0，
  对画面没有影响。比较的是采样偏移 `dir · displacement`。
