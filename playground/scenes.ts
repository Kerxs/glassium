/**
 * Playground 的用户场景（stage.setScene）。和使用者放自己的背景是同一条路径：
 *
 * - photo   程序化生成的 3000×2000「照片」，编码成 JPEG Blob —— 走图片那条路径
 *           （解码 → 缩到场景分辨率 → 只上传一次）
 * - canvas  一块 960×540 的动画画布，dynamic: true，每帧重新上传
 * - video   把那块动画画布录成流、放进 <video> —— 走视频那条路径（有新帧才上传）
 * - file    本地图片文件（File 就是 Blob）
 */

import type { GlassStage, SceneFit } from 'glassium'

export type UserScene = 'photo' | 'canvas' | 'video' | 'file'

/** 确定性的伪随机数（mulberry32）：同一个种子每次画出同一张图。 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 一张 3000×2000 的「照片」：黄昏的天空、太阳、三层山、前景一排亮着窗的楼。
 * 比视口大得多，正好验「先缩放再上传」；楼和窗给折射与色散提供硬边。
 */
async function makePhoto(): Promise<Blob> {
  const W = 3000
  const H = 2000
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')!
  const r = rng(7)

  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.75)
  sky.addColorStop(0, '#0d1b3d')
  sky.addColorStop(0.55, '#5b4b8a')
  sky.addColorStop(0.82, '#e0806a')
  sky.addColorStop(1, '#f7c07a')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = '#fff'
  for (let i = 0; i < 420; i++) {
    const s = 0.8 + r() * 2.6
    ctx.globalAlpha = 0.25 + r() * 0.75
    ctx.fillRect(r() * W, r() * H * 0.42, s, s)
  }
  ctx.globalAlpha = 1

  const sun = ctx.createRadialGradient(W * 0.68, H * 0.6, 0, W * 0.68, H * 0.6, 300)
  sun.addColorStop(0, 'rgba(255, 248, 225, 1)')
  sun.addColorStop(0.3, 'rgba(255, 224, 160, 0.95)')
  sun.addColorStop(1, 'rgba(255, 200, 140, 0)')
  ctx.fillStyle = sun
  ctx.fillRect(0, 0, W, H)

  const ridges: readonly (readonly [string, number, number])[] = [
    ['#4a3f73', 0.6, 220],
    ['#2c2650', 0.68, 170],
    ['#191632', 0.76, 120]
  ]
  for (const [color, base, amp] of ridges) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(0, H)
    let y = H * base
    for (let x = 0; x <= W; x += 30) {
      y = Math.min(H * base + amp * 0.5, Math.max(H * base - amp, y + (r() - 0.5) * amp * 0.45))
      ctx.lineTo(x, y)
    }
    ctx.lineTo(W, H)
    ctx.closePath()
    ctx.fill()
  }

  let x = -20
  while (x < W) {
    const w = 90 + r() * 170
    const h = 220 + r() * 560
    ctx.fillStyle = '#0b0a14'
    ctx.fillRect(x, H - h, w, h)
    for (let wy = H - h + 22; wy < H - 24; wy += 36) {
      for (let wx = x + 14; wx < x + w - 22; wx += 28) {
        if (r() < 0.42) {
          ctx.fillStyle = r() < 0.8 ? '#ffd27a' : '#9fd0ff'
          ctx.fillRect(wx, wy, 14, 20)
        }
      }
    }
    x += w + 8 + r() * 36
  }

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
}

/** 一块 960×540 的动画画布：移动的斜条纹 + 滚动的大字。自己用 rAF 画。 */
function makeAnimatedCanvas(): { readonly canvas: HTMLCanvasElement; start(): void; stop(): void } {
  const canvas = document.createElement('canvas')
  canvas.width = 960
  canvas.height = 540
  const ctx = canvas.getContext('2d')!
  let raf = 0
  const draw = (now: number): void => {
    const s = now / 1000
    ctx.fillStyle = '#10131c'
    ctx.fillRect(0, 0, 960, 540)
    ctx.save()
    ctx.translate(-((s * 60) % 80), 0)
    for (let i = -10; i < 34; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#1f6feb' : '#f2cc60'
      ctx.beginPath()
      ctx.moveTo(i * 40, 0)
      ctx.lineTo(i * 40 + 40, 0)
      ctx.lineTo(i * 40 - 260, 540)
      ctx.lineTo(i * 40 - 300, 540)
      ctx.fill()
    }
    ctx.restore()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 132px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText('GLASSIUM · LIQUID GLASS ·', 960 - ((s * 160) % 2100), 270)
    raf = requestAnimationFrame(draw)
  }
  return {
    canvas,
    start(): void {
      if (raf === 0) raf = requestAnimationFrame(draw)
    },
    stop(): void {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
}

/**
 * 管理 playground 的用户场景：按需建资源、切换、换 fit。
 * 返回的 show() 把场景交给 stage；传 null 回到内置场景。
 */
export function userScenes(stage: GlassStage): {
  show(which: UserScene | null, fit: SceneFit): Promise<void>
  pickFile(file: File, fit: SceneFit): Promise<void>
} {
  let photo: Promise<Blob> | null = null
  let animated: ReturnType<typeof makeAnimatedCanvas> | null = null
  let video: HTMLVideoElement | null = null
  let file: File | null = null

  const animation = (): ReturnType<typeof makeAnimatedCanvas> => (animated ??= makeAnimatedCanvas())

  const show = async (which: UserScene | null, fit: SceneFit): Promise<void> => {
    // 只有画布与视频场景需要动画在跑
    if (which !== 'canvas' && which !== 'video') animated?.stop()
    if (which !== 'video') video?.pause()
    switch (which) {
      case null:
        return stage.setScene(null)
      case 'photo':
        return stage.setScene(await (photo ??= makePhoto()), { fit })
      case 'canvas': {
        const a = animation()
        a.start()
        return stage.setScene(a.canvas, { fit, dynamic: true })
      }
      case 'video': {
        const a = animation()
        a.start()
        if (!video) {
          video = document.createElement('video')
          video.muted = true
          video.playsInline = true
          video.srcObject = a.canvas.captureStream(30)
        }
        await video.play()
        return stage.setScene(video, { fit })
      }
      case 'file':
        return file ? stage.setScene(file, { fit }) : Promise.resolve()
    }
  }

  return {
    show,
    pickFile(picked: File, fit: SceneFit): Promise<void> {
      file = picked
      return show('file', fit)
    }
  }
}
