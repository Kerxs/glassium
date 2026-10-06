# Glassium 1.0 → 2.0 路线（交接给新会话）

> 新会话的第一件事：读完这一页，再读 [ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md) 与 [ARCHITECTURE_CONFLICT.md](ARCHITECTURE_CONFLICT.md)。
> 一次只做**一步**，做完停下汇报，等用户确认再做下一步。

## 0. 背景与现状

- 仓库：`D:\Claude Project\glassium`，GitHub `Kerxs/glassium`，分支 `main`。npm 包 `glassium`。
- 审计基线是 1.0.0 的提交 `de2fb9c`（356 个测试）。**进度（2026-10-06）**：第 1 步做完（`e214c22`，364 个测试），随 **1.0.1** 发布
  （标签 `v1.0.1` → `b1bbeb9`，同时带了滚动卡顿与验证页的修复）；第 2 步还没开始。
- 1.0 已写兼容承诺（CHANGELOG「1.0.0」）：`spec/api/stable.txt`（146 个稳定导出）、`spec/api/attributes.txt`（51 项 HTML 接口）、
  `stats()` 已有字段、`glassium.css` 兜底表面 —— 由 `src/api-stability.test.ts`、`src/attributes-stability.test.ts` 核对。**2.0 之前不能破。**
- 已有文档：docs/architecture.md（架构、路线、设计决定）、docs/api.md、docs/limitations.md、docs/benchmark.md、docs/compatibility.md、
  spec/pipeline.md（共享模糊链的等价，设计的承重墙）。

## 1. 已定的调整（审计结论，用户若有异议以用户为准）

任务书原定「在 1.0.0 里完成场景图 / 渲染器 / 材质抽象并冻结 API」。因为 1.0.0 已发布并冻结，调整为：

1. 任务书的「1.0」内容作为 **1.x 的内部重构**：公开导出、HTML 属性、`stats()` 字段一个都不改；新抽象不进 `stable.txt`。
2. **场景图 = 每帧从 DOM 派生的只读结构**，作为渲染器的正式输入；不提供外部修改接口（避免 DOM 与场景图两个真源）。
3. **Render Graph 按现有 pass 粒度建**（场景、填充、模糊链、背景、按画布分辨率的填充、玻璃、合并组、层）；
   **不把折射 / 色散 / 扭曲拆成独立全屏 pass**、不拆着色器。
4. **CSS 不做成 Renderer 实现**，保持「降级表面」。
5. **不重组目录、不拆包**：新代码放 `src/renderer/`；`src/core/` 保持「无 DOM、无 GPU 的纯函数」。拆包等到 2.0 再按需决定。

## 2. 每一步的通用验收

每一步都必须满足，缺一不算完成：

- `npm run typecheck`、`npm test`、`npm run build`、`npm run build:lib`、`node scripts/check-pack.ts` 全过。
- 新代码有单元测试；纯重构要有「新旧结果逐项相等」的测试。
- 浏览器里：`playground/verify.html` 在 **WebGPU 与 WebGL2（`?glassium.backend=webgl2`）× 1280×720 与 820×1200** 全 PASS；
  `playground/regress.html` 全过；`playground/bench.html` 主线程时间不比 docs/benchmark.md 回退超过 10%。
- 动到渲染路径时：至少一次**反向对照**（故意改坏 → 确认验证失败 → 用 `cp` + `cmp` 恢复，不用 `git checkout`）。
- 文档同步：docs/architecture.md 的对应段落、CHANGELOG「未发布」。
- 提交信息用中文：`glassium:描述` 或 `修复:描述`，末尾加 `Co-Authored-By` 行。推送、发版只在用户同意后做；`npm publish` 由用户本人执行。

## 3. 路线

### 第 1 步（1.1）：只读 Scene —— 测量结果收成有类型的场景（已完成，`e214c22`，随 1.0.1 发布）
- **做什么**：`PanelRegistry.measure()`（`src/renderer/panels.ts`）现在返回三个扁平数组（`MeasuredPanel[]` / `MeasuredGroup[]` / `MeasuredFill[]`），
  层号在 `layers.ts` 里另算。新增 `src/renderer/scene.ts`：`Scene { nodes, layers, roots }`，节点 = 面板 / 合并组 / 填充，字段含
  `parent`、`children`、`layer`、`order`（Z 序）、`worldRect`、`clip`、`opacity`、`visible`、`dirty`（transform / material / content / layout 四类）。
  `FrameInput` 携带 `scene`；`idle.ts`、`layers.ts`、`stage.debug.scene()`（`SceneSnapshot`）改为从它读。
- **不碰**：后端的绘制代码（为兼容可以暂时保留三个扁平数组作为 `scene` 的视图）、着色器、公开 API。
- **验收**：与旧扁平列表逐项等价的测试；父子 / 层号 / Z 序 / 脏标记的测试；通用验收全过。

### 第 2 步（1.2）：Render Graph 描述层
- **做什么**：新增 `src/renderer/graph.ts`：由 `Scene` + 上一帧状态算出 pass 列表（种类、读写的资源：场景目标、模糊链各级、画布、层来源 / 备份；
  跳过条件：`sceneReusable`、`crispFills`、层的局部复原）。后端仍用现有代码画，但加断言 / 测试：实际执行的 pass 序列 = 图给出的序列。
