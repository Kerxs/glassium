import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lowerMaterial } from './material.ts'
import {
  circleMap,
  gradRadiusOf,
  gradSdRoundedRect,
  radiusAt,
  refractionDirection,
  refractionProfile,
  sdRoundedRect,
  type Radii4,
  type Vec2
} from './optics.ts'

/**
 * 与上游 playground 的逐点对照（T12）。
 *
 * 上游没有 Web 演示（catalog 只有 Android 的 APK），本机也没有 JDK / Android SDK，跑不起
 * 上游的 playground。所以并列对比做在**数学**上：把上游折射着色器的 main() 原样转写成
 * TS（下面的 upstreamOffset），用上游 playground 的**真实配置**
 * （app/.../catalog/destinations/GlassPlaygroundContent.kt @ 65ab177）喂两边，逐像素比采样偏移。
 *
 * upstreamOffset 的几行照抄自上游 backdrop/.../internal/Shaders.kt 的
 * RoundedRectRefractionShaderString（Apache-2.0，Copyright 2025 Kyant），只为对照；
 * 它用到的 SDF 与梯度函数就是 optics.ts 里移植过来的那几个。
 */

const normalize = (v: Vec2): Vec2 => {
  const len = Math.hypot(v[0], v[1])
  return [v[0] / len, v[1] / len] // 上游直接 normalize，零向量得 NaN —— 照抄
}

/**
 * 上游：coord 是左上原点的原始坐标；radiusAt 传的就是它（四角塌缩成右下角的那个 bug）；
 * refractionAmount 在 Lens.kt 里已经取了负号。返回 refractedCoord − coord。
 */
function upstreamOffset(
  coord: Vec2,
  size: Vec2,
  cornerRadii: Radii4,
  refractionHeight: number,
  refractionAmountUniform: number,
  depthEffect: number
): Vec2 {
  const halfSize: Vec2 = [size[0] * 0.5, size[1] * 0.5]
  const centeredCoord: Vec2 = [coord[0] - halfSize[0], coord[1] - halfSize[1]] // offset = −padding = 0
  const radius = radiusAt(coord, cornerRadii)
  let sd = sdRoundedRect(centeredCoord, halfSize, radius)
  if (-sd >= refractionHeight) return [0, 0]
  sd = Math.min(sd, 0)
  const d = circleMap(1 - -sd / refractionHeight) * refractionAmountUniform
  const gradRadius = Math.min(radius * 1.5, Math.min(halfSize[0], halfSize[1]))
  const g = gradSdRoundedRect(centeredCoord, halfSize, gradRadius)
  const c = normalize(centeredCoord)
  const grad = normalize([g[0] + depthEffect * c[0], g[1] + depthEffect * c[1]])
  return [d * grad[0], d * grad[1]]
}

/** Glassium：sample = px − dir · displacement，所以偏移是 −dir · displacement。 */
function glassiumOffset(
  px: Vec2,
  size: Vec2,
  radii: Radii4,
  heightPx: number,
  amountPx: number,
  depthEffect: number
): Vec2 {
  const halfSize: Vec2 = [size[0] / 2, size[1] / 2]
  const centered: Vec2 = [px[0] - halfSize[0], px[1] - halfSize[1]]
  const radius = radiusAt(centered, radii)
  const sd = sdRoundedRect(centered, halfSize, radius)
  const dir = refractionDirection(centered, halfSize, gradRadiusOf(radius, halfSize), depthEffect)
  const disp = refractionProfile(sd, heightPx, amountPx, 2)
  return [-dir[0] * disp, -dir[1] * disp]
}

/** 在面板的每个像素中心上比两边的偏移，返回最大差与有偏移的像素数。 */
function compareField(
  size: Vec2,
  up: (coord: Vec2) => Vec2,
  ours: (px: Vec2) => Vec2
): { maxDiff: number; refracted: number } {
  let maxDiff = 0
  let refracted = 0
  for (let y = 0.5; y < size[1]; y += 1) {
    for (let x = 0.5; x < size[0]; x += 1) {
      const a = up([x, y])
      const b = ours([x, y])
      if (a[0] !== 0 || a[1] !== 0) refracted++
      maxDiff = Math.max(maxDiff, Math.hypot(a[0] - b[0], a[1] - b[1]))
    }
  }
  return { maxDiff, refracted }
}

