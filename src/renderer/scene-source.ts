/**
 * 用户场景：玻璃后面画一张图、一段视频或一块画布。
 *
 * 这里把用户给的源变成每帧交给后端的 SceneImage。三类源的处理不同：
 *
 * - **图片**（URL、Blob、<img>、ImageBitmap、ImageData）：先用 createImageBitmap 缩到场景分辨率，
 *   只上传一次。大图直接上传、在着色器里双线性缩小会闪摩尔纹（一个屏幕像素跨过好几个图片像素，
 *   只采到其中一个）。视口变了就在后台重新缩放，新位图好之前继续用旧的 —— uv 变换与位图大小无关，
 *   旧位图照样铺得对，只是清晰度差一点，不会闪。
 * - **画布**（<canvas>、OffscreenCanvas、VideoFrame）：原样上传。内容变了由调用方 refresh()，
 *   或者设 dynamic 每帧都传。
 * - **视频**：有 requestVideoFrameCallback 时只在出新帧时上传（30fps 的视频在 60Hz 屏上
 *   少传一半）；没有时每帧都传。
 *
 * 换场景时旧场景一直画到新场景就绪为止，中间不闪。
 */

import { parseTint } from '../core/material.ts'
import { sceneBitmapSize, sceneCssBackground, sceneUvTransform, type SceneFit } from '../core/scene.ts'
import type { ResolvedViewport } from '../core/units.ts'
import type { SceneImage, SceneImageSource } from './backend.ts'

/** setScene 接受的源：图片 URL、Blob（比如 `<input type="file">` 选中的文件），或能直接上传的图像源。 */
export type GlassSceneSource = SceneImageSource | Blob | string

export interface SceneOptions {
  /** 怎么铺进视口，语义同 CSS 的 object-fit。默认 'cover'。 */
  readonly fit?: SceneFit
  /** contain 留白处、图片透明处、以及初始场景加载完成之前的底色。CSS 颜色，alpha 不用。默认黑色。 */
  readonly background?: string
  /**
   * 内容会不会自己变。视频默认 true，画布默认 false。
   *
   * 设成 true 的画布每帧都重新上传；false 的画布重画之后要调 refreshScene()。
   * 视频设成 false 就停在当前帧，直到 refreshScene()。
   *
   * 图片（URL、Blob、<img>、ImageBitmap、ImageData）不看这一项：上传的是预先缩放好的一张位图，
   * 每帧重传也还是同一张。动图（GIF、动画 WebP）因此只有第一帧 —— 要动画请用 <video>。
   */
  readonly dynamic?: boolean
}

/** 当前场景是哪一类。'builtin' 是内置的程序化场景（debug.setBackdrop 的 scene）。 */
export type SceneKind = 'builtin' | 'image' | 'canvas' | 'video'

const FITS: readonly string[] = ['cover', 'contain', 'fill']

interface Loaded {
  readonly kind: Exclude<SceneKind, 'builtin'>
  readonly source: SceneImageSource
  /** 没有 GPU 时能拿来当 CSS 背景的 URL。 */
  readonly url: string | null
  /** 释放加载时占用的东西（Blob 的 object URL）。 */
  readonly release: () => void
}

interface Active {
  readonly loaded: Loaded
  readonly fit: SceneFit
  readonly background: readonly [number, number, number]
  readonly backgroundCss: string
  /** 每帧上传：dynamic 的画布、没有 requestVideoFrameCallback 的视频。 */
  readonly everyFrame: boolean
  /** 图片：缩放好的位图（我们建的，由我们关），以及它是按什么尺寸缩的。 */
  bitmap: ImageBitmap | null
  bitmapKey: string
  preparing: boolean
  version: number
  stop: () => void
}

const noop = (): void => {}

/** 源的固有像素尺寸。 */
export function intrinsicSize(source: SceneImageSource): readonly [number, number] {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return [source.naturalWidth, source.naturalHeight]
  }
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return [source.videoWidth, source.videoHeight]
  }
  if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
    return [source.displayWidth, source.displayHeight]
  }
  const sized = source as ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas
  return [sized.width, sized.height]
}

function aborted(): DOMException {
  return new DOMException('[Glassium] 这次 setScene 被后一次调用取代了', 'AbortError')
}

