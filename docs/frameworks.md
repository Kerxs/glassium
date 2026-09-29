# 在框架里用

Glassium 不绑任何框架：`<div glass>` 是一个普通属性，`glass(el)` 接一个普通元素。下面是几种常见写法里要注意的地方。
这里的写法按各框架公开的行为写成，没有在每个框架里逐一跑过 —— 有问题请照实报。

## 通用

- **引一次就够**：应用入口里 `import 'glassium'`（打包器会保留它：包的 `sideEffects` 声明了入口有副作用）。之后页面上
  任何时候出现的 `[glass]` 都会被接管，删掉就注销 —— 不用在组件里手动注册。
- **SSR**：在 Node 里 import 是安全的（模块顶层不碰浏览器全局），runtime 只在浏览器里启动。服务端渲染出来的
  `<div glass>` 在客户端 hydrate 之后自动变成玻璃；hydrate 之前是 CSS 的兜底表面（`backdrop-filter`），不会闪白。
- **属性的值**：`glass` 的值是预设名，空串是 default。不要写成布尔值 —— 有的框架会把 `true` 渲染成 `"true"`
  （不认识的预设，会警告一次并按 default）或者干脆不渲染。写 `glass=""` 或 `glass="tinted"`。
- **命令式**：要在代码里控制（动态材质、按状态开关交互）用 `glass(el, options)`，组件卸载时 `handle.destroy()`。
- **动画**：自己的动画想与玻璃同一帧，用 `nextFrame(cb)` 代替 `requestAnimationFrame`（见 api.md「统一的时间轴」）。
  元素位置怎么变的都行（CSS 过渡、框架的动画库），`glass-jelly` / `glass-glide` 看的是元素在屏幕上的位置。

## React

```tsx
import 'glassium'

export function Card() {
  return (
    <div glass="" className="card">
      <h2>Hello</h2>
    </div>
  )
}
```

TypeScript 不认识 `glass` 这个属性（带连字符的 `glass-blur`、`glass-jelly` 本来就允许）。在项目里补一个声明：

```ts
// glassium-jsx.d.ts
import 'react'
declare module 'react' {
  interface HTMLAttributes<T> {
    glass?: string
  }
}
```

命令式：

```tsx
import { glass } from 'glassium'
import { useEffect, useRef } from 'react'

export function Lens({ strength }: { strength: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handle = glass(ref.current!, { preset: 'clear', interaction: { jelly: true } })
    return () => handle.destroy()
  }, [])
  useEffect(() => {
    glass(ref.current!, { material: { refraction: strength } }) // 已经是玻璃：等于 update
  }, [strength])
  return <div ref={ref} className="lens" />
}
```

## Vue

```vue
<template>
  <div glass="tinted" glass-blur="20" class="card">…</div>
</template>

<script setup>
import 'glassium'
</script>
```

属性原样落到 DOM 上，runtime 接管。命令式写法放在 `onMounted` / `onBeforeUnmount` 里。

## Svelte

```svelte
<script>
  import 'glassium'
</script>

<div glass="" class="card">…</div>
```

## 组件（`<glass-*>`）

组件是标准的自定义元素，框架里当普通标签用。属性写字符串（`corner-radius="16"`）；`value`、`checked` 这类状态
走属性或者 DOM 属性都行，`change` / `input` 事件与原生控件一样。React 18 及更早的版本给自定义元素传复杂值只能走
`ref`，React 19 起可以直接传属性。

## 常见问题

- **玻璃看不见**：多半是它后面有一层不透明的 CSS 背景挡着。`[glass]`（runtime）会把挡着的背景自动收进场景；
  组件（`<glass-*>`）不收，照 limitations.md 的 R1 写，或者 `configure({ absorbForComponents: true })`。
  `glassium.debug.enable()` 的「概览」页有「层级问题」一行，「场景」页能看到每一块玻璃画没画。
- **路由切换后玻璃留在原地**：不会 —— 元素离开文档时玻璃跟着注销。自己用 `glass()` 建的，组件卸载时记得 `destroy()`
  （不调也不会留在屏上，只是句柄没释放）。
