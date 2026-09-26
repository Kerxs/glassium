/**
 * 首页：四个照着 iOS 27 实机截图搭的场景（设置、控制中心、应用列表 + 标签栏、锁屏）。只用公开 API。
 *
 * - 每块屏幕按 390×780 排版，按格子的宽度缩放（--k），玻璃跟着视觉缩放走。
 * - 应用列表里的标题（.scene-text）用 stage.registerBitmapFill 画进场景 —— 标签栏的透镜能放大、扭弯它们；
 *   DOM 那一份在玻璃生效时透明（html[data-gpu]），读屏与选中照旧。
 * - 锁屏的丝带壁纸也是位图填充：自己用 2D 画布画的曲线。
 * - 控制中心的两条竖向滑块：一块胶囊玻璃，里面一块白色填充从下往上长（填充写在玻璃里面，画在它上面）。
 *
 * 与 devices.html 一样认 ?glassium.backend=webgl2 与 ?glassium.simulate=no-webgpu。
 */

import '../src/components/glassium.css'

import { createGlassStage, defineGlassElements, paintContent, simulateNoWebGpu, type GlassStage } from 'glassium'
import { fillIcons, icon } from './showcase-icons.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

// —— 页面背景：深色，几团很淡的光（静态的 Blob：stage 静止时不重画；没有 GPU 时写成画布的 CSS 背景） ——

async function backdrop(): Promise<Blob | HTMLCanvasElement> {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 200
  const g = c.getContext('2d')!
  g.fillStyle = '#08090e'
  g.fillRect(0, 0, c.width, c.height)
  const glow = (x: number, y: number, r: number, color: string): void => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r)
    rg.addColorStop(0, color)
    rg.addColorStop(1, 'rgba(8, 9, 14, 0)')
    g.fillStyle = rg
    g.fillRect(0, 0, c.width, c.height)
  }
  glow(60, 30, 170, 'rgba(70, 96, 200, 0.16)')
  glow(270, 180, 170, 'rgba(170, 70, 150, 0.1)')
  return new Promise((resolve) => c.toBlob((blob) => resolve(blob ?? c), 'image/png'))
}

// —— 屏幕缩放 ——

const SCREEN_W = 390
const MAX_K = 1.2

function fitScreens(): void {
  for (const slot of document.querySelectorAll<HTMLElement>('.slot')) {
    const width = slot.parentElement?.clientWidth ?? SCREEN_W
    const k = Math.min(MAX_K, width / SCREEN_W)
    slot.style.setProperty('--k', k.toFixed(4))
    slot.querySelector<HTMLElement>('.screen')?.style.setProperty('--k', k.toFixed(4))
  }
}

// —— 时间 ——

function dateText(now: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return `${now.getMonth() + 1}月${now.getDate()}日 星期${weekdays[now.getDay()]}`
}

function tick(): void {
  const now = new Date()
  $('lock-time').textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
  $('lock-date').textContent = dateText(now)
  $('store-date').textContent = dateText(now)
}

// —— 应用列表 ——

interface AppEntry {
  readonly name: string
  readonly sub: string
  readonly paint: string
  readonly glyph: string
}

const APPS: readonly AppEntry[] = [
  { name: '晴天', sub: '天气与空气质量', paint: 'linear-gradient(160deg, #4fc3f7, #1e88e5)', glyph: 'sun' },
  { name: '拾光', sub: '照片与回忆', paint: 'linear-gradient(160deg, #ffd54f, #ff7043)', glyph: 'photos' },
  { name: '慢读', sub: '安静地读一本书', paint: 'linear-gradient(160deg, #a5d6a7, #2e7d32)', glyph: 'notes' }
]

const GAMES: readonly AppEntry[] = [
  { name: '星海', sub: '太空探险', paint: 'linear-gradient(160deg, #7e57c2, #311b92)', glyph: 'rocket' },
  { name: '方块派对', sub: '休闲 · 多人', paint: 'linear-gradient(160deg, #ff8a65, #d81b60)', glyph: 'gamepad' },
  { name: '远山', sub: '解谜 · 冒险', paint: 'linear-gradient(160deg, #80cbc4, #00695c)', glyph: 'maps' }
]

