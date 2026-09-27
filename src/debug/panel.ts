/**
 * 调试面板：`glassium.debug.enable()`。右下角一个小面板（影子树里，不参与玻璃、不被收进场景），每半秒刷新一次：
 * 后端、质量、帧时间、面板 / 组 / 填充数、draw calls、模糊趟数、管线与目标的创建数、层级问题。
 * 可以切面板的调试视图（sdf / mask / grad / displacement）。
 */

import { currentStage } from '../renderer/stage.ts'
import { DEBUG_MODES, type PanelDebugMode } from '../shaders/glass.wgsl.ts'
import { debugRows } from './rows.ts'

let host: HTMLElement | null = null
let timer = 0

export function enableDebugPanel(): void {
  if (host || typeof document === 'undefined') return
  host = document.createElement('div')
  host.setAttribute('data-glassium-debug', '')
  Object.assign(host.style, { position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647' })
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
<style>
  .panel { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #e8eaf0;
    background: rgba(18, 20, 26, 0.92); border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
    padding: 8px 10px; min-width: 220px; box-shadow: 0 8px 24px rgba(0,0,0,0.35); }
  .title { font-weight: 600; margin-bottom: 4px; display: flex; justify-content: space-between; gap: 8px; }
  table { border-collapse: collapse; }
  td { padding: 0 6px 0 0; white-space: nowrap; }
  td:first-child { color: #9aa3b5; }
  select, button { font: inherit; color: inherit; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18);
    border-radius: 6px; padding: 1px 4px; }
</style>
<div class="panel" role="status" aria-label="Glassium 调试">
  <div class="title"><span>Glassium</span><button type="button" data-close aria-label="关闭">×</button></div>
  <table><tbody></tbody></table>
  <label>面板视图 <select data-mode>${DEBUG_MODES.map((m) => `<option>${m}</option>`).join('')}</select></label>
</div>`
  root.querySelector('[data-close]')!.addEventListener('click', disableDebugPanel)
  root.querySelector<HTMLSelectElement>('[data-mode]')!.addEventListener('change', (e) => {
    currentStage()?.debug.setPanelDebug((e.target as HTMLSelectElement).value as PanelDebugMode)
  })
  document.body.append(host)
  const render = (): void => {
    const body = root.querySelector('tbody')!
    body.innerHTML = debugRows()
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
      .join('')
  }
  render()
  timer = window.setInterval(render, 500)
}

export function disableDebugPanel(): void {
  if (timer) window.clearInterval(timer)
  timer = 0
  currentStage()?.debug.setPanelDebug('off')
  host?.remove()
  host = null
}
