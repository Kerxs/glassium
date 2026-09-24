/**
 * 用 CSS 画的玻璃：盖在 DOM 上的玻璃（`overlay` 属性，或者在模态对话框、打开的 popover、全屏元素 —— 浏览器的
 * 「顶层」—— 里面的玻璃）用它。
 *
 * GPU 玻璃画在最底下的画布上，DOM 内容都在它上面；顶层里的元素更是画在一切之上 —— 那里的 GPU 玻璃被整页内容
 * 盖住，看不见。平台不许读 DOM 的像素，所以这种玻璃做不了折射；能做的是让浏览器的 `backdrop-filter` 模糊下面的一切
 * （包括文字），材质的其余部分照搬：
 *
 * - 模糊：CSS 的 `blur()` 参数就是高斯的 σ，与材质的 blur（σ，dp = CSS px）同一个量；
 * - 饱和度：CSS 的 `saturate()` 用 Rec.709 的亮度权重，与着色器的 applyColorFilter 同源；
 * - tint：`background-color` 盖在模糊过的背景上，就是 mix(背景, tint.rgb, tint.a) —— 与着色器相同；
 * - 亮边与投影：近似成 `box-shadow`（左上亮、右下暗的一圈 1.5px，往下 4px、σ 10px 的影子）。
 *
 * 这里只算数，写成 CSS 自定义属性；规则在 glassium.css 与各组件的影子样式里。
 */

import { MATERIAL_DEFAULTS, parseTint, type GlassMaterial } from './material.ts'

/** GPU 投影在 shadow = 1 时的峰值不透明度（与 renderer/panels.ts 的 SHADOW_OPACITY 相同）。 */
const SHADOW_PEAK = 0.5
/** 亮边在 highlight = 1 时的不透明度。GPU 的亮边是加性光，CSS 只能叠白色，取一个看起来相当的量。 */
const RIM_PEAK = 0.55
/** 暗边相对亮边的强度（与着色器的 DARK_RIM 相同）。 */
const DARK_RIM = 0.35

const round = (x: number, digits = 4): number => Number(x.toFixed(digits))

/**
 * 材质 → CSS 自定义属性（名 → 值）。材质的 opacity 乘进 tint 的 alpha 与亮边、投影的强度 ——
 * 模糊没法「半透明」，照原样给。
 */
export function overlayVars(material: GlassMaterial): Record<string, string> {
  const m = { ...MATERIAL_DEFAULTS, ...material }
  const opacity = Math.min(1, Math.max(0, m.opacity))
  const [r, g, b, a] = parseTint(m.tint)
  const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255)
  return {
    '--glassium-blur': `${round(Math.max(0, m.blur), 3)}px`,
    '--glassium-saturate': `${round(Math.max(0, m.saturation), 3)}`,
    '--glassium-tint': `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${round(a * opacity, 3)})`,
    '--glassium-rim-light': `rgba(255, 255, 255, ${round(m.highlight * RIM_PEAK * opacity, 3)})`,
    '--glassium-rim-dark': `rgba(0, 0, 0, ${round(m.highlight * RIM_PEAK * DARK_RIM * opacity, 3)})`,
    '--glassium-shadow': `rgba(0, 0, 0, ${round(m.shadow * SHADOW_PEAK * opacity, 3)})`
  }
}

/**
 * 玻璃组件（卡片、按钮、标签栏）影子样式里的那条规则：被 stage 标成 CSS 画的玻璃时，表面照材质画。
 * 放在组件自己的影子样式里，没引 glassium.css 也生效 —— 这是一条正式的渲染路径，不只是兜底。
 * glassium.css 里只有几条细化（不支持 backdrop-filter、减少透明度、更高对比度），外部的规则压得过 :host。
 */
export const OVERLAY_HOST_CSS = `
:host([data-glassium-overlay]) {
  background-color: var(--glassium-tint, rgba(255, 255, 255, 0.18));
  box-shadow:
    inset 1.5px 1.5px 1px -1px var(--glassium-rim-light, rgba(255, 255, 255, 0.33)),
    inset -1.5px -1.5px 1px -1px var(--glassium-rim-dark, rgba(0, 0, 0, 0.12)),
    0 4px 20px var(--glassium-shadow, rgba(0, 0, 0, 0.15));
  -webkit-backdrop-filter: blur(var(--glassium-blur, 8px)) saturate(var(--glassium-saturate, 1.4));
  backdrop-filter: blur(var(--glassium-blur, 8px)) saturate(var(--glassium-saturate, 1.4));
}
`

/** 写成一条 `:host { … }` 规则（组件挂在自己影子树里的那张样式表）。 */
export function overlayHostRule(material: GlassMaterial): string {
  const vars = overlayVars(material)
  return `:host { ${Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ')} }`
}
