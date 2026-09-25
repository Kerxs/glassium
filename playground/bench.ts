/**
 * Benchmark（bench.html）：几组场景各自的帧开销。结果表格可以复制成 JSON，贴进 docs/benchmark.md。
 *
 * 每组：搭好 DOM → 预热 30 帧 → 同步连画 N 帧（`renderNow()`，不走 rAF）→ 等 GPU 画完。
 * 主线程取每帧 `stats().cpuMs` 的平均（没有跨源隔离的页面上 performance.now() 只有 0.1 ms 的分辨率，
 * 单帧量不准，平均几百帧才稳）；「含 GPU」是连画 N 帧再等一次回读（它排在前面所有的 GPU 工作后面）的总时间除以 N。
 *
 * `?backend=webgl2` 换后端，`?frames=600` 改帧数，`?auto=1` 打开页面就跑（没人点按钮时也能跑完，比如在自动化里）。
 */

import '../src/components/glassium.css'

import { createGlassStage, defineGlassElements, VERSION, type GlassStage } from 'glassium'

const params = new URLSearchParams(location.search)
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

interface Scenario {
  readonly id: string
  readonly label: string
  build(area: HTMLElement): void
}

/** n 块 96×64 的卡片排成网格（带色散，算最贵的那种单块玻璃）。 */
function cards(area: HTMLElement, n: number, nested = false): void {
  for (let i = 0; i < n; i++) {
    const card = document.createElement('glass-card')
    card.setAttribute('preset', 'regular')
    card.setAttribute('dispersion', '0.3')
    card.setAttribute('corner-radius', '16')
    Object.assign(card.style, { position: 'absolute', left: `${(i % 7) * 106}px`, top: `${Math.floor(i / 7) * 74}px`, width: '96px', height: '64px' })
    if (nested) {
      // 卡片里的按钮在上面一层：画它之前要把下面那层采回来、重建那一块的模糊链
      const button = document.createElement('glass-button')
      Object.assign(button.style, { position: 'absolute', left: '28px', top: '18px', width: '40px', height: '28px' })
      card.append(button)
    }
    area.append(card)
  }
}

/** n 个合并组，每组两个挨着的按钮。 */
function groups(area: HTMLElement, n: number): void {
  for (let i = 0; i < n; i++) {
    const g = document.createElement('glass-container')
    g.setAttribute('smoothing', '20')
    Object.assign(g.style, { position: 'absolute', left: `${(i % 3) * 250}px`, top: `${Math.floor(i / 3) * 90}px`, display: 'flex', gap: '8px' })
    for (let k = 0; k < 2; k++) {
      const b = document.createElement('glass-button')
      Object.assign(b.style, { width: '110px', height: '56px' })
      g.append(b)
    }
    area.append(g)
  }
}

/** n 块填充，上面各压一块卡片（填充画进场景，卡片折射它）。 */
function fills(area: HTMLElement, n: number): void {
  for (let i = 0; i < n; i++) {
    const fill = document.createElement('glass-fill')
    fill.setAttribute('style', `position: absolute; left: ${(i % 4) * 190}px; top: ${Math.floor(i / 4) * 130}px; width: 170px; height: 110px; border-radius: 18px; --glass-fill: hsl(${i * 23} 70% 55%)`)
    area.append(fill)
  }
  cards(area, n)
}

/** 圆角滚动容器，带两头淡出的遮罩，里面 n 块卡片（裁剪与遮罩都在着色器里算）。 */
function clipped(area: HTMLElement, n: number): void {
  const box = document.createElement('div')
  box.setAttribute(
    'style',
    'position: absolute; left: 0; top: 0; width: 740px; height: 600px; overflow: auto; border-radius: 28px; ' +
      'mask-image: linear-gradient(to bottom, transparent, black 40px, black calc(100% - 40px), transparent)'
  )
  const inner = document.createElement('div')
  Object.assign(inner.style, { position: 'relative', height: '1200px' })
  box.append(inner)
  area.append(box)
  cards(inner, n)
}

const SCENARIOS: readonly Scenario[] = [
  ...[1, 8, 16, 32, 64].map((n) => ({ id: `cards-${n}`, label: `${n} 块卡片`, build: (a: HTMLElement) => cards(a, n) })),
  { id: 'groups-8', label: '8 个合并组（16 块）', build: (a) => groups(a, 8) },
  { id: 'nested-16', label: '16 张卡片，每张里一个按钮（两层）', build: (a) => cards(a, 16, true) },
  { id: 'fills-16', label: '16 块填充 + 16 块卡片', build: (a) => fills(a, 16) },
  { id: 'clip-mask-16', label: '16 块卡片在圆角、遮罩的滚动容器里', build: (a) => clipped(a, 16) }
]

