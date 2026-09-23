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

import { evalMergedOptics, type MemberGeometry } from '../core/merge.ts'
import {
  gradRadiusOf,
  gradSdRoundedRect,
  radiusAt,
  refractionDirection,
  refractionProfile,
  safeNormalize,
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

/** 合并组的探针回读。格式与 OpticsProbe 相同，附带的是全部成员的几何与 k。 */
export interface GroupOpticsProbe {
  readonly width: number
  readonly height: number
  readonly origin: Vec2
  readonly data: Float32Array
  readonly members: readonly MemberGeometry[]
  /** smin 的 k，画布设备像素。 */
  readonly smoothingPx: number
}

/** CPU 侧在一个像素中心上算出的光学量。 */
interface CpuOptics {
  readonly sd: number
  readonly dir: Vec2
  readonly displacement: number
}

/** 逐纹素比对 GPU 探针与一个 CPU 实现。单块面板与合并组共用。 */
function compareAgainst(
  width: number,
  height: number,
  origin: Vec2,
  data: Float32Array,
  cpu: (px: Vec2) => CpuOptics
): OpticsComparison {
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
      const c = cpu(px)

      const eSd = Math.abs(gSd - c.sd)
      const eDisp = Math.abs(gDisp - c.displacement)
      const eOffset = Math.hypot(gDx * gDisp - c.dir[0] * c.displacement, gDy * gDisp - c.dir[1] * c.displacement)

      if (eSd > maxSd) maxSd = eSd
      if (eDisp > maxDisp) maxDisp = eDisp
      if (eOffset > maxOffset) {
        maxOffset = eOffset
        worstSd = c.sd
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

export function compareOptics(probe: OpticsProbe): OpticsComparison {
  const { panel } = probe
  const [rx, ry, rw, rh] = panel.rect
  const halfSize: Vec2 = [rw / 2, rh / 2]
  const center: Vec2 = [rx + halfSize[0], ry + halfSize[1]]
  return compareAgainst(probe.width, probe.height, probe.origin, probe.data, (px) => {
    const centered: Vec2 = [px[0] - center[0], px[1] - center[1]]
    const radius = radiusAt(centered, panel.radii)
    const sd = sdRoundedRect(centered, halfSize, radius)
    return {
      sd,
      dir: refractionDirection(centered, halfSize, gradRadiusOf(radius, halfSize), panel.depthEffect),
      displacement: refractionProfile(sd, panel.heightPx, panel.amountPx, panel.squircle)
    }
  })
}

/**
 * 合并组的 GPU 探针与 core/merge.ts 的 CPU 实现逐像素比对。判据与单块面板相同：
 * 零个非有限值、采样偏移 p99 在 1e-4 像素以下。
 */
export function compareGroupOptics(probe: GroupOpticsProbe): OpticsComparison {
  return compareAgainst(probe.width, probe.height, probe.origin, probe.data, (px) =>
    evalMergedOptics(px, probe.members, probe.smoothingPx)
  )
}

/* ------------------------------------------------------------------ *
 * 颜色层面的验证：把光学探针与颜色回读按像素对齐拼起来
 *
 * 探针给出每个像素上 GPU 实际用的 sd、方向、位移；颜色回读给出同一个像素最终画出来的
 * 颜色。两者覆盖同一块区域时逐像素对齐，于是可以直接问「在外法线朝左上的那些边缘像素上，
 * 颜色是不是比中间亮」这种问题，而不必去猜哪个像素对应面板的哪个位置。
 * ------------------------------------------------------------------ */

/** 8 个扇区，按外法线方向划分（屏幕坐标，y 向下）。 */
export type Sector = 'T' | 'TR' | 'R' | 'BR' | 'B' | 'BL' | 'L' | 'TL'
export const SECTORS: readonly Sector[] = ['T', 'TR', 'R', 'BR', 'B', 'BL', 'L', 'TL']

const SECTOR_BY_OCTANT: readonly Sector[] = ['L', 'TL', 'T', 'TR', 'R', 'BR', 'B', 'BL', 'L']

/** 外法线 → 扇区。atan2 在 y 向下的屏幕坐标里：0 朝右、π/2 朝下。 */
export function sectorOf(n: Vec2): Sector {
  const octant = Math.round(Math.atan2(n[1], n[0]) / (Math.PI / 4)) // −4 … 4
  return SECTOR_BY_OCTANT[octant + 4]!
}

export interface JoinedPixel {
  /** 画布设备像素，像素中心。 */
  readonly px: Vec2
  readonly sd: number
  readonly displacement: number
  /** 轮廓外法线（纯 SDF 梯度，放大后的角半径）—— 与着色器里高光用的同一个。 */
  readonly normal: Vec2
  readonly sector: Sector
  /** 0–1，RGBA 顺序（回读已经处理过 BGRA）。 */
  readonly rgb: readonly [number, number, number]
}

/**
 * 按像素对齐探针与颜色回读。两者必须覆盖同一块区域：
 * 先 probeOptics(i)，再用它的 origin/width/height 去 readback。
 */
export function joinProbeAndColors(probe: OpticsProbe, rgba: Uint8Array): JoinedPixel[] {
  const { width, height, origin, data, panel } = probe
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `[Glassium] 探针 ${width}x${height} 与颜色回读的尺寸对不上（${rgba.length / 4} 像素）`
    )
  }
  const [rx, ry, rw, rh] = panel.rect
  const halfSize: Vec2 = [rw / 2, rh / 2]
  const center: Vec2 = [rx + halfSize[0], ry + halfSize[1]]
  const out: JoinedPixel[] = []
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const t = j * width + i
      const px: Vec2 = [origin[0] + i + 0.5, origin[1] + j + 0.5]
      const centered: Vec2 = [px[0] - center[0], px[1] - center[1]]
      const r = radiusAt(centered, panel.radii)
      const normal = safeNormalize(gradSdRoundedRect(centered, halfSize, gradRadiusOf(r, halfSize)))
      out.push({
        px,
        sd: data[t * 4]!,
        displacement: data[t * 4 + 3]!,
        normal,
        sector: sectorOf(normal),
        rgb: [rgba[t * 4]! / 255, rgba[t * 4 + 1]! / 255, rgba[t * 4 + 2]! / 255]
      })
    }
  }
  return out
}

