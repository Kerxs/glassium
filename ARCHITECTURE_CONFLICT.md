# 架构冲突记录

按任务书「规则 7」：现有实现与计划冲突时，先记录、不强行套用。审计见 [ARCHITECTURE_AUDIT.md](ARCHITECTURE_AUDIT.md)。

## 1. 版本：任务书的「1.0.0」已经发布

- **当前实现**：`package.json` 1.0.0（2026-09-30）；CHANGELOG 写了兼容承诺（2.0 之前不破）：`spec/api/stable.txt` 的稳定导出、
  `spec/api/attributes.txt` 的 HTML 接口、`stats()` 字段、`glassium.css` 兜底表面，均有测试核对。
- **计划方案**：在 1.0.0 里完成 Scene Graph、Renderer / Material / Backend 抽象、目录重组，然后冻结 API。
- **冲突原因**：1.0 的 API 已冻结；任务书的 1.0 内容若改公开接口，就是破坏承诺。
- **推荐**：任务书的「1.0」内容作为 **1.x 的内部重构**做（公开 API 不变），任何公开形状的变化放 2.0。

## 2. 可变的 Scene Graph 对象

- **当前实现**：DOM 是唯一真源，每帧量出扁平的面板 / 组 / 填充；层与 Z 序从元素树与层叠上下文读（`layers.ts`）；只读快照
  `stage.debug.scene()`。docs/architecture.md「0.6」明确「可变的场景图对象：1.0 定下来不做 —— 再给一份可以改的对象就有了两个真源」。
- **计划方案**：一等公民的 Scene Graph，Node 有 parent / children / transform / bounds / opacity / visibility / clipping / z-order / dirty。
- **冲突原因**：若场景图可被外部修改，DOM 与场景图会互相打架（谁的位置、谁的 z-order 说了算）。
- **推荐**：做**每帧从 DOM 派生的只读场景图**，作为 Renderer 的正式输入（满足「正式输入」「不是简单包装」），不暴露修改接口。

## 3. 拆成独立的 Distortion / Refraction / Dispersion Pass

- **当前实现**：折射、色散、亮边、体光在一个片元着色器里；pass 按「场景 / 填充 / 共享模糊链 / 背景 / 玻璃 / 组 / 层」划分。
  共享模糊链成立的前提是调色与模糊可交换（spec/pipeline.md，整个设计的承重墙）。
- **计划方案**：BackgroundPass → ContentPass → BlurPass → DistortionPass → RefractionPass → DispersionPass → GlassPass → CompositePass。
- **冲突原因**：折射、色散是同一次采样的不同偏移，拆成全屏 pass 要多出几个中间目标、几倍带宽，且没有画质收益。
- **推荐**：Render Graph 按现有粒度建（场景、填充、模糊、背景、玻璃、组、层），着色器不拆。

## 4. CSS 作为 Renderer 的一个实现

- **当前实现**：CSS 兜底 = stage 的 `backend: 'none'` + `core/overlay.ts` 的 CSS 玻璃 + `runtime/styles.ts` + `glassium.css`；
  顶层（对话框 / popover）里的玻璃即使在 GPU 后端下也走 CSS。
- **计划方案**：`Renderer ├── WebGPURenderer ├── WebGL2Renderer └── CSSRenderer`。
- **冲突原因**：CSS 不画像素、按元素写样式，吃不了 `FrameInput`；而且它与 GPU 后端**同时**存在（顶层里的玻璃）。
- **推荐**：`createRenderer` 的自动选择与显式指定已经存在（`createGlassStage({ backend })`）；CSS 保持现状，在文档里把它定义为「降级表面」而非后端。

## 5. 目录重组（`src/core/scene`、`src/core/renderer`、`src/core/graph`）与拆包

- **当前实现**：`src/core/` 是「无 DOM、无 GPU 的纯函数」；渲染相关在 `src/renderer/`；1.0 选了「一个包 + `glassium/runtime` 子路径」的折中（docs/architecture.md）。
- **冲突原因**：任务书把 Renderer / RenderContext 放进 core，会让 core 依赖渲染概念；拆包需要版本对齐，现有决定刚做出。
- **推荐**：新代码放 `src/renderer/scene.ts`、`src/renderer/graph.ts`；拆包到 2.0 再按实际需要决定。
