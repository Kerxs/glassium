/**
 * Playground 的「给出代码」：编辑器里的材质 → 最短的 HTML 属性写法与 JS 材质对象。
 *
 * 纯函数（Node 里测：material-code.test.ts）。三种写法，与各自的基准一样的项不写：
 * - 零配置（`<div glass>`）：基准是 runtime 的预设（不写预设就是 default = regular）；圆角写成 CSS 的 border-radius（runtime 读它）；
 * - 组件（`<glass-card>`）：基准是 组件自己的默认值 ⊕ 预设（`<glass-card>` 默认 24dp 圆角、`<glass-button>` 默认胶囊）；
 * - JS（`glass(element, options)`）：基准与零配置相同，圆角同样交给 CSS。
 *
 * 从源码引而不是按包名引：这个模块要在 Node 里跑测试，Node 不认 Vite 的别名。
 */

import { GlassPresets, MATERIAL_DEFAULTS, parseTint, type GlassMaterial, type GlassPresetName } from '../src/core/material.ts'

export type PreviewElement = 'glass-card' | 'glass-button'

/** 用滑杆调的数值项。 */
export type NumericField =
  | 'blur'
  | 'refraction'
  | 'distortion'
  | 'highlight'
  | 'dispersion'
  | 'saturation'
  | 'opacity'
  | 'squircle'
  | 'depthEffect'
  | 'adaptive'
  | 'shadow'

export interface FieldSpec {
  readonly key: NumericField
  /** HTML 属性名。 */
  readonly attr: string
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
}

/** 滑杆的顺序与范围（范围取常用的那一段，属性本身不限于它）。 */
export const FIELDS: readonly FieldSpec[] = [
  { key: 'blur', attr: 'blur', label: '模糊', min: 0, max: 40, step: 0.5 },
  { key: 'refraction', attr: 'refraction', label: '折射深度', min: 0, max: 0.6, step: 0.01 },
  { key: 'distortion', attr: 'distortion', label: '位移幅度', min: -0.6, max: 0.6, step: 0.01 },
  { key: 'highlight', attr: 'highlight', label: '亮边', min: 0, max: 1, step: 0.01 },
  { key: 'dispersion', attr: 'dispersion', label: '色散', min: 0, max: 1, step: 0.01 },
  { key: 'saturation', attr: 'saturation', label: '饱和度', min: 0, max: 2, step: 0.01 },
  { key: 'opacity', attr: 'opacity', label: '不透明度', min: 0, max: 1, step: 0.01 },
  { key: 'squircle', attr: 'squircle', label: '倒角剖面', min: 2, max: 6, step: 0.1 },
  { key: 'depthEffect', attr: 'depth-effect', label: '透镜厚度', min: 0, max: 1, step: 0.01 },
  { key: 'adaptive', attr: 'adaptive', label: '自适应', min: 0, max: 1, step: 0.01 },
  { key: 'shadow', attr: 'shadow', label: '投影', min: 0, max: 1, step: 0.01 }
]

/** 编辑器的状态。tint 是 [r, g, b（0–255 的整数）, a（0–1）]；圆角是 dp 或者胶囊。 */
export interface EditorState {
  readonly element: PreviewElement
  readonly preset: GlassPresetName | null
  readonly values: Readonly<Record<NumericField, number>>
  readonly tint: readonly [number, number, number, number]
  readonly cornerRadius: number | 'pill'
  readonly width: number
  readonly height: number
}

/** 组件自己的默认值（base.ts 的 defaults()）：卡片 24dp 圆角，按钮胶囊。 */
const COMPONENT_DEFAULTS: Readonly<Record<PreviewElement, GlassMaterial>> = {
  'glass-card': { cornerRadius: 24 },
  'glass-button': { cornerRadius: '1frac' }
}

/** 预览的默认尺寸（CSS px）。 */
export const PREVIEW_SIZE: Readonly<Record<PreviewElement, readonly [number, number]>> = {
  'glass-card': [340, 220],
  'glass-button': [180, 64]
}

function baseline(element: PreviewElement | null, preset: GlassPresetName | null): Required<GlassMaterial> {
  return {
    ...MATERIAL_DEFAULTS,
    ...(element ? COMPONENT_DEFAULTS[element] : {}),
    ...(preset ? GlassPresets[preset] : {})
  } as Required<GlassMaterial>
}

const toTint = (css: string): [number, number, number, number] => {
  const [r, g, b, a] = parseTint(css)
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(a * 100) / 100]
}

/** 数字写成最短的样子：最多两位小数，去掉末尾的 0。 */
export const fmt = (n: number): string => String(Number(n.toFixed(2)))

const tintCss = ([r, g, b, a]: readonly number[]): string => `rgba(${r}, ${g}, ${b}, ${fmt(a!)})`

const sameTint = (a: readonly number[], b: readonly number[]): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && Math.abs(a[3]! - b[3]!) < 0.005

const radiusValue = (r: number | 'pill'): string | number => (r === 'pill' ? '1frac' : r)

const sameRadius = (r: number | 'pill', base: GlassMaterial['cornerRadius']): boolean =>
  r === 'pill' ? base === '1frac' : typeof base === 'number' && Math.abs(base - r) < 0.005

