/**
 * GPU 与 CPU 光学实现的逐像素比对。
 *
 * GPU 端没法单步调试，CPU 端可以。只要两者在每个像素上算出同样的数，GPU 上的任何
 * 视觉问题就都不是光学写错了 —— 这条比对把「查光学」这一大类嫌疑一次排除掉。
 *
 * ## 比什么
 *
 * 不直接比折射方向 dir，而是比**实际的采样偏移** dir × displacement。
 *
 * 面板内部深处有一条 cy = cx 的对角线，gradSdRoundedRect 在那里从 (1,0) 跳到 (0,1)。
 * f32 与 f64 在紧贴这条线的像素上会落到不同的一侧，dir 差出 90° —— 但那里早已在
 * 折射带之外，displacement 恰为 0，这个差异根本不影响渲染。直接比 dir 会把它报成错，
 * 比偏移则不会。偏移才是真正移动像素的那个量。
 */

import {
  gradRadiusOf,
  radiusAt,
  refractionDirection,
  refractionProfile,
  sdRoundedRect,
  type Radii4,
  type Vec2
} from '../core/optics.ts'

/** 探针回读：每个纹素 4 个 f32 = sd, dir.x, dir.y, displacement。 */
export interface OpticsProbe {
  readonly width: number
  readonly height: number
  /** 纹素 (0,0) 在画布上的设备像素原点。 */
  readonly origin: Vec2
  readonly data: Float32Array
  readonly panel: {
    readonly rect: readonly [number, number, number, number]
    readonly radii: Radii4
    readonly heightPx: number
    readonly amountPx: number
    readonly squircle: number
    readonly depthEffect: number
  }
}

export interface OpticsComparison {
  readonly texels: number
  /** GPU 输出里的非有限值个数。必须是 0 —— 一个 NaN 会经混合扩散，把整块面板抹掉。 */
  readonly gpuNonFinite: number
  readonly maxErr: {
    readonly sd: number
    readonly displacement: number
    /** 采样偏移 dir × displacement 的误差（像素）。这是真正决定画面的量。 */
    readonly offset: number
  }
  /** 偏移误差的第 99 百分位 —— 用来区分「普遍的精度差」与「个别点的放大」。 */
  readonly p99OffsetErr: number
  /** 偏移误差最大的那个像素处的 sd，用来判断它是不是落在边界上。 */
  readonly worstOffsetAtSd: number
}

export function compareOptics(probe: OpticsProbe): OpticsComparison {
  const { width, height, origin, data, panel } = probe
  const [rx, ry, rw, rh] = panel.rect
  const halfSize: Vec2 = [rw / 2, rh / 2]
  const center: Vec2 = [rx + halfSize[0], ry + halfSize[1]]

  let nonFinite = 0
  let maxSd = 0
  let maxDisp = 0
  let maxOffset = 0
  let worstSd = 0
  const offsetErrs: number[] = []

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = (j * width + i) * 4
      const gSd = data[k]!
      const gDx = data[k + 1]!
      const gDy = data[k + 2]!
      const gDisp = data[k + 3]!
      if (
        !Number.isFinite(gSd) ||
        !Number.isFinite(gDx) ||
        !Number.isFinite(gDy) ||
        !Number.isFinite(gDisp)
      ) {
        nonFinite++
        continue
      }

      // 片元位置取像素中心，与 @builtin(position) 的约定一致。
      const px: Vec2 = [origin[0] + i + 0.5, origin[1] + j + 0.5]
      const centered: Vec2 = [px[0] - center[0], px[1] - center[1]]
      const radius = radiusAt(centered, panel.radii)
      const sd = sdRoundedRect(centered, halfSize, radius)
      const dir = refractionDirection(
        centered,
        halfSize,
        gradRadiusOf(radius, halfSize),
        panel.depthEffect
      )
      const disp = refractionProfile(sd, panel.heightPx, panel.amountPx, panel.squircle)

      const eSd = Math.abs(gSd - sd)
      const eDisp = Math.abs(gDisp - disp)
      const eOffset = Math.hypot(gDx * gDisp - dir[0] * disp, gDy * gDisp - dir[1] * disp)

      if (eSd > maxSd) maxSd = eSd
      if (eDisp > maxDisp) maxDisp = eDisp
      if (eOffset > maxOffset) {
        maxOffset = eOffset
        worstSd = sd
      }
      offsetErrs.push(eOffset)
    }
  }

  offsetErrs.sort((a, b) => a - b)
  const p99 = offsetErrs.length ? offsetErrs[Math.floor(offsetErrs.length * 0.99)]! : 0

  return {
    texels: width * height,
    gpuNonFinite: nonFinite,
    maxErr: { sd: maxSd, displacement: maxDisp, offset: maxOffset },
    p99OffsetErr: p99,
    worstOffsetAtSd: worstSd
  }
}
