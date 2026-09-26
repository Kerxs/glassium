/**
 * 把元素里的文字与图标画进 2D 画布：位图填充（stage.registerBitmapFill）的 painter 用它。
 *
 * `<glass-segmented>`、`<glass-tab-bar>` 按住时把各段的文字、图标画进场景，选中块 / 气泡的透镜就能把它们放大、
 * 在边缘扭弯 —— iOS 26 拖动选中块时就是这样。平时照旧显示 DOM（锐利、可选中、无障碍），只有按住时换成画进
 * 场景的这一份（组件负责交叉淡化）。
 *
 * 画什么：
 * - 文字节点：按父元素的计算样式（字体、颜色、字距、方向）画在 Range 量出来的位置上；折成几行的文字节点
 *   逐字符量位置。宽度与 DOM 量到的差一点（亚像素、字形微调）时水平拉到一样宽。
 * - 内联 `<svg>`：克隆一份、把每个图形的计算样式（fill、stroke……，currentColor 已经解析成颜色）写成内联样式，
 *   序列化成图片异步解码 —— 解码好之前这个图标先不画，好了调 onReady 让调用方重画。
 * - 同源的 `<img>`（已经加载好的）。跨源图片不画：它会污染共享的图集画布，之后整张图集都传不进 GPU。
 *
 * 画不了的（跨源图片、canvas、视频、CSS 背景图、text-shadow、渐变文字……）跳过：按住时它们就不在场景里，
 * 见 docs/limitations.md。坐标按包围盒换算，不支持旋转。
 */

import { OVERLAY_ATTRIBUTE, type SceneBitmapFill } from '../renderer/panels.ts'
import type { GlassStage } from '../renderer/stage.ts'
import { ACTIVE_ATTRIBUTE } from './base.ts'

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** 要画的一个元素（连同它的子孙）。 */
export interface LabelSource {
  readonly element: Element
  /** 文字与图标的颜色换成它（比如选中色）；不写用各自的计算颜色。 */
  readonly color?: string
}

/** 逐字符量位置的文字节点最多这么长：再长的就只按第一个矩形画（标签不会这么长）。 */
const MAX_PER_CHAR = 400

/** 画布上的字与 DOM 量到的宽度差在这个比例以内，就水平拉到一样宽（更大的差说明字体不一样，拉了反而难看）。 */
const FIT_TOLERANCE = 0.15

/**
 * 把 sources 里的内容画进 ctx。ctx 的原点是 origin 元素盒子的左上角（变换之前）、单位是 CSS 像素 ——
 * 与 registerBitmapFill 给 painter 的 ctx 相同。异步的东西（SVG 图标）准备好之后调 onReady。
 */
export function paintContent(ctx: Context2D, origin: Element, sources: readonly LabelSource[], onReady: () => void): void {
  const map = localMapping(origin)
  if (!map) return
  for (const source of sources) {
    paintTexts(ctx, source, map)
    paintSvgs(ctx, source, map, onReady)
    paintImages(ctx, source, map)
  }
}

/** 客户区坐标（getBoundingClientRect，含变换）→ origin 盒子里的 CSS 像素（变换之前）。 */
interface LocalMapping {
  readonly left: number
  readonly top: number
  /** 一个 CSS 像素在屏幕上是几个客户区像素（变换的缩放）。 */
  readonly sx: number
  readonly sy: number
}

function localMapping(origin: Element): LocalMapping | null {
  const box = origin.getBoundingClientRect()
  const w = (origin as HTMLElement).offsetWidth
  const h = (origin as HTMLElement).offsetHeight
  if (!(box.width > 0 && box.height > 0)) return null
  return { left: box.left, top: box.top, sx: w > 0 ? box.width / w : 1, sy: h > 0 ? box.height / h : 1 }
}

function toLocal(map: LocalMapping, r: DOMRect): { x: number; y: number; w: number; h: number } {
  return { x: (r.left - map.left) / map.sx, y: (r.top - map.top) / map.sy, w: r.width / map.sx, h: r.height / map.sy }
}