export interface SectorStat {
  readonly n: number
  readonly mean: number
  readonly min: number
  readonly max: number
  /** 取值为正的比例。 */
  readonly positive: number
}

/**
 * 按扇区汇总某个量。pick 返回 null 表示这个像素不参与统计。
 * 没有样本的扇区照样出现在结果里（n = 0），免得「没测到」被读成「测到了 0」。
 */
export function summarizeBySector(
  pixels: readonly JoinedPixel[],
  pick: (p: JoinedPixel) => number | null
): Record<Sector, SectorStat> {
  const acc = new Map<Sector, number[]>(SECTORS.map((k) => [k, []]))
  for (const p of pixels) {
    const v = pick(p)
    if (v === null || !Number.isFinite(v)) continue
    acc.get(p.sector)!.push(v)
  }
  const out = {} as Record<Sector, SectorStat>
  for (const k of SECTORS) {
    const vs = acc.get(k)!
    if (vs.length === 0) {
      out[k] = { n: 0, mean: Number.NaN, min: Number.NaN, max: Number.NaN, positive: Number.NaN }
      continue
    }
    // 不用 Math.min(...vs)：展开到参数列表会在十万量级的数组上撑爆调用栈，
    // 而一整块面板就有十八万个像素。
    let sum = 0
    let min = Infinity
    let max = -Infinity
    let pos = 0
    for (const v of vs) {
      sum += v
      if (v < min) min = v
      if (v > max) max = v
      if (v > 0) pos++
    }
    out[k] = { n: vs.length, mean: sum / vs.length, min, max, positive: pos / vs.length }
  }
  return out
}