function appRow(app: AppEntry): HTMLElement {
  const row = document.createElement('div')
  row.className = 'app'
  const tile = document.createElement('glass-fill')
  tile.className = 'app-ico'
  tile.style.setProperty('--glass-fill', app.paint)
  const text = document.createElement('span')
  const name = document.createElement('span')
  name.className = 'app-name scene-text'
  name.textContent = app.name
  const sub = document.createElement('span')
  sub.className = 'app-sub'
  sub.textContent = app.sub
  text.append(name, sub)
  const get = document.createElement('glass-fill')
  get.className = 'app-get'
  get.textContent = '获取'
  row.append(tile, text, get)
  // 图块上的图形：DOM（白色线稿），在填充上面
  tile.innerHTML = `<span style="display:block;width:34px;height:34px;margin:13px;color:#fff">${icon(app.glyph)}</span>`
  return row
}

// —— 画进场景的字：DOM 那一份透明，场景里画一份同样的（颜色写死成这块屏幕的正文色） ——

function paintSceneText(stage: GlassStage): void {
  for (const el of document.querySelectorAll<HTMLElement>('.scene-text')) {
    const color = getComputedStyle(el.closest('.screen') ?? el).color
    const fill = stage.registerBitmapFill(el, (ctx) => paintContent(ctx, el, [{ element: el, color }], () => fill.invalidate()))
    // 字体加载完、尺寸变了会自己重画（尺寸由 stage 量）；字体换了要手动作废
    document.fonts?.addEventListener('loadingdone', () => fill.invalidate())
  }
}

// —— 锁屏壁纸：暖灰的丝带（自己画的曲线） ——

function paintRibbons(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number): void {
  const base = ctx.createLinearGradient(0, 0, w, h)
  base.addColorStop(0, '#8d8173')
  base.addColorStop(0.45, '#3f3934')
  base.addColorStop(1, '#6f6b70')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)
  // 右上角一团暖光：丝带有个受光的方向
  const glow = ctx.createRadialGradient(w * 0.85, h * 0.08, 0, w * 0.85, h * 0.08, w * 0.9)
  glow.addColorStop(0, 'rgba(255, 226, 190, 0.35)')
  glow.addColorStop(1, 'rgba(255, 226, 190, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, w, h)

  /** 一条丝带：上下两条贝塞尔围成的带子。edge 是上沿（t = 0）到下沿（t = 1）之间第 t 处的曲线。 */
  const ribbon = (y0: number, amp: number, thick: number, c0: string, c1: string, phase: number): void => {
    const edge = (t: number): void => {
      const d = thick * t
      ctx.moveTo(-20, y0 + d)
      ctx.bezierCurveTo(w * 0.3, y0 - amp * Math.cos(phase) + d * 1.4, w * 0.6, y0 + amp + d, w + 20, y0 - amp * 0.4 + d)
    }
    const outline = (): void => {
      ctx.beginPath()
      edge(0)
      ctx.lineTo(w + 20, y0 - amp * 0.4 + thick)
      ctx.bezierCurveTo(w * 0.6, y0 + amp + thick, w * 0.3, y0 - amp * Math.cos(phase) + thick * 1.4, -20, y0 + thick)
      ctx.closePath()
    }
    const g = ctx.createLinearGradient(0, y0 - amp, w, y0 + amp)
    g.addColorStop(0, c0)
    g.addColorStop(1, c1)
    // 投在下面那条上的影子
    ctx.save()
    ctx.shadowColor = 'rgba(20, 16, 12, 0.45)'
    ctx.shadowBlur = 36
    ctx.shadowOffsetY = 14
    outline()
    ctx.fillStyle = g
    ctx.fill()
    ctx.restore()
    // 横过带子的明暗：上沿亮、下沿暗（丝带是弯的）
    ctx.save()
    outline()
    ctx.clip()
    const shade = ctx.createLinearGradient(0, y0 - amp * 0.5, 0, y0 + amp + thick)
    shade.addColorStop(0, 'rgba(255, 255, 255, 0.22)')
    shade.addColorStop(0.55, 'rgba(255, 255, 255, 0)')
    shade.addColorStop(1, 'rgba(0, 0, 0, 0.28)')
    ctx.fillStyle = shade
    ctx.fillRect(0, 0, w, h)
    // 里面一道折痕
    ctx.beginPath()
    edge(0.42)
    ctx.strokeStyle = 'rgba(255, 250, 240, 0.16)'
    ctx.lineWidth = 6
    ctx.stroke()
    ctx.restore()
    // 上沿一道亮线（丝带的折边）
    ctx.beginPath()
    edge(0)
    ctx.strokeStyle = 'rgba(255, 250, 240, 0.75)'
    ctx.lineWidth = 1.4
    ctx.stroke()
  }
  ribbon(h * 0.08, 90, 150, '#e6ddd0', '#9c8f80', 2.6)
  ribbon(h * 0.22, 150, 230, '#d9d2c7', '#8a8178', 0.3)
  ribbon(h * 0.45, 120, 200, '#c9c4bf', '#6d6660', 1.4)
  ribbon(h * 0.6, 90, 140, '#d8cbbd', '#7d7066', 3.4)
  ribbon(h * 0.72, 160, 260, '#b8b3b0', '#5d5a5f', 2.2)
  ribbon(h * 0.92, 110, 220, '#a7a3a6', '#4c4a50', 0.8)
}

