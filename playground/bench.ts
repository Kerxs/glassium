/**
 * Benchmark（bench.html）：几组场景各自的帧开销。结果表格可以复制成 JSON，贴进 docs/benchmark.md。
 *
 * 每组：搭好 DOM → 预热 30 帧 → 同步连画 N 帧（`renderNow()`，不走 rAF）→ 等 GPU 画完。
 * 主线程取每帧 `stats().cpuMs` 的平均（没有跨源隔离的页面上 performance.now() 只有 0.1 ms 的分辨率，
 * 单帧量不准，平均几百帧才稳）；「含 GPU」是连画 N 帧再等一次回读（它排在前面所有的 GPU 工作后面）的总时间除以 N。
 * 「GPU」是 timestamp-query 量的一帧 GPU 时间（WebGPU 才有）：再画 GPU_SAMPLES 帧、每帧之间让出主线程等读回，取中位数。
 * 每组量两遍：「整帧」关掉沿用场景（每帧都重建场景与模糊链，与 0.3 之前的数可比），「实际」照默认（场景没变就沿用）。
 * 「显存」是 stats().gpuMemory 的估计；「沿用」是实际那一遍里沿用上一帧场景的比例。
 * 有的组每帧都要动一下（build 返回的 step）：挪一块玻璃、在场景画布上画一帧。
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
  /** 搭 DOM；返回每帧要做的事（可以没有）。 */
  build(area: HTMLElement, stage: GlassStage): ((frame: number) => void) | void
  /** 拆掉 DOM 之外还要复原的（比如用户场景）。 */
  teardown?(stage: GlassStage): Promise<void> | void
}

/** n 块卡片排成网格（带色散，算最贵的那种单块玻璃）。多于 50 块时换小一号，一屏放得下。 */
function cards(area: HTMLElement, n: number, nested = false, blur?: number): HTMLElement[] {
  const small = n > 50
  const [w, h, cols] = small ? [70, 46, 10] : [96, 64, 7]
  const out: HTMLElement[] = []
  for (let i = 0; i < n; i++) {
    const card = document.createElement('glass-card')
    card.setAttribute('preset', 'regular')
    card.setAttribute('dispersion', '0.3')
    card.setAttribute('corner-radius', '16')
    if (blur !== undefined) card.setAttribute('blur', String(blur))
    Object.assign(card.style, {
      position: 'absolute',
      left: `${(i % cols) * (w + 10)}px`,
      top: `${Math.floor(i / cols) * (h + 10)}px`,
      width: `${w}px`,
      height: `${h}px`
    })
    out.push(card)
    if (nested) {
      // 卡片里的按钮在上面一层：画它之前要把下面那层采回来、重建那一块的模糊链
      const button = document.createElement('glass-button')
      Object.assign(button.style, { position: 'absolute', left: '28px', top: '18px', width: '40px', height: '28px' })
      card.append(button)
    }
    area.append(card)
  }
  return out
}

