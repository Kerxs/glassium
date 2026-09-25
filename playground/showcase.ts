/**
 * 展示页（index.html）：iPhone 与 Mac 上的液态玻璃。只用公开 API。
 *
 * - 场景：一张静态的深色小画布（页面背景）。设备的壁纸、App 里的照片都是 <glass-fill>，画进场景，玻璃看得见。
 * - 两台设备按原尺寸排版，按可用宽度整体 transform: scale（--k）—— 玻璃的模糊、折射、圆角跟着缩。
 * - 重复的东西（图标格、照片格、Dock、月历）在这里生成；交互都是切换属性，过渡交给 CSS。
 */

import '../src/components/glassium.css'
import './showcase.css'

import {
  createGlassStage,
  defineGlassElements,
  MATERIAL_DEFAULTS,
  morphGlass,
  simulateNoWebGpu,
  type CornerRadius,
  type GlassMaterial
} from 'glassium'

import { fillIcons, icon } from './showcase-icons.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches

// —— 照片：一块填充一层渐变（最多 5 个色标），按几种「照片」的样子配色 ——

/** 确定性的伪随机数（mulberry32）：同一个种子每次生成同一组照片。 */
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

type Palette = readonly [string, string, string, string]

/** 亮 → 暗。 */
const PALETTES: readonly Palette[] = [
  ['#ffd29a', '#ff7a59', '#b83a6e', '#2a1640'], // 黄昏
  ['#b8f1ff', '#3aa6ff', '#1d4fd8', '#071a4a'], // 海
  ['#e3f9c8', '#7cc86f', '#2f7d4a', '#0f2e1f'], // 林
  ['#fff1c9', '#ffb870', '#d9824a', '#6b3a22'], // 沙
  ['#ffd6ec', '#ff6fa8', '#8a2b6d', '#23102a'], // 花
  ['#d7d2ff', '#8f7cff', '#4b2fbf', '#150d3d'], // 夜
  ['#c9fff4', '#3be0c1', '#11897a', '#062e2a'], // 湖
  ['#fff4b8', '#ffd23f', '#f08a24', '#5c2b0c'], // 秋
  ['#e6ecff', '#9bb4ff', '#4b63d6', '#141c4f'], // 雪
  ['#ffe0d6', '#ff8f70', '#d6455f', '#3b0f24'] // 珊瑚
]

const pct = (r: () => number, from: number, span: number): number => Math.round(from + r() * span)

/** 几种「照片」：地平线、夕阳、散景、斜光、夜景、花心。硬边（同一处两个色标）给折射一点东西可弯。 */
const SHOTS: readonly ((p: Palette, r: () => number) => string)[] = [
  (p, r) => {
    const h = pct(r, 44, 26)
    return `linear-gradient(180deg, ${p[0]} 0%, ${p[1]} ${h}%, ${p[2]} ${h}%, ${p[3]} 100%)`
  },
  (p, r) =>
    `radial-gradient(circle at ${pct(r, 30, 40)}% ${pct(r, 38, 30)}%, #fff7df 0%, #fff7df 9%, ${p[1]} 10%, ${p[2]} 50%, ${p[3]} 100%)`,
  (p, r) => `radial-gradient(circle at ${pct(r, 20, 60)}% ${pct(r, 20, 60)}%, ${p[0]} 0%, ${p[1]} 32%, ${p[2]} 66%, ${p[3]} 100%)`,
  (p, r) => `linear-gradient(${pct(r, 100, 120)}deg, ${p[3]} 0%, ${p[2]} 35%, ${p[1]} 70%, ${p[0]} 100%)`,
  (p, r) => {
    const h = pct(r, 60, 16)
    return `linear-gradient(180deg, ${p[3]} 0%, ${p[2]} ${h}%, ${p[0]} ${h}%, ${p[0]} ${h + 3}%, ${p[3]} ${h + 3}%)`
  },
  (p) => `radial-gradient(ellipse at 50% 55%, ${p[0]} 0%, ${p[1]} 28%, ${p[2]} 60%, ${p[3]} 100%)`
]

