/**
 * DOM Renderer：玻璃后面的内容（文字、`<img>`、内联 SVG、`<canvas>`、`<video>`）画进场景，玻璃折射得到。
 *
 * GPU 玻璃画在页面底下的画布上：玻璃后面的 DOM 内容照常画在它上面、不被折射（limitations.md 的 R2）。runtime 把
 * 「在玻璃后面」的内容块搬进场景：
 * - 找：在每块 runtime 玻璃里一格一格做命中测试（layering.ts 的 hitStacksBehind），夹在玻璃与画布之间的元素里，
 *   离玻璃最近的那个往上找到块级的内容块（段落、标题、列表项、图片容器……）。块里有别的玻璃、表单控件、
 *   contenteditable，块有背景图，或者块太大（比视口大一半以上）的不收。
 * - 收：块注册成位图填充，painter 用 paintContent 把块里的背景色、图片、画面、SVG、文字画进场景（画的时候先摘掉
 *   `data-glassium-content`，读到的是原样式）；然后挂上属性，runtime 的样式表把 DOM 里的字变透明、图片与画面变成
 *   不透明度 0 —— 布局、选中、链接、焦点、读屏都还是 DOM 的，看得见的那一份在场景里。
 * - 更新：块里的文字、子元素、class / style 变了（MutationObserver）、图片加载完、字体加载完，只重画这一块；
 *   视频按 requestVideoFrameCallback 每出一帧重画一次（不出新帧不上传）；画布没有变化通知，每画一帧重画一次。
 * - 放：块不在任何玻璃后面了（并且离玻璃的盒子远过一点）就还给 DOM —— 画布画的字与 DOM 的字抗锯齿不完全一样，
 *   不在玻璃后面的内容照旧由浏览器画。
 * - 画不了的（跨源图片、跨源视频、被污染的画布、渐变文字、text-shadow、下划线……）：块照收，这几样在场景里缺着；
 *   跨源的图片 / 视频警告一次。
 *
 * 只对 runtime 管的玻璃做；`configure({ absorbContent: false })` 关掉。
 */

import { canvasIsClean, paintContent, sameOriginImage, videoIsClean } from '../renderer/paint-content.ts'
import { hitStacksBehind } from '../renderer/layering.ts'
import type { SceneBitmapFill } from '../renderer/panels.ts'
import type { GlassStage } from '../renderer/stage.ts'

/** 内容被搬进场景的块。 */
export const CONTENT_ATTRIBUTE = 'data-glassium-content'
/** 最多同时收这么多块。 */
const MAX_BLOCKS = 64
/** 块不在玻璃后面之后，离玻璃的盒子超过这么远（CSS 像素）才还回去（滞回：滚动时边缘上的块不来回换）。 */
const RELEASE_MARGIN = 48

interface ContentEntry {
  readonly element: HTMLElement
  fill: SceneBitmapFill | null
  /** 最近一次在玻璃后面被看到的扫描代数。 */
  seen: number
  readonly videos: Map<HTMLVideoElement, number>
  /** 块里的画布与它们上一次的缩略指纹。 */
  readonly canvases: Map<HTMLCanvasElement, Uint8ClampedArray | null>
  /** 视频出了几帧、画了几次（验证页读）。 */
  videoFrames: number
  paints: number
}

const entries = new Map<HTMLElement, ContentEntry>()
const warned = new WeakSet<Element>()
let generation = 0
let stageOf: GlassStage | null = null
let unsubscribeFrame: (() => void) | null = null
let listening = false

/** 收进场景的内容块（调试面板、验证页读）。 */
export function contentBlocks(): HTMLElement[] {
  return [...entries.keys()]
}

/** 一块的统计（验证页读）：视频出了几帧、这一块画了几次。 */
export function contentStats(el: HTMLElement): { videoFrames: number; paints: number } | null {
  const e = entries.get(el)
  return e ? { videoFrames: e.videoFrames, paints: e.paints } : null
}

export function isContentBlock(el: Element): boolean {
  return entries.has(el as HTMLElement)
}