/** 某个元素在某个预设下的编辑器状态：每一项取基准值（组件默认 ⊕ 预设）。 */
export function stateFromPreset(element: PreviewElement, preset: GlassPresetName | null): EditorState {
  const base = baseline(element, preset)
  const values = Object.fromEntries(FIELDS.map((f) => [f.key, base[f.key] as number])) as Record<NumericField, number>
  const r = base.cornerRadius
  return {
    element,
    preset,
    values,
    tint: toTint(base.tint),
    cornerRadius: r === '1frac' ? 'pill' : typeof r === 'number' ? r : 24,
    width: PREVIEW_SIZE[element][0],
    height: PREVIEW_SIZE[element][1]
  }
}

/** 与基准不同的项：[属性名, 值]，preset 排在最前。 */
export function attributesOf(state: EditorState): [string, string][] {
  const base = baseline(state.element, state.preset)
  const out: [string, string][] = []
  if (state.preset) out.push(['preset', state.preset])
  for (const f of FIELDS) {
    const v = state.values[f.key]
    if (Math.abs(v - (base[f.key] as number)) >= 0.005) out.push([f.attr, fmt(v)])
  }
  if (!sameTint(state.tint, toTint(base.tint))) out.push(['tint', tintCss(state.tint)])
  if (!sameRadius(state.cornerRadius, base.cornerRadius)) out.push(['corner-radius', String(radiusValue(state.cornerRadius))])
  return out
}

/** JS 材质里与 MATERIAL_DEFAULTS ⊕ 预设不同的项（camelCase）。 */
export function overridesOf(state: EditorState): [string, string | number][] {
  const base = baseline(null, state.preset)
  const out: [string, string | number][] = []
  for (const f of FIELDS) {
    const v = state.values[f.key]
    if (Math.abs(v - (base[f.key] as number)) >= 0.005) out.push([f.key, Number(fmt(v))])
  }
  if (!sameTint(state.tint, toTint(base.tint))) out.push(['tint', tintCss(state.tint)])
  if (!sameRadius(state.cornerRadius, base.cornerRadius)) out.push(['cornerRadius', radiusValue(state.cornerRadius)])
  return out
}

/** runtime 的基准：MATERIAL_DEFAULTS ⊕ 预设（不写预设时是 default = regular）。 */
function runtimeBaseline(preset: GlassPresetName | null): Required<GlassMaterial> {
  return { ...MATERIAL_DEFAULTS, ...GlassPresets[preset ?? 'regular'] } as Required<GlassMaterial>
}

/** 零配置与 glass() 的材质覆盖（camelCase 键、HTML 属性名、值），不含圆角（交给 CSS）。 */
export function runtimeOverridesOf(state: EditorState): Array<{ key: string; attr: string; value: string | number }> {
  const base = runtimeBaseline(state.preset)
  const out: Array<{ key: string; attr: string; value: string | number }> = []
  for (const f of FIELDS) {
    const v = state.values[f.key]
    if (Math.abs(v - (base[f.key] as number)) >= 0.005) out.push({ key: f.key, attr: f.attr, value: Number(fmt(v)) })
  }
  if (!sameTint(state.tint, toTint(base.tint))) out.push({ key: 'tint', attr: 'tint', value: tintCss(state.tint) })
  return out
}

const cssRadius = (r: number | 'pill'): string => (r === 'pill' ? '999px' : `${fmt(r)}px`)

/** 零配置的写法：`<div glass>`（按钮是 `<button glass>`），材质写成 glass-* 属性，圆角写成 CSS。 */
export function runtimeSnippet(state: EditorState): string {
  const tag = state.element === 'glass-button' ? 'button' : 'div'
  const attrs = runtimeOverridesOf(state).map((o) => ` glass-${o.attr}="${o.value}"`).join('')
  const style = `width: ${state.width}px; height: ${state.height}px; border-radius: ${cssRadius(state.cornerRadius)}`
  const inner = tag === 'div' ? '\n  …\n' : '按钮'
  return `<${tag} glass="${state.preset ?? ''}"${attrs} style="${style}">${inner}</${tag}>`
}

export function htmlSnippet(state: EditorState): string {
  const attrs = attributesOf(state).map(([k, v]) => ` ${k}="${v}"`).join('')
  const inner = state.element === 'glass-card' ? '\n  …\n' : '按钮'
  return `<${state.element}${attrs} style="width: ${state.width}px; height: ${state.height}px">${inner}</${state.element}>`
}

/** JS 的写法：`glass(element, { preset, material })`（圆角交给元素的 CSS border-radius）。 */
export function jsSnippet(state: EditorState): string {
  const entries = runtimeOverridesOf(state).map((o) => `${o.key}: ${typeof o.value === 'string' ? `'${o.value}'` : o.value}`)
  const options = [
    ...(state.preset ? [`preset: '${state.preset}'`] : []),
    ...(entries.length > 0 ? [`material: { ${entries.join(', ')} }`] : [])
  ]
  return [
    "import { glass } from 'glassium'",
    '',
    `// 圆角取元素 CSS 的 border-radius（${cssRadius(state.cornerRadius)}）`,
    `glass(element${options.length > 0 ? `, { ${options.join(', ')} }` : ''})`
  ].join('\n')
}
