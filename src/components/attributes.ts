/**
 * HTML 属性 → GlassMaterial。
 *
 * 单独放一个文件，是为了能在 Node 里测：组件本身要 DOM，属性解析不要。
 *
 * 写错的属性值**报出来并忽略**，不抛、也不静默吞掉：抛的话一个手滑的属性会让整块面板
 * 不渲染；静默吞掉的话 `blur="8px"` 这种写法会悄悄变成默认值，而你会以为模糊没生效。
 *
 * 所以 tint 也在这里校验，而不是留给下游：下游的 parseTint 会抛，而属性是在
 * attributeChangedCallback 里生效的 —— 在那里抛，整份材质都应用不上。
 */

import {
  GlassPresets,
  parseTint,
  type CornerRadius,
  type GlassMaterial
} from '../core/material.ts'

/** 组件认的属性名。与 GlassMaterial 的字段一一对应（kebab-case）。 */
export const MATERIAL_ATTRIBUTES = [
  'preset',
  'blur',
  'refraction',
  'distortion',
  'highlight',
  'dispersion',
  'saturation',
  'tint',
  'opacity',
  'corner-radius',
  'squircle',
  'depth-effect'
] as const

type NumericKey =
  | 'blur'
  | 'refraction'
  | 'distortion'
  | 'highlight'
  | 'dispersion'
  | 'saturation'
  | 'opacity'
  | 'squircle'
  | 'depthEffect'

const NUMERIC: ReadonlyArray<readonly [string, NumericKey]> = [
  ['blur', 'blur'],
  ['refraction', 'refraction'],
  ['distortion', 'distortion'],
  ['highlight', 'highlight'],
  ['dispersion', 'dispersion'],
  ['saturation', 'saturation'],
  ['opacity', 'opacity'],
  ['squircle', 'squircle'],
  ['depth-effect', 'depthEffect']
]

/** 预设名，同时接受 camelCase 与 kebab-case（`ultraThin` / `ultra-thin`）。 */
function presetFrom(name: string): GlassMaterial | null {
  const key = name.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  return key in GlassPresets ? GlassPresets[key as keyof typeof GlassPresets] : null
}

/** 严格的数字：整个字符串必须是一个有限数，`8px`、`1e`、空串都不算。 */
function strictNumber(raw: string): number | null {
  const t = raw.trim()
  if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** `16` / `0.5frac` / `4 32 8 28`（TL TR BR BL）。 */
function cornerRadiusFrom(raw: string): CornerRadius | null {
  const t = raw.trim()
  const frac = /^([+-]?(\d+\.?\d*|\.\d+))frac$/.exec(t)
  if (frac) return `${Number(frac[1])}frac`
  const parts = t.split(/\s+/)
  if (parts.length === 1) return strictNumber(parts[0]!)
  if (parts.length === 4) {
    const nums = parts.map(strictNumber)
    if (nums.every((n): n is number => n !== null)) {
      return [nums[0]!, nums[1]!, nums[2]!, nums[3]!]
    }
  }
  return null
}

export interface ParsedMaterial {
  readonly material: GlassMaterial
  /** 解析不了的属性，逐条说明。调用方负责 console.warn。 */
  readonly problems: readonly string[]
}

/**
 * 从属性读出材质。`preset` 打底，其余属性逐项覆盖。
 *
 * @param get 按属性名取值，没有该属性时返回 null（就是 Element.getAttribute）
 */
export function parseMaterialAttributes(get: (name: string) => string | null): ParsedMaterial {
  const problems: string[] = []
  let material: GlassMaterial = {}

  const preset = get('preset')
  if (preset !== null) {
    const base = presetFrom(preset)
    if (base) material = { ...base }
    else {
      problems.push(
        `preset="${preset}" 不认识，可用：${Object.keys(GlassPresets).join(' / ')}`
      )
    }
  }

  const out: Record<string, unknown> = { ...material }
  for (const [attr, key] of NUMERIC) {
    const raw = get(attr)
    if (raw === null) continue
    const n = strictNumber(raw)
    if (n === null) {
      problems.push(`${attr}="${raw}" 不是数字（不要带单位 —— blur 是 dp，其余多为比例）`)
      continue
    }
    out[key] = n
  }

  const tint = get('tint')
  if (tint !== null) {
    try {
      parseTint(tint)
      out.tint = tint
    } catch {
      problems.push(`tint="${tint}" 解析不了，只支持 hex（#rgb/#rgba/#rrggbb/#rrggbbaa）与 rgb()/rgba()`)
    }
  }

  const radius = get('corner-radius')
  if (radius !== null) {
    const r = cornerRadiusFrom(radius)
    if (r === null) {
      problems.push(`corner-radius="${radius}" 看不懂，可写 16 / 0.5frac / 4 32 8 28`)
    } else {
      out.cornerRadius = r
    }
  }

  return { material: out as GlassMaterial, problems }
}
