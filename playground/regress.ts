/**
 * 视觉回归（regress.html）：几个标准场景各画一遍、回读，缩成 48×32 的小图，与签入的基准比（spec/golden/baselines.json）。
 *
 * 为什么是缩小的图、带容差（而不是逐位的截图比对）：见 spec/golden/README.md —— 驱动、DPR、舍入都会让像素差 1、2 级，
 * 逐位比只会天天红。缩小（按块平均）之后这些差别被抹平，而真正的回归 —— 形状错了、颜色错了、少画了一块 —— 在
 * 48×32 上照样是几十级的差。判据：平均差 ≤ MEAN_LIMIT、最大差 ≤ MAX_LIMIT（0–255 的通道值）。
 *
 * 基准按「后端 + GPU」分开存：换一台机器、换一个后端就是「没有基准」（不算失败），点「记为基准」拿到 JSON，
 * 签进 spec/golden/baselines.json。
 *
 * `?backend=webgl2` 换后端；`?regress.perturb=<场景>` 故意把那个场景改一点（反向对照：它必须失败），`all` 全部改。
 */

import '../src/components/glassium.css'

import { createGlassStage, defineGlassElements, morphGlass, type GlassStage } from 'glassium'
import baselines from '../spec/golden/baselines.json'

const params = new URLSearchParams(location.search)
const perturb = params.get('regress.perturb')
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 缩小之后的尺寸。 */
export const THUMB_W = 48
export const THUMB_H = 32
/**
 * 判据：缩小之后逐通道的平均差、最大差。实测（RTX 4070 Laptop）：同一后端、DPR 1 与 1.5 之间，以及两个后端之间，
 * 平均差 ≤ 1.35、最大差 ≤ 15；每个场景故意改一点（?regress.perturb=all）平均差 1.5–23、最大差 35–158。
 */
export const MEAN_LIMIT = 2.5
export const MAX_LIMIT = 28

interface Scene {
  readonly id: string
  readonly label: string
  /** 在 area（360×240）里搭好；返回拆掉时要做的事。 */
  build(area: HTMLElement, stage: GlassStage, perturbed: boolean): Promise<(() => void) | void> | (() => void) | void
}

const box = (el: HTMLElement, x: number, y: number, w: number, h: number, radius: number | string): HTMLElement => {
  Object.assign(el.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, borderRadius: typeof radius === 'number' ? `${radius}px` : radius })
  return el
}

const card = (attrs: Record<string, string>): HTMLElement => {
  const c = document.createElement('glass-card')
  for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v)
  return c
}