function loadImage(url: string, label: string): Promise<HTMLImageElement> {
  const img = new Image()
  // 不设的话，没有 CORS 的跨源图片能显示却传不进 GPU（它会污染上传），错误来得更晚、也更难懂。
  // 设了之后这样的图片直接加载失败，在这里就能报清楚。
  img.crossOrigin = 'anonymous'
  img.decoding = 'async'
  img.src = url
  return img.decode().then(
    () => img,
    () => {
      // 加载失败时浏览器不告诉页面原因（404、格式不支持、CORS 都是同一个错误）。
      // 能分辨的只有是不是跨源 —— 跨源时 CORS 是最常见的原因，同源时提它反而误导。
      const hint = isCrossOrigin(url)
        ? '跨源图片需要服务器返回 Access-Control-Allow-Origin 头'
        : '检查地址是否正确、浏览器是否支持这种格式'
      throw new Error(`[Glassium] 场景图片加载失败：${label}。${hint}`)
    }
  )
}

function isCrossOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin !== location.origin
  } catch {
    return false
  }
}

function videoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const done = (): void => {
      video.removeEventListener('loadeddata', ok)
      video.removeEventListener('error', fail)
    }
    const ok = (): void => {
      done()
      resolve()
    }
    const fail = (): void => {
      done()
      reject(new Error(`[Glassium] 场景视频加载失败：${video.currentSrc || video.src || '（没有 src）'}`))
    }
    video.addEventListener('loadeddata', ok)
    video.addEventListener('error', fail)
  })
}

/**
 * 跨源又没有 CORS 授权的源，浏览器不允许传进 GPU。上传时才发现的话只能在帧循环里警告；
 * 在 setScene 里画一个像素到 2D 画布上试读一下，就能当场拒绝、说清原因。
 */
function assertOriginClean(source: SceneImageSource): void {
  if (source instanceof ImageData) return // 像素数组，没有来源可言
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : Object.assign(document.createElement('canvas'), { width: 1, height: 1 })
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) return // 查不了就不查，上传失败时后端会警告
  ctx.drawImage(source, 0, 0, 1, 1, 0, 0, 1, 1)
  try {
    ctx.getImageData(0, 0, 1, 1)
  } catch {
    throw new Error(
      '[Glassium] 场景源是跨源的，而且没有 CORS 授权，浏览器不允许把它传进 GPU。' +
        '图片与视频请设 crossOrigin="anonymous"，并让服务器返回 Access-Control-Allow-Origin 头'
    )
  }
}

async function load(source: GlassSceneSource): Promise<Loaded> {
  if (typeof source === 'string') {
    const img = await loadImage(source, source)
    return { kind: 'image', source: img, url: source, release: noop }
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const url = URL.createObjectURL(source)
    const label = typeof File !== 'undefined' && source instanceof File ? source.name : `Blob（${source.type || '类型未知'}）`
    try {
      const img = await loadImage(url, label)
      return { kind: 'image', source: img, url, release: () => URL.revokeObjectURL(url) }
    } catch (err) {
      URL.revokeObjectURL(url)
      throw err
    }
  }
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    try {
      await source.decode()
    } catch {
      throw new Error(`[Glassium] <img> 没有加载成功：${source.currentSrc || source.src || '（没有 src）'}`)
    }
    return { kind: 'image', source, url: source.currentSrc || source.src || null, release: noop }
  }
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    await videoReady(source)
    assertOriginClean(source)
    return { kind: 'video', source, url: null, release: noop }
  }
  if (source instanceof ImageBitmap || source instanceof ImageData) {
    return { kind: 'image', source, url: null, release: noop }
  }
  // 上面的 typeof 守卫让 TS 收窄不掉那几种类型；走到这里的只剩画布与 VideoFrame
  const direct = source as HTMLCanvasElement | OffscreenCanvas | VideoFrame
  assertOriginClean(direct)
  return { kind: 'canvas', source: direct, url: null, release: noop }
}

function prepareBitmap(source: SceneImageSource, width: number, height: number): Promise<ImageBitmap> {
  return createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
}

/** 没有视口时（刚换过画布）估一个场景尺寸。下一帧量到真实视口后不对会自己重新缩放。 */
function estimateTarget(): readonly [number, number] {
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
  return [Math.max(1, Math.round(innerWidth * dpr)), Math.max(1, Math.round(innerHeight * dpr))]
}

function parseBackground(css: string): readonly [number, number, number] {
  const [r, g, b] = parseTint(css)
  return [r, g, b]
}

