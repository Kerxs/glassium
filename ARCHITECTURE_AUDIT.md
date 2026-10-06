# Glassium 架构审计（对照「1.0 → 2.0 开发任务书」）

审计对象：`main` 上的 `de2fb9c`（`package.json` 版本 **1.0.0**，2026-09-30 发布），工作区干净。
方法：只读 —— 读源码、文档、测试与 CI 配置，统计目录间的 import；没有改任何代码。
`npm run typecheck` 与 `npm test`（356 个测试全过）是审计前的基线。

> 任务书的出发点是「把现有 Glassium 演进到 1.0.0」。**仓库已经是 1.0.0，并且有书面的兼容承诺**（CHANGELOG 1.0.0 一节、
> `spec/api/stable.txt` 146 个名字、`spec/api/attributes.txt` 51 项，均有测试核对）。任务书里第八节「1.0.0」的若干条目与这份承诺、
> 与 docs/architecture.md 里已经做出的设计决定冲突 —— 详见 [ARCHITECTURE_CONFLICT.md](ARCHITECTURE_CONFLICT.md)。
> 本文按实际代码写，迁移方案按「1.0.0 已发布」重排。

---

## 1. Current Architecture

### 1.1 一句话

Glassium 持有一块铺满视口的画布（`z-index: -1`），场景与玻璃都画在上面；**DOM 是唯一真源**：每一帧把注册过的元素
用 `getBoundingClientRect()` 与计算样式量一遍，得到扁平的「量到的面板 / 合并组 / 填充」列表，交给后端画。
玻璃折射的是 Glassium 自己的场景，不是任意 DOM（docs/limitations.md）。

### 1.2 分层（实际代码）

| 层 | 实际位置 | 规模（非测试行数） | 说明 |
|---|---|---|---|
| 数学 / 材质 / 光学（纯函数） | `src/core/` | 1 901 | 无 DOM、无 GPU，Node 可测；`material.ts` 声明式材质 → `pipeline.ts` 的 `EffectChain` |
| 着色器 | `src/shaders/` | 1 966 | WGSL 唯一真源；`translate-glsl.ts` 机械生成 GLSL（签入、CI 校验）；入口与绑定两后端各自手写 |
| 与后端无关的渲染层 | `src/renderer/` | 9 823 | `stage.ts`（1 638）帧循环 + 后端阶梯；`panels.ts`（1 389）注册表 + 测量 + uniform 打包；`layers.ts` 层；`idle.ts` 脏判断；`atlas.ts` 图集；`paint-content.ts` DOM 光栅化 |
| WebGPU 后端 | `src/renderer/gpu.ts`（1 434）+ `src/webgpu/`（354） | | |
| WebGL2 后端 | `src/webgl2/`（2 131） | | `renderer.ts` + 手写 GLSL 入口 |
| CSS 兜底 | `src/core/overlay.ts` + `src/runtime/styles.ts` + `glassium.css` | | 不是一个 `Renderer` 实现，是 stage 的 `backend: 'none'` 状态 + 组件 / runtime 的 CSS 表面 |
| Runtime（零配置） | `src/runtime/` | 2 063 | `[glass]` 自动发现、`glass()`、`configure`、能力、背景收进场景（absorb）、内容进场景（content） |
| 交互 | `src/interaction/` | 1 125 | press、jelly、glide、morph、motion、element-motion |
| 动画 | `src/animation/timeline.ts` | 116 | 一帧一个 rAF 的统一时间轴 |
| 性能 | `src/performance/` | 441 | 帧监测、自适应质量、局部质量 |
| 组件 | `src/components/` | 3 996 | `<glass-*>` 9 个，基于 `StageLink` / `GlassElement` |
| 调试 | `src/debug/` | 355 | 调试面板与检查器 |

入口：`src/index.ts`（完整，含组件）、`src/runtime-entry.ts`（`glassium/runtime`，不含组件，gzip ≈ 98 KB vs 117 KB）。

### 1.3 一帧的数据流

