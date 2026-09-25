/**
 * 注册 `<glass-card>` / `<glass-button>` / `<glass-container>` / `<glass-fill>` / `<glass-switch>` / `<glass-slider>` /
 * `<glass-segmented>` / `<glass-tab-bar>` / `<glass-nav-bar>` / `<glass-toolbar>`，
 * 以及填充颜色的 CSS 自定义属性 `--glass-fill`。
 *
 * 显式调用，不在 import 时自动注册：自动注册是 import 的副作用，会让「只想用光学数学」的
 * 使用方也注册上这几个元素名，而且在 SSR 里根本没有 customElements。
 */

import { FILL_PROPERTY_DEFINITION } from '../renderer/fills.ts'
import { GlassButton } from './glass-button.ts'
import { GlassCard } from './glass-card.ts'
import { GlassContainer } from './glass-container.ts'
import { GlassFill } from './glass-fill.ts'
import { GlassSegmented } from './glass-segmented.ts'
import { GlassSlider } from './glass-slider.ts'
import { GlassSwitch } from './glass-switch.ts'
import { GlassNavBar, GlassToolbar } from './glass-nav-bar.ts'
import { GlassTabBar } from './glass-tab-bar.ts'

const ELEMENTS = [
  ['glass-card', GlassCard],
  ['glass-button', GlassButton],
  ['glass-container', GlassContainer],
  ['glass-fill', GlassFill],
  ['glass-switch', GlassSwitch],
  ['glass-slider', GlassSlider],
  ['glass-segmented', GlassSegmented],
  ['glass-tab-bar', GlassTabBar],
  // 导航栏的两个胶囊是影子树里的 <glass-card>：排在它后面定义
  ['glass-nav-bar', GlassNavBar],
  ['glass-toolbar', GlassToolbar]
] as const

/**
 * `--glass-fill` 注册成不继承、可以过渡的 `<color>`。glassium.css 里也有同样的 `@property` ——
 * 没引那份 CSS 时由这里兜底。已经注册过（另一份 Glassium、或者作者自己注册了）时浏览器抛错，忽略。
 */
function registerFillProperty(): void {
  if (typeof CSS === 'undefined' || typeof CSS.registerProperty !== 'function') return
  try {
    CSS.registerProperty(FILL_PROPERTY_DEFINITION)
  } catch {
    // 已经注册过
  }
}

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
  registerFillProperty()
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
    'glass-container': GlassContainer
    'glass-fill': GlassFill
    'glass-switch': GlassSwitch
    'glass-slider': GlassSlider
    'glass-segmented': GlassSegmented
    'glass-tab-bar': GlassTabBar
    'glass-nav-bar': GlassNavBar
    'glass-toolbar': GlassToolbar
  }
}
