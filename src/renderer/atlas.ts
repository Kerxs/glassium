/**
 * 位图填充的图集：一张共享的 2D 画布，每块位图填充在里面占一格（货架式分配）。
 *
 * 位图填充（panels.ts 的 registerBitmapFill）把元素里的内容 —— 分段控件、标签栏的文字与图标 —— 画进场景，
 * 玻璃就能折射、放大它（iOS 26 按住选中块时底下的字被放大、在边缘扭弯，靠的就是这个）。内容先用 2D 画布画进
 * 图集里自己那一格，后端把整张图集传成一张纹理，填充着色器按格子的 uv 取样。
 *
 * - 分配：货架式。一排排往下摆，一排的高是这一排里最高的那格；格子四周留 GUTTER 像素的空隙，
 *   线性过滤时不会串到邻居。
 * - 满了：整张清空、代数（generation）加一，大家重新分配、重画 —— 格子是按需画的（只有看得见的位图填充才画），
 *   所以清空的代价就是下一帧把看得见的那几块重画一遍。一格放不进空图集时图集长大一倍（到 MAX_SIZE 为止）。
 * - 版本（version）：内容每变一次加一，后端按它判断要不要重新上传。
 * - 局部上传：每画一格记一笔（版本 + 格子连空隙的矩形）。后端记着自己传到了哪个版本，`dirtySince(版本)` 给出之后画过的
 *   那几块（合并过），只传它们 —— 视频在玻璃后面播放时每出一帧只传它那一格，不是整张图集。清空、长大、记录太旧
 *   时返回 null：整张传。
 */

/** 格子四周的空隙，像素。线性过滤最多读到相邻一个像素。 */
export const ATLAS_GUTTER = 1
/** 初始边长与上限，像素。上限取 WebGL2 保证的最小 MAX_TEXTURE_SIZE（2048）。 */
export const ATLAS_INITIAL_SIZE = 1024
export const ATLAS_MAX_SIZE = 2048

/**
 * 位图填充在图集里画多大：fit 是一个设备像素画成几个图集像素 —— 默认 1（与旁边的 DOM 一样锐利），
 * oversample > 1 画得更细（透镜放大之后不虚）；比一格的上限还大就整体缩小。
 */
export function rasterFit(
  deviceW: number,
  deviceH: number,
  maxCell: number,
  oversample = 1
): { readonly fit: number; readonly pxW: number; readonly pxH: number } {
  const fit = Math.min(Math.max(1, oversample), maxCell / deviceW, maxCell / deviceH)
  return { fit, pxW: Math.max(1, Math.ceil(deviceW * fit)), pxH: Math.max(1, Math.ceil(deviceH * fit)) }
}

/**
 * 位图填充的 uv（填充着色器的 geom）：xy 是填充盒子原点在图集里的 uv，zw 是一个设备像素的 uv 步长。
 * 画的那块（target，元素自己或者锚点）的原点在格子的左上角；盒子原点与它不同（有锚点）时 uv 的原点跟着挪，
 * 只露出锚点画面里盒子盖住的那一块。坐标都是画布设备像素。
 */
export function bitmapUv(
  cell: { readonly x: number; readonly y: number },
  target: { readonly x: number; readonly y: number },
  boxX: number,
  boxY: number,
  fit: number,
  atlasW: number,
  atlasH: number
): [number, number, number, number] {
  return [
    (cell.x + (boxX - target.x) * fit) / atlasW,
    (cell.y + (boxY - target.y) * fit) / atlasH,
    fit / atlasW,
    fit / atlasH
  ]
}

export interface AtlasCell {
  /** 格子的左上角与尺寸（不含空隙），图集像素。 */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** 分配时图集的代数：图集清空过（代数变了）这一格就不算数了。 */
  readonly generation: number
}

interface Shelf {
  readonly y: number
  readonly h: number
  /** 这一排已经用到的宽度（含空隙）。 */
  used: number
}

/** 货架式分配器（纯计算，单元测试直接测它）。 */
export class ShelfAllocator {
  readonly #shelves: Shelf[] = []
  #bottom = 0
  readonly width: number
  readonly height: number
  readonly gutter: number

  constructor(width: number, height: number, gutter = ATLAS_GUTTER) {
    this.width = width
    this.height = height
    this.gutter = gutter
  }

