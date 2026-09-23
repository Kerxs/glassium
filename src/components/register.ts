/**
 * 注册 `<glass-card>` / `<glass-button>`。
 *
 * 显式调用，不在 import 时自动注册：自动注册是 import 的副作用，会让「只想用光学数学」的
 * 使用方也注册上两个元素名，而且在 SSR 里根本没有 customElements。
 */

import { GlassButton } from './glass-button.ts'
import { GlassCard } from './glass-card.ts'

const ELEMENTS = [
  ['glass-card', GlassCard],
  ['glass-button', GlassButton]
] as const

/**
 * 幂等：重复调用什么都不做。服务端（没有 customElements）也什么都不做 ——
 * 组件在服务端就是普通的未知元素，客户端调用这个函数时就地 upgrade。
 */
export function defineGlassElements(
  registry: CustomElementRegistry | undefined = typeof customElements === 'undefined'
    ? undefined
    : customElements
): void {
  if (!registry) return
  for (const [name, ctor] of ELEMENTS) {
    const existing = registry.get(name)
    if (!existing) {
      registry.define(name, ctor)
    } else if (existing !== ctor) {
      // 页面上加载了两份 Glassium（比如两个包各打包了一份）。元素名只能定义一次，
      // 沿用先来的那份 —— 但两份各自有一个 stage 单例，玻璃会画到另一份的画布上去。
      console.warn(
        `[Glassium] <${name}> 已经被另一份定义占用，沿用已有的。` +
          '页面上是不是加载了两份 Glassium？两份各有自己的 stage，互相看不见。'
      )
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'glass-card': GlassCard
    'glass-button': GlassButton
  }
}
