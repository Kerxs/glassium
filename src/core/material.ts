/**
 * 声明式材质立面 —— 降级到 pipeline.ts 的有序管线。
 *
 * 这一层保留了最初设想的那组参数名（blur / opacity / refraction / distortion /
 * highlight / saturation / tint / cornerRadius）。它们本身是好用的词汇，问题只在于
 * 不能拿它当**内核**：扁平属性包表达不了效果顺序，也表达不了采样余量协商
 * （上游 v1 正是这么设计的，作者后来整块删掉了，见 pipeline.ts 顶部）。
 *
 * 所以两层都要：这里一行写完常见情况，需要精确控制时直接构造 EffectChain。
 */

import { clampRadii, type Radii4, type Vec2 } from './optics.ts'
import { resolveMargins, type EffectChain, type GlassEffect } from './pipeline.ts'

/**
 * 角半径。三种写法：
 * - `number` —— 绝对 dp
 * - `` `${number}frac` `` —— 短边一半的比例，`'1frac'` 是完全的胶囊形
 * - `Radii4` —— 四角各自的绝对 dp，顺序 TL/TR/BR/BL
 *
 * 第三种能用，是因为 Glassium 修掉了上游那个让四角塌缩成右下角的坐标系 bug
 * （见 docs/porting-notes.md）。上游给了这个参数，但它实际上不起作用。
 */
export type CornerRadius = number | `${number}frac` | Radii4

export interface GlassMaterial {
  /**
   * 高斯模糊 σ，**绝对 dp**。
   *
   * 这里和下面两个参数的量纲不一致，是刻意的，不是疏漏：模糊半径的观感是绝对的
   * （8dp 的模糊在大面板和小按钮上看起来一样柔），而折射必须随尺寸缩放
   * （小按钮用大面板那套位移量会糊成一团）。上游自己的 playground 也是这么分的。
   */
  readonly blur?: number
  /** 折射带深度，**短边的比例**。最终 heightDp = refraction × minDimension × 0.5。 */
  readonly refraction?: number
  /** 位移幅值，**短边的比例**。最终 amountDp = distortion × minDimension。 */
  readonly distortion?: number
  /** 边缘高光强度，0–1，0 关闭。 */
  readonly highlight?: number
  /** 色散强度，0–1，0 关闭。关闭时与无色散路径逐位相同。 */
  readonly dispersion?: number
  /** 饱和度，1 为原样。Apple 的 vibrancy 大约 1.2–1.5。 */
  readonly saturation?: number
  /** 叠加色，CSS 颜色字符串。它的 alpha 是**叠加强度**，不是面板透明度。 */
  readonly tint?: string
  /** 面板整体不透明度，0–1。 */
  readonly opacity?: number
  /** 角半径，见 CornerRadius。 */
  readonly cornerRadius?: CornerRadius
  /** 倒角剖面的超椭圆指数，2 = 圆形。更大 = 中心更平、过渡更柔。 */
  readonly squircle?: number
  /** 0 像倒角薄板，1 像整块厚透镜。 */
  readonly depthEffect?: number
}

/**
 * 默认值。
 *
 * refraction / distortion 取 0.2，与上游 playground 的
 * refractionHeightFrac / refractionAmountFrac 默认值一致 —— 这样两边的校准结果
 * 可以直接对比（见 docs/calibration.md）。
 */
const DEFAULTS = {
  blur: 8,
  refraction: 0.2,
  distortion: 0.2,
  highlight: 0.6,
  dispersion: 0,
  saturation: 1.4,
  tint: 'rgba(255, 255, 255, 0.18)',
  opacity: 1,
  cornerRadius: '0.5frac' as CornerRadius,
  squircle: 2,
  depthEffect: 1
} satisfies Required<GlassMaterial>

/**
 * 预设。
 *
 * 厚度梯度照 Apple 的说法走：玻璃变厚时「投下更深更浓的阴影、透镜与折射更明显、
 * 光的散射更柔」。所以 thick 不只是模糊更大，折射和 depthEffect 也一起上去。
 *
 * clear 对应 Apple 的 Clear 变体：**没有自适应行为**、更透，只该用在媒体内容上，
 * 而且需要调用方自己压一层遮罩来保证上面的内容可读。它不是「更淡的 regular」。
 */
export const GlassPresets = {
  ultraThin: { blur: 2, refraction: 0.1, distortion: 0.1, saturation: 1.15, tint: 'rgba(255,255,255,0.1)', highlight: 0.4, depthEffect: 0.3 },
  thin: { blur: 4, refraction: 0.14, distortion: 0.14, saturation: 1.25, tint: 'rgba(255,255,255,0.14)', highlight: 0.5, depthEffect: 0.6 },
  regular: { blur: 8, refraction: 0.2, distortion: 0.2, saturation: 1.4, tint: 'rgba(255,255,255,0.18)', highlight: 0.6, depthEffect: 1 },
  thick: { blur: 16, refraction: 0.3, distortion: 0.28, saturation: 1.5, tint: 'rgba(255,255,255,0.22)', highlight: 0.7, depthEffect: 1 },
  clear: { blur: 0, refraction: 0.2, distortion: 0.22, saturation: 1.1, tint: 'rgba(255,255,255,0)', highlight: 0.8, depthEffect: 1 }
} as const satisfies Record<string, GlassMaterial>