/** 用户场景是一块每帧都画的画布（像视频）：每帧上传、每帧重建场景与模糊链。 */
function videoScene(area: HTMLElement, stage: GlassStage): (frame: number) => void {
  cards(area, 16)
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const ctx = canvas.getContext('2d')!
  const draw = (frame: number): void => {
    ctx.fillStyle = `hsl(${(frame * 3) % 360} 60% 40%)`
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#fff'
    for (let i = 0; i < 12; i++) ctx.fillRect((frame * 7 + i * 110) % canvas.width, 100 + i * 45, 80, 30)
  }
  draw(0)
  void stage.setScene(canvas, { dynamic: true })
  return draw
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

/** 每帧把第一块卡片挪一点（只动玻璃：沿用场景）。 */
const moveFirst =
  (nested: boolean) =>
  (a: HTMLElement): ((frame: number) => void) => {
    const [first] = cards(a, 16, nested)
    return (frame) => {
      first!.style.translate = `${frame % 20}px 0`
    }
  }

const SCENARIOS: readonly Scenario[] = [
  ...[1, 10, 50, 100].map((n) => ({ id: `cards-${n}`, label: `${n} 块卡片`, build: (a: HTMLElement) => void cards(a, n) })),
  { id: 'groups-8', label: '8 个合并组（16 块）', build: (a) => groups(a, 8) },
  { id: 'nested-16', label: '16 张卡片，每张里一个按钮（两层）', build: (a) => void cards(a, 16, true) },
  { id: 'fills-16', label: '16 块填充 + 16 块卡片', build: (a) => fills(a, 16) },
  { id: 'clip-mask-16', label: '16 块卡片在圆角、遮罩的滚动容器里', build: (a) => clipped(a, 16) },
  { id: 'blur-40-16', label: '16 块卡片，模糊 40', build: (a) => void cards(a, 16, false, 40) },
  { id: 'move-1-of-16', label: '16 块卡片，每帧挪一块（沿用场景）', build: moveFirst(false) },
  { id: 'move-1-of-16-nested', label: '16 张两层的卡片，每帧挪一块（沿用 + 局部复原）', build: moveFirst(true) },
  { id: 'video-16', label: '16 块卡片，场景是每帧都变的画布（像视频）', build: videoScene, teardown: (s) => s.setScene(null) }
]

/** GPU 时间取几帧的中位数（每帧之间让出主线程，等 timestamp 读回来）。 */
const GPU_SAMPLES = 24

export interface BenchResult {
  readonly id: string
  readonly label: string
  readonly panels: number
  readonly groups: number
  readonly fills: number
  /** 整帧的 draw 数；沿用场景时的 draw 数。 */
  readonly drawCalls: number
  readonly actualDrawCalls: number
  /** 主线程每帧（stats().cpuMs.total 的平均），ms。 */
  readonly cpuMs: number
  /** 其中量面板的那一段，ms。 */
  readonly measureMs: number
  /** 连画 N 帧再等 GPU 画完的总时间 ÷ N，ms（整帧）。 */
  readonly frameMs: number
  /** timestamp-query 量的一帧 GPU 时间（中位数），ms；后端量不了是 null（整帧）。 */
  readonly gpuMs: number | null
  /** 实际（场景没变就沿用）那一遍的「含 GPU」与 GPU 时间。 */
  readonly actualFrameMs: number
  readonly actualGpuMs: number | null
  /** 显存估计（字节）。 */
  readonly gpuMemory: number
  /** N 帧里沿用上一帧场景的比例。 */
  readonly reuse: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function runOne(stage: GlassStage, scenario: Scenario, frames: number): Promise<BenchResult> {
  const area = $('area')
  area.replaceChildren()
  const step = scenario.build(area, stage) ?? null
  await sleep(50) // 组件 upgrade、注册
  // 等 GPU 画完：回读排在前面所有的 GPU 工作后面。回读是在下一帧里兑现的，请求之后马上同步画一帧 ——
  // 不然要等帧循环的 rAF，标签页在后台时就一直等下去（计时里因此多一帧，N 帧里差 1 帧）
  const sync = (): Promise<unknown> => {
    const done = stage.debug.readback({ x: 0, y: 0, width: 1, height: 1 })
    stage.debug.renderNow()
    return done
  }
  let frame = 0
  const next = (): void => {
    step?.(frame++)
    stage.debug.renderNow()
  }
  const pass = async (
    reuse: boolean
  ): Promise<{ cpu: number; measure: number; frameMs: number; gpuMs: number | null; reuse: number; draws: number }> => {
    stage.debug.setSceneReuse(reuse)
    for (let i = 0; i < 30; i++) next()
    await sync()
    let cpu = 0
    let measure = 0
    let reused = 0
    const t0 = performance.now()
    for (let i = 0; i < frames; i++) {
      next()
      const st = stage.debug.stats()
      cpu += st.cpuMs.total
      measure += st.cpuMs.measure
      if (st.sceneReused) reused++
    }
    await sync()
    const t1 = performance.now()
    // GPU 时间：每帧之间让出主线程，timestamp 才读得回来
    const gpu: number[] = []
    for (let i = 0; i < GPU_SAMPLES; i++) {
      next()
      await sleep(16)
      const g = stage.debug.stats().gpuMs
      if (g !== null) gpu.push(g)
    }
    gpu.sort((a, b) => a - b)
    return {
      draws: stage.debug.stats().drawCalls,
      cpu: cpu / frames,
      measure: measure / frames,
      frameMs: (t1 - t0) / frames,
      gpuMs: gpu.length ? gpu[Math.floor(gpu.length / 2)]! : null,
      reuse: reused / frames
    }
  }
  const whole = await pass(false)
  const actual = await pass(true)
  const s = stage.debug.stats()
  await scenario.teardown?.(stage)
  return {
    id: scenario.id,
    label: scenario.label,
    panels: s.panels,
    groups: s.groups,
    fills: s.fills,
    drawCalls: whole.draws,
    actualDrawCalls: actual.draws,
    cpuMs: whole.cpu,
    measureMs: whole.measure,
    frameMs: whole.frameMs,
    gpuMs: whole.gpuMs,
    actualFrameMs: actual.frameMs,
    actualGpuMs: actual.gpuMs,
    gpuMemory: s.gpuMemory.bytes,
    reuse: actual.reuse
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
      const cells = [
        r.label,
        String(r.panels),
        `${r.drawCalls} / ${r.actualDrawCalls}`,
        f2(r.cpuMs),
        f2(r.measureMs),
        f2(r.frameMs),
        r.gpuMs === null ? '—' : f2(r.gpuMs),
        f2(r.actualFrameMs),
        r.actualGpuMs === null ? '—' : f2(r.actualGpuMs),
        `${(r.gpuMemory / 1024 / 1024).toFixed(1)} MB`,
        `${Math.round(r.reuse * 100)}%`
      ]
      for (const cell of cells) {
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