/** 第 i 张照片的渐变。 */
function photo(seed: number, i: number): string {
  const r = rng(seed * 9973 + i * 7919)
  const shot = SHOTS[(i * 5 + Math.floor(r() * SHOTS.length)) % SHOTS.length]!
  const palette = PALETTES[(i * 3 + Math.floor(r() * PALETTES.length)) % PALETTES.length]!
  return shot(palette, r)
}

/** n 块照片填充放进 host（已有就只换渐变）。 */
function fillPhotos(host: HTMLElement, n: number, seed: number): void {
  for (let i = 0; i < n; i++) {
    let tile = host.children[i] as HTMLElement | undefined
    if (!tile) {
      tile = document.createElement('glass-fill')
      tile.className = 'tile'
      host.append(tile)
    }
    tile.style.setProperty('--glass-fill', photo(seed, i))
  }
}

// —— 页面背景：深色、两团很淡的光。静态的：内置场景一直在漂移，会让 stage 每帧都画。
//    交给 stage 的是 Blob（一张图）而不是画布：没有 GPU 时 stage 把图写成画布的 CSS 背景，页面还是这个样子 ——

async function backdrop(): Promise<Blob | HTMLCanvasElement> {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 200
  const g = c.getContext('2d')!
  g.fillStyle = '#07080d'
  g.fillRect(0, 0, c.width, c.height)
  const glow = (x: number, y: number, r: number, color: string): void => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r)
    rg.addColorStop(0, color)
    rg.addColorStop(1, 'rgba(7, 8, 13, 0)')
    g.fillStyle = rg
    g.fillRect(0, 0, c.width, c.height)
  }
  glow(70, 40, 170, 'rgba(64, 86, 190, 0.32)')
  glow(260, 170, 160, 'rgba(160, 60, 150, 0.2)')
  return new Promise((resolve) => c.toBlob((blob) => resolve(blob ?? c), 'image/png'))
}

// —— 设备缩放 ——

/** 手机连同两边的侧键有多宽（机身 426 + 两边各 22）；最多占视口高度的这么多。 */
const PHONE_WIDTH = 470
const PHONE_MAX_VH = 0.86

function fitDevices(): void {
  for (const slot of document.querySelectorAll<HTMLElement>('[data-slot]')) {
    const device = slot.firstElementChild as HTMLElement
    const phone = slot.dataset.slot === 'phone'
    const w = phone ? PHONE_WIDTH : device.offsetWidth
    const h = device.offsetHeight
    let k = Math.min(1, slot.clientWidth / w)
    if (phone) k = Math.min(k, (innerHeight * PHONE_MAX_VH) / h)
    k = Math.max(0.1, k)
    device.style.setProperty('--k', k.toFixed(4))
    slot.style.height = `${Math.ceil(h * k)}px`
  }
}

/** 元素所在设备此刻的缩放：屏幕上的宽 ÷ 布局宽。 */
function scaleOf(device: HTMLElement): number {
  return device.getBoundingClientRect().width / device.offsetWidth || 1
}

/**
 * morphGlass 的过渡玻璃画在文档最外层、按屏幕像素算：按 dp 写的圆角与模糊不会跟着设备的 transform: scale 缩。
 * 两头的材质先乘上缩放系数传进去，变形结束的那一刻才与缩放后的面板对得上（'frac' 圆角按短边的比例，本来就跟着缩）。
 */
function scaledMaterial(el: HTMLElement, k: number): GlassMaterial {
  const m = { ...MATERIAL_DEFAULTS, ...(el as HTMLElement & { material: GlassMaterial }).material }
  const r = m.cornerRadius
  const cornerRadius: CornerRadius =
    typeof r === 'number' ? r * k : Array.isArray(r) ? [r[0]! * k, r[1]! * k, r[2]! * k, r[3]! * k] : r
  return { ...m, cornerRadius, blur: m.blur * k }
}

// —— 时间与日期 ——