const SCENES: readonly Scene[] = [
  {
    id: 'basic',
    label: '基本玻璃（regular）',
    build: (a, _s, p) => void a.append(box(card({ preset: 'regular', 'corner-radius': '28', ...(p ? { tint: 'rgba(255, 0, 0, 0.3)' } : {}) }), 40, 40, 280, 160, 28))
  },
  {
    id: 'nested',
    label: '嵌套（卡片里的按钮）',
    build: (a, _s, p) => {
      const c = box(card({ preset: 'regular', tint: 'rgba(200, 60, 60, 0.35)', 'corner-radius': '24' }), 30, 30, 300, 180, 24)
      const b = box(document.createElement('glass-button'), p ? 150 : 90, 60, 120, 60, 30)
      c.append(b)
      a.append(c)
    }
  },
  {
    id: 'refraction',
    label: '强折射（clear、refraction 0.9）',
    build: (a, _s, p) => void a.append(box(card({ preset: 'clear', refraction: p ? '0.3' : '0.9', 'corner-radius': '0.5frac' }), 60, 40, 240, 160, '999px'))
  },
  {
    id: 'dispersion',
    label: '色散（dispersion 1）',
    build: (a, _s, p) => void a.append(box(card({ preset: 'clear', dispersion: p ? '0' : '1', refraction: '0.6', 'corner-radius': '40' }), 60, 40, 240, 160, 40))
  },
  {
    id: 'text',
    label: '文字进场景（分段控件按住）',
    build: async (a, _s, p) => {
      const seg = document.createElement('glass-segmented') as HTMLElement
      seg.setAttribute('value', p ? 'b' : 'a')
      Object.assign(seg.style, { position: 'absolute', left: '40px', top: '96px', color: '#000' })
      seg.innerHTML = '<span value="a">Alpha</span><span value="b">Bravo</span><span value="c">Charlie</span>'
      a.append(seg)
      await sleep(0)
      for (const anim of seg.shadowRoot?.getAnimations() ?? []) anim.finish()
    }
  },
  {
    id: 'clip',
    label: '裁剪（圆角的 overflow 容器）',
    build: (a, _s, p) => {
      const clip = box(document.createElement('div'), 40, 40, 280, 160, 40)
      clip.style.overflow = 'hidden'
      clip.append(box(card({ preset: 'regular', 'corner-radius': '0' }), p ? 40 : 100, -20, 240, 200, 0))
      a.append(clip)
    }
  },
  {
    id: 'mask',
    label: '遮罩（mask-image 渐变）',
    build: (a, _s, p) => {
      const m = box(document.createElement('div'), 40, 40, 280, 160, 0)
      m.style.maskImage = p ? 'linear-gradient(to right, black, transparent)' : 'linear-gradient(to bottom, black, transparent)'
      m.append(box(card({ preset: 'regular', tint: 'rgba(60, 60, 200, 0.4)', 'corner-radius': '20' }), 0, 0, 280, 160, 20))
      a.append(m)
    }
  },
  {
    id: 'morph',
    label: '变形（走到一半）',
    build: async (a, _s, p) => {
      const from = box(card({ preset: 'regular', 'corner-radius': '0.5frac' }), 40, 80, 80, 80, '999px')
      const to = box(card({ preset: 'regular', tint: 'rgba(40, 160, 90, 0.35)', 'corner-radius': '24' }), 160, 40, 170, 160, 24)
      a.append(from, to)
      await sleep(0)
      const m = morphGlass(from, to, { duration: 1000 })
      m.seek(p ? 0.2 : 0.5)
      return () => m.cancel()
    }
  },
  {
    id: 'jelly',
    label: '果冻（呈现变换拉长）',
    build: (a, stage, p) => {
      const el = box(document.createElement('div'), 110, 80, 140, 80, 40)
      a.append(el)
      const panel = stage.register(el, { refraction: 0.6, tint: 'rgba(255, 255, 255, 0.2)', cornerRadius: '0.5frac' })
      panel.setPresentation({ dx: 0, dy: 0, sx: p ? 1.1 : 1.35, sy: p ? 0.95 : 0.82 })
      return () => panel.unregister()
    }
  }
]

/** 按块平均缩到 THUMB_W×THUMB_H 的 RGB。 */
export function downsample(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(THUMB_W * THUMB_H * 3)
  for (let ty = 0; ty < THUMB_H; ty++) {
    const y0 = Math.floor((ty * height) / THUMB_H)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / THUMB_H))
    for (let tx = 0; tx < THUMB_W; tx++) {
      const x0 = Math.floor((tx * width) / THUMB_W)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / THUMB_W))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          r += rgba[i]!
          g += rgba[i + 1]!
          b += rgba[i + 2]!
          n++
        }
      }
      const o = (ty * THUMB_W + tx) * 3
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
    }
  }
  return out
}

export function compareThumbs(a: Uint8Array, b: Uint8Array): { mean: number; max: number } {
  let sum = 0
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    sum += d
    if (d > max) max = d
  }
  return { mean: sum / a.length, max }
}

const toBase64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u))
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** 这台设备、这个后端的键：后端 + GPU（WebGPU 的 adapter 信息，WebGL2 的 UNMASKED_RENDERER）。 */
async function deviceKey(stage: GlassStage): Promise<string> {
  let gpu = 'unknown'
  if (stage.backend === 'webgpu' && navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter()
    const info = adapter?.info
    if (info) gpu = `${info.vendor}/${info.architecture}`
  } else if (stage.backend === 'webgl2') {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const r = ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    gpu = /nvidia/i.test(r) ? 'nvidia' : /intel/i.test(r) ? 'intel' : /amd|radeon/i.test(r) ? 'amd' : /apple/i.test(r) ? 'apple' : r.slice(0, 40) || 'unknown'
  }
  return `${stage.backend}:${gpu}`
}

type Baselines = Record<string, Record<string, string>>

/**
 * 基准用的场景：按视口的 CSS 尺寸画一张（铺满，fill），与 DPR 无关；图案按固定的 CSS 坐标画（渐变、色块都不随视口
 * 伸缩），所以 #area 底下那一块在任何视口里都一样 —— 渐变打底、24px 的斜条纹（折射弯折看得出来）、几块纯色（色散、tint 看得出来）。
 */