```
timeline.flushFrame(now)                       animation/timeline.ts：交互、动画先写值
        ↓
PanelRegistry.measure()                        renderer/panels.ts：每个注册元素一次 getBoundingClientRect
   面板 → MeasuredPanel（矩形、裁剪、遮罩、旋转、层号、EffectChain、质量）
   合并组 → MeasuredGroup；填充 → MeasuredFill（纯色 / 渐变 / 位图 → 图集）
        ↓
FrameSnapshot → idle.ts unchangedFrame()       整帧没变就不画
        ↓
Renderer.render(FrameInput)                    gpu.ts / webgl2/renderer.ts，各自手写同一串 pass：
   场景 → 第 0 层填充 → 模糊链（共享，2(K−1) 趟）→ 背景上屏 → 填充按画布分辨率 → 面板 → 合并组
   → 逐层（采回画布、局部重建模糊链、画这一层）
   sceneReusable()：场景与模糊链没变就沿用（只画背景与玻璃）
```

---

## 2. Dependency Graph

目录间的 import（非测试文件，按出现次数）：

```
core        → （无）
shaders     → core
webgpu      → （无）
renderer    → core(42) shaders(15) webgpu(3) webgl2(1) animation(1)
webgl2      → renderer(8) shaders(4) core(4)
animation   → （无）
performance → renderer(3)
interaction → renderer(13) core(7) animation(5) shaders(1) runtime(1)
runtime     → renderer(15) core(8) interaction(3) performance(2)
components  → renderer(17) core(14) interaction(7) runtime(2) animation(1)
debug       → renderer(5) runtime(3) shaders(1)
```

文档声明的方向（docs/architecture.md「模块」）：`runtime / components → interaction → renderer → core`。实际有三处不一致：

1. **renderer ↔ webgl2 双向**：`renderer/stage.ts:53` import `webgl2/renderer.ts`，而 `webgl2/renderer.ts` 又从 `renderer/`
   引 8 个模块（backend、blur、atlas、fills、layers、idle、resources、panels）。WebGPU 后端则直接住在 `renderer/gpu.ts`。
   后端没有独立成包或独立成层。
2. **interaction → runtime**：`interaction/morph.ts:30` 引 `runtime/binding.ts`（为了从 `GlassBinding` 取两头的材质）。
3. **renderer → animation**：`stage.ts:42` 调 `flushFrame`（这是有意的：stage 的帧循环负责冲时间轴），但让 animation 处在
   renderer 之下，与「animation 是上层」的目标图相反。

没有发现模块级的循环 import 导致的初始化问题（测试与 SSR 测试都在 Node 里 import 全部入口）。

---

## 3. Existing Features（按任务书的条目逐项核对实际代码）

