/**
 * `<glass-fill>` —— 画进场景的纯色形状：玻璃看得见它。
 *
 * ```html
 * <glass-fill style="--glass-fill: #34c759; width: 51px; height: 31px; border-radius: 999px"></glass-fill>
 * ```
 *
 * 玻璃只折射场景（R2）：DOM 元素的背景玻璃看不见，放在玻璃后面还会把玻璃整块挡住（R1）。
 * `<glass-fill>` 的颜色不画在 DOM 里，而是由 stage 画进场景 —— 盒子、圆角、变换、裁剪、不透明度都来自 CSS，
 * 颜色来自 `--glass-fill`（注册成可以过渡的 `<color>`，`transition: --glass-fill 0.25s` 直接可用）。
 * 于是开关的轨道、滑块的进度条、卡片后面的色块，放在玻璃底下都会被折射、被模糊。
 *
 * 里面可以放内容（文字、图标）：它们是普通的 DOM，画在画布之上。
 * 没有玻璃时（stage 没建好、没有 GPU、高对比度模式）它就是一块普通的 CSS 背景（glassium.css）。
 */

import { HTMLElementBase, sharedSheet } from './base.ts'
import { StageLink } from './stage-link.ts'

/** `display: block` 写在影子树里：没引 glassium.css 时，给它设的宽高照样生效。 */
const CSS = ':host { display: block; }'
const sheet = { sheet: null as CSSStyleSheet | null }

export class GlassFill extends HTMLElementBase {
  // 有玻璃时 CSS 背景去掉（颜色画在场景里），没有时由 glassium.css 画成 CSS 背景 —— 由 data-glassium-active 切换
  readonly #link = new StageLink(this, (stage) => {
    const fill = stage.registerFill(this)
    return () => fill.unregister()
  })

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sharedSheet(sheet, CSS)]
    root.append(document.createElement('slot'))
  }

  connectedCallback(): void {
    this.#link.connect()
  }

  disconnectedCallback(): void {
    this.#link.disconnect()
  }
}
