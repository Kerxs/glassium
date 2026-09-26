/**
 * 质感对照页（lab.html）：四个场景对着四张 iOS 26 真机截图，右边的读数与截图上的实测并排。
 *
 * 截图上的实测（sRGB 0–255，亮度按 Rec. 709 加权）记在 APPLE 里；这里在对应的元素上按同样的相对位置回读。
 * 「亮边」= 边外 4% 到边内 15% 那条线上的峰值（或谷值）减去边内 15% 处 —— 与截图上的量法一样。
 *
 * `?glassium.backend=webgl2` 换后端，`?scene=segmented&press=1` 直接打开某个场景并按住。
 */

import '../src/components/glassium.css'

import { createGlassStage, defineGlassElements, type GlassStage } from 'glassium'

type SceneName = 'slider' | 'segmented' | 'panel' | 'buttons'
const SCENES: readonly SceneName[] = ['slider', 'segmented', 'panel', 'buttons']

const params = new URLSearchParams(location.search)
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// —— 背景：按参考图画 ——

function canvas(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(innerWidth))
  c.height = Math.max(1, Math.round(innerHeight))
  draw(c.getContext('2d')!, c.width, c.height)
  return c
}

const flat = (color: string) => (g: CanvasRenderingContext2D, w: number, h: number): void => {
  g.fillStyle = color
  g.fillRect(0, 0, w, h)
}

/** 参考图 2：紫色的视频帧，中间两条模糊的粉色（腿）。 */
function purpleVideo(g: CanvasRenderingContext2D, w: number, h: number): void {
  const bg = g.createLinearGradient(0, 0, w, h)
  bg.addColorStop(0, '#2c2a86')
  bg.addColorStop(0.5, '#4a40b0')
  bg.addColorStop(1, '#2a2474')
  g.fillStyle = bg
  g.fillRect(0, 0, w, h)
  g.filter = 'blur(26px)'
  g.fillStyle = 'rgba(214, 160, 200, 0.9)'
  g.fillRect(w * 0.3, -40, w * 0.07, h + 80)
  g.fillRect(w * 0.43, -40, w * 0.06, h + 80)
  g.fillStyle = 'rgba(120, 90, 210, 0.8)'
  g.fillRect(w * 0.55, h * 0.1, w * 0.3, h * 0.5)
  g.filter = 'none'
}

