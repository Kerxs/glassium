# 移植说明

本文件履行 Apache License 2.0 §4(b)「声明已作修改」的义务，并记录移植的判断依据。

## 上游源

| 项 | 值 |
|---|---|
| 仓库 | <https://github.com/Kyant0/AndroidLiquidGlass> |
| 分支 | `kmp`（**默认分支**，不是 `main` —— `main` 不存在） |
| commit | `65ab177e90e5c1d8c62e70cf7755841982da65f6`（2026-08-26） |
| 文件 | `backdrop/src/commonMain/kotlin/com/kyant/backdrop/internal/Shaders.kt` |
| blob | `a96e90010335a6913eb3a829ad6f04b93567b48e`（6457 字节） |
| 许可 | Apache-2.0，`Copyright 2025 Kyant` |

引 commit SHA 而不是版本号，是因为 `2.0.1` 是 Maven 坐标不是源码修订号。审阅者要核对的是
**实际被读过的那棵树**，版本号做不到这件事。

上游该文件带一个**真正的 Kotlin 文件级许可头**（位于 `package` 声明之前，不是嵌在着色器
字符串里）。这是上游源码树里唯一带显式许可头的文件，所以它就是跟着数学一起走的那个头。

## 逐条偏离

### 1. 语言：AGSL/SkSL 字符串常量 → WGSL + TypeScript

上游把着色器写成 Kotlin 的 `@Language("AGSL") private const val` 字符串，用字符串插值把共享的
`$RoundedRectSDF` 块拼进每个着色器。AGSL 与 SkSL 方言几乎相同，所以一份文本同时喂 Android
与 Skiko。

Glassium 没有 Skia，所以这条路不通。改为：WGSL 是唯一真源（`src/shaders/optics.wgsl.ts`），
GLSL ES 3.0 由 `src/shaders/translate-glsl.ts` 生成；另有一份**独立的 TypeScript 实现**
（`src/core/optics.ts`）作为 CPU 参考，用来在没有 GPU 的前提下证明数学，并与 GPU 的浮点
回读逐像素比对（`stage.debug.probeOptics()` + `compareOptics()`，结果见 docs/calibration.md）。

顺带记一个对未来 Android 渲染器重要的事实：**没有任何主流着色器转译器能产出 AGSL**
（naga、Tint、SPIRV-Cross、Slang 都不支持）。AGSL 是 Skia SkSL 的受限子集，唯一的单源路径是
用 SkSL 写、并留在 AGSL 子集内。`spec/optics.md` 因此用与语言无关的数学表述，而不是给一份
可转译的着色器源。

### 2. 色散：鞍面调制 → 径向幅值，且蓝光位移大于红光

上游按 `(coord.x * coord.y) / (halfSize.x * halfSize.y)` 缩放逐通道偏移量。

这是个**鞍面**：在两条中轴上恒为零，在四角取 ±1，且**逐象限变号**（左上/右下为正，
右上/左下为负）。后果是彩边方向在相邻两角之间翻转 —— 跨过对角线时从「红在外」变成
「蓝在外」。在平滑背景上看不出来，在高对比边缘上读起来像涂抹而不是玻璃。

上游的谱权重也是 7 个手调系数的离散采样（`/3.5`、`/3.0`、`/7.0`），不是物理波长模型。

Glassium 改为：三个通道沿与基础折射相同的方向往里采样，长度按 `{R: 1-k, G: 1, B: 1+k}` 缩放 ——
**蓝光位移大于红光**（波长更短、折射率更高、偏折更大，落点更靠近中心）。这个次序在边缘每一点上
都成立，与象限无关。

上游的次序则取决于象限：按它的公式（红 = 折射点 + dispersed，蓝 = 折射点 − dispersed，
d 取负），左上与右下两个象限里是红更靠里（与物理相反），右上与左下两个象限里是蓝更靠里。
`src/core/lighting.test.ts` 把上游写法也实现了一遍，断言相邻两角异号。

