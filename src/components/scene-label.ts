/**
 * 组件的文字进场景：`<glass-segmented>`、`<glass-tab-bar>` 按住时把各段的文字、图标画进场景（SceneLabels）。
 * 怎么画在 renderer/paint-content.ts（DOM Renderer 也用它）；这里只是一排段的镜像：注册成位图填充、内容变了作废重画。
 */

import { OVERLAY_ATTRIBUTE, type SceneBitmapFill } from '../renderer/panels.ts'
import type { GlassStage } from '../renderer/stage.ts'
import { ACTIVE_ATTRIBUTE } from '../runtime/binding.ts'
import { paintContent, type LabelSource } from '../renderer/paint-content.ts'

// 原来都在这个文件里：照旧从这里也能拿到
export {
  baselineIn,
  canvasFont,
  canvasIsClean,
  objectFitRect,
  paintContent,
  sameOriginImage,
  serializeSvg,
  videoIsClean,
  type LabelSource,
  type PaintOptions
} from '../renderer/paint-content.ts'

export interface LensLabels {
  /** 与透镜同一个位置、大小、缩放的元素（Segments 的跟随者）：填充的盒子是它，内容按镜像元素的坐标画。 */
  readonly element: HTMLElement
  /** 透镜里的字与图标的颜色：选中那一段的计算颜色（没有选中时 undefined，用各自的颜色）。 */
  readonly color: () => string | undefined
}

/**
 * 透镜里的那一份画得比设备像素细几倍：按住时透镜把它放大 1.2 倍（SEGMENT_THUMB_PRESSED.magnify）、边缘还要再拉，
 * 按 1 倍画放大之后发虚。
 */
const LENS_OVERSAMPLE = 1.5

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
    const lens = this.#lens
    // 镜像在透镜的窗口里挖掉（hole）：那里只有选中色的那一份，半透明的边缘底下不再垫着原色
    const fill = stage.registerBitmapFill(
      this.#element,
      (ctx) => paintContent(ctx, this.#element, this.#sources(), () => this.invalidate()),
      lens ? { hole: lens.element } : {}
    )
    this.#fill = fill
    const lensFill = lens
      ? stage.registerBitmapFill(
          lens.element,
          (ctx) => {
            const color = lens.color()
            const sources = this.#sources().map((s) => (color ? { ...s, color } : s))
            paintContent(ctx, this.#element, sources, () => this.invalidate())
          },
          { anchor: this.#element, oversample: LENS_OVERSAMPLE }
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