/** 参考图 4：暗青色的视频帧，一只手（肉色）从左边伸进来，几块粉、绿的光斑。 */
function tealVideo(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#16302e'
  g.fillRect(0, 0, w, h)
  g.filter = 'blur(22px)'
  g.fillStyle = 'rgba(40, 110, 100, 0.9)'
  g.fillRect(w * 0.05, h * 0.1, w * 0.5, h * 0.35)
  g.fillStyle = 'rgba(214, 150, 130, 0.95)'
  g.beginPath()
  g.ellipse(w * 0.33, h * 0.46, w * 0.22, h * 0.05, -0.2, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = 'rgba(230, 90, 120, 0.8)'
  g.beginPath()
  g.arc(w * 0.42, h * 0.5, h * 0.05, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = 'rgba(120, 200, 150, 0.6)'
  g.fillRect(w * 0.55, h * 0.3, w * 0.25, h * 0.3)
  g.filter = 'none'
}

const BACKGROUNDS: Record<SceneName, (g: CanvasRenderingContext2D, w: number, h: number) => void> = {
  slider: flat('rgb(236, 236, 238)'),
  segmented: flat('rgb(241, 241, 241)'),
  panel: purpleVideo,
  buttons: tealVideo
}

// —— 截图上的实测 ——

interface Reading {
  readonly label: string
  /** 截图上的值。 */
  readonly apple: number
  /** 这里的值。 */
  readonly ours: number
}

/** 截图上的实测：key 与各场景的 measure 返回的一一对应。 */
const APPLE: Record<SceneName, Record<string, number>> = {
  slider: {
    背景: 236,
    'Δ 里面上 8%': -8.7,
    'Δ 里面上 22%': 2,
    'Δ 里面 35%': 10,
    'Δ 里面下 80%': 13,
    'Δ 灰轨道 里−外': 12,
    'Δ 蓝轨道 里−外': 18.6,
    '亮边 上缘（谷）': -79,
    '亮边 下缘（峰）': 4.6,
    'Δ 影子 下 8%': -7.3,
    'Δ 影子 下 20%': -4,
    'Δ 影子 红通道 下 8%': -14,
    'Δ 影子 侧面': 0
  },
  segmented: {
    背景: 241,
    'Δ 里面上 15%（对底）': 18,
    'Δ 里面中（对底）': 27,
    'Δ 里面下 85%（对底）': 28,
    '亮边 上缘（峰）': 15,
    '亮边 下缘（峰）': 5,
    'Δ 影子 下 10%': -9
  },
  panel: {
    '亮边 上': 39,
    '亮边 下': 58,
    '亮边 左': 44,
    '亮边 右': 68,
    'Δ 里面−外面 左侧': 19
  },
  buttons: {
    '大按钮 亮边 上': 68,
    '大按钮 亮边 下': 73,
    '大按钮 亮边 左': 36,
    '大按钮 亮边 右': 30,
    'Δ 小按钮 里面−外面': 21
  }
}

// —— 回读 ——

let stage: GlassStage

/** CSS 坐标的一块区域 → 画布设备像素回读（请求之后马上同步出一帧，回读在那一帧里兑现）。 */
async function grab(x: number, y: number, w: number, h: number): Promise<{ data: Uint8Array; w: number; h: number; s: number; x0: number; y0: number }> {
  const v = stage.debug.stats().viewport!
  const s = v.compositeWidth / v.cssWidth
  const box = stage.canvas.getBoundingClientRect()
  const x0 = Math.max(0, Math.floor((x - box.left) * s))
  const y0 = Math.max(0, Math.floor((y - box.top) * s))
  const rw = Math.max(1, Math.min(v.compositeWidth - x0, Math.ceil(w * s)))
  const rh = Math.max(1, Math.min(v.compositeHeight - y0, Math.ceil(h * s)))
  const p = stage.debug.readback({ x: x0, y: y0, width: rw, height: rh })
  stage.debug.renderNow()
  return { data: (await p).rgba, w: rw, h: rh, s, x0, y0 }
}

const lumOf = (d: Uint8Array, i: number): number => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!

/** 一个 CSS 点的颜色与亮度。 */
async function at(x: number, y: number): Promise<{ rgb: [number, number, number]; lum: number }> {
  const g = await grab(x, y, 1, 1)
  return { rgb: [g.data[0]!, g.data[1]!, g.data[2]!], lum: lumOf(g.data, 0) }
}

/**
 * 亮边：从边外 4% 走到边内 15%（按元素的短边），取线上的峰值与谷值，减去边内 15% 处的亮度。
 * side 是边的方向：'top' | 'bottom' | 'left' | 'right'；at 是沿边的位置（0–1）。
 */
async function rim(r: DOMRect, side: 'top' | 'bottom' | 'left' | 'right', along = 0.5): Promise<{ peak: number; trough: number }> {
  const m = Math.min(r.width, r.height)
  const outside = m * 0.04
  const inside = m * 0.15
  let g: Awaited<ReturnType<typeof grab>>
  let values: number[] = []
  if (side === 'top' || side === 'bottom') {
    const x = r.left + r.width * along
    const y0 = side === 'top' ? r.top - outside : r.bottom - inside
    g = await grab(x, y0, 1, outside + inside)
    for (let i = 0; i < g.h; i++) values.push(lumOf(g.data, i * g.w * 4))
    if (side === 'bottom') values = values.reverse()
  } else {
    const y = r.top + r.height * along
    const x0 = side === 'left' ? r.left - outside : r.right - inside
    g = await grab(x0, y, outside + inside, 1)
    for (let i = 0; i < g.w; i++) values.push(lumOf(g.data, i * 4))
    if (side === 'right') values = values.reverse()
  }
  // values 现在是从边外往里走；最后一个是边内 15% 处
  const base = values[values.length - 1]!
  return { peak: Math.max(...values) - base, trough: Math.min(...values) - base }
}

// —— 各场景的测点（相对位置对应截图上的测点） ——

function partOf(host: HTMLElement, part: string): DOMRect {
  return (host.shadowRoot!.querySelector(`[part="${part}"]`) as HTMLElement).getBoundingClientRect()
}

async function measureSlider(): Promise<Record<string, number>> {
  const sl = $('lab-slider')
  const t = partOf(sl, 'thumb')
  const track = partOf(sl, 'track')
  const cx = t.left + t.width / 2
  const ty = track.top + track.height / 2
  const bg = await at(t.left - t.width * 0.6, t.top + t.height * 0.22)
  const in8 = await at(cx, t.top + t.height * 0.08)
  const inTop = await at(cx, t.top + t.height * 0.22)
  const in35 = await at(cx, t.top + t.height * 0.35)
  const inBot = await at(cx, t.top + t.height * 0.8)
  const grayOut = await at(track.right - 20, ty)
  const grayIn = await at(t.left + t.width * 0.75, ty)
  const blueOut = await at(track.left + 30, ty)
  const blueIn = await at(t.left + t.width * 0.3, ty)
  const sh1 = await at(cx, t.bottom + t.height * 0.08)
  const sh2 = await at(cx, t.bottom + t.height * 0.2)
  const side = await at(t.right + t.width * 0.12, t.top + t.height * 0.85)
  const top = await rim(t, 'top')
  const bottom = await rim(t, 'bottom')
  return {
    背景: bg.lum,
    'Δ 里面上 8%': in8.lum - bg.lum,
    'Δ 里面上 22%': inTop.lum - bg.lum,
    'Δ 里面 35%': in35.lum - bg.lum,
    'Δ 里面下 80%': inBot.lum - bg.lum,
    'Δ 灰轨道 里−外': grayIn.lum - grayOut.lum,
    'Δ 蓝轨道 里−外': blueIn.lum - blueOut.lum,
    '亮边 上缘（谷）': top.trough,
    '亮边 下缘（峰）': bottom.peak,
    'Δ 影子 下 8%': sh1.lum - bg.lum,
    'Δ 影子 下 20%': sh2.lum - bg.lum,
    'Δ 影子 红通道 下 8%': sh1.rgb[0] - bg.rgb[0],
    'Δ 影子 侧面': side.lum - bg.lum
  }
}

async function measureSegmented(): Promise<Record<string, number>> {
  const seg = $('lab-seg')
  const t = partOf(seg, 'thumb')
  const track = partOf(seg, 'track')
  const cx = t.left + t.width / 2
  const bg = await at(track.left + track.width / 2, track.top - track.height * 0.3)
  const under = await at(track.left + 12, track.top + track.height / 2)
  const inTop = await at(cx, t.top + t.height * 0.15)
  // 截图上这一点在两个词之间，没有字；这里取选中块右端、放大之后的字外面
  const inMid = await at(cx + t.width * 0.4, t.top + t.height * 0.5)
  const inBot = await at(cx, t.top + t.height * 0.85)
  const sh = await at(cx, t.bottom + t.height * 0.1)
  const top = await rim(t, 'top')
  const bottom = await rim(t, 'bottom')
  return {
    背景: bg.lum,
    'Δ 里面上 15%（对底）': inTop.lum - under.lum,
    'Δ 里面中（对底）': inMid.lum - under.lum,
    'Δ 里面下 85%（对底）': inBot.lum - under.lum,
    '亮边 上缘（峰）': top.peak,
    '亮边 下缘（峰）': bottom.peak,
    'Δ 影子 下 10%': sh.lum - bg.lum
  }
}

async function measurePanel(): Promise<Record<string, number>> {
  const r = $('lab-now').getBoundingClientRect()
  const outside = await at(r.left - 20, r.top + r.height * 0.6)
  const inside = await at(r.left + 40, r.top + r.height * 0.6)
  return {
    '亮边 上': (await rim(r, 'top', 0.62)).peak,
    '亮边 下': (await rim(r, 'bottom', 0.62)).peak,
    '亮边 左': (await rim(r, 'left', 0.6)).peak,
    '亮边 右': (await rim(r, 'right', 0.6)).peak,
    'Δ 里面−外面 左侧': inside.lum - outside.lum
  }
}

async function measureButtons(): Promise<Record<string, number>> {
  const big = $('lab-b2').getBoundingClientRect()
  const small = $('lab-b1').getBoundingClientRect()
  const inSmall = await at(small.left + small.width * 0.5, small.top + small.height * 0.25)
  const outSmall = await at(small.left - 20, small.top + small.height * 0.5)
  return {
    '大按钮 亮边 上': (await rim(big, 'top')).peak,
    '大按钮 亮边 下': (await rim(big, 'bottom')).peak,
    '大按钮 亮边 左': (await rim(big, 'left')).peak,
    '大按钮 亮边 右': (await rim(big, 'right')).peak,
    'Δ 小按钮 里面−外面': inSmall.lum - outSmall.lum
  }
}

const MEASURE: Record<SceneName, () => Promise<Record<string, number>>> = {
  slider: measureSlider,
  segmented: measureSegmented,
  panel: measurePanel,
  buttons: measureButtons
}

// —— 按住：滑块与分段控件的旋钮（合成的 pointer 事件，与手指按住一样走组件自己的路径） ——

function pressTarget(scene: SceneName): { host: HTMLElement; thumb: DOMRect } | null {
  if (scene === 'slider') return { host: $('lab-slider'), thumb: partOf($('lab-slider'), 'thumb') }
  if (scene === 'segmented') return { host: $('lab-seg'), thumb: partOf($('lab-seg'), 'thumb') }
  return null
}

function setPressed(scene: SceneName, down: boolean): void {
  const t = pressTarget(scene)
  if (!t) return
  const x = t.thumb.left + t.thumb.width / 2
  const y = t.thumb.top + t.thumb.height / 2
  t.host.dispatchEvent(
    new PointerEvent(down ? 'pointerdown' : 'pointerup', {
      bubbles: true,
      composed: true,
      clientX: x,
      clientY: y,
      pointerId: 11,
      pointerType: 'mouse',
      button: 0,
      buttons: down ? 1 : 0,
      isPrimary: true
    })
  )
}

// —— 页面 ——

let current: SceneName = 'slider'
let lastReadings: Reading[] = []

function render(readings: readonly Reading[]): void {
  const rows = $('rows')
  rows.replaceChildren()
  for (const r of readings) {
    const tr = document.createElement('tr')
    const diff = r.ours - r.apple
    const near = Math.abs(diff) <= Math.max(4, Math.abs(r.apple) * 0.25)
    for (const [text, cls] of [
      [r.label, ''],
      [r.apple.toFixed(1), ''],
      [r.ours.toFixed(1), ''],
      [`${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`, near ? 'near' : 'far']
    ] as const) {
      const td = document.createElement('td')
      td.textContent = text
      if (cls) td.className = cls
      tr.append(td)
    }
    rows.append(tr)
  }
}

/** 把过渡与动画推到终点（包括组件影子树里的：document.getAnimations() 不含它们）。 */
function finishAnimations(): void {
  const roots: (Document | ShadowRoot)[] = [document]
  for (const el of document.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot)
  for (const root of roots) {
    for (const a of root.getAnimations()) {
      try {
        a.finish()
      } catch {
        // 无限循环的动画 finish 会抛；这里没有
      }
    }
  }
}

async function measure(): Promise<Reading[]> {
  // 按压的缓动、组件的过渡走完再量
  await sleep(50)
  finishAnimations()
  for (let i = 0; i < 3; i++) stage.debug.renderNow()
  const ours = await MEASURE[current]()
  const apple = APPLE[current]
  lastReadings = Object.keys(apple).map((label) => ({ label, apple: apple[label]!, ours: ours[label] ?? NaN }))
  render(lastReadings)
  Object.assign(window as unknown as Record<string, unknown>, { glassiumLab: { scene: current, readings: lastReadings } })
  return lastReadings
}

async function show(scene: SceneName): Promise<void> {
  const press = $<HTMLInputElement>('press')
  if (press.checked) setPressed(current, false)
  current = scene
  for (const s of document.querySelectorAll<HTMLElement>('.scene')) s.classList.toggle('on', s.dataset.scene === scene)
  for (const b of document.querySelectorAll<HTMLElement>('[data-go]')) b.setAttribute('aria-pressed', String(b.dataset.go === scene))
  await stage.setScene(canvas(BACKGROUNDS[scene]), { fit: 'fill' })
  if (press.checked) setPressed(scene, true)
  await measure()
}

async function main(): Promise<void> {
  defineGlassElements()
  const requested = params.get('glassium.backend')
  const backend = requested === 'webgl2' || requested === 'webgpu' ? requested : 'auto'
  stage = await createGlassStage({ backend, sceneOptions: { background: '#000' } })
  Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })
  const v = stage.debug.stats().viewport
  $('env').textContent = `${stage.backend} · DPR ${devicePixelRatio} · ${v ? `${v.compositeWidth}×${v.compositeHeight}` : ''}`

  for (const b of document.querySelectorAll<HTMLElement>('[data-go]')) {
    b.addEventListener('click', () => void show(b.dataset.go as SceneName))
  }
  const press = $<HTMLInputElement>('press')
  press.checked = params.get('press') === '1'
  press.addEventListener('change', () => {
    setPressed(current, press.checked)
    void measure()
  })
  $('measure').addEventListener('click', () => void measure())

  const first = params.get('scene') as SceneName | null
  await show(first && SCENES.includes(first) ? first : 'slider')
}

void main()