GPU 实测（docs/calibration.md）：径向亮度场上 R − B 在四个角都是 +5.70/255，没有一个像素反向。

### 3. 高光：对称 `abs()` → 不对称，且新增暗边

上游是 `pow(abs(dot(grad, lightDir)), falloff)`。`abs()` 会把朝光和背光两条边**等亮**点亮 ——
那等于两个光源，不是一个。

上游也没有暗边项。这是上游 issue #118 正在要的东西：Apple 的 Liquid Glass 有一道微妙的
深色轮廓，纯加性高光永远做不出来。

Glassium 去掉 `abs()`，只点亮受光边，并减去一个背光侧的暗边项。明暗不对称这一对才是真正
读起来有厚度的东西。

GPU 实测（docs/calibration.md）：光源左上 45°，平灰场上左上边缘平均 +73.8/255、右下 −15.6/255；
右下扇区里**一个发亮的像素都没有**（最大值 0）。上游的 `abs()` 会让它和左上一样亮。

### ~~4. 采样余量~~ —— 已撤回，这不是上游的 bug

早期版本（提交 `7f210c9` 到 `bdaea48`）在这里声称：上游 lens 按 `refractionHeight`
消费 `padding` 预算，而真正决定采样点推出去多远的是 `refractionAmount`；在上游 playground
默认值下 amount 是 height 的 2 倍，所以余量欠补一半，面板边缘会出现一道硬亮缝。

**这个说法是错的。** `Lens.kt` 在传给着色器之前把 refractionAmount 取了负号：

```kotlin
setFloatUniform("refractionAmount", -refractionAmount)
```

而 `gradSdRoundedRect` 指向外侧，于是着色器里的 `coord + d * grad` 是**往面板内部**走的。
折射读到的永远是面板内部的像素，根本不会越出面板，也就谈不上欠补。这个方向也符合物理：
视线在凸面的倾斜处向法线偏折，落点比入射点更靠近中心 —— 凸透镜在边缘的放大。

这个结论来自规划阶段的推断，从没实际渲染验证过，却被当作已确认的事实写进了这份文档、
`THIRD-PARTY-NOTICES.md`、`pipeline.ts` 的注释和测试、两个移植文件的许可头以及提交信息。
写 T7 的折射着色器时要定采样方向，回头读 `Lens.kt` 才发现和它矛盾。

现在的做法：Glassium 与上游一致向内采样，`sampleMargin(lens)` 为 0，需要读到面板外的
只有模糊（3σ）。上游那套 `padding` 协议到底在协商什么，这里不再下判断 —— 它服务于上游
按元素录制图层的架构，而 Glassium 的背景是整个视口共享的一张纹理，不需要逐面板外扩。

### 5. radiusAt 的坐标系（这是上游的一个 bug，不是风格差异）

上游四个着色器全都这样调用：

```glsl
float2 centeredCoord = (coord + offset) - halfSize;
float radius = radiusAt(coord, cornerRadii);   // ← 传的是 coord，不是 centeredCoord
```

而 `radiusAt` 的实现按符号分象限：

```glsl
if (coord.x >= 0.0) { if (coord.y <= 0.0) return radii.y; else return radii.z; }
else                { if (coord.y <= 0.0) return radii.x; else return radii.w; }
```

AGSL 的 `main(float2 coord)` 拿到的是 Canvas/RenderNode 坐标系，**左上原点、取值
[0,w]×[0,h]**。所以 `coord.x >= 0.0` 恒真，`coord.y <= 0.0` 只在最上面一行成立 ——
实际效果是**四角半径塌缩成右下角那一个**（`radii.z`）。

四角半径相同时（`RoundedRectangle(r)` 这种最常见的写法）完全看不出来，这也是它能一直
活着的原因。验证方式见 `src/core/optics.test.ts` 里那条
「上游把原始坐标传进 radiusAt 会让四角塌缩成右下角」—— 它按上游的方式调用，断言在整个
面板范围内只会取到 BR。

Glassium 传中心化坐标。象限到角的映射关系（`radii.y` 对应右上等等）沿用上游，那部分是对的。