| 任务书条目 | 实际状态 | 证据 |
|---|---|---|
| WebGPU → WebGL2 → CSS 自动阶梯、可显式指定 | **有** | `createGlassStage({ backend: 'auto' \| 'webgpu' \| 'webgl2' })`，`stage.ts:637–658`；设备丢失：同后端重建一次，再丢降一级（`stage.ts:1062–1079`） |
| 上层不判断后端 | **基本是** | 后端判断集中在 `stage.ts`；runtime / 组件只看 `data-glassium-active` 与 `capabilities` |
| 统一 Renderer 接口 | **有，但只覆盖 GPU 两家** | `renderer/backend.ts:174` `interface Renderer { kind: 'webgpu' \| 'webgl2'; resize; render(FrameInput); destroy; trim? }`；CSS 不是它的实现 |
| Scene Graph | **没有独立对象**（有意） | 层、Z 序从 DOM 与层叠上下文读（`layers.ts`、`layering.ts`）；只读快照 `stage.debug.scene()` → `SceneSnapshot`；docs/architecture.md「0.6」写明「可变的场景图对象：1.0 定下来不做」 |
| Layer System：z-index、层叠上下文、transform、opacity、overflow、圆角、裁剪、滚动 | **有** | `clipping.ts`（613，按包含块链求裁剪祖先、圆角、椭圆角）、`clip-path.ts`、`mask.ts`、`pose.ts`（旋转 / 缩放）、`layers.ts`（嵌套玻璃按层画）、每帧测量天然跟随滚动 |
| DOM Renderer：div / span / p / img / canvas / video | **有，而且更多** | `renderer/paint-content.ts`（630）：背景色、图片、`<canvas>`、`<video>`（`object-fit`，`requestVideoFrameCallback` 只在新帧时作废）、内联 SVG、文字（Range 量位置）、边框、文字装饰；`runtime/content.ts` 负责找块、增量作废、滞回释放 |
| 视频 → 玻璃实时折射 / 模糊 / 色散 | **有** | 两条路：`stage.setScene(video)`（`scene-source.ts`，整屏场景）与内容进场景（位图填充，按帧作废） |
| Material 抽象：Glass / Solid / Image / Video / Custom | **部分** | `GlassMaterial` 是声明式的普通对象（14 项）+ 5 个预设；Solid / 渐变 / 位图是「填充」的三种 paint（`fills.ts`）；图片 / 视频 / 画布是「场景源」或「内容块」。**没有统一的 Material 类型层级，也没有 Custom（自定义着色器）** |
| GlassMaterial 参数：blur、refraction、dispersion、distortion、opacity、saturation | **有** | `core/material.ts` |
| fresnel、brightness | **没有同名参数** | 边缘的 `highlight`（双面亮边，`rimLight`）承担了菲涅尔式亮边；亮度靠 `tint` 与 `bodyLight` 间接控制 |
| Render Pass 拆分（Blur / Distortion / Refraction / Dispersion / Glass / Composite） | **按「场景 / 填充 / 模糊链 / 背景 / 玻璃 / 组 / 层」分 pass**；折射、色散、亮边在同一个片元着色器里 | 这是有意的：调色与模糊可交换、模糊链共享，是整个设计的承重墙（spec/pipeline.md）；把折射、色散拆成独立全屏 pass 会多出 N 倍带宽 |
| Render Graph | **没有** | pass 顺序在两个后端里各手写一遍 |
| Interaction State（pointer、hover、pressed、dragging、velocity、scroll） | **有，分散在几个模块** | `interaction/press.ts`（hover / press / focus 的能量）、`element-motion.ts`（速度 → 果冻、跳变 → 飞行，滚动不算）、组件里的 `segments.ts`（拖动）；**没有 pressure** |
| 统一 Animation Runtime：Tween / Spring / Decay / Gesture / Timeline | **只有调度层统一** | `animation/timeline.ts` 统一 rAF 与减少动效；缓动各自实现（`motion.ts` 的指数趋近、jelly 的弹簧、glide 的缓动、CSS 过渡）；**没有 `animate(glass, {...})` 这样的公共入口** |
| Dirty State | **有，三级** | 整帧（`idle.ts unchangedFrame`）、场景（`sceneReusable`）、层改过的那一块（备份 + 局部复原）；材质降级按尺寸缓存；图集按格子版本局部上传 |
| Texture Pool / Resource Lifecycle | **部分** | 目标与管线缓存在各后端里各自实现；`renderer/resources.ts` 记账（`stats().gpuMemory`）；`setMemoryBudget` + 空闲驱逐（600 帧）；**没有跨后端统一的 acquire / release 池** |
| Benchmark、视觉回归、兼容矩阵 | **有** | `playground/bench.html`（docs/benchmark.md）、`playground/regress.html` + `spec/golden/baselines.json`、docs/compatibility.md |
| TypeScript strict | **有，且更严** | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` |
| 多浏览器实测 | **只有一格** | 仅 Windows + NVIDIA + Chromium 实测；Firefox / Safari / 移动端是「推断」（docs/compatibility.md） |

---

## 4. Missing Architecture（相对任务书）

1. **一等公民的 Scene Graph 对象**：没有持久的节点树（parent / children / world bounds / dirty flags）。每帧从 DOM 重新量出扁平列表。
2. **Render Graph**：没有 pass / 资源 / 依赖的声明式描述；跳过、复用、缓存靠手写的条件（`sceneReusable`、`crispFills`、层的备份）。
3. **CSS 后端作为 `Renderer` 的一个实现**：CSS 兜底散在 stage（`'none'`）、`core/overlay.ts`、`runtime/styles.ts`、`glassium.css`、各组件的兜底样式里。
4. **统一的 Material 类型层级**与 Custom Material（自定义着色器的扩展点）。
5. **公共动画入口**（`animate()`、Spring / Decay 原语）；pressure 输入。
6. **跨后端的资源池**（acquire / release / destroy 的统一生命周期）。
7. **Firefox / Safari / 移动端的实测**（不是代码问题，是设备问题）。

---

## 5. Technical Debt

按危险程度排序：

1. **两个后端各手写一遍整帧的 pass 序列**（`gpu.ts` 1 434 行、`webgl2/renderer.ts` 1 129 行）。场景、第 0 层填充、
   模糊链、背景、按画布分辨率的填充、玻璃、组、逐层、场景沿用与层备份 —— 每加一个 pass 或改一处顺序都要在两边同步改，
   靠 verify.html 的跨后端整帧比对兜底（CI 没有 GPU，跑不到）。**这是最大的技术债**，也是任务书「Render Graph」真正能解决的问题。
2. **`stage.ts`（1 638 行）是上帝对象**：画布、帧循环、后端阶梯与设备丢失、系统设置监听（减少动效、强制配色、减少透明度、对比度）、
   调试接口、回读与探针、质量与显存预算、场景源都在一个闭包里。
3. **`panels.ts`（1 389 行）一身三职**：注册表、几何测量（与 clipping / mask / pose 交织）、uniform 打包（含两种结构体的字节布局）。
   测量结果（`MeasuredPanel` / `MeasuredFill`）事实上就是「每帧重建的场景表示」，但没有被命名、没有类型边界。
4. **uniform 字节布局的手写同步**：`Panel` 结构体 432 B、`Fill` 544 B，TS 打包、WGSL、GLSL 三处按偏移对齐；有解析 WGSL 结构体的测试
   兜住 TS ↔ WGSL，GLSL 的 std140 对齐靠约定。
5. **渲染层的像素路径 CI 覆盖不到**：Node 测试覆盖纯函数、打包、测量逻辑（356 个）；GPU 输出只在本机浏览器里由 verify / regress 验。
   `webgl2/`、`webgpu/`、`debug/` 没有单元测试。
6. **目录分层与文档不符**（第 2 节的三处）。
7. **交互状态散落**：按压能量、元素运动、分段拖动、旋钮补间分别实现，没有一个 Interaction State 结构。

## 6. Risks

| 风险 | 说明 | 缓解 |
|---|---|---|
| 破坏 1.0 承诺 | 任务书的很多条目（重组 `src/core/scene` 等目录、拆包、改 API 形状）若照做会改公开导出或 HTML 接口 | 一切新抽象先作**内部**实现、不进 `stable.txt`；改公开接口只能放 2.0 |
| 两个真源 | 引入可变的场景图对象后，DOM 与场景图谁说了算？docs 已因此否决过一次 | 场景图只做**每帧从 DOM 派生的只读中间表示**（见第 7 节），不允许外部改 |
| 性能回退 | 现在 100 块卡片主线程 ≈ 0.6 ms（docs/benchmark.md）；多一层对象树、多一层 pass 调度都可能变慢 | 每一步对照 bench 的 12 个场景，回退超过 10% 不合入 |
| 拆 pass 的带宽 | 把折射 / 色散 / 亮边拆成独立全屏 pass，带宽 ×N，且破坏「共享模糊链」的等价 | Render Graph 描述现有粒度的 pass，不拆着色器 |
| 验证只在一台机器 | 改后端结构后，跨后端一致性只能本机 verify 证明 | 每步跑 verify（两后端 × 两视口）+ regress |

---

## 7. Recommended Architecture

原则：**不推翻已经被验证过的设计**（DOM 唯一真源、共享模糊链、两后端同一份 uniform 字节、WGSL 唯一真源），
把任务书要的抽象落在**已经存在、但没有被命名的边界**上。

```
DOM（唯一真源）
  ↓  PanelRegistry.measure()  —— 现有
