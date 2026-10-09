/**
 * CSS 画玻璃时的透镜（`<glass-tab-bar>` 按住、拖动、飞过去的那一下）。
 *
 * GPU 画的时候各格的内容画进场景，气泡就是真的透镜：放大、边缘扭弯、色散（scene-label.ts）。CSS 画的时候
 * （`backend: 'css'`、对话框 / popover 里）没有场景，`backdrop-filter` 也放大不了东西 —— 以前按住只是一块浅色鼓起来，
 * 底下的字原样不动。这里用一张 2D 画布补上：按住时 DOM 的各格淡出，画布逐帧画出
 *
 * - 透镜外：各格原样（与 DOM 逐像素同位，淡入淡出时看不出换了）；
 * - 透镜里：选中色的那一份。中间放大（按压越深越大，到 `magnify`），越靠左右两边越压缩，到边上与透镜外接上 ——
 *   凸透镜的边缘就是这样，单纯放大的话靠边的字会被推出透镜、看着像没了。横向按竖条逐条贴（lensMap），
 *   竖向整体放大。红、蓝两份在边上比选中色那份多偏 / 少偏一点，色散只出现在边缘那一圈；
 *
 * 透镜的形状每帧从气泡的 getBoundingClientRect 读（含按压的缩放、果冻、飞行），所以与气泡严丝合缝。
 * 两份内容各画一次到离屏画布（放大要用，画得比设备像素细 1.5 倍），之后每帧只是贴图，不再量字。
 * 只在按住到松手后过渡走完这段时间出帧，平时不跑。
 */

import { paintContent, type LabelSource } from '../renderer/paint-content.ts'
import { cancelFrame, nextFrame } from '../animation/timeline.ts'

/** 离屏的两份比设备像素细这么多倍：透镜放大之后不发虚（与 scene-label.ts 的 LENS_OVERSAMPLE 一样）。 */
const OVERSAMPLE = 1.5
/** 画布比宿主四边各大这么多（CSS 像素）：按住时气泡鼓起来，会伸出栏外一点。 */
export const CSS_LENS_BLEED = 16
/** 松手后再画这么久：气泡缩回、画布淡出的过渡（0.2s 与 0.12s）走完。 */
const LINGER_MS = 360
/** 色散：红、蓝两份在透镜边上比选中色那份多偏 / 少偏透镜半宽的这么多（按压到底时）。 */
const DISPERSION = 0.035
/** 透镜里横向逐条贴的竖条有多宽（CSS 像素）。 */
const STRIP_PX = 2
/** 压缩集中在边上多窄的一圈：越大越窄（lensMap 里的指数）。 */
const EDGE_POWER = 4

/**
 * 透镜里横向的映射：屏幕上离中心 u（-1 到 1，透镜半宽为 1）的地方显示内容里离中心多远的东西。
 * 中间是 u / m（放大 m 倍），到边上回到 ±1（与透镜外接上）；k 越大压缩越集中在边上。
 * 单调（导数 1/m + (1 − 1/m)·k·|u|^(k−1) > 0），不会把内容翻过来。
 */
export function lensMap(u: number, m: number, k = EDGE_POWER): number {
  const a = Math.abs(u)
  const inv = 1 / m
  return Math.sign(u) * (a * inv + (1 - inv) * a ** k)
}

export interface CssLensOptions {
  /** 宿主：各格是它的子元素。 */
  readonly host: HTMLElement
  /** 画布（在影子树里，盖住宿主、四边各伸出 CSS_LENS_BLEED）。 */
  readonly canvas: HTMLCanvasElement
  /** 气泡：透镜的形状与位置。 */
  readonly lens: HTMLElement
  /** 要画的元素（各格）。 */
  readonly sources: () => readonly LabelSource[]
  /** 透镜里的字与图标的颜色（选中那一格的颜色）。 */
  readonly color: () => string | undefined
  /** 按压到底时放大多少（0.2 = 1.2 倍）。 */
  readonly magnify: number
  /** 按压到底时气泡的竖直缩放（读它来算按压有多深）。 */
  readonly pressedScale: () => number
}

interface Layer {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
}

