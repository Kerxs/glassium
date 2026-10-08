/**
 * 自动启动：`import 'glassium'` 之后页面上的 `<div glass>` 就是玻璃。
 *
 * 在微任务里启动（import 之后同步写的 `configure()` 先生效），`configure({ auto: false })` 关掉。启动时：
 * - 定义 `<glass-*>` 组件（幂等）、挂 runtime 的样式表；
 * - 接管页面上已有的 `[glass]`，再用一个 MutationObserver 看 `[glass]` 的增删、属性变化，以及它们的 class / style
 *   （圆角跟着 CSS 走）；
 * - 页面上第一次出现 `[glass]` 时才建 stage（`createGlassStage({ backend })`）。已经有、或者别人正在建，就沿用 ——
 *   自己调 createGlassStage 的页面（组件、验证页）不受影响。
 *
 * SSR / Node 里什么都不做。
 */

import { getConfig } from './config.ts'
import { ensureStage } from './ensure-stage.ts'
import { glass, runtimeGlassOf } from './glass.ts'
import { GLASS_BEHAVIOR_ATTRIBUTES, GLASS_MATERIAL_ATTRIBUTES, parseGlassAttributes } from './presets.ts'
import { restyleAbsorbed, ROOT_FILL_ATTRIBUTE, scheduleAbsorb, scheduleAbsorbFrame } from './absorb.ts'
import { invalidateContentAt } from './content.ts'
import { installRuntimeStyles } from './styles.ts'

const WATCHED = ['glass', ...GLASS_MATERIAL_ATTRIBUTES, ...GLASS_BEHAVIOR_ATTRIBUTES, 'class', 'style']

let scheduled = false
let started = false
let observer: MutationObserver | null = null
/** 属性驱动的玻璃（`[glass]`）：属性删掉时注销。glass() 直接建的不在这里。 */
const fromAttribute = new WeakSet<HTMLElement>()
/** 每个元素报过的属性错误（同一条只报一次）。 */
const reported = new WeakMap<HTMLElement, Set<string>>()

/** 第一次扫描（接管页面上已有的 [glass]）做完了；不会有扫描（关了自动启动）时也算完。glassium.ready 等它。 */
let markScanned: () => void = () => {}
const scanned = new Promise<void>((resolve) => (markScanned = resolve))

/**
 * 第一次扫描做完时 resolve（等 DOMContentLoaded）。没有安排启动（Node、configure({ auto: false }) 之后没手动启动）时马上 resolve。
 */
export function whenScanned(): Promise<void> {
  return scheduled || started ? scanned : Promise.resolve()
}

/**
 * 注册组件（`<glass-*>`）的函数：完整入口（index.ts）给 defineGlassElements，`glassium/runtime` 入口不给 ——
 * runtime 自己不引用组件，只用 runtime 的页面不带组件的代码。
 */
let registerElements: (() => void) | null = null

export function setElementRegistrar(fn: (() => void) | null): void {
  registerElements = fn
}

/** 安排启动（import 时调一次；幂等）。 */
export function scheduleAutoStart(): void {
  if (scheduled || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  scheduled = true
  queueMicrotask(() => {
    if (getConfig().auto) startRuntime()
    else if (!started) markScanned()
  })
}

/** 立即启动（`glassium.start()`；configure({ auto: false }) 之后手动启动也用它）。幂等。 */
export function startRuntime(): void {
  if (started || typeof document === 'undefined') return
  started = true
  registerElements?.()
  installRuntimeStyles()
  const begin = (): void => {
    for (const el of document.querySelectorAll<HTMLElement>('[glass]')) adopt(el)
    markScanned()
    observer = new MutationObserver(onMutations)
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: WATCHED
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true })
  else begin()
}

/** 停掉自动发现，注销属性驱动的玻璃（测试、热重载用）。 */
export function stopRuntime(): void {
  observer?.disconnect()
  observer = null
  started = false
  if (typeof document === 'undefined') return
  for (const el of document.querySelectorAll<HTMLElement>('[glass]')) {
    if (fromAttribute.has(el)) runtimeGlassOf(el)?.destroy()
    fromAttribute.delete(el)
  }
}

