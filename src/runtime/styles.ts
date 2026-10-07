/**
 * runtime 自己的样式表（挂在 document.adoptedStyleSheets 上，不碰作者的 style 属性与样式表）。
 *
 * - `[glass]` 的 CSS 兜底表面：玻璃还没生效（stage 没建好、没有 GPU、高对比度）或者在对话框 / popover 里改用 CSS 画
 *   （`data-glassium-overlay`）时，用 backdrop-filter 画一块近似的玻璃。与组件影子树里的 OVERLAY_HOST_CSS 同一套变量。
 *   选择器包在 :where() 里，优先级 0，作者的样式都能盖过它。
 * - 每块玻璃的材质写成 CSS 变量：`[data-glassium-glass="3"] { --glassium-blur: … }`，材质变了才重写。
 * - GPU 玻璃生效时，元素自己的底色换成透明（优先级 0）：GPU 玻璃画在页面底下，元素的底色会把它整块盖住。
 *   清掉的是浏览器给 `<button>` 之类的默认底色 —— 作者自己写的底色照样盖过这一条（那是作者要的）。
 * - 收进场景的背景（absorb.ts）：`[data-glassium-absorbed] { background: transparent !important }`。
 */

import type { GlassMaterial } from '../core/material.ts'
import { overlayVars } from '../core/overlay.ts'

/** 每块 runtime 玻璃的编号属性：CSS 变量的规则按它选中元素。 */
export const GLASS_ID_ATTRIBUTE = 'data-glassium-glass'
/** 背景被收进场景的元素（absorb.ts）。 */
export const ABSORBED_ATTRIBUTE = 'data-glassium-absorbed'

/** runtime 样式表的固定部分（导出给测试核对）。 */
export const BASE_CSS = `
:where([glass]:not([data-glassium-active]), [glass][data-glassium-overlay]) {
  background-color: var(--glassium-tint, rgba(255, 255, 255, 0.18));
  box-shadow:
    inset 0 1px 0 0 var(--glassium-rim-light, rgba(255, 255, 255, 0.495)),
    inset 0 -1px 0 0 var(--glassium-rim-light, rgba(255, 255, 255, 0.495)),
    inset 0 0 0 1px var(--glassium-rim-side, rgba(255, 255, 255, 0.223)),
    0 0 0 0.5px var(--glassium-edge, rgba(41, 41, 41, 0.315)),
    0 6px 12px -4px var(--glassium-shadow, rgba(0, 0, 0, 0.053));
  -webkit-backdrop-filter: blur(var(--glassium-blur, 8px)) saturate(var(--glassium-saturate, 1.4));
  backdrop-filter: blur(var(--glassium-blur, 8px)) saturate(var(--glassium-saturate, 1.4));
}
:where([glass][data-glassium-active]:not([data-glassium-overlay])) {
  background-color: transparent;
}
[${ABSORBED_ATTRIBUTE}] {
  background: transparent !important;
}
[data-glassium-hit] {
  pointer-events: auto !important;
}
[data-glassium-content],
[data-glassium-content] * {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  text-decoration-color: transparent !important;
  background-color: transparent !important;
  border-color: transparent !important;
}
[data-glassium-content] :is(img, svg, canvas, video) {
  opacity: 0 !important;
}
:is(img, canvas, video)[data-glassium-content] {
  object-position: -99999px -99999px !important;
}
svg[data-glassium-content] > * {
  opacity: 0 !important;
}
@media (forced-colors: active) {
  :where([glass]) {
    forced-color-adjust: auto;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}
`

let baseSheet: CSSStyleSheet | null = null
let varsSheet: CSSStyleSheet | null = null
const varRules = new Map<string, string>()
let flushQueued = false

/** 把两张样式表挂到文档上（幂等）。没有 CSSStyleSheet 构造函数的环境什么都不做。 */
export function installRuntimeStyles(): void {
  if (baseSheet || typeof document === 'undefined' || typeof CSSStyleSheet === 'undefined') return
  try {
    baseSheet = new CSSStyleSheet()
    baseSheet.replaceSync(BASE_CSS)
    varsSheet = new CSSStyleSheet()
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, baseSheet, varsSheet]
  } catch {
    baseSheet = null
    varsSheet = null
  }
}

/** 这块玻璃的材质变量（材质变了才真的重写样式表，同一个微任务里的多次更新合并成一次）。 */
export function setGlassVars(id: string, material: GlassMaterial): void {
  const vars = overlayVars(material)
  const rule = `[${GLASS_ID_ATTRIBUTE}="${id}"] { ${Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ')} }`
  if (varRules.get(id) === rule) return
  varRules.set(id, rule)
  queueFlush()
}

export function removeGlassVars(id: string): void {
  if (varRules.delete(id)) queueFlush()
}

function queueFlush(): void {
  if (flushQueued || !varsSheet) return
  flushQueued = true
  queueMicrotask(() => {
    flushQueued = false
    varsSheet?.replaceSync([...varRules.values()].join('\n'))
  })
}