export class CssLens {
  readonly #o: CssLensOptions
  #plain: Layer | null = null
  #picked: Layer | null = null
  #red: Layer | null = null
  #blue: Layer | null = null
  #dirty = true
  #frame = 0
  #active = false
  #stopAt = 0

  constructor(options: CssLensOptions) {
    this.#o = options
  }

  /** 内容变了（文字、选中色、尺寸）：下一帧重画离屏的两份。 */
  invalidate(): void {
    this.#dirty = true
    if (this.#active || this.#frame) this.#schedule()
  }

  /** 按下 / 松开。松开后再画一小会儿，等过渡走完。 */
  press(on: boolean): void {
    if (on) {
      this.#active = true
      this.#schedule()
    } else if (this.#active) {
      this.#active = false
      this.#stopAt = performance.now() + LINGER_MS
      this.#schedule()
    }
  }

  /** 宿主离开文档：停下，丢掉离屏。 */
  release(): void {
    this.#active = false
    if (this.#frame) cancelFrame(this.#frame)
    this.#frame = 0
    this.#plain = this.#picked = this.#red = this.#blue = null
    this.#dirty = true
  }

  #schedule(): void {
    if (this.#frame) return
    this.#frame = nextFrame(() => {
      this.#frame = 0
      this.#draw()
      if (this.#active || performance.now() < this.#stopAt) this.#schedule()
    })
  }

  /** 画布与离屏按宿主的尺寸、设备像素比；内容变了就重画两份。 */
  #prepare(): number {
    const { host, canvas } = this.#o
    // 最多 2 倍：手机是 3 倍屏，按 3 倍画这张横跨整条栏的画布，飞过去的那一下每帧都要贴好几百条
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2)
    const w = host.offsetWidth + CSS_LENS_BLEED * 2
    const h = host.offsetHeight + CSS_LENS_BLEED * 2
    const pw = Math.max(1, Math.round(w * ratio))
    const ph = Math.max(1, Math.round(h * ratio))
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
      this.#dirty = true
    }
    const scale = ratio * OVERSAMPLE
    const ow = Math.max(1, Math.round(w * scale))
    const oh = Math.max(1, Math.round(h * scale))
    if (!this.#plain || this.#plain.canvas.width !== ow || this.#plain.canvas.height !== oh) {
      this.#plain = layer(ow, oh)
      this.#picked = layer(ow, oh)
      this.#red = layer(ow, oh)
      this.#blue = layer(ow, oh)
      this.#dirty = true
    }
    if (this.#dirty && this.#plain && this.#picked && this.#red && this.#blue) {
      this.#dirty = false
      const sources = this.#o.sources()
      const color = this.#o.color()
      paintLayer(this.#plain, scale, (ctx) => paintContent(ctx, canvas, sources, () => this.invalidate()))
      paintLayer(this.#picked, scale, (ctx) =>
        paintContent(ctx, canvas, color ? sources.map((s) => ({ ...s, color })) : sources, () => this.invalidate())
      )
      tinted(this.#red, this.#picked.canvas, 'rgb(255, 40, 90)')
      tinted(this.#blue, this.#picked.canvas, 'rgb(40, 150, 255)')
    }
    return ratio
  }

  #draw(): void {
    const ctx = this.#o.canvas.getContext('2d')
    if (!ctx) return
    const ratio = this.#prepare()
    const plain = this.#plain
    const picked = this.#picked
    if (!plain || !picked || !this.#red || !this.#blue) return
    const { canvas, lens } = this.#o
    const w = canvas.width / ratio
    const h = canvas.height / ratio
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)

    // 透镜在画布里的位置（CSS 像素）。画布本身有变换（宿主被缩放）时按比例换回来
    const c = canvas.getBoundingClientRect()
    const b = lens.getBoundingClientRect()
    const sx = c.width > 0 ? w / c.width : 1
    const sy = c.height > 0 ? h / c.height : 1
    const lx = (b.left - c.left) * sx
    const ly = (b.top - c.top) * sy
    const lw = b.width * sx
    const lh = b.height * sy
    const hasLens = lw > 1 && lh > 1

    // 透镜外：原样，挖掉透镜那块
    ctx.save()
    if (hasLens) {
      ctx.beginPath()
      ctx.rect(0, 0, w, h)
      pill(ctx, lx, ly, lw, lh)
      ctx.clip('evenodd')
    }
    ctx.drawImage(plain.canvas, 0, 0, w, h)
    ctx.restore()
    if (!hasLens) return

    // 按压有多深：气泡的竖直缩放（果冻对竖直方向影响小）在 1 与按到底之间的位置
    const rest = lens.offsetHeight
    const full = this.#o.pressedScale()
    const depth = rest > 0 && full > 1 ? clamp((lh / rest - 1) / (full - 1)) : 0
    const m = 1 + this.#o.magnify * depth
    const cx = lx + lw / 2
    const cy = ly + lh / 2
    const half = lw / 2
    const disp = DISPERSION * depth

    // 透镜里：竖向整体绕中心放大 m 倍；横向逐条贴，每条从内容里取 lensMap 映射过去的那一窄条。
    // 红、蓝两份画在下面，边上多偏 / 少偏一点（色散）
    ctx.save()
    ctx.beginPath()
    pill(ctx, lx, ly, lw, lh)
    ctx.clip()
    const k = plain.canvas.width / w // 离屏每 CSS 像素几个像素
    const srcH = lh / m // 竖向：透镜的高对应内容里这么高
    const srcY = cy - srcH / 2
    const strips = Math.max(1, Math.ceil(lw / STRIP_PX))
    const sw = lw / strips
    const layers: Array<[HTMLCanvasElement, number, number]> =
      disp > 0.001
        ? [
            [this.#red.canvas, 1 + disp, 0.55],
            [this.#blue.canvas, 1 - disp, 0.55],
            [picked.canvas, 1, 1]
          ]
        : [[picked.canvas, 1, 1]]
    for (const [image, spread, alpha] of layers) {
      ctx.globalAlpha = alpha
      for (let i = 0; i < strips; i++) {
        const x0 = lx + i * sw
        const u0 = (x0 - cx) / half
        const u1 = (x0 + sw - cx) / half
        // 红、蓝两份在中间那段（离中心不到 55%）与选中色那份重合、被它盖住：不贴，省掉大半的贴图
        if (spread !== 1 && Math.max(Math.abs(u0), Math.abs(u1)) < 0.55) continue
        // 色散只在边上：偏多偏少按 |u|^k 加权，中间与选中色那份重合
        const s0 = cx + lensMap(u0, m) * half * (1 + (spread - 1) * Math.abs(u0) ** EDGE_POWER)
        const s1 = cx + lensMap(u1, m) * half * (1 + (spread - 1) * Math.abs(u1) ** EDGE_POWER)
        const sx0 = Math.min(s0, s1)
        const sww = Math.max(Math.abs(s1 - s0), 1 / k)
        ctx.drawImage(image, sx0 * k, srcY * k, sww * k, srcH * k, x0, ly, sw + 0.05, lh)
      }
    }
    ctx.globalAlpha = 1
    ctx.restore()
  }
}

function layer(w: number, h: number): Layer {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('CssLens：拿不到 2D 上下文')
  return { canvas, ctx }
}

function paintLayer(l: Layer, scale: number, paint: (ctx: CanvasRenderingContext2D) => void): void {
  l.ctx.setTransform(1, 0, 0, 1, 0, 0)
  l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height)
  l.ctx.setTransform(scale, 0, 0, scale, 0, 0)
  paint(l.ctx)
}

/** 把 source 的形状染成一种颜色画进 l（色散用的红、蓝两份）。 */
function tinted(l: Layer, source: HTMLCanvasElement, color: string): void {
  const ctx = l.ctx
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, l.canvas.width, l.canvas.height)
  ctx.drawImage(source, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, l.canvas.width, l.canvas.height)
  ctx.globalCompositeOperation = 'source-over'
}

/** 胶囊（圆角 = 短边的一半）。 */
function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = Math.min(w, h) / 2
  ctx.roundRect(x, y, w, h, r)
}

function clamp(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0
}