export interface BenchResult {
  readonly id: string
  readonly label: string
  readonly panels: number
  readonly groups: number
  readonly fills: number
  readonly drawCalls: number
  /** 主线程每帧（stats().cpuMs.total 的平均），ms。 */
  readonly cpuMs: number
  /** 其中量面板的那一段，ms。 */
  readonly measureMs: number
  /** 连画 N 帧再等 GPU 画完的总时间 ÷ N，ms。 */
  readonly frameMs: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function runOne(stage: GlassStage, scenario: Scenario, frames: number): Promise<BenchResult> {
  const area = $('area')
  area.replaceChildren()
  scenario.build(area)
  await sleep(50) // 组件 upgrade、注册
  // 等 GPU 画完：回读排在前面所有的 GPU 工作后面。回读是在下一帧里兑现的，请求之后马上同步画一帧 ——
  // 不然要等帧循环的 rAF，标签页在后台时就一直等下去（计时里因此多一帧，N 帧里差 1 帧）
  const sync = (): Promise<unknown> => {
    const done = stage.debug.readback({ x: 0, y: 0, width: 1, height: 1 })
    stage.debug.renderNow()
    return done
  }
  for (let i = 0; i < 30; i++) stage.debug.renderNow()
  await sync()
  let cpu = 0
  let measure = 0
  const t0 = performance.now()
  for (let i = 0; i < frames; i++) {
    stage.debug.renderNow()
    const s = stage.debug.stats()
    cpu += s.cpuMs.total
    measure += s.cpuMs.measure
  }
  await sync()
  const t1 = performance.now()
  const s = stage.debug.stats()
  return {
    id: scenario.id,
    label: scenario.label,
    panels: s.panels,
    groups: s.groups,
    fills: s.fills,
    drawCalls: s.drawCalls,
    cpuMs: cpu / frames,
    measureMs: measure / frames,
    frameMs: (t1 - t0) / frames
  }
}

function environment(stage: GlassStage): Record<string, unknown> {
  const s = stage.debug.stats()
  const v = s.viewport
  return {
    glassium: VERSION,
    backend: stage.backend,
    userAgent: navigator.userAgent,
    dpr: devicePixelRatio,
    css: v ? `${v.cssWidth}×${v.cssHeight}` : null,
    composite: v ? `${v.compositeWidth}×${v.compositeHeight}` : null,
    scene: v ? `${v.sceneWidth}×${v.sceneHeight}` : null,
    blurLevels: s.blurLevels,
    date: new Date().toISOString()
  }
}

const f2 = (n: number): string => n.toFixed(3)

async function main(): Promise<void> {
  defineGlassElements()
  const backendParam = params.get('backend')
  const backend = backendParam === 'webgpu' || backendParam === 'webgl2' ? backendParam : 'auto'
  $<HTMLSelectElement>('backend').value = backend
  $<HTMLSelectElement>('backend').addEventListener('change', () => {
    const next = new URLSearchParams(location.search)
    next.set('backend', $<HTMLSelectElement>('backend').value)
    location.search = next.toString()
  })
  const framesParam = Number(params.get('frames'))
  if (framesParam >= 20) $<HTMLInputElement>('frames').value = String(framesParam)

  const stage = await createGlassStage({ backend })
  stage.debug.setBackdrop({ scene: 'calibration' })
  Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })
  const env = environment(stage)
  $('env').textContent = Object.entries(env)
    .filter(([k]) => k !== 'date')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  let results: BenchResult[] = []
  const run = async (): Promise<void> => {
    const button = $<HTMLButtonElement>('run')
    button.disabled = true
    $<HTMLButtonElement>('copy').disabled = true
    document.title = 'Glassium Benchmark · 跑着…'
    const frames = Math.max(20, Number($<HTMLInputElement>('frames').value) || 300)
    const rows = $('rows')
    rows.replaceChildren()
    results = []
    for (const scenario of SCENARIOS) {
      const r = await runOne(stage, scenario, frames)
      results.push(r)
      const tr = document.createElement('tr')
      for (const cell of [r.label, String(r.panels), String(r.drawCalls), f2(r.cpuMs), f2(r.measureMs), f2(r.frameMs)]) {
        const td = document.createElement('td')
        td.textContent = cell
        tr.append(td)
      }
      rows.append(tr)
    }
    $('area').replaceChildren()
    stage.debug.renderNow()
    const report = { ...environment(stage), frames, results }
    Object.assign(window as unknown as Record<string, unknown>, { glassiumBench: report })
    document.title = `Glassium Benchmark · 完成（${results.length} 组）`
    button.disabled = false
    $<HTMLButtonElement>('copy').disabled = false
    $<HTMLButtonElement>('copy').onclick = (): void => {
      void navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
        $('copy').textContent = '已复制'
        setTimeout(() => ($('copy').textContent = '复制 JSON'), 1200)
      })
    }
  }
  $('run').addEventListener('click', () => void run())
  if (params.get('auto') === '1') await run()
}

void main()