function referenceScene(): HTMLCanvasElement {
  const w = document.documentElement.clientWidth
  const h = document.documentElement.clientHeight
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 1280, 720)
  g.addColorStop(0, '#f4d9b0')
  g.addColorStop(0.5, '#9fc6e8')
  g.addColorStop(1, '#6c5ba7')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = 'rgba(20, 20, 30, 0.55)'
  ctx.lineWidth = 8
  for (let x = -h; x < w + h; x += 24) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + h, h)
    ctx.stroke()
  }
  // #area 在 (460, 40)，360×240：色块落在它里面
  const blocks: [string, number, number][] = [
    ['#e0402a', 540, 70],
    ['#2fae5a', 700, 170],
    ['#2a5fe0', 610, 210],
    ['#ffd23f', 760, 80]
  ]
  for (const [color, x, y] of blocks) {
    ctx.fillStyle = color
    ctx.fillRect(x, y, 70, 70)
  }
  return c
}

async function main(): Promise<void> {
  defineGlassElements()
  const requested = params.get('backend')
  const backend = requested === 'webgpu' || requested === 'webgl2' ? requested : 'auto'
  const stage = await createGlassStage({ backend })
  stage.debug.setBackdrop({ blurDp: 0, saturation: 1, tint: 'rgba(255, 255, 255, 0)' })
  // 场景按 CSS 像素画（内置的 calibration 是按设备像素的棋盘，换 DPR 就是另一张图，基准没法跨 DPR）
  await stage.setScene(referenceScene(), { fit: 'fill' })
  Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })
  const key = await deviceKey(stage)
  const known = (baselines as Baselines)[key] ?? null
  $('env').textContent = `${key} · DPR ${devicePixelRatio}${known ? '' : ' · 这台设备、这个后端还没有基准'}`

  const area = $('area')
  const rows = $('rows')
  const recorded: Record<string, string> = {}
  let failed = 0
  let compared = 0
  for (const scene of SCENES) {
    area.replaceChildren()
    const cleanup = await scene.build(area, stage, perturb === scene.id || perturb === 'all')
    await sleep(60)
    stage.debug.renderNow()
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const r = area.getBoundingClientRect()
    const c = stage.canvas.getBoundingClientRect()
    const region = {
      x: Math.round((r.left - c.left) * s),
      y: Math.round((r.top - c.top) * s),
      width: Math.round(r.width * s),
      height: Math.round(r.height * s)
    }
    const read = stage.debug.readback(region)
    stage.debug.renderNow()
    const { rgba } = await read
    const thumb = downsample(rgba, region.width, region.height)
    recorded[scene.id] = toBase64(thumb)
    cleanup?.()

    const base = known?.[scene.id]
    let verdict = '没有基准'
    let cls = 'skip'
    if (base) {
      compared++
      const d = compareThumbs(thumb, fromBase64(base))
      const ok = d.mean <= MEAN_LIMIT && d.max <= MAX_LIMIT
      if (!ok) failed++
      verdict = `${ok ? 'PASS' : 'FAIL'} · 平均差 ${d.mean.toFixed(2)} · 最大差 ${d.max}`
      cls = ok ? 'pass' : 'fail'
    }
    const tr = document.createElement('tr')
    tr.className = cls
    for (const text of [scene.label, verdict]) {
      const td = document.createElement('td')
      td.textContent = text
      tr.append(td)
    }
    rows.append(tr)
  }
  area.replaceChildren()
  stage.debug.renderNow()
  const report = { key, dpr: devicePixelRatio, scenes: recorded }
  Object.assign(window as unknown as Record<string, unknown>, { glassiumRegress: report })
  document.title = compared === 0 ? `NO BASELINE ${SCENES.length}` : `${failed === 0 ? 'PASS' : 'FAIL'} ${compared - failed}/${compared}`
  $<HTMLButtonElement>('record').disabled = false
  $<HTMLButtonElement>('record').onclick = (): void => {
    const next = { ...(baselines as Baselines), [key]: recorded }
    void navigator.clipboard.writeText(JSON.stringify(next, null, 2) + '\n').then(() => {
      $('record').textContent = '已复制（贴进 spec/golden/baselines.json）'
    })
  }
}

void main()