/** 校验选项。写错在 setScene 里当场报，而不是在帧循环里。 */
function resolveOptions(options: SceneOptions): {
  readonly fit: SceneFit
  readonly background: readonly [number, number, number]
  readonly backgroundCss: string
} {
  const fit = options.fit ?? 'cover'
  if (!FITS.includes(fit)) {
    throw new Error(`[Glassium] 场景的 fit 只能是 ${FITS.join(' / ')}，收到 ${String(fit)}`)
  }
  const backgroundCss = options.background ?? '#000'
  return { fit, background: parseBackground(backgroundCss), backgroundCss }
}

/**
 * 没有 GPU 时的 setScene：能写成 CSS 背景的源（URL、<img>、Blob）就写到画布的 CSS 背景上，
 * 页面照样有这张背景图。返回 CSS 与释放函数；表达不了的源返回 null。
 */
export function sceneFallbackCss(
  source: GlassSceneSource | null,
  options: SceneOptions = {}
): { readonly css: string; readonly release: () => void } | null {
  if (source === null) return null
  const { fit, backgroundCss } = resolveOptions(options)
  if (typeof source === 'string') return { css: sceneCssBackground(source, fit, backgroundCss), release: noop }
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    const url = source.currentSrc || source.src
    return url ? { css: sceneCssBackground(url, fit, backgroundCss), release: noop } : null
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const url = URL.createObjectURL(source)
    return { css: sceneCssBackground(url, fit, backgroundCss), release: () => URL.revokeObjectURL(url) }
  }
  return null
}

/**
 * 一个 stage 的场景槽：当前场景、正在加载的场景、每帧的 SceneImage。
 *
 * @param viewport 当前视口（没有时为 null）
 * @param changed  场景内容变了、需要重画一帧
 */
export class SceneSlot {
  readonly #viewport: () => ResolvedViewport | null
  readonly #changed: () => void
  #current: Active | null = null
  /** 初始场景加载完成之前画的纯色（一个透明像素叠在底色上）。 */
  #placeholder: SceneImage | null = null
  #token = 0
  #disposed = false

  constructor(viewport: () => ResolvedViewport | null, changed: () => void) {
    this.#viewport = viewport
    this.#changed = changed
  }

  get kind(): SceneKind {
    return this.#current?.loaded.kind ?? 'builtin'
  }