function tick(): void {
  const now = new Date()
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(now)
  for (const el of document.querySelectorAll<HTMLElement>('[data-clock="time"]')) el.textContent = hm
  for (const el of document.querySelectorAll<HTMLElement>('[data-clock="long"]')) {
    el.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${weekday} ${hm}`
  }
}

function fillDates(now: Date): void {
  const set = (key: string, text: string): void => {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-date="${key}"]`)) el.textContent = text
  }
  set('weekday', new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now))
  set('day', String(now.getDate()))
  set('month', new Intl.DateTimeFormat('zh-CN', { month: 'long' }).format(now))

  // 月历：周一开头
  const y = now.getFullYear()
  const m = now.getMonth()
  const offset = (new Date(y, m, 1).getDay() + 6) % 7
  const days = new Date(y, m + 1, 0).getDate()
  const cells = ['一', '二', '三', '四', '五', '六', '日'].map((d) => `<span class="dow">${d}</span>`)
  for (let i = 0; i < offset; i++) cells.push('<span></span>')
  for (let d = 1; d <= days; d++) cells.push(d === now.getDate() ? `<span class="today">${d}</span>` : `<span>${d}</span>`)
  $('month-grid').innerHTML = cells.join('')
}

// —— iPhone ——

const HOME_APPS: readonly (readonly [string, string])[] = [
  ['photos', '照片'],
  ['camera', '相机'],
  ['weather', '天气'],
  ['clock', '时钟'],
  ['maps', '地图'],
  ['calendar', '日历'],
  ['notes', '备忘录'],
  ['reminders', '提醒事项'],
  ['music', '音乐'],
  ['podcasts', '播客'],
  ['health', '健康'],
  ['wallet', '钱包'],
  ['files', '文件'],
  ['store', '商店'],
  ['calculator', '计算器'],
  ['settings', '设置']
]

const PHONE_DOCK: readonly (readonly [string, string])[] = [
  ['phone', '电话'],
  ['browser', '浏览器'],
  ['messages', '信息'],
  ['mail', '邮件']
]

/** 清透的玻璃图标（iOS 26 的「清透」外观）：几乎不模糊，边缘把壁纸弯过来。 */
function appIcon(name: string, label: string): HTMLElement {
  const b = document.createElement('glass-button')
  b.className = 'app-icon'
  b.setAttribute('type', 'button')
  b.setAttribute('preset', 'clear')
  b.setAttribute('corner-radius', '16')
  b.setAttribute('blur', '1.5')
  b.setAttribute('tint', 'rgba(255, 255, 255, 0.08)')
  b.setAttribute('aria-label', label)
  b.dataset.app = name
  b.innerHTML = icon(name)
  return b
}

/** 圆形按钮的「开」：tint 换成它的颜色（data-on），关的时候回到预设。 */
function applyToggle(t: HTMLElement): void {
  if (t.getAttribute('aria-pressed') === 'true') t.setAttribute('tint', `${t.dataset.on}d9`)
  else t.removeAttribute('tint')
}