/** 块里的东西变了：只重画这一块。返回有没有命中。 */
export function invalidateContentAt(node: Node): boolean {
  let hit = false
  for (const e of entries.values()) {
    if (e.element === node || e.element.contains(node)) {
      e.fill?.invalidate()
      hit = true
    }
  }
  return hit
}

/** 全部还给 DOM。 */
export function releaseContent(): void {
  for (const e of [...entries.values()]) release(e)
  unsubscribeFrame?.()
  unsubscribeFrame = null
}

/**
 * 扫一遍：panels 是 runtime 的玻璃。新收的块会让 stage 立刻画一帧（DOM 里的字刚变透明，场景里的那一份要同一帧出现）。
 * @param takeOver 块原来的背景被收成了背景层（absorb.ts）：让它放手，背景改由这一块的 painter 画
 */
export function scanContent(stage: GlassStage, panels: readonly HTMLElement[], takeOver: (el: HTMLElement) => void): void {
  listen()
  if (stage !== stageOf) {
    for (const e of entries.values()) e.fill = null
    stageOf = stage
    unsubscribeFrame?.()
    // 画布没有变化通知：帧循环每转一圈（静止时也转）最多每 32ms 比一次缩略指纹，变了才重画
    // （不能每画一帧就重画 —— 重画本身又要画一帧，静止的画布会让 stage 永远停不下来）
    let lastCheck = -Infinity
    unsubscribeFrame = stage.onFrame((f) => {
      if (f.time - lastCheck < 32) return
      lastCheck = f.time
      for (const e of entries.values()) if (e.canvases.size > 0 && canvasesChanged(e)) e.fill?.invalidate()
    })
  }
  generation++
  let added = false
  for (const panel of panels) {
    if (!panel.isConnected) continue
    const floor = occludingAncestor(panel)
    for (const stack of hitStacksBehind(panel, stage.canvas, 6, 4) ?? []) {
      const block = blockOf(stack, floor)
      if (!block) continue
      // 不嵌套：祖先已经收了就算看见了祖先；新块把已经收的块包在里面就换成外面这块（弹性容器里的 <img> 会块级化，
      // 按到图片上找到的是图片、按到空隙里找到的是容器 —— 两块都收的话，外面那块画的时候里面那块还透明着）
      const existing = entries.get(block) ?? enclosing(block)
      if (existing) {
        existing.seen = generation
        continue
      }
      for (const inner of [...entries.values()]) if (block.contains(inner.element)) release(inner)
      if (entries.size >= MAX_BLOCKS) continue
      takeOver(block)
      absorb(stage, block)
      added = true
    }
  }
  for (const e of [...entries.values()]) {
    if (!e.fill) register(stage, e)
    if (e.seen !== generation && !nearAny(e.element, panels, RELEASE_MARGIN)) release(e)
  }
  if (added) stage.debug.renderNow()
}

/** 已经收了的祖先块。 */
function enclosing(el: HTMLElement): ContentEntry | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const e = entries.get(p)
    if (e) return e
  }
  return null
}

/**
 * 命中栈（离玻璃最近的在前）→ 要收的内容块：从最近的往下试几个（最近的可能是没有内容的装饰层）。
 * 碰到有背景的（或者背景已经收进场景的）就停：再往后的内容被它挡着，收进来会画到它的背景上面。
 */
function blockOf(stack: readonly Element[], floor: Element | null): HTMLElement | null {
  for (let i = 0; i < Math.min(3, stack.length); i++) {
    const el = stack[i]!
    if (floor && !floor.contains(el)) return null
    const block = blockFrom(stack, el)
    if (block) return block
    if (occludes(el)) return null
  }
  return null
}

/**
 * 玻璃最近的、有背景的祖先（命中栈里没有玻璃的祖先）：它的背景垫在玻璃后面，不在它里面的内容都被它挡着。
 * body / html 的背景是整页的底，不算。
 */
function occludingAncestor(panel: HTMLElement): Element | null {
  for (let el = panel.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (occludes(el)) return el
  }
  return null
}

