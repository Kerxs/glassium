/**
 * Runtime 示例页：只 import 'glassium'，页面上的 [glass] 自动变成玻璃。
 * 下面这几行只是示例页自己的控件：质量档位、调试面板、显示能力。
 */
import glassium from 'glassium'

const quality = document.getElementById('quality') as HTMLSelectElement
quality.addEventListener('change', () => glassium.configure({ quality: quality.value as 'auto' }))
document.getElementById('debug')!.addEventListener('click', () => void glassium.debug.enable())

const caps = document.getElementById('caps')!
void glassium.ready.then((c) => {
  caps.textContent = `后端 ${c.renderer} · tier ${c.tier} · WebGPU ${c.webgpu} · WebGL2 ${c.webgl2} · backdrop-filter ${c.backdropFilter}`
})
