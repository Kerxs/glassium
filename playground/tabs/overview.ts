/**
 * 概览（#overview）：零配置。这一节只有 `import 'glassium'` 与 glass 属性 —— 页面背景、渐变、图片、文字都由 runtime
 * 自己收进场景。下面这几行只是这一节自己的控件：质量档位、调试面板、显示能力，以及让玻璃动起来的拖动、选中块、变形。
 */

import '../overview.css'

import glassium, { type GlassStage } from 'glassium'

let root: HTMLElement
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!

// 这一节的场景：一块与页面底色一样的纯色（静态：内置场景一直在漂移，会让 stage 每帧都画）；
// 页面的背景（html 的底色、body 的渐变）由 runtime 收进场景盖在上面
let backdrop: Promise<Blob | HTMLCanvasElement> | null = null
function plainBackdrop(): Promise<Blob | HTMLCanvasElement> {
  const c = document.createElement('canvas')
  c.width = 8
  c.height = 8
  const g = c.getContext('2d')!
  g.fillStyle = '#1b1030'
  g.fillRect(0, 0, 8, 8)
  return new Promise((resolve) => c.toBlob((blob) => resolve(blob ?? c), 'image/png'))
}

let spinning = 0
let clip: HTMLVideoElement

/** 画布动画：一个转动的色环（只在这一节显示时转）。 */
function startSpin(): void {
  const spin = $<HTMLCanvasElement>('spin')
  const sctx = spin.getContext('2d')!
  const draw = (t: number): void => {
    sctx.fillStyle = '#101828'
    sctx.fillRect(0, 0, spin.width, spin.height)
    for (let i = 0; i < 12; i++) {
      const a = t / 900 + (i * Math.PI) / 6
      sctx.fillStyle = `hsl(${i * 30}, 90%, 60%)`
      sctx.beginPath()
      sctx.arc(120 + Math.cos(a) * 45, 75 + Math.sin(a) * 45, 12, 0, Math.PI * 2)
      sctx.fill()
    }
    spinning = requestAnimationFrame(draw)
  }
  if (spinning === 0) spinning = requestAnimationFrame(draw)
}

export function mount(section: HTMLElement): void {
  root = section
  const quality = $<HTMLSelectElement>('quality')
  quality.addEventListener('change', () => glassium.configure({ quality: quality.value as 'auto' }))
  $('open-debug').addEventListener('click', () => void glassium.debug.enable())

  // 玻璃透镜跟着指针在「内容」那一节里走
  const content = $('content')
  const lens = content.querySelector<HTMLElement>('.lens')!
  content.addEventListener('pointermove', (e) => {
    const r = content.getBoundingClientRect()
    lens.style.left = `${e.clientX - r.left - lens.offsetWidth / 2}px`
    lens.style.top = `${e.clientY - r.top - lens.offsetHeight / 2}px`
  })

  // 视频：画布的画面录成视频流（同源、不污染），在 <video> 里播
  const spin = $<HTMLCanvasElement>('spin')
  clip = $<HTMLVideoElement>('clip')
  if (typeof spin.captureStream === 'function') clip.srcObject = spin.captureStream(30)

  const caps = $('caps')
  void glassium.ready.then((c) => {
    caps.textContent = `后端 ${c.renderer} · tier ${c.tier} · WebGPU ${c.webgpu} · WebGL2 ${c.webgl2} · backdrop-filter ${c.backdropFilter}`
  })

  // 拖动：只改元素的位置，果冻是 runtime 看着位置自己算的（glass-jelly）
  const pad = $('pad')
  const puck = pad.querySelector<HTMLElement>('.puck')!
  let grab: { dx: number; dy: number } | null = null
  puck.addEventListener('pointerdown', (e) => {
    const r = puck.getBoundingClientRect()
    grab = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    puck.setPointerCapture(e.pointerId)
  })
  puck.addEventListener('pointermove', (e) => {
    if (!grab) return
    const box = pad.getBoundingClientRect()
    const x = Math.min(Math.max(e.clientX - box.left - grab.dx, 0), box.width - puck.offsetWidth)
    const y = Math.min(Math.max(e.clientY - box.top - grab.dy, 0), box.height - puck.offsetHeight)
    puck.style.left = `${x}px`
    puck.style.top = `${y}px`
  })
  const drop = (): void => {
    grab = null
  }
  puck.addEventListener('pointerup', drop)
  puck.addEventListener('pointercancel', drop)

  // 选中块：换格子时直接把它放到新格子下面，飞过去是 runtime 做的（glass-glide）
  const tabs = $('tabs')
  const pill = tabs.querySelector<HTMLElement>('.pill')!
  const place = (tab: HTMLElement): void => {
    pill.style.left = `${tab.offsetLeft}px`
    pill.style.width = `${tab.offsetWidth}px`
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b === tab))
  }
  for (const b of tabs.querySelectorAll<HTMLElement>('button')) b.addEventListener('click', () => place(b))
  place(tabs.querySelector<HTMLElement>('button')!)

  // 变形：一块玻璃变成另一块
  const chip = $('chip')
  const sheet = $('sheet')
  // 看不见的那一块不接指针（morph 只改不透明度）
  const show = (on: HTMLElement, off: HTMLElement): void => {
    on.style.pointerEvents = 'auto'
    off.style.pointerEvents = 'none'
  }
  chip.addEventListener('click', () => {
    glassium.morph(chip, sheet)
    show(sheet, chip)
  })
  $('collapse').addEventListener('click', () => {
    glassium.morph(sheet, chip)
    show(chip, sheet)
  })
}

export function activate(stage: GlassStage | null): void {
  startSpin()
  if (clip.srcObject) void clip.play().catch(() => undefined)
  // 图还没生成好就切走了：不再换（换了会盖掉下一个标签的场景）
  if (stage?.active) {
    void (backdrop ??= plainBackdrop())
      .then((scene) => (root.isConnected ? stage.setScene(scene, { background: '#1b1030' }) : undefined))
      .catch(() => undefined)
  }
}

export function deactivate(): void {
  cancelAnimationFrame(spinning)
  spinning = 0
  clip.pause()
}