Scene（每帧派生的只读场景表示：节点 = 面板 / 组 / 填充，带层号、Z 序、世界矩形、裁剪、不透明度、脏标记）
  ↓  FrameSnapshot / idle.ts 的脏判断 —— 现有，改为基于 Scene
RenderGraph（与后端无关：pass 列表 + 资源 + 依赖 + 跳过条件；由 Scene 与上一帧的结果算出）
  ↓
Renderer 接口（现有 backend.ts）——  WebGPU 执行器 | WebGL2 执行器 | （CSS 兜底保持现状）
```

- **Scene**：不是新的真源，是把现在的 `MeasuredPanel / MeasuredGroup / MeasuredFill` + `layers.ts` 的分层结果收成一个有类型的
  `Scene`（节点有 `parent`、`children`、`layer`、`worldRect`、`clip`、`opacity`、`dirty`）。DOM 树决定结构；场景图不能被外部修改 ——
  这样满足任务书「Scene Graph 是 Renderer 的正式输入」，又不违背 1.0 时「不要两个真源」的决定。
- **RenderGraph**：后端无关的 pass 描述（`scene`、`fills`、`blur(levels)`、`backdrop`、`canvasFills`、`glass`、`groups`、`layer(i)`），
  每个 pass 声明读写的资源（场景目标、模糊链、画布、层来源 / 备份）与跳过条件（`sceneReusable`、`crispFills`）。两个后端只实现
  「怎么执行某一种 pass」，顺序、跳过、复用由图决定 —— 直接消掉技术债 1。
- **不重组目录、不拆包**（1.x 内）：新代码放 `src/renderer/scene.ts`、`src/renderer/graph.ts`；任务书的 `src/core/scene/`、
  `@glassium/*` 拆包留到 2.0 再按实际需要决定（docs 已决定 1.0 用子路径入口的折中方案）。
- **CSS**：保持现状。把它包装成 `Renderer` 实现没有收益（它不画像素、按元素逐个写样式），记为冲突（见 ARCHITECTURE_CONFLICT.md）。

## 8. Migration Plan

任务书要求「从当前版本到 1.0.0 的最小迁移方案」。**当前已是 1.0.0**，所以这里给的是「1.0.0 → 任务书目标架构」的最小路径，
每一步都是 1.x 的小版本、公开 API 不变、`typecheck` / `build` / `test` 必过、verify 两后端 × 两视口全过、bench 不回退：

| 步 | 内容 | 产出 | 不碰 |
|---|---|---|---|
| **1（第一步）** | **把测量结果收成有类型的 `Scene`**：`PanelRegistry.measure()` 返回 `Scene`（节点树 + 层 + 脏标记）而不是三个扁平数组；`FrameInput` 携带 `Scene`；`idle.ts`、`layers.ts`、`stage.debug.scene()` 改为读它 | `src/renderer/scene.ts` + 单元测试（父子、层号、世界矩形、脏标记、与旧扁平列表逐项等价） | 后端的绘制代码（只换输入的取法）、公开 API |
| 2 | **Render Graph（描述层）**：从 `Scene` + 上一帧状态算出 pass 列表与跳过条件；后端仍按自己的代码画，但先断言「我画的 pass 序列 = 图的序列」 | `src/renderer/graph.ts` + 测试（各种场景下的 pass 序列、跳过与复用） | 着色器 |
| 3 | **两个后端改为执行图**：每种 pass 一个执行函数，顺序由图给；删掉两边重复的编排代码 | gpu.ts / webgl2 各自变短；verify 跨后端整帧比对证明逐位相同 | 着色器、uniform 布局 |
| 4 | 拆 `stage.ts`：帧循环、后端阶梯、系统设置、调试接口各成模块 | 纯重构，像素逐位相同 | 公开 API |
| 5 | 资源池（acquire / release）统一两后端的目标与纹理生命周期 | `resources.ts` 从记账扩成池 | — |
| 6 | 交互状态收成一个结构；公共 `animate()`（进阶接口，不进稳定承诺） | | 现有稳定接口 |
| 2.0 | 公开 `Scene` / `RenderGraph`（若届时证明有外部需求）、Material 类型层级与 Custom Material、按需拆包、拿掉已废弃的 `glass(preset, overrides)` | | |

每步之前先读相关代码；与本计划冲突的地方先记进 ARCHITECTURE_CONFLICT.md 再动手。