function adopt(el: HTMLElement): void {
  const parsed = parseGlassAttributes((name) => el.getAttribute(name))
  let seen = reported.get(el)
  for (const p of parsed.problems) {
    if (!seen) reported.set(el, (seen = new Set()))
    if (seen.has(p)) continue
    seen.add(p)
    console.warn(`[Glassium] 属性有误，已忽略：${p}`, el)
  }
  const motion = parsed.jelly !== undefined || parsed.glide !== undefined
  const options = {
    preset: parsed.preset,
    material: parsed.overrides,
    ...(motion ? { interaction: { jelly: parsed.jelly ?? false, glide: parsed.glide ?? false } } : {}),
    ...(parsed.quality !== undefined ? { quality: parsed.quality } : {})
  }
  const existing = runtimeGlassOf(el)
  if (existing && fromAttribute.has(el)) existing.replace(options)
  else if (!existing) {
    glass(el, options)
    fromAttribute.add(el)
  }
}

function release(el: HTMLElement): void {
  if (!fromAttribute.has(el)) return
  runtimeGlassOf(el)?.destroy()
  fromAttribute.delete(el)
}

/** runtime 自己动的元素（画布：层级检查时切 pointer-events；根背景）的变化不算，不然扫描会自己把自己叫醒。 */
function ours(node: Node): boolean {
  return node instanceof HTMLElement && (node.hasAttribute('data-glassium-scene') || node.hasAttribute(ROOT_FILL_ATTRIBUTE))
}

/** 只是文字变了（改了文字节点，或者只增删了文字节点）：不会多出、少掉玻璃后面带背景的元素。 */
function textOnly(r: MutationRecord): boolean {
  if (r.type === 'characterData') return true
  if (r.type !== 'childList') return false
  const text = (n: Node): boolean => n.nodeType === Node.TEXT_NODE
  return [...r.addedNodes].every(text) && [...r.removedNodes].every(text)
}

function onMutations(records: MutationRecord[]): void {
  let changed = false
  for (const r of records) {
    if (ours(r.target)) continue
    // 收进场景的内容块里的文字、子元素、样式变了：只重画那一块
    invalidateContentAt(r.target)
    // 只改了文字（数字刷新之类）不重扫背景：扫一次要对每块玻璃做好几次命中测试（elementsFromPoint），
    // 每秒刷新一遍状态的页面会一直在扫
    if (textOnly(r)) continue
    changed = true
    if (r.type === 'attributes') {
      const el = r.target as HTMLElement
      if (r.attributeName === 'class' || r.attributeName === 'style') {
        const g = runtimeGlassOf(el)
        if (g) {
          g.restyle()
          // 玻璃挪了（拖动、动画）：它后面换了一块内容，要赶在这一帧画出来之前收进场景
          scheduleAbsorbFrame()
        }
        restyleAbsorbed(el)
        continue
      }
      if (el.hasAttribute('glass')) adopt(el)
      else release(el)
      continue
    }
    for (const node of r.addedNodes) {
      if (!(node instanceof HTMLElement)) continue
      for (const el of withDescendants(node)) {
        const g = runtimeGlassOf(el)
        if (g) g.setConnected(true)
        else if (el.hasAttribute('glass')) adopt(el)
      }
    }
    for (const node of r.removedNodes) {
      if (!(node instanceof HTMLElement)) continue
      for (const el of withDescendants(node)) if (!el.isConnected) runtimeGlassOf(el)?.setConnected(false)
    }
  }
  // 布局可能变了：玻璃后面挡着的元素要重新看一遍（节流）
  if (changed) scheduleAbsorb()
}

/** 节点自己和它里面的 `[glass]` / runtime 玻璃。 */
function withDescendants(node: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  if (node.hasAttribute('glass') || node.hasAttribute('data-glassium-glass')) out.push(node)
  for (const el of node.querySelectorAll<HTMLElement>('[glass], [data-glassium-glass]')) out.push(el)
  return out
}
