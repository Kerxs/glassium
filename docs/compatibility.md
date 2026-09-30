# 兼容性

Glassium 在任何浏览器里都不会让页面坏掉：能力不够时一级一级往下退，最后是普通的 DOM。这一页写清楚**每一级是什么**、
**哪些格子实测过**、**在一台新设备上怎么验**。

## 四级

| tier | 后端 | 玻璃是什么样 | 什么时候落到这一级 |
|---|---|---|---|
| 3 | WebGPU | 完整的 GPU 玻璃：折射、色散、亮边、融合、层、内容进场景 | `navigator.gpu` 有、`requestAdapter` / `requestDevice` 成功 |
| 2 | WebGL2 | 同一套光学（GLSL 由 WGSL 机械生成），画出来与 WebGPU 逐像素对得上 | 没有 WebGPU，或者 WebGPU 初始化失败、设备丢失后重建失败 |
| 1 | CSS | `backdrop-filter` 的模糊 + tint + 亮边与投影的 box-shadow 近似，没有折射 | 没有 GPU 后端；强制配色（高对比度）；在顶层（模态对话框、popover、全屏）里的玻璃 |
| 0 | 普通 DOM | 元素照常显示，没有玻璃 | 浏览器不支持 `backdrop-filter`（很老的浏览器） |

`glassium.capabilities.tier` 给出当前这一级（按能力定，不看设备型号），`renderer` 是实际用上的后端。
每一级里内容、焦点、键盘、读屏都是元素自己的 —— 退级只影响外观。

## 实测过的格子

只有一台机器：Windows 11，NVIDIA RTX 4070 Laptop，Chromium（Claude 桌面端内置的浏览器，与 Chrome 同一内核）。

| 浏览器 × 平台 | tier 3 WebGPU | tier 2 WebGL2 | tier 1 CSS | tier 0 DOM |
|---|---|---|---|---|
| Chromium × Windows（独显） | ✅ verify.html 全过、regress.html 9/9、bench | ✅ 同上（`?glassium.backend=webgl2`） | ✅ verify 的 overlay 一项（顶层里的玻璃走 CSS）、调试台的强制配色模拟 | ⚠️ 没有自动化（Chromium 都支持 backdrop-filter，落不到这一级） |

两个后端各跑两种视口（1280×720、820×1200），DPR 1 与 1.5 都遇到过。已知的例外：WebGL2 在这台机器、DPR 1、1280×720
时有一个像素偶发差 1 级（limitations.md「WebGL2 在个别机器、个别分辨率上帧与帧之间差 1 级」）。

## 没实测的格子（按各平台公布的能力推断）

下面是**推断**，不是实测结论：按各浏览器公布的 WebGPU / WebGL2 / backdrop-filter 支持情况，Glassium 应该落到哪一级。
有设备的话请按下一节跑一遍、把结果补进这张表。

| 浏览器 × 平台 | 预计的 tier | 依据 |
|---|---|---|
| Chrome / Edge × macOS、ChromeOS | 3 | Chrome 113 起桌面默认开 WebGPU |
| Chrome / Edge × Linux | 2（WebGPU 受 GPU 门禁时） | Linux 上 WebGPU 的默认开启随驱动与版本变化；WebGL2 普遍可用 |
| Chrome × Android | 3 或 2 | Chrome 121 起 Android 12+、部分 GPU 默认开 WebGPU，其余走 WebGL2 |
| Safari × macOS、iOS / iPadOS | 3（Safari 26 起）或 2 | Safari 26 默认开 WebGPU；更早的版本走 WebGL2 |
| Firefox × Windows | 3（141 起）或 2 | Firefox 141 在 Windows 上默认开 WebGPU |
| Firefox × macOS、Linux、Android | 2（或 3，以 Mozilla 公布为准） | WebGPU 在这些平台上陆续开启；WebGL2 普遍可用 |
| 很老的浏览器（没有 backdrop-filter） | 0 | 页面照常，玻璃没有 |

移动端要特别留意的不是能不能跑，而是**贵不贵**：DPR 3 的手机画布是桌面的好几倍，模糊链与画布像素数成正比。
自适应质量会降（先降色散、局部先降贵的那几块），像素预算（默认 130 万）会压场景分辨率 —— 但这些都没在真机上量过。

## 在一台新设备上怎么验

打开线上的几页（或者 `npm run dev` 之后打开本地的），读标题栏：

1. `/verify.html` 与 `/verify.html?glassium.backend=webgl2` —— 标题栏 `PASS n/n`。失败的那一项下面写着实测的数。
   这一页假定视口至少 820×720；面板被隐藏（后台标签页）时 rAF 不跑，放在前台跑。
2. `/regress.html` 与 `/regress.html?backend=webgl2` —— 视觉回归（见 spec/golden/README.md）。新设备上是
   `NO BASELINE`：点「记为基准」，把 JSON 贴进 `spec/golden/baselines.json`，以后在这台设备上跑就有对照了。
   换一种 GPU 就是另一份基准 —— 不同驱动的像素本来就不同，不跨设备比。
3. `/bench.html` —— 这台设备的帧开销、GPU 时间、显存，「复制 JSON」贴进 docs/benchmark.md。
4. `/#overview`（站点的「概览」标签）—— 零配置的页面：看 `tier`、`renderer`，拖一拖「动起来的玻璃」那一节，打开调试面板看质量与显存。

没有 WebGPU 的浏览器里 1、2 的 WebGPU 那一遍会直接落到 WebGL2（标题栏的第一项 `backend` 写着实际的后端）。
