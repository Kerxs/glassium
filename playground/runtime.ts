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
