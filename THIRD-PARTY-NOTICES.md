# 第三方声明

本仓库自身以 **Apache License 2.0** 发布（见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）。
选 Apache-2.0 而不是工作区里 meshora 用的 MIT，理由见 [docs/porting-notes.md](docs/porting-notes.md#为什么整个项目都用-apache-20)。

---

## AndroidLiquidGlass / Backdrop

Glassium 的光学数学移植自 [`Kyant0/AndroidLiquidGlass`](https://github.com/Kyant0/AndroidLiquidGlass)
（制品坐标 `io.github.kyant0:backdrop`）的 `backdrop/src/commonMain/kotlin/com/kyant/backdrop/internal/Shaders.kt`。
该项目以 **Apache License 2.0** 发布，`Copyright 2025 Kyant`。

携带该许可头的 Glassium 文件**只有两个**：

- `src/core/optics.ts` —— 同一数学的 TypeScript 译本（CPU 参考实现）
- `src/shaders/optics.wgsl.ts` —— 同一数学的 WGSL 译本（GPU 实现，唯一真源）

其余文件（管线、材质、渲染器、组件、WGSL→GLSL 重写器）均为原创，不带许可头。
这是刻意的：给全部文件加头会冲淡「哪些代码真的带义务」这个信号。

### 已作的修改

Apache-2.0 §4(b) 要求声明修改。完整逐条清单在 [docs/porting-notes.md](docs/porting-notes.md)，摘要：

- 重写为 WGSL / TypeScript（原文是 Kotlin 字符串常量里的 AGSL / SkSL）
- 色散改为径向幅值、蓝光位移大于红光（原实现按 `(x·y)/(hx·hy)` 缩放，逐象限变号）
- 高光改为不对称并新增暗边（原实现用 `abs()`，两侧等亮且无暗边）
- 采样余量改为由 `amount` 推导（原实现按 `height` 编排，在其 playground 默认下欠补 2 倍）
- 修正 `radiusAt` 的坐标系（原实现传左上原点的原始坐标，四角半径会塌缩成右下角那一个）

### 关于 NOTICE

上游**没有** NOTICE 文件 —— 已递归枚举 `kmp` 与 `android` 两个分支的完整文件树，以及
`io.github.kyant0:backdrop:2.0.1` 制品，均无 `NOTICE` / `NOTICE.txt` / `NOTICE.md`。

Apache-2.0 §4(d) 是条件性的，只在「Work 包含 NOTICE 文本文件」时生效，因此本项目
**不承担**对上游的转载义务 —— 也没有可供转载的内容。§4(a)–(c) 仍然适用，本项目通过
随附 LICENSE、在两个移植文件里保留许可头、以及上面的修改声明来履行。

对比：meshora 转录了 Paper Shaders 的 NOTICE，正是因为那个库确实附带了一份。

尽管如此，Glassium 仍然**主动附上了自己的 [NOTICE](NOTICE)** 来承载对 Kyant 的归属。
这会给 Glassium 的下游创造一份上游本没有创造的 §4(d) 义务 —— 这是有意识的取舍：
归属本就该在再分发中存活。

Apache License 2.0 全文见 <https://www.apache.org/licenses/LICENSE-2.0>。
