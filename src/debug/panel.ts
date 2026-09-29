/**
 * 调试面板：`glassium.debug.enable()`。右下角一个小面板（影子树里，不参与玻璃、不被收进场景），每半秒刷新一次。三页：
 *
 * - 概览：后端、质量、帧时间、面板 / 组 / 填充数、draw calls、模糊趟数、GPU 时间、显存、层级问题……
 * - 场景（场景检查器 + 材质检查器）：上一帧画的每一块玻璃、合并组的成员、填充（stage.debug.scene()）。点一行，或者按
 *   「选取」再点页面上的元素：页面上框出它，下面列出它的材质、降级出来的效果链、质量系数、呈现变换。
 * - 资源（资源检查器）：显存每一项、目标与管线的创建数、场景上传次数。
 *
 * 可以切面板的调试视图（sdf / mask / grad / displacement）。内容全用 DOM 接口写（不拼 innerHTML），元素的名字里有什么都安全。
 */

import { currentStage } from '../renderer/stage.ts'
import { DEBUG_MODES, type PanelDebugMode } from '../shaders/glass.wgsl.ts'
import { debugRows, detailLines, resourceRows, sceneRows } from './rows.ts'

type Tab = 'overview' | 'scene' | 'resources'

let host: HTMLElement | null = null
let timer = 0
let stopPicking: (() => void) | null = null

const CSS = `
  .panel { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #e8eaf0;
    background: rgba(18, 20, 26, 0.94); border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
    padding: 8px 10px; min-width: 260px; max-width: min(560px, calc(100vw - 24px)); max-height: 70vh; overflow: auto;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35); }
  .title { font-weight: 600; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 6px; }
  .tabs button[aria-selected="true"] { background: rgba(120, 170, 255, 0.35); }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 0 6px 0 0; white-space: nowrap; }
  td:first-child { color: #9aa3b5; }
  tr[data-index] { cursor: pointer; }
  tr[data-index]:hover td { background: rgba(255,255,255,0.06); }
  tr[aria-selected="true"] td { background: rgba(120, 170, 255, 0.22); }
  .detail { margin-top: 6px; white-space: pre-wrap; word-break: break-all; color: #cfd6e4; }
  .row { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  select, button { font: inherit; color: inherit; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18);
    border-radius: 6px; padding: 1px 6px; }
  .highlight { position: fixed; pointer-events: none; border: 2px solid #5aa9ff; background: rgba(90, 169, 255, 0.12);
    border-radius: 4px; display: none; }
`

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (text !== undefined) e.textContent = text
  return e
}

export function enableDebugPanel(): void {
  if (host || typeof document === 'undefined') return
  host = el('div')
  host.setAttribute('data-glassium-debug', '')
  Object.assign(host.style, { position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647' })
  const root = host.attachShadow({ mode: 'open' })
  const style = el('style', CSS)
  const panel = el('div')
  panel.className = 'panel'
  panel.setAttribute('role', 'region')
  panel.setAttribute('aria-label', 'Glassium 调试')

  const title = el('div')
  title.className = 'title'
  const close = el('button', '×')
  close.type = 'button'
  close.setAttribute('aria-label', '关闭')
  close.addEventListener('click', disableDebugPanel)
  title.append(el('span', 'Glassium'), close)

  const tabs = el('div')
  tabs.className = 'tabs'
  tabs.setAttribute('role', 'tablist')
  const tabButtons = new Map<Tab, HTMLButtonElement>()
  for (const [id, label] of [
    ['overview', '概览'],
    ['scene', '场景'],
    ['resources', '资源']
  ] as const) {
    const b = el('button', label)
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.addEventListener('click', () => {
      tab = id
      render()
    })
    tabButtons.set(id, b)
    tabs.append(b)
  }

  const table = el('table')
  const body = el('tbody')
  table.append(body)
  const detail = el('div')
  detail.className = 'detail'
  const controls = el('div')
  controls.className = 'row'
  const modeLabel = el('label', '面板视图 ')
  const mode = el('select')
  for (const m of DEBUG_MODES) mode.append(el('option', m))
  mode.addEventListener('change', () => currentStage()?.debug.setPanelDebug(mode.value as PanelDebugMode))
  modeLabel.append(mode)
  const pick = el('button', '选取')
  pick.type = 'button'
  pick.title = '再点页面上的一块玻璃或填充'
  controls.append(modeLabel, pick)

  const highlight = el('div')
  highlight.className = 'highlight'

  panel.append(title, tabs, table, detail, controls)
  root.append(style, panel, highlight)
  document.body.append(host)

  let tab: Tab = 'overview'
  let selected: HTMLElement | null = null

  const place = (): void => {
    if (!selected || !selected.isConnected || tab !== 'scene') {
      highlight.style.display = 'none'
      return
    }
    const r = selected.getBoundingClientRect()
    Object.assign(highlight.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
  }

  const fillRows = (rows: ReadonlyArray<readonly string[]>, elements?: readonly HTMLElement[]): void => {
    body.replaceChildren()
    rows.forEach((cells, i) => {
      const tr = el('tr')
      for (const c of cells) tr.append(el('td', c))
      const target = elements?.[i]
      if (target) {
        tr.dataset.index = String(i)
        tr.setAttribute('aria-selected', String(target === selected))
        tr.addEventListener('click', () => {
          selected = target === selected ? null : target
          render()
        })
      }
      body.append(tr)
    })
  }

  const render = (): void => {
    for (const [id, b] of tabButtons) b.setAttribute('aria-selected', String(id === tab))
    const scene = currentStage()?.debug.scene() ?? null
    if (tab === 'overview') {
      fillRows(debugRows())
      detail.textContent = ''
    } else if (tab === 'scene') {
      const { rows, elements } = sceneRows(scene)
      fillRows(rows, elements)
      detail.textContent = selected ? detailLines(scene, selected).join('\n') : rows.length ? '点一行看材质；「选取」之后点页面上的玻璃。' : '上一帧没有画东西'
    } else {
      fillRows(resourceRows())
      detail.textContent = ''
    }
    pick.hidden = tab !== 'scene'
    place()
  }

  // 选取：下一次点页面（捕获阶段、吃掉这一下，不让页面自己的点击响应），沿着组合路径找上一帧画过的那块
  pick.addEventListener('click', () => {
    stopPicking?.()
    pick.textContent = '点页面上的玻璃…（Esc 取消）'
    const onDown = (e: PointerEvent): void => {
      if (host && e.composedPath().includes(host)) return
      e.preventDefault()
      e.stopPropagation()
      const scene = currentStage()?.debug.scene() ?? null
      const { elements } = sceneRows(scene)
      const hit = e.composedPath().find((n): n is HTMLElement => n instanceof HTMLElement && elements.includes(n))
      selected = hit ?? null
      done(true)
      render()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') done(false)
    }
    // 选中的那一下之后，松手时的 click 也吃掉（只吃一次、只吃面板外面的）
    const swallowClick = (e: MouseEvent): void => {
      if (host && e.composedPath().includes(host)) return
      e.preventDefault()
      e.stopPropagation()
      document.removeEventListener('click', swallowClick, true)
    }
    const done = (picked: boolean): void => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      if (picked) document.addEventListener('click', swallowClick, true)
      pick.textContent = '选取'
      stopPicking = null
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    stopPicking = () => done(false)
  })

  render()
  timer = window.setInterval(render, 500)
}

export function disableDebugPanel(): void {
  if (timer) window.clearInterval(timer)
  timer = 0
  stopPicking?.()
  currentStage()?.debug.setPanelDebug('off')
  host?.remove()
  host = null
}