### 原样保留的部分

下面几处是上游的真正贡献，Glassium 逐字沿用其数学，只换语言：

- `sdRoundedRect` / `radiusAt` —— 带逐角半径的圆角矩形有符号距离场
- `gradSdRoundedRect` —— **闭式解析梯度**（不是有限差分）。更便宜，且无差分噪声
- `gradRadius = min(radius * 1.5, min(halfSize.x, halfSize.y))` —— 法线场用**放大 1.5 倍**的
  角半径求值，与 SDF 自身的半径解耦。它让位移方向绕角的转弯分摊到更长的弧上，峰值转向率
  实测低 1.66 倍（方向场本身放不放大都连续，放大改变的是转得多急）。极易被漏掉，
  `optics.test.ts` 用一条**正反双向**的测试钉住它
- `circleMap(x) = 1 - sqrt(1 - x²)` —— 圆形（球面）倒角剖面。不是线性斜坡、不是高斯、
  也不是 Snell 定律，是个几何近似
- **只在边缘成带 + 提前返回**：比 `refractionHeight` 更深的内部直通。这既是视觉特征
  （lensing 集中在边缘），也是性能优化

## 为什么整个项目都用 Apache 2.0

`src/core/optics.ts` 与 `src/shaders/optics.wgsl.ts` 两个文件带着无法改授的 Apache-2.0 条款。
在此之上有三个选项：

1. **全仓库 Apache-2.0**（采用）
2. 新代码 MIT、移植部分 Apache-2.0 —— 合法，但留下混合许可仓库，每个下游都要逐文件读头
   才能判断自己受什么约束
3. 不移植、从光学规格重新推导 —— 可行（数学是公开的），但要放弃上游那几处非显然的调校
   （1.5× 梯度半径、边缘带提前返回），而那些正是让它看起来对的东西

选 1 的第二个理由是**专利**：Apache-2.0 §3 有明示专利授权，MIT 对专利完全沉默。对一项外观上
明显近似 Apple 在售设计语言的渲染技术而言，这比通常更值得在意。

工作区里 meshora 用 MIT —— 那是对的，它不是衍生作品，只是借了约定。

## 关于 NOTICE

上游**没有** NOTICE 文件。已递归枚举 `kmp` 与 `android` 两个分支的完整文件树，以及
`io.github.kyant0:backdrop:2.0.1` 制品，均无 `NOTICE` / `NOTICE.txt` / `NOTICE.md`。

Apache-2.0 §4(d) 以「If the Work includes a "NOTICE" text file」开头，是条件性的。上游没有，
所以本项目**不承担转载义务**，也没有可转载的内容。§4(a)–(c) 仍然适用，通过随附 LICENSE、
在两个移植文件保留许可头、以及本文件的修改声明来履行。

Glassium 仍然主动附了自己的 [NOTICE](../NOTICE)，承载对 Kyant 的归属。这会给 Glassium 的
下游创造一份上游本没有创造的义务 —— 这是有意识的取舍，归属本就该在再分发中存活。

## 一件应该先知道的事

上游**已经不是 Android 专属**了。默认分支 `kmp`，内部改名为 Backdrop，自 2.0.0（2026-05-28）
起用 Compose Multiplatform 覆盖 Android / iOS / macOS / 桌面 JVM / JS / Wasm。
`Modifier.liquidGlass` 在 `1.0.0-alpha14` 被整块删除，当前入口是 `Modifier.drawBackdrop`。

**如果你的项目在 Kotlin 生态里，直接用上游，不要用 Glassium。** Glassium 填的是另一个空白：
原生 Web/TypeScript，不经 Kotlin/Wasm。

上游 API 演进本身也是一条设计证据：v1 的 `GlassStyle`/`GlassMaterial` 扁平属性包被作者自己
删掉，换成有序命令式 effect DSL，因为**效果顺序有语义**且**各效果必须协商采样边距**。
Glassium 的内核因此是有序管线；那组属性名保留在上层的声明式立面里，而不是内核。