export type GlassPresetName = keyof typeof GlassPresets

const HEX = /^#([0-9a-f]{3,8})$/i
const RGB_FN = /^rgba?\(([^)]+)\)$/i

/**
 * CSS 颜色 → 预乘前的 [r, g, b, a]，各分量 0–1。
 *
 * 只支持 hex（3/4/6/8 位）和 rgb()/rgba()。**不支持** 具名颜色、hsl()、color()、
 * oklch() 等 —— 那需要一个完整的颜色库，而 tint 这个场景用不上。
 * 不支持的写法**抛错**，不静默当成黑色：一块本该发白的玻璃默默变暗，
 * 会被当成光学 bug 查上半天。
 */
export function parseTint(css: string): [number, number, number, number] {
  const s = css.trim()

  const hex = HEX.exec(s)
  if (hex) {
    const h = hex[1]!
    const expand = (c: string): number => parseInt(c.length === 1 ? c + c : c, 16) / 255
    if (h.length === 3 || h.length === 4) {
      const a = h.length === 4 ? expand(h[3]!) : 1
      return [expand(h[0]!), expand(h[1]!), expand(h[2]!), a]
    }
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? expand(h.slice(6, 8)) : 1
      return [expand(h.slice(0, 2)), expand(h.slice(2, 4)), expand(h.slice(4, 6)), a]
    }
    throw new Error(`[Glassium] tint 的 hex 位数不合法：${css}（支持 3/4/6/8 位）`)
  }

  const fn = RGB_FN.exec(s)
  if (fn) {
    const parts = fn[1]!.split(/[,\s/]+/).filter(Boolean)
    if (parts.length < 3) throw new Error(`[Glassium] tint 的分量不足：${css}`)
    const chan = (t: string): number =>
      t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t) / 255
    const alphaRaw = parts[3]
    const a = alphaRaw === undefined ? 1 : alphaRaw.endsWith('%') ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw)
    const out: [number, number, number, number] = [chan(parts[0]!), chan(parts[1]!), chan(parts[2]!), a]
    if (out.some((v) => !Number.isFinite(v))) throw new Error(`[Glassium] tint 解析失败：${css}`)
    return out
  }

  throw new Error(
    `[Glassium] 无法解析 tint：${css}。只支持 hex（#rgb/#rgba/#rrggbb/#rrggbbaa）` +
      `与 rgb()/rgba()，不支持具名颜色、hsl()、oklch() 等。`
  )
}

/** 把 CornerRadius 解算成四角绝对 dp，并钳到几何允许的范围。 */
export function resolveCornerRadii(radius: CornerRadius, size: Vec2): Radii4 {
  const minDimension = Math.min(size[0], size[1])
  // 先判 number / string 再兜底到 Radii4。用 Array.isArray 先判会narrow 成 any[]，
  // 而 Radii4 是 readonly 元组，负分支里去不掉，反而把另外两支的类型搞坏。
  if (typeof radius === 'number') {
    return clampRadii([radius, radius, radius, radius], size)
  }
  if (typeof radius === 'string') {
    const frac = parseFloat(radius)
    if (!Number.isFinite(frac)) throw new Error(`[Glassium] 无法解析 cornerRadius：${radius}`)
    const dp = (frac * minDimension) / 2
    return clampRadii([dp, dp, dp, dp], size)
  }
  return clampRadii(radius, size)
}

/**
 * 立面 → 有序管线。
 *
 * 降级是**全序且顺序固定**的：colorFilter → blur → lens，永不重排。
 * 无操作的效果会被省略 —— 不是为了省那一点开销，而是为了让
 * `chain.effects` 读起来就是「这块玻璃实际做了什么」。
 */
export function lowerMaterial(material: GlassMaterial, size: Vec2): EffectChain {
  const m = { ...DEFAULTS, ...material }
  const minDimension = Math.min(size[0], size[1])
  const effects: GlassEffect[] = []

  const tint = parseTint(m.tint)
  const saturationIsNoop = m.saturation === 1
  const tintIsNoop = tint[3] === 0
  if (!saturationIsNoop || !tintIsNoop) {
    effects.push({ kind: 'colorFilter', saturation: m.saturation, tint })
  }

  if (m.blur > 0) {
    effects.push({ kind: 'blur', sigmaDp: m.blur })
  }

  // 两条缩放规则照抄上游 playground，这样两边的校准数值可以直接对比：
  //   heightDp = refractionHeightFrac × minDimension × 0.5
  //   amountDp = refractionAmountFrac × minDimension
  const heightDp = m.refraction * minDimension * 0.5
  const amountDp = m.distortion * minDimension
  if (heightDp > 0 && amountDp > 0) {
    effects.push({
      kind: 'lens',
      heightDp,
      amountDp,
      cornerRadiiDp: resolveCornerRadii(m.cornerRadius, size),
      squircle: m.squircle,
      dispersion: m.dispersion,
      highlight: m.highlight,
      depthEffect: m.depthEffect
    })
  }

  return {
    effects,
    paddingDp: resolveMargins(effects),
    opacity: Math.min(Math.max(m.opacity, 0), 1)
  }
}

/** 取预设并可选覆盖若干字段。`glass(GlassPresets.thick, { tint: '#0af3' })` */
export function glass(preset: GlassMaterial, overrides: GlassMaterial = {}): GlassMaterial {
  return { ...preset, ...overrides }
}
