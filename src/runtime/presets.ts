/**
 * Default Glass 与 runtime 的预设：`<div glass>`、`<div glass="tinted">`、`glass(el, { preset })`。
 *
 * 四个名字对应到 core/material.ts 的 GlassPresets：
 * - `default` —— 就是 regular（`<div glass>` 不写值时用它），整个项目的视觉基准；
 * - `clear` —— 最透：不模糊、折射强、带一点色散，没有投影；
 * - `tinted` —— regular 上多一层颜色（默认白 0.18），`glass-tint` 换颜色；
 * - `frosted` —— thick 上再模糊一些，背景太亮太暗时自己蒙纱（adaptive）。
 * 旧名字（ultraThin / thin / regular / thick）照样认。
 *
 * 另外按元素算两样默认值（都可以被 `glass-*` 属性与 glass() 的 material 覆盖）：
 * - 圆角：取元素 CSS 的 border-radius（玻璃的形状跟着作者写的样式走）；
 * - 交互：元素本身可以交互（按钮、链接、可聚焦的、表单控件）时开悬停、按压、键盘焦点的反馈，否则不开。
 */

import { MATERIAL_ATTRIBUTES, parseMaterialAttributes } from '../core/attributes.ts'
import { GlassPresets, type CornerRadius, type GlassMaterial } from '../core/material.ts'

export const RUNTIME_PRESETS = {
  default: GlassPresets.regular,
  clear: GlassPresets.clear,
  tinted: { ...GlassPresets.regular, tint: 'rgba(255,255,255,0.18)' },
  frosted: { ...GlassPresets.thick, blur: 28, adaptive: 1 }
} as const satisfies Record<string, GlassMaterial>

export type RuntimePresetName = keyof typeof RUNTIME_PRESETS | keyof typeof GlassPresets

/** 预设名 → 材质；空串是 default；不认识返回 null。大小写不敏感（ultrathin 也认）。 */
export function runtimePreset(name: string): GlassMaterial | null {
  const key = name.trim()
  if (key === '') return RUNTIME_PRESETS.default
  const all: Record<string, GlassMaterial> = { ...GlassPresets, ...RUNTIME_PRESETS }
  const hit = Object.keys(all).find((k) => k.toLowerCase() === key.toLowerCase())
  return hit ? all[hit]! : null
}

/** runtime 认的预设名（报错时列出来）。 */
export function runtimePresetNames(): string[] {
  return [...Object.keys(RUNTIME_PRESETS), ...Object.keys(GlassPresets).filter((k) => k !== 'regular')]
}

/** `glass-*` 属性（`glass-blur="20"` …）：名字是组件材质属性加前缀，preset 例外（写在 glass 属性的值里）。 */
export const GLASS_MATERIAL_ATTRIBUTES: readonly string[] = MATERIAL_ATTRIBUTES.filter((a) => a !== 'preset').map(
  (a) => `glass-${a}`
)

/** 交互与质量的属性：`glass-jelly`、`glass-glide`（写了就开，`="false"` 关），`glass-quality="0.6"`。 */
export const GLASS_BEHAVIOR_ATTRIBUTES: readonly string[] = ['glass-jelly', 'glass-glide', 'glass-quality']

export interface ParsedGlassAttributes {
  /** 预设 ⊕ `glass-*` 属性。不含按元素算的默认值（圆角）。 */
  readonly material: GlassMaterial
  /** 预设名（glass 属性的值；空串是 default）。 */
  readonly preset: string
  /** 只有 `glass-*` 属性写的那几项（不含预设）。 */
  readonly overrides: GlassMaterial
  /** 显式写了圆角（`glass-corner-radius`）。没写时 runtime 取 CSS 的 border-radius。 */
  readonly explicitRadius: boolean
  /** `glass-jelly` / `glass-glide`：没写是 undefined（按默认）。 */
  readonly jelly?: boolean
  readonly glide?: boolean
  /** `glass-quality`：0–1，没写或写错是 undefined（自适应）。 */
  readonly quality?: number
  readonly problems: readonly string[]
}

/**
 * 从 `glass` 属性（值是预设名）与 `glass-*` 属性读出材质。
 *
 * @param get 按属性名取值，没有时返回 null（就是 Element.getAttribute）
 */
export function parseGlassAttributes(get: (name: string) => string | null): ParsedGlassAttributes {
  const problems: string[] = []
  const presetName = get('glass') ?? ''
  let base = runtimePreset(presetName)
  if (!base) {
    problems.push(`glass="${presetName}" 不认识，可用：${runtimePresetNames().join(' / ')}`)
    base = RUNTIME_PRESETS.default
  }
  const parsed = parseMaterialAttributes((name) => (name === 'preset' ? null : get(`glass-${name}`)))
  for (const p of parsed.problems) problems.push(`glass-${p}`)
  const flag = (name: string): boolean | undefined => {
    const v = get(name)
    if (v === null) return undefined
    return v.trim().toLowerCase() !== 'false'
  }
  let quality: number | undefined
  const q = get('glass-quality')
  if (q !== null && q.trim() !== 'auto') {
    const n = Number(q)
    if (q.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 1) quality = n
    else problems.push(`glass-quality="${q}"：要 0–1 的数或 auto`)
  }
  const jelly = flag('glass-jelly')
  const glide = flag('glass-glide')
  return {
    material: { ...base, ...parsed.material },
    preset: runtimePreset(presetName) ? presetName : '',
    overrides: parsed.material,
    explicitRadius: parsed.material.cornerRadius !== undefined,
    ...(jelly !== undefined ? { jelly } : {}),
    ...(glide !== undefined ? { glide } : {}),
    ...(quality !== undefined ? { quality } : {}),
    problems
  }
}

/**
 * CSS 的四个角（计算值，`12px`、`50%`、`12px 8px` …）→ 玻璃的圆角。
 * 像素照抄（椭圆角取水平半径）；四个角都是同一个百分比时换成短边的比例（50% → 0.5frac，胶囊）；
 * 百分比与像素混写时百分比按 0 近似。都是 0 时返回 0（方角）。
 */
export function cornerRadiusFromCss(corners: readonly [string, string, string, string]): CornerRadius {
  const parsed = corners.map((c) => {
    const first = c.trim().split(/\s+/)[0] ?? '0'
    if (first.endsWith('%')) return { pct: parseFloat(first) }
    const px = parseFloat(first)
    return { px: Number.isFinite(px) ? px : 0 }
  })
  const pcts = parsed.map((p) => ('pct' in p ? p.pct : null))
  if (pcts.every((p) => p !== null && Number.isFinite(p) && p === pcts[0])) {
    return `${Math.min(pcts[0]! / 100, 0.5)}frac`
  }
  const px = parsed.map((p) => ('px' in p ? p.px : 0)) as [number, number, number, number]
  if (px.every((v) => v === px[0])) return px[0]
  return px
}

/** 本身可以交互的元素：按钮、链接、表单控件、可聚焦的、带交互角色的。 */
export function isInteractiveElement(el: {
  readonly localName: string
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
}): boolean {
  const tag = el.localName
  if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true
  if (tag === 'a' && el.hasAttribute('href')) return true
  const tabindex = el.getAttribute('tabindex')
  if (tabindex !== null && Number(tabindex) >= 0) return true
  const role = el.getAttribute('role')
  return role !== null && /^(button|link|tab|switch|checkbox|radio|menuitem|option|slider)$/.test(role)
}
