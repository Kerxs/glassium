/**
 * Runtime 示例页：只 import 'glassium'，页面上的 [glass] 自动变成玻璃。
 * 下面这几行只是示例页自己的控件：质量档位、调试面板、显示能力。
 */
import glassium from 'glassium'

const quality = document.getElementById('quality') as HTMLSelectElement
quality.addEventListener('change', () => glassium.configure({ quality: quality.value as 'auto' }))
document.getElementById('debug')!.addEventListener('click', () => void glassium.debug.enable())

// 玻璃透镜跟着指针在「内容」那一节里走
const content = document.getElementById('content')!
const lens = content.querySelector<HTMLElement>('.lens')!
content.addEventListener('pointermove', (e) => {
  const r = content.getBoundingClientRect()
  lens.style.left = `${e.clientX - r.left - lens.offsetWidth / 2}px`
  lens.style.top = `${e.clientY - r.top - lens.offsetHeight / 2}px`
})

// 画布动画：一个转动的色环
const spin = document.getElementById('spin') as HTMLCanvasElement
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
  requestAnimationFrame(draw)
}
requestAnimationFrame(draw)

// 视频：画布的画面录成视频流（同源、不污染），在 <video> 里播
const clip = document.getElementById('clip') as HTMLVideoElement
if (typeof spin.captureStream === 'function') {
  clip.srcObject = spin.captureStream(30)
  void clip.play().catch(() => undefined)
}

const caps = document.getElementById('caps')!
void glassium.ready.then((c) => {
  caps.textContent = `后端 ${c.renderer} · tier ${c.tier} · WebGPU ${c.webgpu} · WebGL2 ${c.webgl2} · backdrop-filter ${c.backdropFilter}`
})

// 拖动：只改元素的位置，果冻是 runtime 看着位置自己算的（glass-jelly）
const pad = document.getElementById('pad')!
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
const tabs = document.getElementById('tabs')!
const pill = tabs.querySelector<HTMLElement>('.pill')!
const place = (tab: HTMLElement): void => {
  pill.style.left = `${tab.offsetLeft}px`
  pill.style.width = `${tab.offsetWidth}px`
  for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b === tab))
}
for (const b of tabs.querySelectorAll<HTMLElement>('button')) b.addEventListener('click', () => place(b))
place(tabs.querySelector<HTMLElement>('button')!)

// 变形：一块玻璃变成另一块
const chip = document.getElementById('chip')!
const sheet = document.getElementById('sheet')!
// 看不见的那一块不接指针（morph 只改不透明度）
const show = (on: HTMLElement, off: HTMLElement): void => {
  on.style.pointerEvents = 'auto'
  off.style.pointerEvents = 'none'
}
chip.addEventListener('click', () => {
  glassium.morph(chip, sheet)
  show(sheet, chip)
})
document.getElementById('collapse')!.addEventListener('click', () => {
  glassium.morph(sheet, chip)
  show(chip, sheet)
})