function setupPhone(): void {
  const phone = $('iphone')
  const screen = phone.querySelector<HTMLElement>('.screen')!
  const home = $('home')
  const photos = $('photos')
  const cc = $('cc')
  const ccToggle = $('cc-toggle')

  const apps = $('apps')
  for (const [name, label] of HOME_APPS) {
    const cell = document.createElement('div')
    cell.className = 'app-cell'
    const text = document.createElement('span')
    text.className = 'app-label'
    text.setAttribute('aria-hidden', 'true')
    text.textContent = label
    cell.append(appIcon(name, label), text)
    apps.append(cell)
  }
  const dock = $('dock-apps')
  for (const [name, label] of PHONE_DOCK) dock.append(appIcon(name, label))

  const grid = $('grid')
  const gridScroll = $('grid-scroll')
  fillPhotos(grid, 36, 1)

  // 打开「照片」：App 从图标中心放大出来（transform-origin 用屏幕里的布局坐标 = 屏幕上的距离 ÷ 缩放）
  const openPhotos = (from: HTMLElement): void => {
    const s = screen.getBoundingClientRect()
    const r = from.getBoundingClientRect()
    const k = scaleOf(phone)
    photos.style.setProperty('--ox', `${(r.left + r.width / 2 - s.left) / k}px`)
    photos.style.setProperty('--oy', `${(r.top + r.height / 2 - s.top) / k}px`)
    phone.dataset.screen = 'photos'
    photos.inert = false
    home.inert = true
  }
  const goHome = (): void => {
    phone.dataset.screen = 'home'
    photos.inert = true
    home.inert = false
  }
  apps.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-app="photos"]')
    if (b) openPhotos(b)
  })

  // 控制中心
  const setCC = (open: boolean): void => {
    phone.toggleAttribute('data-cc', open)
    cc.inert = !open
    ccToggle.setAttribute('aria-expanded', String(open))
    ccToggle.setAttribute('aria-label', open ? '关闭控制中心' : '打开控制中心')
    const behind = phone.dataset.screen === 'photos' ? photos : home
    behind.inert = open
  }
  ccToggle.addEventListener('click', () => setCC(!phone.hasAttribute('data-cc')))
  $('cc-backdrop').addEventListener('click', (e) => {
    const target = e.target as Element
    if (target === e.currentTarget || target.classList.contains('cc-grid')) setCC(false)
  })
  for (const t of cc.querySelectorAll<HTMLElement>('.toggle')) {
    applyToggle(t)
    t.addEventListener('click', () => {
      t.setAttribute('aria-pressed', String(t.getAttribute('aria-pressed') !== 'true'))
      applyToggle(t)
    })
  }
  const play = $('cc-play')
  play.addEventListener('click', () => {
    const playing = play.getAttribute('aria-label') === '播放'
    play.setAttribute('aria-label', playing ? '暂停' : '播放')
    play.innerHTML = icon(playing ? 'pause' : 'play')
  })

  $('home-bar').addEventListener('click', () => {
    if (phone.hasAttribute('data-cc')) setCC(false)
    else if (phone.dataset.screen !== 'home') goHome()
  })

  // 「选择」：从按钮里分出「分享」「删除」两颗水滴，再按一下融回去
  const group = $('select-group') as HTMLElement & { dismiss(member: HTMLElement): Promise<void> }
  const select = $('select')
  let extras: HTMLElement[] = []
  select.addEventListener('click', () => {
    const on = extras.length === 0
    if (on) {
      extras = [
        ['share', '分享'],
        ['trash', '删除']
      ].map(([glyph, label]) => {
        const b = document.createElement('glass-button')
        b.className = 'round'
        b.setAttribute('type', 'button')
        b.setAttribute('preset', 'regular')
        b.setAttribute('aria-label', label!)
        b.innerHTML = icon(glyph!)
        group.append(b)
        return b
      })
    } else {
      for (const b of extras) void group.dismiss(b)
      extras = []
    }
    select.textContent = on ? '完成' : '选择'
    select.setAttribute('aria-pressed', String(on))
  })

  // 标签栏：换排法（照片还是那些，玻璃底下的东西换了样子）
  const tabs = $('photo-tabs') as HTMLElement & { value: string }
  const title = photos.querySelector<HTMLElement>('.app-title')!
  tabs.addEventListener('change', () => {
    grid.dataset.layout = tabs.value
    title.textContent = tabs.querySelector('[aria-selected="true"] span:last-child')?.textContent ?? '图库'
    gridScroll.scrollTop = 0
  })

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !phone.contains(document.activeElement)) return
    if (phone.hasAttribute('data-cc')) setCC(false)
    else if (phone.dataset.screen !== 'home') goHome()
  })
}

// —— Mac ——

interface DockApp {
  readonly key: string
  readonly name: string
  readonly bg: string
  readonly dark?: boolean
}

const MAC_DOCK: readonly DockApp[] = [
  { key: 'files', name: '文件', bg: 'linear-gradient(180deg, #6cc4ff, #1f6fde)' },
  { key: 'browser', name: '浏览器', bg: 'linear-gradient(180deg, #7fe0ff, #2a7cf0)' },
  { key: 'photos', name: '照片', bg: 'linear-gradient(145deg, #ffcf5c, #ff7a59 45%, #d8457e)' },
  { key: 'music', name: '音乐', bg: 'linear-gradient(180deg, #ff6f8e, #f0284a)' },
  { key: 'messages', name: '信息', bg: 'linear-gradient(180deg, #6ff08a, #1fbf4f)' },
  { key: 'mail', name: '邮件', bg: 'linear-gradient(180deg, #7cc7ff, #2e86f5)' },
  { key: 'calendar', name: '日历', bg: 'linear-gradient(180deg, #ffffff, #e9e9ee)', dark: true },
  { key: 'notes', name: '备忘录', bg: 'linear-gradient(180deg, #ffe680, #ffc93c)', dark: true },
  { key: 'settings', name: '设置', bg: 'linear-gradient(180deg, #a3a8b3, #5d626d)' }
]