test('上游 playground 的主玻璃（默认值）：采样偏移场逐点一致', () => {
  // GlassPlaygroundContent.kt：.size(256.dp)，RoundedRectangle(256.dp / 2 * cornerRadiusFrac)，
  // lens(refractionHeight = frac·minDim·0.5, refractionAmount = frac·minDim, depthEffect = true)，
  // 默认 cornerRadiusFrac = 0.5、refractionHeightFrac = refractionAmountFrac = 0.2。按 density 1 算。
  const size: Vec2 = [256, 256]
  const upRadius = (256 / 2) * 0.5
  const upHeight = 0.2 * 256 * 0.5
  const upAmount = 0.2 * 256

  // 同一组数经 Glassium 的材质立面降级：两条缩放规则照抄上游 playground，所以数应当相同
  const chain = lowerMaterial({ cornerRadius: '0.5frac', refraction: 0.2, distortion: 0.2, depthEffect: 1 }, size)
  const lens = chain.effects.find((e) => e.kind === 'lens')
  assert.ok(lens && lens.kind === 'lens')
  assert.deepEqual(chain.cornerRadiiDp, [upRadius, upRadius, upRadius, upRadius])
  assert.equal(lens.heightDp, upHeight)
  assert.equal(lens.amountDp, upAmount)

  const r = compareField(
    size,
    (c) => upstreamOffset(c, size, [upRadius, upRadius, upRadius, upRadius], upHeight, -upAmount, 1),
    (p) => glassiumOffset(p, size, chain.cornerRadiiDp, lens.heightDp, lens.amountDp, lens.depthEffect)
  )
  assert.ok(r.refracted > 10000, `折射带里该有上万个像素，实际 ${r.refracted}`)
  // 两边只差在 Math.pow(y, 0.5) 与 Math.sqrt(y) 这类末位舍入上
  assert.ok(r.maxDiff < 1e-9, `采样偏移最大差 ${r.maxDiff} px`)
})

test('上游 playground 的控件面板：lens(16dp, 32dp)、32dp 圆角、depthEffect 默认关', () => {
  const size: Vec2 = [320, 360] // 面板尺寸随内容变，取一个有代表性的
  const radii: Radii4 = [32, 32, 32, 32]
  const r = compareField(
    size,
    (c) => upstreamOffset(c, size, radii, 16, -32, 0),
    (p) => glassiumOffset(p, size, radii, 16, 32, 0)
  )
  assert.ok(r.refracted > 10000)
  assert.ok(r.maxDiff < 1e-9, `采样偏移最大差 ${r.maxDiff} px`)
})

test('四角半径不同时两边分道扬镳 —— 上游 radiusAt 的 bug 在这里才显形', () => {
  // 上游把原始坐标传给 radiusAt，四角都取到右下角（8）；Glassium 各角取各的
  const size: Vec2 = [256, 128]
  const radii: Radii4 = [4, 32, 8, 28]
  const r = compareField(
    size,
    (c) => upstreamOffset(c, size, radii, 16, -32, 1),
    (p) => glassiumOffset(p, size, radii, 16, 32, 1)
  )
  assert.ok(r.maxDiff > 5, `应当有明显差异，实际最大 ${r.maxDiff} px`)
})

test('饱和度：上游 vibrancy 的亮度权重与 Rec.709 只差在第四位小数，可以忽略', () => {
  // 上游 colorControlsColorFilter：R' = s·R + (1−s)·(0.213R + 0.715G + 0.072B)，vibrancy 取 s = 1.5
  // Glassium applyColorFilter：mix(luma709, rgb, s) —— 同一个形式，只是权重是 0.2126/0.7152/0.0722
  const s = 1.5
  let worst = 0
  const steps = 16
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      for (let k = 0; k <= steps; k++) {
        const c = [i / steps, j / steps, k / steps] as const
        const lu = 0.213 * c[0] + 0.715 * c[1] + 0.072 * c[2]
        const lg = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        for (const ch of c) {
          worst = Math.max(worst, Math.abs(s * ch + (1 - s) * lu - (s * ch + (1 - s) * lg)))
        }
      }
    }
  }
  assert.ok(worst * 255 < 0.1, `最大通道差 ${(worst * 255).toFixed(4)}/255`)
})