  /** 分配 w×h 的一格（不含空隙）。放不下返回 null。 */
  allocate(w: number, h: number): { x: number; y: number } | null {
    const g = this.gutter
    const cw = Math.ceil(w) + 2 * g
    const ch = Math.ceil(h) + 2 * g
    if (!(w > 0 && h > 0) || cw > this.width || ch > this.height) return null
    // 放进已有的一排：够高、剩下的够宽，挑最矮的那排（少浪费）
    let best: Shelf | null = null
    for (const s of this.#shelves) {
      if (s.h >= ch && this.width - s.used >= cw && (!best || s.h < best.h)) best = s
    }
    if (best) {
      const x = best.used
      best.used += cw
      return { x: x + g, y: best.y + g }
    }
    // 新开一排
    if (this.#bottom + ch > this.height) return null
    const shelf: Shelf = { y: this.#bottom, h: ch, used: cw }
    this.#shelves.push(shelf)
    this.#bottom += ch
    return { x: g, y: shelf.y + g }
  }

  reset(): void {
    this.#shelves.length = 0
    this.#bottom = 0
  }
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** 图集里的一块矩形，图集像素。 */
export interface AtlasRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 记录最多留这么多笔：再旧的版本要整张传。 */
export const ATLAS_LOG_SIZE = 64
/** 合并后的块超过这么多：并成一个外接矩形。 */
export const ATLAS_MAX_UPLOAD_RECTS = 8
/** 要传的面积超过整张的这么多：干脆整张传（一次调用比很多块省事，也不慢多少）。 */
export const ATLAS_FULL_UPLOAD_RATIO = 0.5

/**
 * 把几块脏矩形合并成要上传的块（纯计算）：重叠或相接的并起来；块太多时并成一个外接矩形；
 * 面积超过整张的 ATLAS_FULL_UPLOAD_RATIO 时返回 null（整张传）。空数组返回空数组。
 */
export function mergeDirtyRects(rects: readonly AtlasRect[], width: number, height: number): AtlasRect[] | null {
  const clip = (r: AtlasRect): AtlasRect | null => {
    const x0 = Math.max(0, Math.floor(r.x))
    const y0 = Math.max(0, Math.floor(r.y))
    const x1 = Math.min(width, Math.ceil(r.x + r.w))
    const y1 = Math.min(height, Math.ceil(r.y + r.h))
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
  }
  const touches = (a: AtlasRect, b: AtlasRect): boolean =>
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
  const union = (a: AtlasRect, b: AtlasRect): AtlasRect => {
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
  }
  let out: AtlasRect[] = []
  for (const r of rects) {
    let cur = clip(r)
    if (!cur) continue
    // 与已有的块相接就并进去；并完的块可能又碰到别的，重新扫一遍
    for (let merged = true; merged; ) {
      merged = false
      for (let i = 0; i < out.length; i++) {
        if (touches(out[i]!, cur)) {
          cur = union(out[i]!, cur)
          out.splice(i, 1)
          merged = true
          break
        }
      }
    }
    out.push(cur)
  }
  if (out.length > ATLAS_MAX_UPLOAD_RECTS) out = [out.reduce(union)]
  const area = out.reduce((a, r) => a + r.w * r.h, 0)
  return area > width * height * ATLAS_FULL_UPLOAD_RATIO ? null : out
}

/** 共享的图集画布。拿不到 2D 画布（单元测试、很老的环境）时 create 返回 null，位图填充就不画。 */
export class LabelAtlas {
  canvas: OffscreenCanvas | HTMLCanvasElement
  context: Context2D
  /** 清空重排一次加一。 */
  generation = 0
  /** 内容变一次加一（画了一格、清空、长大）。 */
  version = 0
  #allocator: ShelfAllocator
  /** 画过的格子：版本与矩形（含空隙），按版本递增。 */
  readonly #log: { readonly version: number; readonly rect: AtlasRect }[] = []
  /** 最近一次整张都变了（清空、长大）时的版本。 */
  #fullAt = 0

  private constructor(canvas: OffscreenCanvas | HTMLCanvasElement, context: Context2D) {
    this.canvas = canvas
    this.context = context
    this.#allocator = new ShelfAllocator(canvas.width, canvas.height)
  }

  static create(size = ATLAS_INITIAL_SIZE): LabelAtlas | null {
    const made = makeCanvas(size)
    return made ? new LabelAtlas(made.canvas, made.context) : null
  }

  get width(): number {
    return this.canvas.width
  }

  get height(): number {
    return this.canvas.height
  }

  /** 一格最大能多大（不含空隙）：超过它的内容要缩小了再画。 */
  get maxCell(): number {
    return ATLAS_MAX_SIZE - 2 * ATLAS_GUTTER
  }

  /**
   * 分配 w×h 的一格。放不下就清空重排（代数加一：别的格子都作废）；空图集也放不下就长大一倍再试。
   * 仍然放不下（比上限还大）返回 null —— 调用方应当先按 maxCell 缩小。
   */
  allocate(w: number, h: number): AtlasCell | null {
    let at = this.#allocator.allocate(w, h)
    if (!at) {
      this.#clear()
      at = this.#allocator.allocate(w, h)
    }
    while (!at && this.canvas.width < ATLAS_MAX_SIZE) {
      this.#grow()
      at = this.#allocator.allocate(w, h)
    }
    if (!at) return null
    return { x: at.x, y: at.y, w: Math.ceil(w), h: Math.ceil(h), generation: this.generation }
  }

  /**
   * 从 version（后端上次传完时的版本）到现在画过的块，合并过、裁在图集里。null 表示要整张传：
   * 中间清空或长大过、记录已经丢了，或者要传的面积太大。版本没变返回空数组。
   */
  dirtySince(version: number): AtlasRect[] | null {
    if (version === this.version) return []
    if (version < this.#fullAt || version > this.version) return null
    const first = this.#log[0]
    // 记录只留最近的几笔：version 之后的第一笔已经丢了
    if (!first || first.version > version + 1) return null
    const rects = this.#log.filter((e) => e.version > version).map((e) => e.rect)
    return mergeDirtyRects(rects, this.width, this.height)
  }

  /** 这一格还有效吗（图集没清空过）。 */
  holds(cell: AtlasCell | null | undefined): cell is AtlasCell {
    return !!cell && cell.generation === this.generation
  }

  /**
   * 往一格里画：先把这一格（连同空隙）清成透明，裁到格子里，原点挪到格子左上角、按 scale 缩放，再调 paint。
   * paint 抛错时这一格留空（透明），错误照样抛给调用方。
   */
  draw(cell: AtlasCell, scale: number, paint: (ctx: Context2D) => void): void {
    const ctx = this.context
    const g = ATLAS_GUTTER
    ctx.save()
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(cell.x - g, cell.y - g, cell.w + 2 * g, cell.h + 2 * g)
      ctx.beginPath()
      ctx.rect(cell.x, cell.y, cell.w, cell.h)
      ctx.clip()
      ctx.setTransform(scale, 0, 0, scale, cell.x, cell.y)
      paint(ctx)
    } finally {
      ctx.restore()
      this.version++
      this.#log.push({ version: this.version, rect: { x: cell.x - g, y: cell.y - g, w: cell.w + 2 * g, h: cell.h + 2 * g } })
      if (this.#log.length > ATLAS_LOG_SIZE) this.#log.shift()
    }
  }

  #clear(): void {
    this.#allocator.reset()
    this.context.setTransform(1, 0, 0, 1, 0, 0)
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.generation++
    this.version++
    this.#fullAt = this.version
    this.#log.length = 0
  }

  #grow(): void {
    const size = Math.min(this.canvas.width * 2, ATLAS_MAX_SIZE)
    const made = makeCanvas(size)
    if (!made) return
    this.canvas = made.canvas
    this.context = made.context
    this.#allocator = new ShelfAllocator(size, size)
    this.generation++
    this.version++
    this.#fullAt = this.version
    this.#log.length = 0
  }
}

function makeCanvas(size: number): { canvas: OffscreenCanvas | HTMLCanvasElement; context: Context2D } | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(size, size)
      const context = canvas.getContext('2d')
      if (context) return { canvas, context }
    }
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')
      if (context) return { canvas, context }
    }
  } catch {
    // 拿不到 2D 画布：不画位图填充
  }
  return null
}