/**
 * 从 el 往上、到 stop 为止（不含 stop）的不透明度之积。stop 是要画的那一段本身：组件按住时正是把它淡出
 * （换成画进场景的这一份），它自己的不透明度不能算进来。
 */
function opacityUpTo(el: Element, stop: Element): number {
  let o = 1
  for (let e: Element | null = el; e && e !== stop; e = e.parentElement) {
    const v = parseFloat(getComputedStyle(e).opacity)
    if (Number.isFinite(v)) o *= v
  }
  return o
}

/** 计算样式 → 画布的 font。字号、粗细、斜体、小型大写、字体族与 DOM 相同。 */
export function canvasFont(cs: Pick<CSSStyleDeclaration, 'fontStyle' | 'fontVariant' | 'fontWeight' | 'fontSize' | 'fontFamily'>): string {
  const style = cs.fontStyle && cs.fontStyle !== 'normal' ? `${cs.fontStyle} ` : ''
  const variant = cs.fontVariant === 'small-caps' ? 'small-caps ' : ''
  return `${style}${variant}${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
}

/**
 * 基线的位置：Range 的矩形是字体的内容区（上伸 + 下伸），基线在它顶上往下「上伸」处 —— 内容区与量到的
 * 上伸 + 下伸不一样高时两头平分差值。
 */
export function baselineIn(top: number, height: number, ascent: number, descent: number): number {
  return top + (height - (ascent + descent)) / 2 + ascent
}

function visible(el: Element): boolean {
  const cs = getComputedStyle(el)
  return cs.visibility !== 'hidden' && cs.display !== 'none'
}

function paintTexts(ctx: Context2D, source: LabelSource, map: LocalMapping): void {
  const root = source.element
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = doc.createRange()
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement
    if (!parent || !node.data.trim() || !visible(parent)) continue
    // SVG 里的文字交给 SVG 那一支
    if (parent.closest('svg')) continue
    const cs = getComputedStyle(parent)
    const alpha = opacityUpTo(parent, root)
    if (!(alpha > 0)) continue
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.font = canvasFont(cs)
    ctx.fillStyle = source.color ?? cs.color
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.direction = cs.direction === 'rtl' ? 'rtl' : 'ltr'
    if ('letterSpacing' in ctx) ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
    range.selectNodeContents(node)
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
    if (rects.length === 1) {
      drawRun(ctx, node.data.replace(/\s+/g, ' ').trim(), toLocal(map, rects[0]!))
    } else if (rects.length > 1) {
      // 折成了几行：逐字符量（Range 一个字符一个字符地取矩形）
      const n = Math.min(node.data.length, MAX_PER_CHAR)
      for (let i = 0; i < n; i++) {
        const ch = node.data[i]!
        if (/\s/.test(ch)) continue
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const r = range.getClientRects()[0]
        if (r && r.width > 0) drawRun(ctx, ch, toLocal(map, r))
      }
    }
    ctx.restore()
  }
  range.detach()
}

/** 一段文字画在 box 里：基线按字体的上伸、下伸放，宽度差一点时水平拉到与 DOM 一样宽。 */
function drawRun(ctx: Context2D, text: string, box: { x: number; y: number; w: number; h: number }): void {
  if (!text) return
  const m = ctx.measureText(text)
  const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent
  const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent
  const y = baselineIn(box.y, box.h, ascent, descent)
  const k = m.width > 0 ? box.w / m.width : 1
  if (Math.abs(k - 1) <= FIT_TOLERANCE && k !== 1) {
    ctx.save()
    ctx.translate(box.x, y)
    ctx.scale(k, 1)
    ctx.fillText(text, 0, 0)
    ctx.restore()
  } else {
    ctx.fillText(text, box.x, y)
  }
}

// —— SVG 图标 ——

/** 解码好的 SVG 图片，按序列化出来的文本缓存。 */
const svgCache = new Map<string, HTMLImageElement | 'pending' | 'failed'>()
const SVG_CACHE_LIMIT = 128

/** 写进克隆的内联样式的计算属性：图形的颜色与描边（currentColor、CSS 变量、类选择器都已经解析了）。 */
const SVG_STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'opacity',
  'visibility',
  'display'
] as const

/**
 * 克隆一个 svg，把原件每个元素的计算样式写进克隆的 style（颜色换成 color 时 fill / stroke 里不是 none 的都换），
 * 宽高写成量到的尺寸，序列化成文本。
 */
export function serializeSvg(svg: SVGSVGElement, width: number, height: number, color?: string): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const originals = [svg, ...Array.from(svg.querySelectorAll('*'))]
  const copies = [clone, ...Array.from(clone.querySelectorAll('*'))]
  for (let i = 0; i < originals.length && i < copies.length; i++) {
    const cs = getComputedStyle(originals[i]!)
    const parts: string[] = []
    for (const prop of SVG_STYLE_PROPS) {
      let v = cs.getPropertyValue(prop)
      if (!v) continue
      if (color && (prop === 'fill' || prop === 'stroke') && v !== 'none' && !v.startsWith('url(')) v = color
      parts.push(`${prop}:${v}`)
    }
    ;(copies[i] as SVGElement).setAttribute('style', parts.join(';'))
  }
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return new XMLSerializer().serializeToString(clone)
}

function paintSvgs(ctx: Context2D, source: LabelSource, map: LocalMapping, onReady: () => void): void {
  const root = source.element
  const svgs: SVGSVGElement[] = root.localName === 'svg' ? [root as SVGSVGElement] : []
  for (const s of root.querySelectorAll('svg')) if (!s.parentElement?.closest('svg')) svgs.push(s)
  for (const svg of svgs) {
    if (!visible(svg)) continue
    const r = svg.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const box = toLocal(map, r)
    const markup = serializeSvg(svg, Math.round(box.w * 100) / 100, Math.round(box.h * 100) / 100, source.color)
    const cached = svgCache.get(markup)
    if (cached instanceof HTMLImageElement) {
      ctx.save()
      ctx.globalAlpha = opacityUpTo(svg.parentElement ?? svg, root)
      ctx.drawImage(cached, box.x, box.y, box.w, box.h)
      ctx.restore()
    } else if (cached === undefined) {
      loadSvg(markup, onReady)
    }
  }
}

function loadSvg(markup: string, onReady: () => void): void {
  if (typeof Image === 'undefined') return
  if (svgCache.size >= SVG_CACHE_LIMIT) svgCache.delete(svgCache.keys().next().value!)
  svgCache.set(markup, 'pending')
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  img
    .decode()
    .then(() => {
      svgCache.set(markup, img)
      onReady()
    })
    .catch(() => svgCache.set(markup, 'failed'))
}

// —— 图片 ——

/** 同源（含 data: / blob:）的图片才画：跨源的会污染画布。 */
export function sameOriginImage(src: string, base: string): boolean {
  try {
    const url = new URL(src, base)
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true
    return url.origin === new URL(base).origin
  } catch {
    return false
  }
}

function paintImages(ctx: Context2D, source: LabelSource, map: LocalMapping): void {
  const root = source.element
  const images: HTMLImageElement[] = root.localName === 'img' ? [root as HTMLImageElement] : []
  images.push(...Array.from(root.querySelectorAll('img')))
  for (const img of images) {
    if (!img.complete || !(img.naturalWidth > 0) || !visible(img)) continue
    if (!sameOriginImage(img.currentSrc || img.src, img.ownerDocument.baseURI)) continue
    const r = img.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    const box = toLocal(map, r)
    ctx.save()
    ctx.globalAlpha = opacityUpTo(img, root)
    ctx.drawImage(img, box.x, box.y, box.w, box.h)
    ctx.restore()
  }
}

// —— 组件用的镜像 ——

/**
 * 一排段（分段控件的各段、标签栏的各格）画进场景的镜像：一个盖在它们上面的元素注册成位图填充，
 * 内容（文字、颜色、字体、图标）变了就作废，下次看得见时重画。`<glass-segmented>` 与 `<glass-tab-bar>` 共用。
 *
 * 平时镜像透明（不画、不占图集）；组件按住时让它不透明、把 DOM 的字淡出（见 ready）。
 */
/** SceneLabels 的「透镜里的那一份」：只在透镜的窗口里露出来，内容统一换成选中色。 */
export interface LensLabels {
  /** 与透镜同一个位置、大小、缩放的元素（Segments 的跟随者）：填充的盒子是它，内容按镜像元素的坐标画。 */
  readonly element: HTMLElement
  /** 透镜里的字与图标的颜色：选中那一段的计算颜色（没有选中时 undefined，用各自的颜色）。 */
  readonly color: () => string | undefined
}

export class SceneLabels {
  readonly #host: HTMLElement
  readonly #element: HTMLElement
  readonly #sources: () => readonly LabelSource[]
  readonly #lens: LensLabels | null
  #fill: SceneBitmapFill | null = null
  #lensFill: SceneBitmapFill | null = null
  readonly #observer: MutationObserver | null
  readonly #onFonts = (): void => this.invalidate()

  /**
   * @param host 组件宿主（段是它的子元素）
   * @param element 镜像元素：在影子树里、盖住各段，位图填充画在它的盒子里
   * @param sources 要画的元素（各段），每次重画时取
   * @param lens 透镜里的那一份（iOS 27 截图：拖动时透镜下的字都是选中色，透镜外还是原色）。它画在镜像之上、
   *   只在透镜的窗口里露出来 —— 位图填充的锚点，内容画一次、不跟着透镜重画
   */
  constructor(host: HTMLElement, element: HTMLElement, sources: () => readonly LabelSource[], lens?: LensLabels) {
    this.#host = host
    this.#element = element
    this.#sources = sources
    this.#lens = lens ?? null
    this.#observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => this.invalidate())
        : null
  }

  /**
   * 在 stage 上注册成位图填充（先镜像，再透镜里的那一份：按注册的顺序画，后者盖在前者上面），
   * 返回注销它们的函数（StageLink 的 attach 里调）。
   */
  attach(stage: GlassStage): () => void {
    const fill = stage.registerBitmapFill(this.#element, (ctx) =>
      paintContent(ctx, this.#element, this.#sources(), () => this.invalidate())
    )
    this.#fill = fill
    const lens = this.#lens
    const lensFill = lens
      ? stage.registerBitmapFill(
          lens.element,
          (ctx) => {
            const color = lens.color()
            const sources = this.#sources().map((s) => (color ? { ...s, color } : s))
            paintContent(ctx, this.#element, sources, () => this.invalidate())
          },
          { anchor: this.#element }
        )
      : null
    this.#lensFill = lensFill
    return () => {
      lensFill?.unregister()
      fill.unregister()
      if (this.#fill === fill) this.#fill = null
      if (this.#lensFill === lensFill) this.#lensFill = null
    }
  }

  /**
   * 镜像能用吗：注册过、玻璃真的在画（宿主有 data-glassium-active）、不在 CSS 画的模式（对话框、popover 里）。
   * 不能用时组件别把 DOM 的字藏起来。
   */
  get ready(): boolean {
    return this.#fill !== null && this.#host.hasAttribute(ACTIVE_ATTRIBUTE) && !this.#element.hasAttribute(OVERLAY_ATTRIBUTE)
  }

  /** 内容变了：下次看得见时重画。 */
  invalidate(): void {
    this.#fill?.invalidate()
    this.#lensFill?.invalidate()
  }

  /** 宿主进文档：开始盯着各段的变化（文字、子元素、类与样式）与字体加载。 */
  connect(): void {
    this.#observer?.observe(this.#host, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'src']
    })
    this.#host.ownerDocument.fonts?.addEventListener('loadingdone', this.#onFonts)
    this.invalidate()
  }

  disconnect(): void {
    this.#observer?.disconnect()
    this.#host.ownerDocument.fonts?.removeEventListener('loadingdone', this.#onFonts)
  }
}