// —— 开关状态的按钮：打开时染色（蓝），白色的那几颗打开时变白 ——

const ON_BLUE = 'rgba(10, 132, 255, 0.92)'
const ON_WHITE = 'rgba(255, 255, 255, 0.94)'

function applyToggle(b: HTMLElement): void {
  const on = b.getAttribute('aria-pressed') === 'true'
  if (on) b.setAttribute('tint', b.hasAttribute('data-light') ? ON_WHITE : ON_BLUE)
  else b.removeAttribute('tint')
}

function setupToggles(): void {
  for (const b of document.querySelectorAll<HTMLElement>('[data-toggle]')) {
    // 打开时变白的那几颗：图标是彩色 / 深色的，自适应会把它当成浅色字、把白玻璃压暗 —— 关掉
    if (b.hasAttribute('data-light')) b.setAttribute('adaptive', '0')
    applyToggle(b)
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))
      applyToggle(b)
    })
  }
  const play = $('cc-play')
  play.addEventListener('click', () => {
    const playing = play.getAttribute('aria-label') === '暂停'
    play.setAttribute('aria-label', playing ? '播放' : '暂停')
    play.querySelector('[data-icon]')!.innerHTML = icon(playing ? 'play' : 'pause')
    $('cc-title').textContent = playing ? '未在播放' : '玻璃 · Glassium'
  })
}

// —— 控制中心的竖向滑块 ——

function setupVSlider(el: HTMLElement): void {
  const set = (v: number): void => {
    const value = Math.round(Math.min(100, Math.max(0, v)))
    el.style.setProperty('--level', `${value}%`)
    el.setAttribute('aria-valuenow', String(value))
  }
  set(Number(el.getAttribute('aria-valuenow') ?? 50))
  let dragging = false
  const fromPointer = (e: PointerEvent): void => {
    const r = el.getBoundingClientRect()
    set(((r.bottom - e.clientY) / r.height) * 100)
  }
  el.addEventListener('pointerdown', (e) => {
    dragging = true
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // 合成的事件没有活的指针
    }
    fromPointer(e)
  })
  el.addEventListener('pointermove', (e) => {
    if (dragging) fromPointer(e)
  })
  el.addEventListener('pointerup', () => {
    dragging = false
  })
  el.addEventListener('keydown', (e) => {
    const now = Number(el.getAttribute('aria-valuenow'))
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(now + 5)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(now - 5)
    else return
    e.preventDefault()
  })
}

// —— 页头的按钮是链接 ——

function setupNav(): void {
  for (const b of document.querySelectorAll<HTMLElement>('[data-href]')) {
    b.addEventListener('click', () => {
      location.href = b.dataset.href!
    })
  }
}

// 不用顶层 await：Vite 的默认构建目标（es2020）不支持
async function main(): Promise<void> {
  defineGlassElements()
  $('store-apps').append(...APPS.map(appRow))
  $('store-games').append(...GAMES.map(appRow))
  fillIcons(document)
  tick()
  setInterval(tick, 15_000)
  setupToggles()
  setupVSlider($('cc-bright'))
  setupVSlider($('cc-volume'))
  setupNav()

  fitScreens()
  addEventListener('resize', fitScreens)
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => fitScreens())
    for (const scene of document.querySelectorAll('.scene')) observer.observe(scene)
  }

  const params = new URLSearchParams(location.search)
  if (params.get('glassium.simulate') === 'no-webgpu') simulateNoWebGpu(true)
  const requested = params.get('glassium.backend')
  const backend = requested === 'webgl2' || requested === 'webgpu' ? requested : 'auto'
  const stage = await createGlassStage({ scene: await backdrop(), sceneOptions: { background: '#08090e' }, backend })
  Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })
  if (!stage.active) return
  document.documentElement.toggleAttribute('data-gpu', true)
  paintSceneText(stage)
  stage.registerBitmapFill($('lock-wall'), paintRibbons)
}

void main()
