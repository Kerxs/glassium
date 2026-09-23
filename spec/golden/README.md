# Golden 图像：为什么这里是空的

这个目录现在没有 golden 图像。这是判断，不是遗漏。

## 为什么没有

GitHub `ubuntu-latest` runner **没有 GPU**。要在 CI 里跑 golden-image 比对，只能走
Dawn/SwiftShader 的软件 WebGPU，而软件光栅化与真实驱动（开发机是 Edge 153 的 D3D12 路径）
的像素差距大到**任何阈值都失去意义**：定宽松了抓不到真实回归，定严了每次 runner 镜像更新
都红。一个两头不是的门禁比没有门禁更坏 —— 它会让人习惯性地忽略红灯。

其次是工装本身：本机没有 Rust、没有 CMake，构建或校验这样一套 harness 的前提条件不具备。

## 那么像素靠什么验证

**在浏览器里手工跑。** 现在的手段是 `stage.debug.probeOptics(i)`：把面板的光学中间量
（sd、方向、位移）渲到 `rgba32float`，`copyTextureToBuffer` + `mapAsync` 回读，再用
`compareOptics()` 与 `src/core/optics.ts` 的 CPU 实现逐像素比对。颜色层面另有
`readback()` + `joinProbeAndColors()`，按扇区统计高光与色散。这是唯一能证明 WGSL 与 TS
没有漂移的手段，而且它比截图比对**更强** —— 它比的是数值，不是渲染出来的样子。

标签页或面板被隐藏时浏览器不跑 rAF，回读会一直等下去（`document.visibilityState` 不一定
报 hidden，从页面里看不出来）。在 `readback()` / `probeOptics()` 之后调一次
`stage.debug.renderNow()`，请求就在同步出的这一帧里被服务。

判据是 T7 实测之后定的：**零个非有限值、采样偏移 p99 在 1e-4 像素以下、最大误差只出现在
|sd| < 0.01 处**。原先写的「1e-5 绝对误差」在面板边界上做不到也不该要求 —— circleMap 在那里
斜率发散，f32 的舍入会被放大（见 docs/calibration.md）。

两个后端之间也是这么比的：同一页面里先回读 WebGPU 的整帧，dispose 之后用
`createGlassStage({ backend: 'webgl2' })` 重建、给同样的参数再回读，逐像素比。T11 实测
96.6 万个像素里只有 1 个差 1/255（见 docs/calibration.md）。

这套手工步骤已经固化成 `playground/verify.html`（T12），两个后端各跑一遍：

```
/verify.html                           → 标题栏 PASS 14/14
/verify.html?glassium.backend=webgl2   → 标题栏 PASS 13/13（跨后端那项跳过）
```

每一项的判据与实测数字见 docs/calibration.md 的「verify.html」一节。
两个后端之间的光学差异超过判据，就是 WGSL→GLSL 重写器错了 —— 套件里没有别的东西能抓到这个。

## CI 实际覆盖什么

`npm run typecheck` + `npm test` + GLSL 重生成同一性。也就是：**数学是对的、类型是对的、
签入的 GLSL 和真源没漂**。

**绿色徽章不等于像素已验证。** 不把这句话写出来，一个绿勾就会被读成它没有承诺过的东西。

## 将来要补什么

如果哪天要补 golden，正确的形态不是截图比对，而是：

1. 把 `verify.html` 的浮点回读结果序列化成数值 fixture，签入这里
2. 在有真实 GPU 的自托管 runner 上跑，或
3. 接受软件光栅化，但只对**几何量**（SDF 值、梯度方向）设门禁，不对最终合成像素设门禁 ——
   几何量在软件与硬件路径上是一致的，颜色不是

第 3 条是成本最低的，真要做就从它开始。

与此相关的、与语言无关的数值向量在 [`../conformance/`](../conformance/)，
未来的 Android / iOS 渲染器消费同一份。