/** 元素有不透明的背景（颜色、背景图，或者背景已经被 absorb.ts 收走）。 */
function occludes(el: Element): boolean {
  if (el.hasAttribute('data-glassium-absorbed')) return true
  if (!(el instanceof HTMLElement)) return false
  const cs = getComputedStyle(el)
  if (cs.backgroundImage !== 'none' && cs.backgroundImage !== '') return true
  const m = /rgba?\(([^)]*)\)/.exec(cs.backgroundColor)
  if (!m) return cs.backgroundColor !== 'transparent'
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean)
  return parts.length < 4 || parseFloat(parts[3]!) > 0
}

function blockFrom(stack: readonly Element[], first: Element): HTMLElement | null {
  if (!(first instanceof HTMLElement) && !(first instanceof SVGElement)) return null
  let el: Element | null = first
  // 往上找到块级（display 不是 inline / contents）；到了 stack 之外（玻璃的祖先）就停
  while (el && stack.includes(el)) {
    if (el instanceof HTMLElement && isBlock(el)) break
    el = el.parentElement
  }
  if (!(el instanceof HTMLElement) || !stack.includes(el)) return null
  if (el === document.body || el === document.documentElement) return null
  if (ours(el) || el.closest('[data-glassium-glass], [data-glassium-active], [data-glassium-debug]')) return null
  if (!hasContent(el)) return null
  if (el.querySelector('input, textarea, select, [contenteditable], [data-glassium-glass], [data-glassium-active]')) return null
  if (el.isContentEditable) return null
  const cs = getComputedStyle(el)
  if (cs.backgroundImage !== 'none' && cs.backgroundImage !== '') return null
  const r = el.getBoundingClientRect()
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  if (r.width * r.height > vw * vh * 1.5 || r.height > 2048 || r.width > 2048) return null
  return el
}

function isBlock(el: HTMLElement): boolean {
  const d = getComputedStyle(el).display
  return d !== 'inline' && d !== 'contents' && d !== 'none'
}

function ours(el: Element): boolean {
  return el.hasAttribute('data-glassium-scene') || el.hasAttribute('data-glassium-root')
}

/** 块里有没有能画的：非空白的文字、图片、SVG、画布、视频。 */
function hasContent(el: HTMLElement): boolean {
  if (el.querySelector('img, svg, canvas, video') || el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || el instanceof HTMLVideoElement) {
    return true
  }
  return (el.textContent ?? '').trim() !== ''
}

function absorb(stage: GlassStage, el: HTMLElement): void {
  const e: ContentEntry = { element: el, fill: null, seen: generation, videos: new Map(), canvases: new Map(), videoFrames: 0, paints: 0 }
  entries.set(el, e)
  warnCrossOrigin(el)
  register(stage, e)
  el.setAttribute(CONTENT_ATTRIBUTE, '')
  watchMedia(e)
}

function register(stage: GlassStage, e: ContentEntry): void {
  const el = e.element
  const fill = stage.registerBitmapFill(el, (ctx) => {
    e.paints++
    // 画的时候摘掉属性：读到的是原来的颜色与不透明度（挂着时字是透明的）
    const had = el.hasAttribute(CONTENT_ATTRIBUTE)
    if (had) el.removeAttribute(CONTENT_ATTRIBUTE)
    try {
      paintContent(ctx, el, [{ element: el }], () => fill.invalidate(), { backgrounds: true, media: true })
    } finally {
      if (had) el.setAttribute(CONTENT_ATTRIBUTE, '')
    }
  })
  e.fill = fill
}

function release(e: ContentEntry): void {
  e.fill?.unregister()
  e.fill = null
  e.element.removeAttribute(CONTENT_ATTRIBUTE)
  for (const [video, handle] of e.videos) video.cancelVideoFrameCallback?.(handle)
  e.videos.clear()
  entries.delete(e.element)
}

let printer: CanvasRenderingContext2D | null = null
const PRINT = 16

