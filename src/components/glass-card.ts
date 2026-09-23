/**
 * `<glass-card>` —— 静态的玻璃面板。
 *
 * ```html
 * <glass-card preset="regular" corner-radius="24">
 *   <h2>标题</h2>
 *   <p>正文照常选中、聚焦、输入。</p>
 * </glass-card>
 * ```
 *
 * 属性见 attributes.ts 的 MATERIAL_ATTRIBUTES，与 GlassMaterial 的字段一一对应。
 * 没有任何交互行为，是校准场景的判据面板。
 */

import type { GlassMaterial } from '../core/material.ts'
import { GlassElement, sharedSheet } from './base.ts'

/**
 * 影子树里只有一个 slot，内容全在 light DOM。
 *
 * `display: block` 写在这里而不只写在 glassium.css 里：自定义元素默认是 inline，
 * 没引那份 CSS 的话，给它设的宽高全都不生效。这里的 :host 规则优先级最低，
 * 作者的任何样式都能覆盖。
 */
const CSS = ':host { display: block; }'
const sheet = { sheet: null as CSSStyleSheet | null }

export class GlassCard extends GlassElement {
  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sharedSheet(sheet, CSS)]
    root.append(document.createElement('slot'))
  }

  /**
   * 卡片默认 24dp 圆角，而不是材质的默认值 0.5frac（短边的四分之一）——
   * 那是为了和上游 playground 对齐校准用的，放在一张 360×220 的卡片上是 55dp，太圆了。
   */
  protected override defaults(): GlassMaterial {
    return { cornerRadius: 24 }
  }
}
