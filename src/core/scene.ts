/**
 * 用户场景（图片 / 视频 / 画布）怎么铺进视口。
 *
 * 语义与 CSS 的 `object-fit` 相同：
 *
 * - cover   等比缩放到**盖满**视口，多出来的部分裁掉（默认 —— 背景图通常要这个）
 * - contain 等比缩放到**装得下**，空出来的部分填底色
 * - fill    拉伸到视口大小，不保持比例
 *
 * 这里全是纯函数：着色器里只做一次 `uv · scale + offset`，比例怎么算在 CPU 上。
 */

export type SceneFit = 'cover' | 'contain' | 'fill'

export interface UvTransform {
  /** 图片 uv = 视口 uv · scale + offset。视口 uv 与图片 uv 都是左上原点、y 向下。 */
  readonly scale: readonly [number, number]
  readonly offset: readonly [number, number]
}

/**
 * 视口 uv → 图片 uv。落在 [0, 1] 之外的就是图片之外（只有 contain 会出现）。
 *
 * 推导：以中心为不动点，`img = (screen − 0.5) · k + 0.5`，k 是「视口在图片坐标里占多大」。
 * 视口比图片宽（目标宽高比 > 图片宽高比）时：cover 要把图片放大到视口宽，纵向只看得到一部分，
 * k.y = At / Ai < 1；contain 要把图片缩到视口高，横向留白，k.x = At / Ai > 1。
 */
export function sceneUvTransform(
  targetWidth: number,
  targetHeight: number,
  imageWidth: number,
  imageHeight: number,
  fit: SceneFit
): UvTransform {
  if (fit === 'fill' || imageWidth <= 0 || imageHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return { scale: [1, 1], offset: [0, 0] }
  }
  const at = targetWidth / targetHeight
  const ai = imageWidth / imageHeight
  const r = at / ai // > 1：视口比图片宽
  const k: [number, number] =
    fit === 'cover'
      ? r >= 1
        ? [1, 1 / r]
        : [r, 1]
      : r >= 1
        ? [r, 1]
        : [1, 1 / r]
  return { scale: k, offset: [0.5 - 0.5 * k[0], 0.5 - 0.5 * k[1]] }
}

/**
 * 静态图片预先缩放到多大再上传：视口里实际用到的像素数，不多不少。
 *
 * 大图直接上传、在着色器里双线性缩小会闪烁起摩尔纹（一个屏幕像素跨过好几个图片像素，
 * 只采到其中一个）。浏览器的 createImageBitmap(…, { resizeQuality: 'high' }) 做的是正经的
 * 降采样，交给它一次，之后每帧都是 1:1 左右的采样。
 *
 * 返回的尺寸按目标分辨率算：cover 时整张图缩放到盖满（会比视口大一边），contain 时装得下，
 * fill 时就是视口大小。不放大 —— 图片本身比视口小时保持原样，放大交给采样器。
 */
export function sceneBitmapSize(
  targetWidth: number,
  targetHeight: number,
  imageWidth: number,
  imageHeight: number,
  fit: SceneFit
): readonly [number, number] {
  if (imageWidth <= 0 || imageHeight <= 0) return [1, 1]
  if (fit === 'fill') {
    return [Math.max(1, Math.min(imageWidth, targetWidth)), Math.max(1, Math.min(imageHeight, targetHeight))]
  }
  const sx = targetWidth / imageWidth
  const sy = targetHeight / imageHeight
  const s = Math.min(1, fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy))
  return [Math.max(1, Math.round(imageWidth * s)), Math.max(1, Math.round(imageHeight * s))]
}

/**
 * 没有 GPU 时的兜底：同一张图、同样的铺法，写成画布的 CSS 背景。页面照样有这张背景图，
 * 只是没有玻璃。
 *
 * URL 放进 CSS 字符串前转义引号、反斜杠和换行（换行在 CSS 字符串里要写成 `\a `）。
 */
export function sceneCssBackground(url: string, fit: SceneFit, color: string): string {
  const size = fit === 'fill' ? '100% 100%' : fit
  const escaped = url.replace(/["\\\n]/g, (c) => (c === '\n' ? '\\a ' : `\\${c}`))
  return `${color} url("${escaped}") center / ${size} no-repeat`
}