/** 画布缩到 16×16 的像素（画不了、被污染的是 null）。 */
function fingerprint(canvas: HTMLCanvasElement): Uint8ClampedArray | null {
  if (!(canvas.width > 0 && canvas.height > 0) || !canvas.isConnected) return null
  try {
    if (!printer) {
      const c = document.createElement('canvas')
      c.width = PRINT
      c.height = PRINT
      printer = c.getContext('2d', { willReadFrequently: true })
    }
    if (!printer) return null
    printer.clearRect(0, 0, PRINT, PRINT)
    printer.drawImage(canvas, 0, 0, PRINT, PRINT)
    return printer.getImageData(0, 0, PRINT, PRINT).data
  } catch {
    printer = null
    return null
  }
}

/** 块里有画布的指纹变了（顺手记下新的）。 */
function canvasesChanged(e: ContentEntry): boolean {
  let changed = false
  for (const [canvas, before] of e.canvases) {
    const now = fingerprint(canvas)
    if (!now) continue
    if (!before || now.some((v, i) => v !== before[i])) changed = true
    e.canvases.set(canvas, now)
  }
  return changed
}

/** 视频：每出一帧重画一次；画布：指纹变了重画（stage.onFrame，见 scanContent）。 */
function watchMedia(e: ContentEntry): void {
  const el = e.element
  const canvases: HTMLCanvasElement[] = el instanceof HTMLCanvasElement ? [el] : Array.from(el.querySelectorAll('canvas'))
  for (const c of canvases) e.canvases.set(c, fingerprint(c))
  const videos: HTMLVideoElement[] = el instanceof HTMLVideoElement ? [el] : Array.from(el.querySelectorAll('video'))
  for (const video of videos) {
    if (typeof video.requestVideoFrameCallback !== 'function') continue
    const tick = (): void => {
      if (!entries.has(el)) return
      e.videoFrames++
      e.fill?.invalidate()
      e.videos.set(video, video.requestVideoFrameCallback(tick))
    }
    e.videos.set(video, video.requestVideoFrameCallback(tick))
  }
}

function warnCrossOrigin(el: HTMLElement): void {
  const base = document.baseURI
  // 块本身也算（块级化的 <img> 自己就是一块）
  const within = <T extends Element>(selector: string): T[] => [
    ...(el.matches(selector) ? [el as unknown as T] : []),
    ...Array.from(el.querySelectorAll<T>(selector))
  ]
  for (const img of within<HTMLImageElement>('img')) {
    if (warned.has(img) || sameOriginImage(img.currentSrc || img.src, base)) continue
    warned.add(img)
    console.warn('[Glassium] 玻璃后面这张图片是跨源的，画不进场景（会污染画布），它在玻璃里缺着：', img)
  }
  for (const v of within<HTMLVideoElement>('video')) {
    if (warned.has(v) || videoIsClean(v)) continue
    warned.add(v)
    console.warn('[Glassium] 玻璃后面这段视频是跨源的，画不进场景，它在玻璃里缺着：', v)
  }
  for (const c of within<HTMLCanvasElement>('canvas')) {
    if (warned.has(c) || canvasIsClean(c)) continue
    warned.add(c)
    console.warn('[Glassium] 玻璃后面这块画布被跨源内容污染了，画不进场景：', c)
  }
}

/** 元素离某块玻璃的盒子不超过 margin。 */
function nearAny(el: HTMLElement, panels: readonly HTMLElement[], margin: number): boolean {
  if (!el.isConnected) return false
  const a = el.getBoundingClientRect()
  for (const p of panels) {
    const b = p.getBoundingClientRect()
    if (a.right + margin > b.left && a.left - margin < b.right && a.bottom + margin > b.top && a.top - margin < b.bottom) return true
  }
  return false
}

/** 图片加载完、字体加载完：块里的内容要重画。 */
function listen(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener(
    'load',
    (ev) => {
      const t = ev.target
      if (t instanceof HTMLImageElement) invalidateContentAt(t)
    },
    true
  )
  document.fonts?.addEventListener('loadingdone', () => {
    for (const e of entries.values()) e.fill?.invalidate()
  })
}
