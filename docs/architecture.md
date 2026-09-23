# 架构

一句话：**Glassium 自己持有一块画布，场景和玻璃都画在上面；玻璃折射的是 Glassium 的场景，
不是它背后的任意 DOM。** 为什么只能这样，见 [limitations.md](limitations.md) 的「为什么玻璃折射不了任意 DOM」。

## 三层宿主

```
L2  #glassium-overlay        z-index: 3      预留给玻璃盖在 DOM 之上（GlassDialog / GlassSheet），第一期为空
L1  DOM 内容                  照常排版         文字、命中测试、焦点、输入法、无障碍全归 DOM
L0  canvas[data-glassium-scene]  position: fixed; inset: 0; z-index: -1   场景与玻璃
```

- 面板是 DOM 元素，负责占位与内容；stage 每帧量它的矩形，在它正后方的画布上画玻璃。
  滚动、缩放、布局变化都自动跟上，不监听任何事件。
- 画布在 `z-index: -1`：画在根背景之上、所有常规流内容之下。T5 到 T9 期间是 0，理由写错了，
  已撤回（limitations.md「画布为什么在 z-index: -1」）。
- 面板和画布之间的每一层都必须背景透明（R1）。违反时 `src/renderer/layering.ts` 在控制台点名元素。

## 模块

```
src/core/          纯数学与数据，没有 DOM、没有 GPU，全部在 Node 里测
  optics.ts          光学的 CPU 参考实现（移植自上游，带 Apache 头）
  merge.ts           多块玻璃的 smin 合并
  pipeline.ts        有序效果管线与采样余量
  material.ts        声明式材质 → 有序管线；预设
  units.ts           dp / CSS px / 设备像素；分辨率策略
  scene.ts           用户场景怎么铺进视口（object-fit 的 uv 变换、预缩放尺寸、CSS 兜底）

src/shaders/       着色器源（字符串）
  optics.wgsl.ts     光学的 WGSL 唯一真源（带 Apache 头）
  generated/         由它机械生成的 GLSL ES 3.0，签入，CI 校验重生成同一性
  translate-glsl.ts  WGSL → GLSL 的 token 重写器：看不懂就抛
  scene / blur / glass / glass-group.wgsl.ts   入口与绑定，手写

src/renderer/      与后端无关的一层
  stage.ts           画布、帧循环、监听器、后端阶梯、设备丢失与降级
  backend.ts         渲染后端接口，一帧的输入输出
  gpu.ts             WebGPU 后端
  panels.ts          面板注册表、合并组、测量、uniform 打包
  blur.ts            模糊链（级数、σ ↔ 级别）
  layering.ts        面板与画布之间有什么：命中测试 + 点名警告
  clipping.ts        面板的裁剪祖先（按包含块链）与裁剪矩形
  scene-source.ts    用户场景：图片 / 视频 / 画布 → 每帧交给后端的场景图（缩放、上传时机、CSS 兜底）
  verify.ts          GPU 探针与 CPU 实现的逐像素比对工具

src/webgpu/        设备单例、能力探测、创建计数
src/webgl2/        WebGL2 后端与它的 GLSL 入口
src/components/    <glass-card> / <glass-button> / <glass-container>，glassium.css
```

依赖只往下走：components → renderer → core；shaders 只被后端引用。`src/core` 与 `src/shaders`
不碰任何浏览器全局，所以整个包在 Node 里 import 是安全的（SSR），有测试钉住。

## stage 与后端

stage 是**外壳**：画布、面板注册表、调试参数、帧循环、监听器 —— 与 GPU 无关，跨设备存活。
后端持有一台设备 / 一个上下文上的全部 GPU 资源，可以整体丢弃、整体重建。

```
启动：   WebGPU ──失败──▶ WebGL2 ──失败──▶ none（CSS 兜底底色 + 组件的兜底表面）
运行中：  某个后端第一次丢失 → 在同一后端上重建（面板与参数原样保留）
         第二次丢失       → 往下降一级；一块画布只能有一种上下文，所以换一块新画布
```

