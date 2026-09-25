/**
 * 减少透明度（`prefers-reduced-transparency: reduce`）时的材质。
 *
 * 这个系统设置是给读不清半透明表面的人用的：玻璃背后的内容透上来，文字就压在一张花哨的背景上。
 * Apple 自己的玻璃在这个设置下变成更实的磨砂。这里做同样的事：
 *
 * - 模糊加到至少 24dp（σ）：背后的图案糊成色块
 * - 表面叠一层实得多的颜色。材质自己的 tint 够显眼（alpha ≥ 0.3）就沿用它的颜色、加厚到 0.85 ——
 *   作者挑的颜色与文字的对比度是作者定的；否则按**文字颜色**选磨砂：浅色文字配深色、深色文字配浅色，
 *   alpha 0.8，保证文字读得清
 * - 关掉色散：在糊掉的背景上本来也看不出，而彩边正是这个设置想去掉的视觉噪声
 *
 * 形状、折射、高光都保留：玻璃还是玻璃，只是不再透。
 */

import { srgbToLinear } from './color.ts'
import { MATERIAL_DEFAULTS, parseTint, type GlassMaterial } from './material.ts'

export const REDUCED_TRANSPARENCY = Object.freeze({
  /** 模糊的下限，dp（σ）。 */
  minBlurDp: 24,
  /** 按文字颜色选的磨砂的不透明度。 */
  frostAlpha: 0.8,
  /** 材质自带的 tint 够显眼时，加厚到的不透明度。 */
  ownTintAlpha: 0.85,
  /** tint 的 alpha 到这个值以上才算「够显眼」、沿用它的颜色。 */
  ownTintThreshold: 0.3
})

/** 深色磨砂（配浅色文字）与浅色磨砂（配深色文字），0–1 的 sRGB。 */
export const FROST = Object.freeze({
  dark: [28 / 255, 28 / 255, 32 / 255] as const,
  light: [242 / 255, 242 / 255, 247 / 255] as const
})

export type Frost = keyof typeof FROST

/** WCAG 的相对亮度，输入 0–1 的 sRGB 编码值。 */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/**
 * 文字配哪种磨砂：对比度更高的那种。
 *
 * 与黑底的对比度 (L + 0.05) / 0.05、与白底的 1.05 / (L + 0.05)，两者相等处 L ≈ 0.179 ——
 * 比这更亮的文字配深色磨砂。
 */
export function frostFor(textLuminance: number): Frost {
  return (textLuminance + 0.05) ** 2 > 0.05 * 1.05 ? 'dark' : 'light'
}

/** 从 CSS 颜色字符串（计算值）选磨砂。解析不了的写法（比如 oklch()）当作浅色文字 —— 玻璃上更常见。 */
export function frostForColor(css: string): Frost {
  try {
    const [r, g, b] = parseTint(css)
    return frostFor(relativeLuminance(r, g, b))
  } catch {
    return 'dark'
  }
}

const rgba = (rgb: readonly number[], a: number): string =>
  `rgba(${rgb.map((c) => Math.round(c * 255)).join(', ')}, ${a})`

export function reduceTransparency(material: GlassMaterial, frost: Frost): GlassMaterial {
  const [r, g, b, a] = parseTint(material.tint ?? MATERIAL_DEFAULTS.tint)
  const tint =
    a >= REDUCED_TRANSPARENCY.ownTintThreshold
      ? rgba([r, g, b], Math.max(a, REDUCED_TRANSPARENCY.ownTintAlpha))
      : rgba(FROST[frost], REDUCED_TRANSPARENCY.frostAlpha)
  return {
    ...material,
    blur: Math.max(material.blur ?? MATERIAL_DEFAULTS.blur, REDUCED_TRANSPARENCY.minBlurDp),
    dispersion: 0,
    tint
  }
}