function dockIcon(app: DockApp): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = app.dark ? 'dock-icon dark-glyph' : 'dock-icon'
  b.dataset.app = app.key
  b.dataset.name = app.name
  b.setAttribute('aria-label', app.name)
  b.style.setProperty('--bg', app.bg)
  b.innerHTML = icon(app.key)
  return b
}

function bounce(el: HTMLElement): void {
  if (reducedMotion()) return
  el.classList.remove('bounce')
  void el.offsetWidth // 重新触发动画
  el.classList.add('bounce')
}

function setupMac(): void {
  const mac = $('mac')
  const win = $('window')

  // Dock
  const dock = $('mac-dock-apps')
  for (const app of MAC_DOCK) dock.append(dockIcon(app))
  const sep = document.createElement('span')
  sep.className = 'dock-sep'
  dock.append(sep, dockIcon({ key: 'trash', name: '废纸篓', bg: 'linear-gradient(180deg, rgba(255,255,255,0.35), rgba(255,255,255,0.12))' }))
  const photosIcon = dock.querySelector<HTMLElement>('[data-app="photos"]')!
  photosIcon.toggleAttribute('data-running', true)
  for (const b of dock.querySelectorAll<HTMLElement>('.dock-icon')) b.addEventListener('animationend', () => b.classList.remove('bounce'))

  // 窗口：内容是填充
  const winGrid = $('win-grid')
  const hero = win.querySelector<HTMLElement>('.hero')!
  const HEROES = [
    'radial-gradient(ellipse at 50% 88%, #fff2c2 0%, #ffb46b 12%, #ff6f61 36%, #6b3fa0 68%, #1b1840 100%)',
    'linear-gradient(180deg, #bff3ff 0%, #4fb4ff 48%, #1d5fd8 48%, #0a2360 100%)',
    'radial-gradient(circle at 30% 40%, #e3f9c8 0%, #7cc86f 30%, #2f7d4a 62%, #0f2e1f 100%)',
    'linear-gradient(120deg, #150d3d 0%, #4b2fbf 40%, #ff6fa8 72%, #ffd6ec 100%)',
    'radial-gradient(ellipse at 50% 60%, #fff4b8 0%, #ffd23f 22%, #f08a24 55%, #5c2b0c 100%)',
    'linear-gradient(180deg, #0b1026 0%, #1b2250 64%, #ffcc66 64%, #ffcc66 67%, #0b1026 67%)',
    'radial-gradient(circle at 60% 45%, #ffd6ec 0%, #ff6fa8 30%, #8a2b6d 62%, #23102a 100%)'
  ]
  const showCategory = (i: number): void => {
    hero.style.setProperty('--glass-fill', HEROES[i % HEROES.length]!)
    fillPhotos(winGrid, 28, 11 + i)
  }
  showCategory(0)

  const setWindow = (state: 'open' | 'closed' | 'minimized'): void => {
    if (state === 'minimized') {
      // 缩向 Dock 上的「照片」：窗口中心到图标中心的位移，换算回窗口的布局坐标
      const k = scaleOf(mac)
      const w = win.getBoundingClientRect()
      const d = photosIcon.getBoundingClientRect()
      win.style.setProperty('--mx', `${(d.left + d.width / 2 - (w.left + w.width / 2)) / k}px`)
      win.style.setProperty('--my', `${(d.top + d.height / 2 - (w.top + w.height / 2)) / k}px`)
    }
    win.dataset.state = state
    win.inert = state !== 'open'
    photosIcon.toggleAttribute('data-running', state !== 'closed')
  }
  $('win-close').addEventListener('click', () => setWindow('closed'))
  $('win-min').addEventListener('click', () => setWindow('minimized'))
  dock.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('.dock-icon')
    if (!b) return
    bounce(b)
    if (b === photosIcon && win.dataset.state !== 'open') setWindow('open')
  })

  // 侧栏：选中条是侧栏里的填充（画在侧栏玻璃之上），滑到点中的那一项
  const items = [...$('side-items').querySelectorAll<HTMLButtonElement>('button')]
  const sel = $('side-sel')
  const select = (b: HTMLButtonElement): void => {
    for (const other of items) other.removeAttribute('aria-current')
    b.setAttribute('aria-current', 'true')
    sel.style.translate = `0 ${b.offsetTop}px`
  }
  select(items[0]!)
  items.forEach((b, i) =>
    b.addEventListener('click', () => {
      select(b)
      showCategory(i)
      $('win-scroll').scrollTop = 0
    })
  )

  // 工具栏：年 / 月 / 日 / 全部 换网格的疏密
  const seg = $('mac-seg') as HTMLElement & { value: string }
  seg.addEventListener('change', () => {
    winGrid.dataset.cols = seg.value
  })

  // 控制中心：从菜单栏上的按钮变形出来（morphGlass），再变回去。按钮随后淡回来，亮一点表示开着
  const btn = $('mac-cc-btn')
  const panel = $('mac-cc')
  let busy = false
  const setCC = async (open: boolean): Promise<void> => {
    if (busy || (btn.getAttribute('aria-expanded') === 'true') === open) return
    busy = true
    btn.setAttribute('aria-expanded', String(open))
    const k = scaleOf(mac)
    const [from, to] = open ? [btn, panel] : [panel, btn]
    to.classList.remove('collapsed')
    await morphGlass(from, to, { fromMaterial: scaledMaterial(from, k), toMaterial: scaledMaterial(to, k) }).finished
    if (open) {
      btn.style.opacity = '' // 变形把按钮留在不透明度 0；它还是开关，淡回来
      btn.setAttribute('tint', 'rgba(255, 255, 255, 0.4)')
    } else {
      panel.classList.add('collapsed')
      panel.style.opacity = ''
      btn.removeAttribute('tint')
    }
    busy = false
  }
  btn.addEventListener('click', () => void setCC(btn.getAttribute('aria-expanded') !== 'true'))
  document.addEventListener('click', (e) => {
    if (btn.getAttribute('aria-expanded') !== 'true') return
    const t = e.target as Node
    if (!panel.contains(t) && !btn.contains(t)) void setCC(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void setCC(false)
  })

  // 网络开关：左边的圆跟着开关变色
  for (const row of panel.querySelectorAll<HTMLElement>('.net-row')) {
    const sw = row.querySelector('glass-switch') as HTMLElement & { checked: boolean }
    const ico = row.querySelector<HTMLElement>('.net-ico')!
    sw.addEventListener('change', () => ico.classList.toggle('on', sw.checked))
  }
  const play = $('mac-play')
  play.addEventListener('click', () => {
    const playing = play.getAttribute('aria-label') === '播放'
    play.setAttribute('aria-label', playing ? '暂停' : '播放')
    play.innerHTML = icon(playing ? 'pause' : 'play')
  })
}

// 不用顶层 await：Vite 的默认构建目标（es2020）不支持
async function main(): Promise<void> {
  defineGlassElements()
  fillIcons(document)
  const now = new Date()
  fillDates(now)
  tick()
  setInterval(tick, 15_000)
  setupPhone()
  setupMac()

  fitDevices()
  const observer = new ResizeObserver(() => fitDevices())
  for (const slot of document.querySelectorAll('[data-slot]')) observer.observe(slot)
  addEventListener('resize', fitDevices)

  // 与调试台一样认两个 URL 参数：?glassium.backend=webgl2 换后端，?glassium.simulate=no-webgpu 走一遍降级
  const params = new URLSearchParams(location.search)
  if (params.get('glassium.simulate') === 'no-webgpu') simulateNoWebGpu(true)
  const requested = params.get('glassium.backend')
  const backend = requested === 'webgl2' || requested === 'webgpu' ? requested : 'auto'
  const stage = await createGlassStage({ scene: await backdrop(), sceneOptions: { background: '#07080d' }, backend })
  Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })
}

void main()