两个后端吃同一份 `FrameInput`、同一份 uniform 字节、同一套光学（GLSL 由 WGSL 机械生成），
本机实测整帧逐像素比对 96.6 万个像素只差 1 个、1/255。

## 一帧

```
测量  所有面板一次 getBoundingClientRect（帧内之后不再碰布局）
打包  Panel / Group → uniform（256B / 512B 步长）
场景  内置程序化场景，或用户的图片 / 视频 / 画布（按 object-fit 铺）→ 模糊链第 0 级
模糊  每级两趟，2 × (K − 1) 趟，与面板数无关（共享链）
上屏  背景
面板  每块一次 draw：全屏三角形 + 裁剪矩形，片元里用 SDF 算几何
组    每组一次 draw，与成员数无关
```

测量之后先比一次：这一帧的全部输入（视口、背景参数、场景、每块面板的矩形与降级结果……）与上一帧
相同，就不画 —— 浏览器继续显示上一帧（`src/renderer/idle.ts`）。静态页面因此没有持续的 GPU 开销；
测量照做，滚动与布局变化下一帧就能发现。

模糊链能共享，是因为调色（saturation / tint）是逐点仿射、与模糊可交换 —— 这条等价是整个设计的承重墙，
详见 [../spec/pipeline.md](../spec/pipeline.md)。

## 组件

- 属性 → 材质（`attributes.ts`）：写错的属性报一次并忽略，不让整块面板失效。
- 组件可以早于 stage upgrade：`createGlassStage()` 要等 GPU，组件先等着，stage 建好（或重建）时统一注册。
- 没有玻璃时（upgrade 前、没有 GPU、高对比度）组件显示 `glassium.css` 的兜底表面；
  玻璃生效时组件带上 `data-glassium-active`，表面去掉。
- `<glass-button>` 的反馈只改材质的数值（uniform），不建管线、不建 bind group —— 有计数器在设备上钉住。
- `<glass-container>` 按元素指定成员，每帧解析；成员照旧各自注册、各有材质。

## 验证

四层，由便宜到贵：

| 层 | 验什么 | 在哪 |
|---|---|---|
| CPU 单元测试 | 数学的性质（SDF 对暴力解、梯度的转向率恒等式、smin 的精确梯度、合并的逐位性质……） | `npm test`，CI |
| 符合性向量 | 238 条输入 / 输出，给将来的其它渲染器 | `spec/conformance/optics.json`，CI 校验重生成同一性 |
| GPU 探针 | 着色器与 CPU 实现逐像素一致：零个非有限值、采样偏移 p99 < 1e-4 px | `stage.debug.probeOptics()` / `probeGroup()` |
| verify.html | 上面一层加上颜色层面的性质、逐位等价、两个后端的整帧比对 | 浏览器里手工跑，标题栏读作 PASS n/n |

**CI 不覆盖像素**：GitHub 的 runner 没有 GPU，软件光栅化与真实驱动的差距大到任何阈值都没意义。
理由与将来要补什么见 [../spec/golden/README.md](../spec/golden/README.md)。

逐位等价的判据用 SHA-256 做 A/B，而且**只在同一页面、同一视口里比**：先渲染一种写法、回读，
就地换成另一种写法、再回读。跨会话比哈希不可靠 —— 视口尺寸、DPR 每次打开都可能不同，
测试场景本身在某些尺寸上也有取值不定的像素（calibration.md「verify.html」一节）。

## 约定借自哪里

工作区里的 meshora（MIT）：单 GPU 上下文、动态 import、`prefers-reduced-motion` 下彻底停循环、
像素预算与分辨率地板、着色器起不来时退回 CSS 而不是白屏、`z-index: -1` 的背景画布。
没有共享代码，不构成衍生作品。

光学数学移植自上游 AndroidLiquidGlass（Apache-2.0），逐条偏离见 [porting-notes.md](porting-notes.md)。