  /**
   * 初始场景（createGlassStage 的 scene 选项）加载期间先画底色，免得先闪一下内置场景的图案。
   * 加载成功或失败都会撤掉它。
   */
  showPlaceholder(options: SceneOptions = {}): void {
    const { background } = resolveOptions(options)
    this.#placeholder = {
      source: new ImageData(1, 1), // 全透明：着色器把它叠在底色上，结果就是底色
      width: 1,
      height: 1,
      version: 0,
      dynamic: false,
      uvScale: [1, 1],
      uvOffset: [0, 0],
      background
    }
    this.#changed()
  }

  async set(source: GlassSceneSource | null, options: SceneOptions = {}): Promise<void> {
    const token = ++this.#token
    const settled = (): boolean => token === this.#token && !this.#disposed
    try {
      const { fit, background, backgroundCss } = resolveOptions(options)
      if (source === null) {
        this.#replace(null)
        return
      }
      const loaded = await load(source)
      if (!settled()) {
        loaded.release()
        throw aborted()
      }

      let bitmap: ImageBitmap | null = null
      let bitmapKey = ''
      if (loaded.kind === 'image') {
        const [iw, ih] = intrinsicSize(loaded.source)
        if (!(iw > 0 && ih > 0)) {
          loaded.release()
          throw new Error('[Glassium] 场景图片的尺寸是 0')
        }
        const vp = this.#viewport()
        const [tw, th] = vp ? [vp.sceneWidth, vp.sceneHeight] : estimateTarget()
        const [w, h] = sceneBitmapSize(tw, th, iw, ih, fit)
        try {
          bitmap = await prepareBitmap(loaded.source, w, h)
          assertOriginClean(bitmap)
        } catch (err) {
          bitmap?.close()
          loaded.release()
          throw err
        }
        bitmapKey = `${w}x${h}`
        if (!settled()) {
          bitmap.close()
          loaded.release()
          throw aborted()
        }
      }

      const video =
        loaded.kind === 'video' && loaded.source instanceof HTMLVideoElement ? loaded.source : null
      const dynamic = loaded.kind !== 'image' && (options.dynamic ?? loaded.kind === 'video')
      // 视频有新帧回调时按帧递增版本号，只在真的出新帧时上传；没有这个 API 才每帧都传
      const frameCallbacks = video !== null && dynamic && typeof video.requestVideoFrameCallback === 'function'
      const active: Active = {
        loaded,
        fit,
        background,
        backgroundCss,
        everyFrame: dynamic && !frameCallbacks,
        bitmap,
        bitmapKey,
        preparing: false,
        version: 0,
        stop: noop
      }
      if (frameCallbacks && video) {
        let handle = 0
        const onFrame = (): void => {
          active.version++
          handle = video.requestVideoFrameCallback(onFrame)
        }
        handle = video.requestVideoFrameCallback(onFrame)
        active.stop = () => video.cancelVideoFrameCallback(handle)
      }
      this.#replace(active)
    } catch (err) {
      // 已经被后一次调用取代：不管自己是怎么失败的，都报 AbortError —— 调用方只需要忽略这一种
      if (!settled()) throw aborted()
      // 初始场景没加载成：撤掉占位的底色，退回内置场景
      if (this.#current === null && this.#placeholder !== null) {
        this.#placeholder = null
        this.#changed()
      }
      throw err
    }
  }

  /** 非 dynamic 的源内容变了：画布与视频下一帧重新上传，图片重新缩放。 */
  refresh(): void {
    const a = this.#current
    if (!a) return
    if (a.loaded.kind === 'image') a.bitmapKey = ''
    else a.version++
    this.#changed()
  }

  /** 这一帧交给后端的场景。没有用户场景时返回 null（后端画内置场景）。 */
  frame(viewport: ResolvedViewport): SceneImage | null {
    const a = this.#current
    if (!a) return this.#placeholder
    const [iw, ih] = intrinsicSize(a.loaded.source)
    if (!(iw > 0 && ih > 0)) return this.#placeholder
    const uv = sceneUvTransform(viewport.cssWidth, viewport.cssHeight, iw, ih, a.fit)

    let source: SceneImageSource = a.loaded.source
    let width = iw
    let height = ih
    if (a.loaded.kind === 'image') {
      this.#refit(a, viewport, iw, ih)
      if (!a.bitmap) return this.#placeholder
      source = a.bitmap
      width = a.bitmap.width
      height = a.bitmap.height
    }
    return {
      source,
      width,
      height,
      version: a.version,
      dynamic: a.everyFrame,
      uvScale: uv.scale,
      uvOffset: uv.offset,
      background: a.background
    }
  }

  /** 没有 GPU 时画布该用的 CSS 背景。当前场景写不成 CSS 时返回 null。 */
  fallbackCss(): string | null {
    const a = this.#current
    if (!a || !a.loaded.url) return null
    return sceneCssBackground(a.loaded.url, a.fit, a.backgroundCss)
  }

  dispose(): void {
    this.#disposed = true
    this.#token++
    this.#replace(null)
  }

  /** 视口变了、图片需要的像素数跟着变：在后台重新缩放。同一时刻只有一个在做。 */
  #refit(a: Active, viewport: ResolvedViewport, iw: number, ih: number): void {
    if (a.preparing) return
    const [w, h] = sceneBitmapSize(viewport.sceneWidth, viewport.sceneHeight, iw, ih, a.fit)
    const key = `${w}x${h}`
    if (key === a.bitmapKey) return
    a.preparing = true
    prepareBitmap(a.loaded.source, w, h).then(
      (bitmap) => {
        a.preparing = false
        if (this.#current !== a) {
          bitmap.close()
          return
        }
        a.bitmap?.close()
        a.bitmap = bitmap
        a.bitmapKey = key
        this.#changed()
      },
      (err: unknown) => {
        a.preparing = false
        a.bitmapKey = key // 这个尺寸不再重试，继续用旧位图
        console.warn(`[Glassium] 场景图片按新视口重新缩放失败，继续用旧的：${String(err)}`)
      }
    )
  }

  #replace(next: Active | null): void {
    const prev = this.#current
    if (prev) {
      prev.stop()
      prev.bitmap?.close()
      prev.bitmap = null
      prev.loaded.release()
    }
    this.#current = next
    this.#placeholder = null
    this.#changed()
  }
}