- **验收**：覆盖「无填充 / 有填充 / 只动玻璃（场景沿用）/ 嵌套层 / 合并组 / 视频场景」各情形的 pass 序列测试。

### 第 3 步（1.3）：两个后端改为按图执行（消掉最大的技术债）
- **做什么**：`src/renderer/gpu.ts`（1434 行）与 `src/webgl2/renderer.ts`（1129 行）各自把整帧编排拆成「每种 pass 一个执行函数」，
  顺序、跳过、复用由图决定；删掉两边重复的编排代码。顺手修 renderer ↔ webgl2 的双向依赖（后端只依赖 backend 接口与 graph）。
- **不碰**：着色器、uniform 字节布局（Panel 432B、Fill 544B）。
- **验收**：verify 的跨后端整帧比对与 deterministic、scene-reuse 各项逐位通过；draw 数、模糊趟数与改前相同（`stats()`）。

### 第 4 步（1.4）：拆 `stage.ts`（1638 行）
- 帧循环、后端阶梯与设备丢失、系统设置监听（减少动效 / 强制配色 / 减少透明度 / 对比度）、调试接口、回读与探针、质量与显存预算各成模块。
  纯重构，像素逐位相同，公开 API 不变。

### 第 5 步（1.5）：统一资源生命周期
- `src/renderer/resources.ts` 从记账扩成池：`create / acquire / release / destroy`，两个后端的渲染目标、层来源 / 备份、图集纹理都走它；
  `setMemoryBudget` 与空闲驱逐改为基于池。验收：资源泄漏测试（反复建删 stage / 面板后计数归零）、显存账不变或更少。

### 第 6 步（1.6）：交互状态与动画入口
- 把按压能量（`interaction/press.ts`、`components/thumb.ts` 的 PressTween）、元素运动（`element-motion.ts`）、分段拖动（`components/segments.ts`）
  收成一个 `InteractionState`（pointer、hover、pressed、dragging、velocity、scroll；有就带上 pressure）。
- 新增**进阶**（不进稳定承诺）的 `animate(target, { material…, duration, easing: 'spring' | … })`，建在 `animation/timeline.ts` 上；
  Spring / Decay 原语从 jelly / glide 里抽出来复用。修 `interaction/morph.ts` → `runtime/binding.ts` 的反向依赖。

### 第 7 步（1.7）：材质类型
- 在不改 `GlassMaterial` 现有形状的前提下，内部引入判别联合：Glass / Solid / Gradient / Bitmap（图片、画布、视频、DOM 内容）。
  是否加 fresnel、brightness 两个参数：先评估与现有 `highlight`、`tint`、`bodyLight` 的关系，确有缺口再加（加的话是新增，不破兼容）。
  Custom Material（自定义着色器）只做设计，不实现。

### 第 8 步（1.8 / 2.0 Beta）：冻结与评估
- 评估是否公开 `Scene` / `RenderGraph`（有外部需求才公开）、是否拆包（`@glassium/core`、`@glassium/components`…）—— 写成决定文档，交用户定。
- 兼容性实测：有设备时按 docs/compatibility.md 的步骤在 Firefox / Safari / iOS / Android 上跑 verify 与 regress，把「推断」的格子改成实测。

### 2.0.0
- 落实第 8 步的决定；拿掉已废弃的 `glass(preset, overrides)`；更新兼容承诺与 `spec/api/*`。

## 4. 已知的坑（新会话直接照做）

- **WebGL2 的 verify 偶发差一个像素 1 级**（deterministic、local-quality）：已查清是驱动噪声（同一份调用流画出两种结果），
  verify 里已容许至多 2 个像素差 1 级（`WEBGL2_NOISE_PIXELS`）。别再追；差 2 级以上或像素更多才是真问题。
- **浏览器面板不可用时**：用 `D:\Claude Project\.claude\tools\edge-cdp.mjs`（无头 Edge + CDP，走真 GPU）跑 verify / regress / bench；
  注意那里 rAF 是真在跑的，依赖「没人插帧」的检查会暴露竞态。

- **浏览器面板隐藏时 `requestAnimationFrame` 不触发**：验证时用 `resize_window` 固定视口；先把 `window.requestAnimationFrame` 换成
  `setTimeout(cb, 16)` 的替身再触发交互；截图在窗口隐藏时会超时 —— 用 `stage.debug.readback()` 回读画布、存 PNG 再看。
- **Windows 上 `node --test <目录>` 会失败**，用裸 `npm test`（即 `node --test`）。
- **Bash heredoc 会把 `\\` 压成 `\`**：含反斜杠或复杂引号的改动，用 Write 写一个 Python 脚本到 scratchpad 再执行。
- **WebGL2 着色器里不要除以 uniform**（本机 NVIDIA + ANGLE 帧间差 1 ulp）：倒数在 CPU 上算好再乘。
- 改了 `src/shaders/optics.wgsl.ts` 要跑 `npm run gen:glsl`；改了光学函数要跑 `npm run gen:conformance`，生成物一起提交。
- git 身份是仓库级配置（无全局值）。
- 可能有别的会话同时在改这个仓库：开工前 `git log` / `git status` 看一眼；冲突时用 worktree 隔离、`git apply --cached` 只提交自己的改动。
- 开发服务器：`D:\Claude Project\.claude\launch.json` 里的 `glassium-playground`（端口 5174）。
