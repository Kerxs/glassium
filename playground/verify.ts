/**
 * 验证页：把 T5–T11 里手工做过的验证固化成一页，逐项检查，结果写进标题栏。
 *
 *   /verify.html                          默认后端（WebGPU，不可用时 WebGL2）
 *   /verify.html?glassium.backend=webgl2  强制 WebGL2
 *
 * 全部判据都是数值，不看截图：GPU 与 CPU 的光学逐像素比对、整帧 / 区域的 SHA-256、
 * 按外法线扇区统计的颜色差。标题栏读作 `PASS n/n` 才算过。
 *
 * 不依赖 requestAnimationFrame：每次回读和探针之后都调 stage.debug.renderNow() 同步出帧，
 * 所以标签页或面板隐藏时也能跑完（隐藏时浏览器会暂停 rAF）。
 */

import {
  compareGroupOptics,
  compareOptics,
  createGlassStage,
  defineGlassElements,
  GlassPresets,
  joinProbeAndColors,
  linearToSrgb,
  morphGlass,
  MORPH_GLASS_EASE,
  parseFillPaint,
  resolvePaint,
  simulateMoreContrast,
  simulateReducedMotion,
  simulateReducedTransparency,
  srgbToLinear,
  summarizeBySector,
  type GlassStage,
  type OpticsComparison,
  type OpticsProbe,
  type ReadbackRegion
} from 'glassium'

type Status = 'pass' | 'fail' | 'skip'
interface Outcome {
  readonly status: Status
  readonly detail: string
}
const pass = (detail: string): Outcome => ({ status: 'pass', detail })
const fail = (detail: string): Outcome => ({ status: 'fail', detail })
const skip = (detail: string): Outcome => ({ status: 'skip', detail })

const results: { name: string; outcome: Outcome }[] = []
const reportEl = document.getElementById('report')!

function render(done = false): void {
  const ran = results.filter((r) => r.outcome.status !== 'skip')
  const passed = ran.filter((r) => r.outcome.status === 'pass').length
  const skipped = results.length - ran.length
  const lines = results.map(
    (r) =>
      `<span class="${r.outcome.status}">${r.outcome.status.toUpperCase().padEnd(4)}</span> ` +
      `<b>${r.name}</b>\n     ${r.outcome.detail}`
  )
  const head = done
    ? `${passed === ran.length ? 'PASS' : 'FAIL'} ${passed}/${ran.length}${skipped ? `（跳过 ${skipped}）` : ''}`
    : `进行中… ${results.length} 项`
  const changes = viewportChanges.length > 0 ? `\n视口在运行中变过：\n  ${viewportChanges.join('\n  ')}` : ''
  const retried = attempt > 0 ? `\n这是第 ${attempt} 次重跑，上一轮作废：\n  ${retryReason}` : ''
  const inexact = startMismatch ? `\n画布没有 1:1 对上设备像素：${startMismatch}` : ''
  reportEl.innerHTML = `${head}${retried}${inexact}${changes}\n\n${lines.join('\n')}`
  if (done && attempt > 0) console.info(`[verify] 第 ${attempt} 次重跑；上一轮作废：${retryReason}`)
  if (done) {
    document.title = `${passed === ran.length ? 'PASS' : 'FAIL'} ${passed}/${ran.length}`
    console.info(`[verify] ${head}`)
  }
}

/**
 * 一轮里视口（DPR、画布大小、各级分辨率）变过没有、在哪一项里变的。开头探到的面板矩形、场景的布局都按
 * 开头的视口算，中途变了它们就作废 —— 这一轮的结果不算数，自动重跑（见 run 的结尾）。
 *
 * 为什么会变：Claude 桌面端的浏览器面板会在页面加载之后才把模拟的视口与 DPR 落定（验证页有时是 DPR 1、
 * 有时是 1.5），面板显示 / 隐藏、宽度变化时也会重设。实测失败过的两轮里，磨砂前卡片内部的亮度都与别的
 * 同 DPR 的轮次不同 —— calibration 场景的布局随画布宽度变（竖直阶跃在 x = W/2），说明那时画布宽度不一样。
 */
const viewportChanges: string[] = []
/** 这一轮最近一次看到的视口（开头是视口稳定之后的那个），与正在跑的那一项的名字。 */
let lastViewport: string | null = null
let currentCheck: string | null = null
/** 自动重跑的次数与上一轮作废的原因记在 sessionStorage 里（重新加载页面之后还在）。 */
const RETRY_KEY = 'glassium.verify.viewportRetries'
const RETRY_REASON_KEY = 'glassium.verify.viewportRetryReason'
const MAX_RETRIES = 2
/** 上一轮为什么作废（重跑时显示在报告开头）。 */
const retryReason = ((): string => {
  try {
    return sessionStorage.getItem(RETRY_REASON_KEY) ?? ''
  } catch {
    return ''
  }
})()
/** 这是第几次重跑（0 是第一次跑）。sessionStorage 不可用时当作已经重跑够了：不重跑，照实报。 */
const attempt = ((): number => {
  try {
    return Number(sessionStorage.getItem(RETRY_KEY) ?? '0') || 0
  } catch {
    return MAX_RETRIES
  }
})()
/**
 * 检测本身的反向对照：`?verify.perturb=<检查名>` 让那一项跑完之后把画布收窄 20px（只在第一次跑时），
 * 这一轮必须被判作废、自动重跑，重跑那一轮照常通过。
 */
const perturbAfter = new URLSearchParams(location.search).get('verify.perturb')
/** 开头（视口稳定之后）画布没有 1:1 对上设备像素时的说明（见 viewportMismatch）。 */
let startMismatch: string | null = null
/** 查问题用：`?verify.stop=<检查名>` 跑完这一项就停，后面的都不跑，页面留在那一刻的状态。 */
const stopAfter = new URLSearchParams(location.search).get('verify.stop')
let stopped = false

/**
 * 等视口稳定下来（连续 0.5 秒不变）、并且画布 1:1 对上设备像素再开始，最多等 5 秒。每一步同步出一帧，
 * stats 里的视口才是新的。等不到 1:1 也照跑，结果在 finish() 里另算。
 */
async function settleViewport(): Promise<void> {
  stage.debug.renderNow()
  let key = viewportKey()
  let since = performance.now()
  const start = since
  while (performance.now() - start < 5000) {
    await sleep(100)
    stage.debug.renderNow()
    const now = viewportKey()
    if (now !== key) {
      key = now
      since = performance.now()
    } else if (performance.now() - since >= 500 && viewportMismatch() === null) {
      return
    }
  }
}

/**
 * 画布是不是 1:1 对上设备像素：合成目标的尺寸应当就是 CSS 尺寸 × DPR。对不上时返回说明，对得上返回 null。
 *
 * 真实的浏览器里两者最多差 1/128 个设备像素（布局按 1/64 CSS 像素取整）。面板的设备模拟会出现 DPR
 * 2.0000000596、画布 767.33 CSS 像素这样的状态：1535 个设备像素摊在 1534.67 上，浏览器自己也在横向重采样
 * 画布，横竖的缩放差万分之二 —— 转过的圆因此与没转的圆差到 5/255，这不是渲染的错。
 */
function viewportMismatch(): string | null {
  const v = stage.debug.stats().viewport
  if (!v) return null
  const w = v.cssWidth * v.dpr
  const h = v.cssHeight * v.dpr
  if (Math.abs(v.compositeWidth - w) < 0.05 && Math.abs(v.compositeHeight - h) < 0.05) return null
  return `${v.compositeWidth}×${v.compositeHeight} 设备像素摊在 ${v.cssWidth}×${v.cssHeight} CSS px × DPR ${v.dpr} = ${w.toFixed(2)}×${h.toFixed(2)} 上`
}

function viewportKey(): string {
  const v = stage.debug.stats().viewport
  const box = stage.canvas.getBoundingClientRect()
  return `DPR ${devicePixelRatio} · 画布 ${box.width}×${box.height} CSS px · ` + (v ? `${v.compositeWidth}×${v.compositeHeight}` : '—')
}

async function check(name: string, fn: () => Promise<Outcome>): Promise<void> {
  if (stopped) return
  currentCheck = name
  noteViewport()
  let outcome: Outcome
  try {
    outcome = await fn()
  } catch (err) {
    outcome = fail(`抛出：${err instanceof Error ? err.message : String(err)}`)
  }
  if (perturbAfter === name && attempt === 0) {
    stage.canvas.style.width = 'calc(100% - 20px)' // 画布是 width: 100%，改 right 收不窄它
    stage.debug.renderNow()
  }
  noteViewport()
  results.push({ name, outcome })
  render()
  if (stopAfter === name) stopped = true
}

// —— 工具 ——

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function sha(bytes: Uint8Array): Promise<string> {
  // 回读结果都是新分配的 ArrayBuffer（不是 SharedArrayBuffer），这个断言成立
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

let stage: GlassStage

/** 回读并同步出一帧：不等 rAF。 */
async function readback(region?: ReadbackRegion): Promise<Uint8Array> {
  const p = stage.debug.readback(region)
  stage.debug.renderNow()
  const rgba = (await p).rgba
  noteViewport()
  return rgba
}

/**
 * 每次回读之后、每一项跑完之后都看一眼视口，变了就记下这一次跳变（跳过去、跳回来各记一次）。只在每一项前后比的话，
 * 视口在一项里面变过去又变回来就漏掉了（实测面板的 DPR 会在 2 与 2.0000000596 之间跳，画布差一个设备像素）。
 */
function noteViewport(): void {
  if (lastViewport === null) return
  const now = viewportKey()
  if (now === lastViewport) return
  viewportChanges.push(`${currentCheck ?? '开始'}：${lastViewport} → ${now}`)
  lastViewport = now
}

/**
 * 两次回读不一样时说清楚差在哪：几个像素、最大通道差、在区域里的范围（区域坐标），
 * 不同的像素不多时逐个列出两边的值。
 */
function pixelDiff(a: Uint8Array, b: Uint8Array, width: number): string {
  let count = 0
  let max = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const listed: string[] = []
  for (let i = 0; i < a.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c]! - b[i + c]!))
    if (d === 0) continue
    count++
    max = Math.max(max, d)
    const p = i / 4
    const x = p % width
    const y = (p - x) / width
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
    if (listed.length < 6) listed.push(`(${x}, ${y}) ${[...a.subarray(i, i + 3)].join('/')} → ${[...b.subarray(i, i + 3)].join('/')}`)
  }
  if (count === 0) return '逐位相同'
  return `${count} 个像素不同，最大差 ${max}，范围 (${x0}, ${y0})–(${x1}, ${y1})` + (count <= 6 ? `：${listed.join('；')}` : '')
}

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` → 0–1 的 [r, g, b, a]。只给验证页算预期值用。 */
function parseRgb(css: string): [number, number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/.exec(css.trim())
  return m ? [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])] : null
}

/** 元素在画布设备像素下的矩形，四周外扩 pad。 */
function regionOf(elements: readonly Element[], pad: number): ReadbackRegion {
  const v = stage.debug.stats().viewport!
  const s = v.compositeWidth / v.cssWidth
  const canvas = stage.canvas.getBoundingClientRect()
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const el of elements) {
    const r = el.getBoundingClientRect()
    x0 = Math.min(x0, r.left - canvas.left)
    y0 = Math.min(y0, r.top - canvas.top)
    x1 = Math.max(x1, r.right - canvas.left)
    y1 = Math.max(y1, r.bottom - canvas.top)
  }
  const x = Math.floor((x0 - pad) * s)
  const y = Math.floor((y0 - pad) * s)
  return { x, y, width: Math.ceil((x1 + pad) * s) - x, height: Math.ceil((y1 + pad) * s) - y }
}

/** 光学比对的判据（spec/golden/README.md）：零个非有限值，采样偏移 p99 < 1e-4 像素。 */
function judgeOptics(c: OpticsComparison): Outcome {
  const detail =
    `${c.texels} 纹素 · 非有限 ${c.gpuNonFinite} · 偏移最大 ${c.maxErr.offset.toExponential(2)} px` +
    ` · p99 ${c.p99OffsetErr.toExponential(2)} px`
  return c.gpuNonFinite === 0 && c.p99OffsetErr < 1e-4 ? pass(detail) : fail(detail)
}

const card = document.getElementById('v-card')!
const duo = document.getElementById('v-duo')!

type Rgb = readonly [number, number, number]
const RED: Rgb = [255, 0, 0]
const GREEN: Rgb = [0, 255, 0]
const BLUE: Rgb = [0, 0, 255]
const WHITE: Rgb = [255, 255, 255]
const MAGENTA: Rgb = [255, 0, 255]

/** 四象限图：左上红、右上绿、左下蓝、右下白。看四个角的颜色就知道有没有上下 / 左右翻转。 */
function quadrants(size: number): ImageData {
  const img = new ImageData(size, size)
  const colors = [RED, GREEN, BLUE, WHITE]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = colors[(y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1)]!
      img.data.set([c[0], c[1], c[2], 255], (y * size + x) * 4)
    }
  }
  return img
}

/** 一张确定性的测试图：横向红、纵向绿的渐变，叠 16px 宽的斜条纹（硬边，考验采样）。 */
function stripes(width: number, height: number): ImageData {
  const img = new ImageData(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const stripe = ((x + y) >> 4) & 1
      img.data.set(
        [Math.round((x / (width - 1)) * 255), Math.round((y / (height - 1)) * 255), stripe ? 230 : 40, 255],
        (y * width + x) * 4
      )
    }
  }
  return img
}

/** 画布上一点（CSS 像素）的颜色。 */
async function pixelAt(x: number, y: number): Promise<Rgb> {
  const v = stage.debug.stats().viewport!
  const s = v.compositeWidth / v.cssWidth
  const canvas = stage.canvas.getBoundingClientRect()
  const rgba = await readback({
    x: Math.floor((x - canvas.left) * s),
    y: Math.floor((y - canvas.top) * s),
    width: 1,
    height: 1
  })
  return [rgba[0]!, rgba[1]!, rgba[2]!]
}

const near = (a: Rgb, b: Rgb): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= 2)

/** 两帧逐像素比较：多少个像素不同、最大差多少、差异落在哪个矩形里。 */
function diffFrames(a: Uint8Array, b: Uint8Array, width: number): { changed: number; max: number; where: string } {
  let changed = 0
  let max = 0
  let bx0 = Infinity
  let by0 = Infinity
  let bx1 = -Infinity
  let by1 = -Infinity
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!))
    if (d > 0) {
      changed++
      const px = (i / 4) % width
      const py = Math.floor(i / 4 / width)
      bx0 = Math.min(bx0, px)
      by0 = Math.min(by0, py)
      bx1 = Math.max(bx1, px)
      by1 = Math.max(by1, py)
    }
    if (d > max) max = d
  }
  return { changed, max, where: changed > 0 ? `，差异集中在 (${bx0}, ${by0})–(${bx1}, ${by1})` : '' }
}

/** 背景恢复成 calibration（棋盘格 + 硬对角线 + 黑白阶跃）。 */
function calibrationScene(): void {
  stage.debug.setBackdrop({ scene: 'calibration', blurDp: 0, saturation: 1, tint: 'rgba(255, 255, 255, 0)' })
}

/**
 * 探一遍所有单独绘制的面板，按矩形认出是哪一块 —— 不依赖注册顺序。
 * 探针本身与场景无关（只含几何量），换场景之后要配颜色回读时可以复用。
 */
async function probeAll(): Promise<Map<string, OpticsProbe>> {
  const v = stage.debug.stats().viewport!
  const s = v.compositeWidth / v.cssWidth
  const canvas = stage.canvas.getBoundingClientRect()
  const candidates = ['v-card', 'v-pill', 'v-asym'].map((id) => {
    const r = document.getElementById(id)!.getBoundingClientRect()
    return { id, x: (r.left - canvas.left) * s, y: (r.top - canvas.top) * s }
  })
  const found = new Map<string, OpticsProbe>()
  for (let i = 0; i < 8; i++) {
    const p = stage.debug.probeOptics(i)
    stage.debug.renderNow()
    let probe: OpticsProbe
    try {
      probe = await p
    } catch {
      break // 没有第 i 块了
    }
    const hit = candidates.find(
      (c) => Math.abs(c.x - probe.panel.rect[0]) < 0.5 && Math.abs(c.y - probe.panel.rect[1]) < 0.5
    )
    if (hit) found.set(hit.id, probe)
  }
  return found
}

// —— 检查项 ——

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const requested = params.get('glassium.backend')
  const backend = requested === 'webgl2' || requested === 'webgpu' ? requested : 'auto'

  defineGlassElements()
  stage = await createGlassStage({ backend })
  Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })
  calibrationScene()
  // 1:1 判据的反向对照：`?verify.inexact` 把画布收窄 1/3 个 CSS 像素，合成目标就对不上设备像素了。
  // 写成样式规则而不是画布的行内样式：cross-backend 会另建 stage，新画布也要一样窄
  if (params.has('verify.inexact')) {
    const style = document.createElement('style')
    style.textContent = 'canvas[data-glassium-scene] { width: calc(100% - 0.33px) !important; }'
    document.head.append(style)
  }
  await settleViewport()
  lastViewport = viewportKey()
  startMismatch = viewportMismatch()

  await check('backend', async () => {
    const report = stage.debug.probe
    const detail = `${stage.backend}${report ? `（${report.kind}）` : ''}`
    return stage.backend === 'none' ? fail(`${detail}：没有 GPU 后端，下面的检查都没有意义`) : pass(detail)
  })
  if (stage.backend === 'none') {
    render(true)
    return
  }

  await check('deterministic', async () => {
    // 静止的画面连着出 21 帧，整张画布必须逐位相同。WebGL2 在 NVIDIA RTX 4070 Laptop + ANGLE（D3D11）上曾经不是：
    // 片元着色器里除以 uniform 的结果在帧与帧之间差 1 ulp，经过双线性采样变成 ±1 的色阶，一成到四成的帧
    // 与别的帧不同（见 webgl2/shaders.ts 的 uStageInv）。后面按哈希比对的检查都靠这一条
    const v = stage.debug.stats().viewport!
    const full = { x: 0, y: 0, width: v.compositeWidth, height: v.compositeHeight }
    const first = await readback(full)
    const firstHash = await sha(first)
    let differing = 0
    let where = ''
    for (let i = 0; i < 20; i++) {
      const next = await readback(full)
      if ((await sha(next)) === firstHash) continue
      differing++
      if (!where) where = pixelDiff(first, next, full.width)
    }
    const detail = `整张画布（${full.width}×${full.height}）连着 21 帧：` + (differing === 0 ? '逐位相同' : `${differing} 帧与第一帧不同，头一帧 ${where}`)
    return differing === 0 ? pass(detail) : fail(detail)
  })

  const probes = await probeAll()
  for (const id of ['v-card', 'v-pill', 'v-asym']) {
    await check(`optics:${id}`, async () => {
      const probe = probes.get(id)
      return probe ? judgeOptics(compareOptics(probe)) : fail('没有探到这块面板')
    })
  }

  await check('optics:group', async () => {
    const p = stage.debug.probeGroup(0)
    stage.debug.renderNow()
    return judgeOptics(compareGroupOptics(await p))
  })

  await check('opaque-canvas', async () => {
    const rgba = await readback({ x: 0, y: 0, width: stage.canvas.width, height: stage.canvas.height })
    let bad = 0
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) bad++
    const detail = `${rgba.length / 4} 像素，alpha ≠ 255 的 ${bad} 个`
    return bad === 0 ? pass(detail) : fail(detail)
  })

  await check('draw-calls', async () => {
    stage.debug.renderNow()
    const s = stage.debug.stats()
    let grouped = 0
    if (s.groups > 0) grouped = 2 // 这一页里唯一的组有两个成员
    const standalone = s.panels - grouped
    const expect = 2 + s.blurPasses + standalone + s.groups
    const detail =
      `drawCalls ${s.drawCalls}（= 2 + 模糊 ${s.blurPasses} + 单块 ${standalone} + 组 ${s.groups}），` +
      `模糊 ${s.blurPasses} 趟 / ${s.blurLevels} 级`
    return s.drawCalls === expect && s.blurPasses === 2 * (s.blurLevels - 1) ? pass(detail) : fail(detail)
  })

  await check('dispersion-order', async () => {
    // 径向场以卡片中心为圆心：往里采样就是往暗处采。色散让蓝比红采得更靠里 ——
    // 所以折射带里四个角都应当是 R > B。上游的鞍面调制会让相邻两个角给出相反的结论。
    const r = card.getBoundingClientRect()
    stage.debug.setBackdrop({ scene: 'radial', radialCenter: [r.left + r.width / 2, r.top + r.height / 2], radialRadius: 0.6 })
    try {
      const probe = probes.get('v-card')
      if (!probe) return fail('没有探到卡片')
      const rgba = await readback({ x: probe.origin[0], y: probe.origin[1], width: probe.width, height: probe.height })
      const pixels = joinProbeAndColors(probe, rgba)
      const h = probe.panel.heightPx
      const bySector = summarizeBySector(pixels, (px) =>
        px.sd < -1 && px.sd > -0.9 * h ? (px.rgb[0] - px.rgb[2]) * 255 : null
      )
      const corners = (['TL', 'TR', 'BR', 'BL'] as const).map((k) => [k, bySector[k].mean] as const)
      const detail = corners.map(([k, m]) => `${k} ${m.toFixed(2)}`).join(' · ') + '（R − B，/255）'
      return corners.every(([, m]) => m > 0.5) ? pass(detail) : fail(detail)
    } finally {
      calibrationScene()
    }
  })

  await check('highlight-asymmetry', async () => {
    // 平灰场上模糊与折射都改变不了颜色，边缘的亮度差只可能来自高光：
    // 左上（朝光）要亮，右下（背光）一个发亮的像素都不该有。
    stage.debug.setBackdrop({ scene: 'flat' })
    try {
      const probe = probes.get('v-card')
      if (!probe) return fail('没有探到卡片')
      const rgba = await readback({ x: probe.origin[0], y: probe.origin[1], width: probe.width, height: probe.height })
      const pixels = joinProbeAndColors(probe, rgba)
      const luma = (px: (typeof pixels)[number]): number => ((px.rgb[0] + px.rgb[1] + px.rgb[2]) / 3) * 255
      const deep = pixels.filter((px) => px.sd < -probe.panel.heightPx - 4).map(luma).sort((a, b) => a - b)
      const base = deep[Math.floor(deep.length / 2)] ?? 0
      const rim = summarizeBySector(pixels, (px) => (px.sd < -0.5 && px.sd > -1.5 ? luma(px) - base : null))
      const detail =
        `相对内部 ${base.toFixed(1)}：TL 均值 ${rim.TL.mean.toFixed(1)} · BR 均值 ${rim.BR.mean.toFixed(1)}` +
        ` · BR 最大 ${rim.BR.max.toFixed(1)}`
      return rim.TL.mean > 10 && rim.BR.max <= 1 ? pass(detail) : fail(detail)
    } finally {
      calibrationScene()
    }
  })

  await check('reduced-transparency', async () => {
    // 减少透明度：卡片内部（离边缘一个折射带以上、只剩模糊背景与 tint 的地方）的图案要被磨砂盖住 ——
    // 亮度起伏大幅下降，整体变暗（卡片文字是白的 → 深色磨砂）；关掉之后逐位回到原样
    const probe = probes.get('v-card')
    if (!probe) return fail('没有探到卡片')
    // 按面板自己的矩形往里收，不按探针区域（探针覆盖整个 scissor，有投影时还包着外面那一圈影子）
    const inset = Math.ceil(probe.panel.heightPx) + 8
    const [rx, ry, rw, rh] = probe.panel.rect
    const region: ReadbackRegion = {
      x: Math.ceil(rx) + inset,
      y: Math.ceil(ry) + inset,
      width: Math.floor(rw) - 2 * inset,
      height: Math.floor(rh) - 2 * inset
    }
    const lumaStats = (rgba: Uint8Array): { mean: number; std: number } => {
      let sum = 0
      let sq = 0
      const n = rgba.length / 4
      for (let i = 0; i < rgba.length; i += 4) {
        const l = 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!
        sum += l
        sq += l * l
      }
      const mean = sum / n
      return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) }
    }
    const before = await readback(region)
    simulateReducedTransparency(true)
    await sleep(0)
    const reduced = await readback(region)
    const flag = stage.debug.stats().reducedTransparency
    simulateReducedTransparency(null)
    await sleep(0)
    const after = await readback(region)
    // 更高对比度走的是同一个磨砂变换：画出来必须与减少透明度逐位相同，关掉之后同样复原
    simulateMoreContrast(true)
    await sleep(0)
    const contrast = await readback(region)
    const contrastFlag = stage.debug.stats().moreContrast
    simulateMoreContrast(null)
    await sleep(0)
    const afterContrast = await readback(region)
    const a = lumaStats(before)
    const b = lumaStats(reduced)
    const restored = (await sha(before)) === (await sha(after)) && (await sha(before)) === (await sha(afterContrast))
    const sameFrost = (await sha(reduced)) === (await sha(contrast))
    const detail =
      `卡片内部 ${region.width}×${region.height}：亮度 ${a.mean.toFixed(1)} ± ${a.std.toFixed(1)}` +
      ` → ${b.mean.toFixed(1)} ± ${b.std.toFixed(1)} · stats ${flag} / ${contrastFlag}` +
      ` · 更高对比度${sameFrost ? '与之逐位相同' : '与之不同'} · 关掉后${restored ? '逐位复原' : '没有复原'}`
    const ok = flag && contrastFlag && b.std < a.std * 0.25 && b.mean < 90 && sameFrost && restored
    return ok ? pass(detail) : fail(detail)
  })

  await check('button-light', async () => {
    // 按压处的光：在胶囊按钮宽度 25% 处按下。按下本身让整块按钮均匀地变化（tint 加厚、折射加深），
    // 光只加在按下的地方 —— 所以按钮中间那一条（离边缘一个折射带以上）里，按下点的亮度增量
    // 要明显大于对称位置（75% 处）的增量。松开之后逐位复原。
    // 模拟减少动效：能量直接落到终点，结果与帧时序无关。
    const pill = document.getElementById('v-pill')!
    simulateReducedMotion(true)
    try {
      const r = pill.getBoundingClientRect()
      const region = regionOf([pill], 0)
      const at = (clientX: number, clientY: number): PointerEventInit => ({
        bubbles: true,
        button: 0,
        pointerType: 'mouse',
        clientX,
        clientY
      })
      const rest = await readback(region)
      pill.dispatchEvent(new PointerEvent('pointerdown', at(r.left + r.width * 0.25, r.top + r.height / 2)))
      const pressed = await readback(region)
      pill.dispatchEvent(new PointerEvent('pointerup', at(r.left + r.width * 0.25, r.top + r.height / 2)))
      pill.dispatchEvent(new PointerEvent('pointerleave', at(r.left - 10, r.top - 10)))
      const released = await readback(region)

      // 以按下点与对称点为中心、8×12 CSS 像素的方块里，亮度增量的平均
      const v = stage.debug.stats().viewport!
      const s = v.compositeWidth / v.cssWidth
      const gain = (fx: number): number => {
        let sum = 0
        let n = 0
        const cx = Math.round(r.width * fx * s)
        const cy = Math.round((r.height / 2) * s)
        for (let y = cy - Math.round(6 * s); y < cy + Math.round(6 * s); y++) {
          for (let x = cx - Math.round(4 * s); x < cx + Math.round(4 * s); x++) {
            const i = (y * region.width + x) * 4
            const l = (p: Uint8Array): number => 0.2126 * p[i]! + 0.7152 * p[i + 1]! + 0.0722 * p[i + 2]!
            sum += l(pressed) - l(rest)
            n++
          }
        }
        return sum / n
      }
      const near = gain(0.25)
      const far = gain(0.75)
      const restored = (await sha(rest)) === (await sha(released))
      const detail =
        `亮度增量：按下点 +${near.toFixed(1)}，对称点 +${far.toFixed(1)}（/255）· 松开后${restored ? '逐位复原' : '没有复原'}`
      return near > far + 10 && restored ? pass(detail) : fail(detail)
    } finally {
      simulateReducedMotion(null)
    }
  })

  await check('css-opacity', async () => {
    // 玻璃跟着元素的实际不透明度一起淡：外层 opacity 0.5 时，玻璃相对「没有这块面板」的改变量
    // 应当正好减半 —— 预乘混合下 out = 玻璃·a + 背景·(1 − a)，a 减半，改变量就减半
    const wrap = document.createElement('div')
    Object.assign(wrap.style, { position: 'absolute', left: '440px', top: '480px', width: '200px', height: '100px' })
    const card = document.createElement('glass-card')
    card.setAttribute('corner-radius', '16')
    // 浓的 tint 让改变量处处都大：8 位取整之后，平坦区域里每个像素的改变量相同，
    // 改变量小时 round(d/2)/round(d) 会系统性地偏开 0.5（d≈22.6 时是 11/23 = 0.478）
    card.setAttribute('tint', 'rgba(255, 0, 0, 0.6)')
    // 不要投影：玻璃与它的影子都随不透明度变淡，叠起来会多出一个乘积项 —— 这里只验淡入淡出本身
    card.setAttribute('shadow', '0')
    Object.assign(card.style, { left: '0', top: '0', width: '200px', height: '100px' })
    wrap.append(card)
    document.body.append(wrap)
    await sleep(0)
    const region = regionOf([card], 0)
    const full = await readback(region)
    wrap.style.opacity = '0.5'
    await sleep(0)
    const half = await readback(region)
    card.remove()
    await sleep(0)
    const none = await readback(region)
    wrap.remove()
    stage.debug.renderNow()
    // 只看改变量大的通道（|满 − 无| > 48，取整误差不到 1%），比较（半 − 无）/（满 − 无）
    let sum = 0
    let n = 0
    for (let i = 0; i < full.length; i++) {
      if (i % 4 === 3) continue
      const d = full[i]! - none[i]!
      if (Math.abs(d) <= 48) continue
      sum += (half[i]! - none[i]!) / d
      n++
    }
    const ratio = n > 0 ? sum / n : NaN
    const detail = `${n} 个通道值上，外层 opacity 0.5 时玻璃的改变量是完整的 ${ratio.toFixed(3)} 倍（应为 0.5）`
    return n > 1000 && Math.abs(ratio - 0.5) < 0.03 ? pass(detail) : fail(detail)
  })

  await check('adaptive', async () => {
    // 自适应：纯白场景上的白字卡片，玻璃要压暗到与白字 3:1（相对亮度 0.30）；
    // 纯黑场景上的深色字卡片，玻璃要提亮到与黑字 3:1（0.10）。adaptive="0" 时不管。
    const flat = (v: number): ImageData => {
      const img = new ImageData(4, 4)
      for (let i = 0; i < img.data.length; i += 4) img.data.set([v, v, v, 255], i)
      return img
    }
    const card = document.createElement('glass-card')
    card.setAttribute('corner-radius', '16')
    Object.assign(card.style, { left: '440px', top: '480px', width: '200px', height: '100px' })
    document.body.append(card)
    await sleep(0)
    // 离边缘 16px 以上：折射带（regular 在 100px 短边上是 10px）之外，只剩模糊背景、tint 与纱
    const r = regionOf([card], -16)
    const lumaOf = (rgba: Uint8Array): number => {
      const lin = (c: number): number => {
        const s = c / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      let sum = 0
      for (let i = 0; i < rgba.length; i += 4) {
        sum += 0.2126 * lin(rgba[i]!) + 0.7152 * lin(rgba[i + 1]!) + 0.0722 * lin(rgba[i + 2]!)
      }
      return sum / (rgba.length / 4)
    }
    const measure = async (adaptive: boolean): Promise<number> => {
      if (adaptive) card.removeAttribute('adaptive')
      else card.setAttribute('adaptive', '0')
      await sleep(0)
      return lumaOf(await readback(r))
    }
    try {
      await stage.setScene(flat(255), { fit: 'fill' })
      card.style.color = '#fff'
      const whiteOff = await measure(false)
      const whiteOn = await measure(true)
      await stage.setScene(flat(0), { fit: 'fill' })
      card.style.color = '#111'
      await sleep(0)
      const blackOff = await measure(false)
      const blackOn = await measure(true)
      const detail =
        `白底白字：${whiteOff.toFixed(3)} → ${whiteOn.toFixed(3)}（目标 0.30）· ` +
        `黑底深色字：${blackOff.toFixed(3)} → ${blackOn.toFixed(3)}（目标 0.10）`
      const ok =
        whiteOff > 0.9 && Math.abs(whiteOn - 0.3) < 0.03 && blackOff < 0.05 && Math.abs(blackOn - 0.1) < 0.02
      return ok ? pass(detail) : fail(detail)
    } finally {
      card.remove()
      await stage.setScene(null)
      stage.debug.renderNow()
    }
  })

  await check('shadow', async () => {
    // 投影：纯白场景上，卡片正下方那一条比正上方那一条暗（影子往下偏）；shadow="0" 时两条都是纯白
    const white = new ImageData(4, 4)
    white.data.fill(255)
    const card = document.createElement('glass-card')
    card.setAttribute('corner-radius', '16')
    Object.assign(card.style, { left: '440px', top: '480px', width: '200px', height: '100px' })
    document.body.append(card)
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvas = stage.canvas.getBoundingClientRect()
    const strip = (dy0: number, dy1: number, fromBottom: boolean): ReadbackRegion => {
      const r = card.getBoundingClientRect()
      const edge = fromBottom ? r.bottom : r.top
      return {
        x: Math.floor((r.left - canvas.left + r.width * 0.3) * s),
        y: Math.floor((edge - canvas.top + dy0) * s),
        width: Math.floor(r.width * 0.4 * s),
        height: Math.floor((dy1 - dy0) * s)
      }
    }
    const mean = (rgba: Uint8Array): number => {
      let sum = 0
      for (let i = 0; i < rgba.length; i += 4) sum += (rgba[i]! + rgba[i + 1]! + rgba[i + 2]!) / 3
      return sum / (rgba.length / 4)
    }
    try {
      await stage.setScene(white, { fit: 'fill' })
      await sleep(0)
      const below = strip(4, 12, true)
      const above = strip(-12, -4, false)
      const belowOn = mean(await readback(below))
      const aboveOn = mean(await readback(above))
      card.setAttribute('shadow', '0')
      await sleep(0)
      const belowOff = mean(await readback(below))
      const aboveOff = mean(await readback(above))
      const detail =
        `正下方 4–12px：${belowOff.toFixed(1)} → ${belowOn.toFixed(1)}；正上方：${aboveOff.toFixed(1)} → ${aboveOn.toFixed(1)}` +
        '（shadow="0" → 默认，/255）'
      const ok = belowOff >= 254.5 && aboveOff >= 254.5 && belowOn < 250 && aboveOn > belowOn + 3
      return ok ? pass(detail) : fail(detail)
    } finally {
      card.remove()
      await stage.setScene(null)
      stage.debug.renderNow()
    }
  })

  await check('transform-scale', async () => {
    // 祖先 transform: scale(0.5) 里一张 200×100、圆角 24、模糊 8 的卡片，与直接画出来的 100×50、圆角 12、
    // 模糊 4 的卡片应当逐位相同（折射按短边的比例算，本来就跟着缩放；圆角、模糊这类 dp 量要乘视觉缩放）。
    // 亮边宽度与投影的形状是渲染器定的绝对 dp —— 缩放时它们也该跟着缩，而直接画的小卡片不缩，所以这里关掉
    const common = (el: HTMLElement): void => {
      el.setAttribute('highlight', '0')
      el.setAttribute('shadow', '0')
      el.setAttribute('dispersion', '0')
    }
    const wrap = document.createElement('div')
    Object.assign(wrap.style, {
      position: 'absolute',
      left: '440px',
      top: '480px',
      width: '200px',
      height: '100px',
      transform: 'scale(0.5)',
      transformOrigin: '0 0'
    })
    const big = document.createElement('glass-card')
    big.setAttribute('corner-radius', '24')
    big.setAttribute('blur', '8')
    common(big)
    Object.assign(big.style, { left: '0', top: '0', width: '200px', height: '100px' })
    wrap.append(big)
    document.body.append(wrap)
    await sleep(0)
    const region = regionOf([big], 6)
    const scaled = await sha(await readback(region))
    wrap.remove()
    const small = document.createElement('glass-card')
    small.setAttribute('corner-radius', '12')
    small.setAttribute('blur', '4')
    common(small)
    Object.assign(small.style, { left: '440px', top: '480px', width: '100px', height: '50px' })
    document.body.append(small)
    await sleep(0)
    const direct = await sha(await readback(region))
    small.remove()
    stage.debug.renderNow()
    const detail = `scale(0.5) 的大卡片 ${scaled.slice(0, 12)} · 直接画的小卡片 ${direct.slice(0, 12)}`
    return scaled === direct ? pass(detail) : fail(detail)
  })

  await check('rotation', async () => {
    // 1) 形状：200×60 的胶囊转 45°。沿转过的长轴离中心 80px 的点在形状里；沿原来的 x 轴 80px 的点不在
    //    （离转过的长轴 56px，超出半宽 30）。遮罩视图读覆盖率。
    // 2) 光学：圆形玻璃转 37° 与不转，放在以它为圆心的径向场景上 —— 圆本身旋转不变，折射方向与法线
    //    要正确地转回屏幕坐标，两边才一样（旋转的算术会让个别像素差 1/255）。
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvas = stage.canvas.getBoundingClientRect()
    const px = (x: number, y: number): ReadbackRegion => ({
      x: Math.floor((x - canvas.left) * s),
      y: Math.floor((y - canvas.top) * s),
      width: 1,
      height: 1
    })

    const pill = document.createElement('glass-card')
    pill.setAttribute('corner-radius', '1frac')
    Object.assign(pill.style, { left: '440px', top: '500px', width: '200px', height: '60px', transform: 'rotate(45deg)' })
    document.body.append(pill)
    await sleep(0)
    const c = { x: 540, y: 530 } // 中心：变换不挪中心（transform-origin 默认在中心）
    const d = 80 / Math.SQRT2
    stage.debug.setPanelDebug('mask')
    const along = (await readback(px(c.x + d, c.y + d)))[0]!
    const across = (await readback(px(c.x + 80, c.y)))[0]!
    stage.debug.setPanelDebug('off')
    pill.remove()

    const circle = document.createElement('glass-card')
    circle.setAttribute('corner-radius', '1frac') // 圆：半径 = 短边的一半（0.5frac 只是短边的四分之一，那是圆角方块，转了就不一样）
    circle.setAttribute('dispersion', '0.3')
    Object.assign(circle.style, { left: '440px', top: '480px', width: '160px', height: '160px' })
    document.body.append(circle)
    stage.debug.setBackdrop({ scene: 'radial', radialCenter: [520, 560], radialRadius: 0.3 })
    await sleep(0)
    const region = regionOf([circle], 40)
    const straight = await readback(region)
    circle.style.transform = 'rotate(37deg)'
    await sleep(0)
    const turned = await readback(region)
    circle.remove()
    calibrationScene()
    stage.debug.renderNow()

    let changed = 0
    let max = 0
    for (let i = 0; i < straight.length; i += 4) {
      const dd = Math.max(
        Math.abs(straight[i]! - turned[i]!),
        Math.abs(straight[i + 1]! - turned[i + 1]!),
        Math.abs(straight[i + 2]! - turned[i + 2]!)
      )
      if (dd > 0) changed++
      max = Math.max(max, dd)
    }
    const total = straight.length / 4
    const detail =
      `转 45° 的胶囊：长轴上的点覆盖率 ${along}/255，原 x 轴上的点 ${across}/255 · ` +
      `转 37° 的圆与不转的圆：${total} 像素里 ${changed} 个不同，最大差 ${max}/255`
    return along >= 250 && across === 0 && max <= 2 && changed / total < 0.02 ? pass(detail) : fail(detail)
  })

  await check('fill', async () => {
    // 填充（<glass-fill>）：
    // 1) 直接看到的部分按画布分辨率画：离边缘 1 个设备像素以外与没有填充时逐像素相同（场景分辨率的那一份
    //    不能渗出来），离边缘 1 个像素以内的里面是填充的颜色；
    // 2) 玻璃看得见它：盖在填充上的玻璃被染上它的颜色（没有填充时这里 R ≈ G）；
    // 3) 颜色跟着 CSS 过渡逐帧走：过渡到一半时画出来的颜色就是那一刻的计算值。
    //
    // 场景目标压到画布的 0.6 倍（DPR 1 的小视口上预算从来不紧，场景与画布同分辨率，渗色根本不会发生，
    // 第 1 条就验了个寂寞）。
    stage.debug.setBackdrop({ scene: 'flat' })
    const full = stage.debug.stats().viewport!
    stage.debug.setPixelBudget(Math.floor(full.compositeWidth * full.compositeHeight * 0.36))
    stage.debug.renderNow()
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const fill = document.createElement('glass-fill')
    Object.assign(fill.style, { position: 'absolute', left: '440px', top: '480px', width: '200px', height: '100px', borderRadius: '24px' })
    fill.style.setProperty('--glass-fill', 'rgb(255, 0, 0)')
    document.body.append(fill)
    await sleep(0)
    const region = regionOf([fill], 6)
    const withFill = await readback(region)
    const r = fill.getBoundingClientRect()
    const rx = (r.left - canvasBox.left) * s
    const ry = (r.top - canvasBox.top) * s
    const hw = (r.width * s) / 2
    const hh = (r.height * s) / 2
    const radius = 24 * s
    const sdAt = (px: number, py: number): number => {
      const qx = Math.abs(px - rx - hw) - (hw - radius)
      const qy = Math.abs(py - ry - hh) - (hh - radius)
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
    }

    // 2) 右半边盖一块玻璃
    const card = document.createElement('glass-card')
    card.setAttribute('corner-radius', '16')
    card.setAttribute('shadow', '0')
    Object.assign(card.style, { left: '560px', top: '490px', width: '120px', height: '80px' })
    document.body.append(card)
    await sleep(0)
    const glassRegion = regionOf([card], -20) // 玻璃内部、折射带之外；横向落在填充上的是 580–640
    const onFill = await readback(glassRegion)

    // 3) 过渡到一半
    fill.style.transition = '--glass-fill 1000ms linear'
    fill.style.setProperty('--glass-fill', 'rgb(0, 0, 255)')
    const transition = fill.getAnimations()[0]
    let mid: number[] = []
    let midCss = ''
    if (transition) {
      transition.pause()
      transition.currentTime = 500
      midCss = getComputedStyle(fill).getPropertyValue('--glass-fill')
      mid = Array.from(await readback({ x: Math.floor(rx + 20 * s), y: Math.floor(ry + 50 * s), width: 1, height: 1 }))
      transition.cancel()
    }

    fill.remove()
    await sleep(0)
    const noFillGlass = await readback(glassRegion)
    card.remove()
    await sleep(0)
    const without = await readback(region)
    stage.debug.setPixelBudget(null)
    calibrationScene()
    stage.debug.renderNow()

    let outsideChanged = 0
    let inside = 0
    let insideWrong = 0
    for (let j = 0; j < region.height; j++) {
      for (let i = 0; i < region.width; i++) {
        const d = sdAt(region.x + i + 0.5, region.y + j + 0.5)
        const k = (j * region.width + i) * 4
        if (d > 1) {
          const diff = Math.max(
            Math.abs(withFill[k]! - without[k]!),
            Math.abs(withFill[k + 1]! - without[k + 1]!),
            Math.abs(withFill[k + 2]! - without[k + 2]!)
          )
          if (diff > 0) outsideChanged++
        } else if (d < -1) {
          inside++
          if (withFill[k] !== 255 || withFill[k + 1] !== 0 || withFill[k + 2] !== 0) insideWrong++
        }
      }
    }
    // 玻璃里、落在填充上的那几列：R − G 的平均（填充是红的，灰场景上 R ≈ G）
    const redness = (rgba: Uint8Array): number => {
      let sum = 0
      let n = 0
      for (let j = 0; j < glassRegion.height; j++) {
        for (let i = 0; i < glassRegion.width; i++) {
          const x = (glassRegion.x + i + 0.5) / s + canvasBox.left
          if (x > 635) continue // 只要落在填充上的（填充右边界 640，留 5px）
          const k = (j * glassRegion.width + i) * 4
          sum += rgba[k]! - rgba[k + 1]!
          n++
        }
      }
      return n > 0 ? sum / n : NaN
    }
    const glassRed = redness(onFill)
    const glassGray = redness(noFillGlass)
    const expected = /rgba?\(([^)]+)\)/.exec(midCss)?.[1]?.split(',').map((t) => Math.round(parseFloat(t))) ?? []
    const midOk =
      mid.length === 4 &&
      expected.length >= 3 &&
      Math.abs(mid[0]! - expected[0]!) <= 1 &&
      Math.abs(mid[1]! - expected[1]!) <= 1 &&
      Math.abs(mid[2]! - expected[2]!) <= 1 &&
      mid[0]! > 40 &&
      mid[2]! > 40
    const detail =
      `场景 ${v.sceneWidth}×${v.sceneHeight}、画布 ${v.compositeWidth}×${v.compositeHeight} · ` +
      `边缘外 1px 以外变了的像素 ${outsideChanged} 个（应为 0）· 边缘内 ${inside} 个像素里颜色不对的 ${insideWrong} 个 · ` +
      `玻璃里 R − G：有填充 ${glassRed.toFixed(1)}、没有 ${glassGray.toFixed(1)} · ` +
      `过渡到一半：计算值 ${midCss || '（没有过渡）'}，画出来 ${mid.slice(0, 3).join('/')}`
    const reduced = v.sceneWidth < v.compositeWidth * 0.7
    return reduced && outsideChanged === 0 && inside > 10000 && insideWrong === 0 && glassRed > 100 && Math.abs(glassGray) < 5 && midOk
      ? pass(detail)
      : fail(detail)
  })

  await check('fill-gradient', async () => {
    // 渐变填充（--glass-fill 写 linear-gradient / radial-gradient）。预期值按 CSS 的几何现算（resolvePaint），
    // 与画出来的逐点比：
    // 1) 线性 to right 红 → 蓝：沿水平方向 7 个点；
    // 2) 径向 circle at 30% 50%（farthest-corner）白 → 黑：中心、右 80、左 50；
    // 3) 一头是透明的蓝：插值在预乘的 sRGB 里做，半途是半透明的纯红（叠在灰上 191/64/64）；不预乘的话透明那头的
    //    蓝会混进来（191/64/191）。用透明的黑分不出来 —— 那时两种插值恰好相同；
    // 4) 硬边（两个色标同一位置）、重复（周期 20px）；
    // 5) 默认方向（to bottom）上红下蓝；转 90° 的元素渐变跟着转（to right 在屏幕上从上到下）。这两项的预期是手写的，
    //    不经过 resolvePaint —— 它自己的几何错了，拿它算的预期值也跟着错，查不出来；
    // 6) 玻璃看得见它：盖在渐变上的透明玻璃，中心就是那一点的渐变色；线性光模式下渐变照旧（在 sRGB 里插完再换）。
    stage.debug.setBackdrop({ scene: 'flat' })
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const pixel = async (x: number, y: number): Promise<[number, number, number]> => {
      const d = await readback({ x: Math.floor((x - canvasBox.left) * s), y: Math.floor((y - canvasBox.top) * s), width: 1, height: 1 })
      return [d[0]!, d[1]!, d[2]!]
    }
    /** 画布设备像素的中心 → CSS 像素（相对元素左上角）。预期值按采样点真正的位置算。 */
    const centerOf = (x: number, y: number, box: DOMRect): [number, number] => [
      (Math.floor((x - canvasBox.left) * s) + 0.5) / s - (box.left - canvasBox.left),
      (Math.floor((y - canvasBox.top) * s) + 0.5) / s - (box.top - canvasBox.top)
    ]
    const make = (style: string): HTMLElement => {
      const el = document.createElement('glass-fill')
      el.setAttribute('style', `position: absolute; ${style}`)
      document.body.append(el)
      return el
    }
    /** 按解算好的渐变算一点（盒子里的 CSS 坐标）的颜色：两个色标之间线性插值（色标都不透明）。 */
    const expectAt = (css: string, box: DOMRect, local: [number, number]): number[] => {
      const r = resolvePaint(parseFillPaint(css, (c) => (c.startsWith('rgb') ? parseRgb(c) : null))!.paint, box.width, box.height)!
      const [a, b, c, d] = r.geometry
      const t =
        r.kind === 'linear'
          ? ((local[0] - a) * (c - a) + (local[1] - b) * (d - b)) / ((c - a) ** 2 + (d - b) ** 2)
          : Math.hypot((local[0] - a) / c, (local[1] - b) / d)
      const u = Math.min(1, Math.max(0, (t - r.offsets[0]!) / (r.offsets[1]! - r.offsets[0]!)))
      return [0, 1, 2].map((i) => (r.colors[0]![i]! * (1 - u) + r.colors[1]![i]! * u) * 255)
    }
    const errOf = (got: readonly number[], want: readonly number[]): number => Math.max(...got.map((g, i) => Math.abs(g - want[i]!)))
    const f = (c: readonly number[]): string => c.map((x) => Math.round(x)).join('/')
    let worst = 0

    // 1) 线性
    const linearCss = 'linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))'
    const lin = make(`left: 440px; top: 40px; width: 300px; height: 60px; --glass-fill: ${linearCss}`)
    await sleep(0)
    const lb = lin.getBoundingClientRect()
    const linSamples: string[] = []
    for (const k of [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98]) {
      const x = lb.left + k * lb.width
      const y = lb.top + lb.height / 2
      const got = await pixel(x, y)
      const want = expectAt(linearCss, lb, centerOf(x, y, lb))
      worst = Math.max(worst, errOf(got, want))
      if (k === 0.25 || k === 0.75) linSamples.push(`${k * 100}% ${f(got)}（${f(want)}）`)
    }

    // 6) 玻璃：盖在线性渐变 30% 处的一块透明玻璃；线性光下再看一次
    const glassEl = document.createElement('div')
    Object.assign(glassEl.style, { position: 'absolute', left: `${440 + 90 - 20}px`, top: '50px', width: '40px', height: '40px' })
    document.body.append(glassEl)
    const glass = stage.register(glassEl, {
      blur: 0, refraction: 0, distortion: 0, highlight: 0, saturation: 1, dispersion: 0, shadow: 0, adaptive: 0,
      tint: 'rgba(0, 0, 0, 0)', cornerRadius: 8
    })
    const glassSeen = await pixel(440 + 90, 70)
    const glassWant = expectAt(linearCss, lb, centerOf(440 + 90, 70, lb))
    stage.setBlendSpace('linear')
    const glassLinear = await pixel(440 + 90, 70)
    const crispLinear = await pixel(lb.left + 0.75 * lb.width, lb.top + 30)
    stage.setBlendSpace('srgb')
    const crispSrgb = await pixel(lb.left + 0.75 * lb.width, lb.top + 30)
    glass.unregister()
    glassEl.remove()
    lin.remove()

    // 2) 径向
    const radialCss = 'radial-gradient(circle at 30% 50%, rgb(255, 255, 255), rgb(0, 0, 0))'
    const rad = make(`left: 440px; top: 40px; width: 200px; height: 200px; --glass-fill: ${radialCss}`)
    await sleep(0)
    const rb = rad.getBoundingClientRect()
    const radSamples: string[] = []
    for (const dx of [0, 80, -50]) {
      const x = rb.left + 60 + dx
      const y = rb.top + 100
      const got = await pixel(x, y)
      const want = expectAt(radialCss, rb, centerOf(x, y, rb))
      worst = Math.max(worst, errOf(got, want))
      radSamples.push(`${dx} ${got[0]}（${Math.round(want[0]!)}）`)
    }
    rad.remove()

    // 3) 一头透明；4) 硬边、重复；5) 旋转
    const tr = make('left: 440px; top: 40px; width: 200px; height: 40px; --glass-fill: linear-gradient(to right, rgb(255, 0, 0), rgba(0, 0, 255, 0))')
    await sleep(0)
    const half = await pixel(440 + 100.5, 60)
    tr.remove()
    const hard = make('left: 440px; top: 40px; width: 200px; height: 40px; --glass-fill: linear-gradient(to right, rgb(255, 0, 0) 50%, rgb(0, 0, 255) 50%)')
    await sleep(0)
    const hardL = await pixel(440 + 98.5, 60)
    const hardR = await pixel(440 + 101.5, 60)
    hard.remove()
    const rep = make('left: 440px; top: 40px; width: 200px; height: 40px; --glass-fill: repeating-linear-gradient(to right, rgb(255, 0, 0) 0px, rgb(0, 0, 255) 20px)')
    await sleep(0)
    const rep10 = await pixel(440 + 10, 60)
    const rep30 = await pixel(440 + 30, 60)
    rep.remove()
    const down = make('left: 440px; top: 40px; width: 40px; height: 200px; --glass-fill: linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))')
    await sleep(0)
    const downTop = await pixel(460, 50)
    const downBottom = await pixel(460, 230)
    down.remove()
    const rot = make('left: 440px; top: 400px; width: 200px; height: 40px; transform: rotate(90deg); --glass-fill: linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))')
    await sleep(0)
    const rr = rot.getBoundingClientRect()
    const rotTop = await pixel(rr.left + rr.width / 2, rr.top + 10)
    const rotBottom = await pixel(rr.left + rr.width / 2, rr.bottom - 10)
    rot.remove()
    calibrationScene()
    stage.debug.renderNow()

    const detail =
      `线性 ${linSamples.join('、')} · 径向 ${radSamples.join('、')} · 与预期最多差 ${worst.toFixed(1)} · ` +
      `一头透明的半途 ${f(half)} · 硬边 ${f(hardL)} | ${f(hardR)} · 重复 10px ${f(rep10)}、30px ${f(rep30)} · ` +
      `默认方向 上 ${f(downTop)} 下 ${f(downBottom)} · 转 90° 上 ${f(rotTop)} 下 ${f(rotBottom)} · ` +
      `玻璃里 ${f(glassSeen)}（${f(glassWant)}）、线性光 ${f(glassLinear)} · ` +
      `线性光下渐变本身 ${f(crispLinear)}（sRGB ${f(crispSrgb)}）`
    const ok =
      worst <= 2 &&
      errOf(half, [191.5, 64, 64]) <= 2 &&
      errOf(hardL, [255, 0, 0]) === 0 && errOf(hardR, [0, 0, 255]) === 0 &&
      errOf(rep10, rep30) <= 1 && Math.abs(rep10[0]! - rep10[2]!) < 20 &&
      downTop[0]! > 200 && downBottom[2]! > 200 &&
      rotTop[0]! > 200 && rotBottom[2]! > 200 &&
      errOf(glassSeen, glassWant) <= 2 && errOf(glassLinear, glassSeen) <= 2 &&
      errOf(crispLinear, crispSrgb) === 0
    return ok ? pass(detail) : fail(detail)
  })

  await check('fill-ellipse', async () => {
    // 椭圆角：300×100 的填充写 border-radius: 50%，CSS 画的是椭圆。以前两个半径取短的那个，画成胶囊。
    // 有鉴别力的点：(20, 20)、(40, 12)、(60, 8) 在胶囊里、椭圆外 —— 必须是场景的灰；(100, 6)、中心、(8, 50) 两种形状都
    // 包含，是填充的红。预期按椭圆方程手算，不经过被测的代码。另外：圆角（两个半径相等）的填充不受影响，边缘照旧。
    stage.debug.setBackdrop({ scene: 'flat' })
    const el = document.createElement('glass-fill')
    el.setAttribute('style', 'position: absolute; left: 440px; top: 600px; width: 300px; height: 100px; border-radius: 50%; --glass-fill: rgb(255, 0, 0)')
    document.body.append(el)
    await sleep(0)
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const pixel = async (x: number, y: number): Promise<[number, number, number]> => {
      const d = await readback({
        x: Math.floor((box.left + x - canvasBox.left) * s),
        y: Math.floor((box.top + y - canvasBox.top) * s),
        width: 1,
        height: 1
      })
      return [d[0]!, d[1]!, d[2]!]
    }
    const inEllipse = (x: number, y: number): number => ((x - 150) / 150) ** 2 + ((y - 50) / 50) ** 2
    const outside = [[20, 20], [40, 12], [60, 8]] as const
    const inside = [[100, 6], [150, 50], [8, 50]] as const
    const out: string[] = []
    let ok = true
    for (const [x, y] of outside) {
      const c = await pixel(x, y)
      const gray = Math.abs(c[0] - c[1]) <= 2
      ok &&= gray && inEllipse(x, y) > 1.02
      out.push(`(${x}, ${y}) ${c.join('/')}`)
    }
    for (const [x, y] of inside) {
      const c = await pixel(x, y)
      const red = c[0] > 240 && c[1] < 15
      ok &&= red && inEllipse(x, y) < 0.98
      out.push(`(${x}, ${y}) ${c.join('/')}`)
    }
    el.remove()
    calibrationScene()
    stage.debug.renderNow()
    const detail = `椭圆外（胶囊里）${out.slice(0, 3).join('、')} · 椭圆里 ${out.slice(3).join('、')}`
    return ok ? pass(detail) : fail(detail)
  })

  await check('switch', async () => {
    // <glass-switch>：轨道是填充、旋钮是玻璃。
    // 静止时旋钮是白的、轨道是绿的；按下时旋钮变成透镜，透过它看到的是底下的绿色轨道 —— 轨道要是 CSS 背景，
    // 玻璃看不见它，这里只会看到灰色的场景；松开变回白色。点一下切换并派发 change，轨道变成关的颜色。
    // 按压的缓动靠 rAF（面板隐藏时不跑），所以模拟「减少动效」让它直接落到终点。
    stage.debug.setBackdrop({ scene: 'flat' })
    simulateReducedMotion(true)
    const sw = document.createElement('glass-switch')
    sw.toggleAttribute('checked', true)
    Object.assign(sw.style, { position: 'absolute', left: '440px', top: '500px' })
    let changes = 0
    sw.addEventListener('change', () => changes++)
    document.body.append(sw)
    const finish = (): void => {
      for (const a of sw.shadowRoot!.getAnimations()) a.finish()
    }
    finish()
    await sleep(0)
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const pixel = async (x: number, y: number): Promise<[number, number, number]> => {
      const d = await readback({
        x: Math.floor((x - canvasBox.left) * s),
        y: Math.floor((y - canvasBox.top) * s),
        width: 1,
        height: 1
      })
      return [d[0]!, d[1]!, d[2]!]
    }
    const thumb = sw.shadowRoot!.querySelector<HTMLElement>('[part=thumb]')!
    const host = sw.getBoundingClientRect()
    const t = thumb.getBoundingClientRect()
    const cx = t.left + t.width / 2
    const cy = t.top + t.height / 2
    const pipelines0 = stage.debug.stats().pipelineCreations
    const rest = await pixel(cx, cy)
    const track = await pixel(host.left + 6, cy)
    sw.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, button: 0, clientX: cx, clientY: cy, bubbles: true }))
    finish()
    await sleep(0)
    const pressed = await pixel(cx, cy)
    sw.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, button: 0, clientX: cx, clientY: cy, bubbles: true }))
    finish()
    await sleep(0)
    const released = await pixel(cx, cy)
    sw.click()
    await sleep(10) // input / change 在 click 派发完之后的下一个任务里
    finish()
    await sleep(0)
    const offTrack = await pixel(host.right - 6, cy)
    const checkedAfter = sw.checked
    const pipelines1 = stage.debug.stats().pipelineCreations
    sw.remove()
    simulateReducedMotion(null)
    calibrationScene()
    stage.debug.renderNow()

    const white = (c: readonly number[]): boolean => Math.min(c[0]!, c[1]!, c[2]!) > 225
    const green = (c: readonly number[]): boolean => c[1]! - c[0]! > 100 && c[1]! - c[2]! > 60
    const f = (c: readonly number[]): string => c.join('/')
    const detail =
      `静止：旋钮 ${f(rest)}、轨道 ${f(track)} · 按下：旋钮 ${f(pressed)}（透过透镜看到轨道）· 松开：${f(released)} · ` +
      `点一下：checked ${checkedAfter}、change ${changes} 次、轨道 ${f(offTrack)} · 管线 ${pipelines1 - pipelines0} 条新建`
    return white(rest) && green(track) && green(pressed) && white(released) && !checkedAfter && changes === 1 &&
      !green(offTrack) && pipelines1 === pipelines0
      ? pass(detail)
      : fail(detail)
  })

  await check('slider', async () => {
    // <glass-slider>：轨道与进度是填充、旋钮是玻璃。静止时旋钮白、左边进度蓝、右边轨道不蓝；
    // 按下时旋钮变成透镜，左半边透出蓝色进度、右半边透出轨道；方向键走一档；按在轨道 25% 处跳到 25，
    // 松手派发 change，表单数据跟着变。
    stage.debug.setBackdrop({ scene: 'flat' })
    simulateReducedMotion(true)
    const form = document.createElement('form')
    Object.assign(form.style, { position: 'absolute', left: '440px', top: '500px' })
    const sl = document.createElement('glass-slider')
    sl.setAttribute('name', 'level')
    sl.setAttribute('value', '50')
    sl.style.width = '240px'
    form.append(sl)
    document.body.append(form)
    const events: string[] = []
    sl.addEventListener('input', () => events.push('input'))
    sl.addEventListener('change', () => events.push('change'))
    await sleep(0)
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const pixel = async (x: number, y: number): Promise<[number, number, number]> => {
      const d = await readback({ x: Math.floor((x - canvasBox.left) * s), y: Math.floor((y - canvasBox.top) * s), width: 1, height: 1 })
      return [d[0]!, d[1]!, d[2]!]
    }
    const host = sl.getBoundingClientRect()
    const thumb = sl.shadowRoot!.querySelector<HTMLElement>('[part=thumb]')!
    const t = thumb.getBoundingClientRect()
    const cx = t.left + t.width / 2
    const cy = t.top + t.height / 2
    const pipelines0 = stage.debug.stats().pipelineCreations
    const rest = await pixel(cx, cy)
    const progress = await pixel(host.left + 6, cy)
    const track = await pixel(host.right - 6, cy)
    sl.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 11, button: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true }))
    for (const a of sl.shadowRoot!.getAnimations()) a.finish()
    await sleep(0)
    const lensLeft = await pixel(cx - 10, cy)
    const lensRight = await pixel(cx + 10, cy)
    sl.dispatchEvent(new PointerEvent('pointerup', { pointerId: 11, button: 0, clientX: cx, clientY: cy, bubbles: true }))
    const noChangeOnGrab = events.length === 0
    sl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    const afterKey = (sl as unknown as { value: string }).value
    // 按在轨道 25% 处（旋钮中心能走的范围是 [19, 宽 − 19]）
    const x25 = host.left + 19 + 0.25 * (host.width - 38)
    sl.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 12, button: 0, clientX: x25, clientY: cy, bubbles: true, cancelable: true }))
    sl.dispatchEvent(new PointerEvent('pointerup', { pointerId: 12, button: 0, clientX: x25, clientY: cy, bubbles: true }))
    const afterJump = (sl as unknown as { value: string }).value
    const data = new FormData(form).get('level')
    const pipelines1 = stage.debug.stats().pipelineCreations
    form.remove()
    simulateReducedMotion(null)
    calibrationScene()
    stage.debug.renderNow()

    const white = (c: readonly number[]): boolean => Math.min(c[0]!, c[1]!, c[2]!) > 225
    const blue = (c: readonly number[]): boolean => c[2]! > 200 && c[2]! - c[0]! > 120
    const f = (c: readonly number[]): string => c.join('/')
    const detail =
      `静止：旋钮 ${f(rest)}、进度 ${f(progress)}、轨道 ${f(track)} · 按下：透镜左 ${f(lensLeft)}、右 ${f(lensRight)} · ` +
      `→ 键之后 ${afterKey}、按在 25% 处 ${afterJump}、表单 ${String(data)} · 事件 ${events.join(',')} · 管线 ${pipelines1 - pipelines0} 条新建`
    return white(rest) && blue(progress) && !blue(track) && blue(lensLeft) && !blue(lensRight) && noChangeOnGrab &&
      afterKey === '51' && afterJump === '25' && data === '25' &&
      events.join(',') === 'input,change,input,change' && pipelines1 === pipelines0
      ? pass(detail)
      : fail(detail)
  })

  await check('segmented', async () => {
    // <glass-segmented>：底是填充，选中的段下面是白色的玻璃旋钮；按住时旋钮变成透镜（中心不再是白的，透出底）；
    // 点别的段、方向键都换选中并派发 input / change，旋钮跟过去；表单数据是选中的值。
    stage.debug.setBackdrop({ scene: 'flat' })
    simulateReducedMotion(true)
    const form = document.createElement('form')
    Object.assign(form.style, { position: 'absolute', left: '440px', top: '500px', color: '#000' })
    form.innerHTML =
      '<glass-segmented name="period" value="week"><span value="day">日</span><span value="week">周</span><span value="month">月</span></glass-segmented>'
    document.body.append(form)
    const seg = form.firstElementChild as HTMLElement & { value: string; segments: HTMLElement[] }
    const events: string[] = []
    seg.addEventListener('input', () => events.push('input'))
    seg.addEventListener('change', () => events.push('change'))
    const finish = (): void => {
      for (const a of seg.shadowRoot!.getAnimations()) a.finish()
    }
    await sleep(0)
    finish()
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const pixel = async (el: Element): Promise<[number, number, number]> => {
      const r = el.getBoundingClientRect()
      const d = await readback({
        x: Math.floor((r.left + 5 - canvasBox.left) * s),
        y: Math.floor((r.top + r.height / 2 - canvasBox.top) * s),
        width: 1,
        height: 1
      })
      return [d[0]!, d[1]!, d[2]!]
    }
    const [day, week, month] = seg.segments as [HTMLElement, HTMLElement, HTMLElement]
    const pipelines0 = stage.debug.stats().pipelineCreations
    const restSelected = await pixel(week)
    const restOther = await pixel(day)
    const wr = week.getBoundingClientRect()
    seg.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 13, button: 0, clientX: wr.left + 10, clientY: wr.top + 10, bubbles: true }))
    finish()
    await sleep(0)
    const pressed = await pixel(week)
    const mr = month.getBoundingClientRect()
    seg.dispatchEvent(new PointerEvent('pointerup', { pointerId: 13, button: 0, clientX: mr.left + 10, clientY: mr.top + 10, bubbles: true }))
    finish()
    await sleep(0)
    const afterClick = seg.value
    const onMonth = await pixel(month)
    month.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    const afterKey = seg.value // 到头回绕到第一段
    const data = new FormData(form).get('period')
    const pipelines1 = stage.debug.stats().pipelineCreations
    form.remove()
    simulateReducedMotion(null)
    calibrationScene()
    stage.debug.renderNow()

    const white = (c: readonly number[]): boolean => Math.min(c[0]!, c[1]!, c[2]!) > 225
    const f = (c: readonly number[]): string => c.join('/')
    const detail =
      `静止：选中段 ${f(restSelected)}、别的段 ${f(restOther)} · 按住：${f(pressed)} · ` +
      `点「月」之后 ${afterClick}（旋钮 ${f(onMonth)}）· → 键回绕到 ${afterKey} · 表单 ${String(data)} · ` +
      `事件 ${events.join(',')} · 管线 ${pipelines1 - pipelines0} 条新建`
    return white(restSelected) && !white(restOther) && !white(pressed) && afterClick === 'month' && white(onMonth) &&
      afterKey === 'day' && data === 'day' && events.join(',') === 'input,change,input,change' && pipelines1 === pipelines0
      ? pass(detail)
      : fail(detail)
  })

  await check('nested-glass', async () => {
    // 玻璃的层：写在一块玻璃里面的玻璃看得见外面那块。
    // 1) 灰场景上一块 tint 很红的卡片，里面一块普通的卡片：里面那块的中心是红的（透过它看到外面那块）；
    //    挪出来放在同一个位置（不再嵌套）时它只看得到灰色的场景 —— 在红卡片上开了一个灰洞，这是以前的样子；
    // 2) 外面那块离里面那块远的地方，嵌套与不嵌套逐像素相同（它在第 0 层，画法没变）；
    // 3) 卡片里的开关：轨道（填充）在卡片之上，按画布分辨率画出来就是它自己的绿，不被卡片模糊、染色。
    stage.debug.setBackdrop({ scene: 'flat' })
    const outer = document.createElement('glass-card')
    outer.setAttribute('tint', 'rgba(255, 0, 0, 0.5)')
    outer.setAttribute('shadow', '0')
    Object.assign(outer.style, { left: '440px', top: '480px', width: '300px', height: '220px', padding: '40px', boxSizing: 'border-box' })
    const inner = document.createElement('glass-card')
    inner.setAttribute('shadow', '0')
    inner.setAttribute('corner-radius', '16')
    Object.assign(inner.style, { position: 'static', display: 'block', width: '180px', height: '80px' })
    const sw = document.createElement('glass-switch')
    sw.toggleAttribute('checked', true)
    Object.assign(sw.style, { marginTop: '12px' })
    outer.append(inner, sw)
    document.body.append(outer)
    await sleep(0)
    for (const a of sw.shadowRoot!.getAnimations()) a.finish()
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const pixel = async (x: number, y: number): Promise<[number, number, number]> => {
      const d = await readback({ x: Math.floor((x - canvasBox.left) * s), y: Math.floor((y - canvasBox.top) * s), width: 1, height: 1 })
      return [d[0]!, d[1]!, d[2]!]
    }
    const ir = inner.getBoundingClientRect()
    const or = outer.getBoundingClientRect()
    const swr = sw.getBoundingClientRect()
    const strip: ReadbackRegion = {
      x: Math.floor((or.right - 30 - canvasBox.left) * s),
      y: Math.floor((or.top + 30 - canvasBox.top) * s),
      width: Math.floor(10 * s),
      height: Math.floor(100 * s)
    }
    const nested = await pixel(ir.left + ir.width / 2, ir.top + ir.height / 2)
    const track = await pixel(swr.left + 7, swr.top + swr.height / 2)
    const stripNested = await readback(strip)
    const passesNested = stage.debug.stats().blurPasses
    // 挪出来放在同一个位置
    document.body.append(inner)
    Object.assign(inner.style, { position: 'absolute', left: `${ir.left - canvasBox.left + window.scrollX}px`, top: `${ir.top - canvasBox.top + window.scrollY}px` })
    await sleep(0)
    const loose = await pixel(ir.left + ir.width / 2, ir.top + ir.height / 2)
    sw.remove()
    await sleep(0)
    const stripLoose = await readback(strip)
    outer.remove()
    inner.remove()
    calibrationScene()
    stage.debug.renderNow()

    const same = (await sha(stripNested)) === (await sha(stripLoose))
    const f = (c: readonly number[]): string => c.join('/')
    const detail =
      `嵌套的卡片中心 ${f(nested)}、挪出来 ${f(loose)} · 外层远处逐像素${same ? '相同' : '不同'} · ` +
      `卡片里开关的轨道 ${f(track)} · 嵌套时模糊 ${passesNested} 趟`
    return nested[0]! - nested[1]! > 100 && Math.abs(loose[0]! - loose[1]!) < 10 && same &&
      Math.abs(track[0]! - 52) <= 12 && Math.abs(track[1]! - 199) <= 12 && Math.abs(track[2]! - 89) <= 12
      ? pass(detail)
      : fail(detail)
  })

  await check('tab-bar', async () => {
    // <glass-tab-bar>：栏是玻璃，选中那一格下面的气泡是写在栏里面的玻璃（第 1 层）。
    // 灰场景上，气泡中心 = 栏在那里的颜色 × 0.7 + 白 × 0.3（气泡的 tint）—— 看得见栏；不分层的话它只看得到
    // 场景（128 × 0.7 + 76.5 ≈ 166），与栏（≈ 149）上的这个公式对不上。按住时变成透镜，中心几乎就是栏本身。
    // 点第三格、方向键回绕、事件；全程不建管线。
    stage.debug.setBackdrop({ scene: 'flat' })
    simulateReducedMotion(true)
    const bar = document.createElement('glass-tab-bar') as HTMLElement & { value: string; tabs: HTMLElement[]; selectedIndex: number }
    bar.setAttribute('value', 'b')
    bar.setAttribute('shadow', '0')
    Object.assign(bar.style, { position: 'absolute', left: '440px', top: '500px', color: '#fff' })
    bar.innerHTML = '<button value="a">一</button><button value="b">二</button><button value="c">三</button>'
    document.body.append(bar)
    const events: string[] = []
    bar.addEventListener('input', () => events.push('input'))
    bar.addEventListener('change', () => events.push('change'))
    const finish = (): void => {
      for (const a of bar.shadowRoot!.getAnimations()) a.finish()
    }
    await sleep(0)
    finish()
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const center = async (el: Element): Promise<[number, number, number]> => {
      const r = el.getBoundingClientRect()
      const d = await readback({
        x: Math.floor((r.left + r.width / 2 - canvasBox.left) * s),
        y: Math.floor((r.top + r.height / 2 - canvasBox.top) * s),
        width: 1,
        height: 1
      })
      return [d[0]!, d[1]!, d[2]!]
    }
    const [a, b, c] = bar.tabs as [HTMLElement, HTMLElement, HTMLElement]
    const pipelines0 = stage.debug.stats().pipelineCreations
    const selected = await center(b)
    const other = await center(a)
    const layers = stage.debug.stats().blurPasses
    const br = b.getBoundingClientRect()
    bar.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 14, button: 0, clientX: br.left + br.width / 2, clientY: br.top + br.height / 2, bubbles: true }))
    finish()
    await sleep(0)
    const pressed = await center(b)
    bar.dispatchEvent(new PointerEvent('pointerup', { pointerId: 14, button: 0, clientX: br.left + br.width / 2, clientY: br.top + br.height / 2, bubbles: true }))
    const cr = c.getBoundingClientRect()
    bar.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 15, button: 0, clientX: cr.left + 8, clientY: cr.top + 8, bubbles: true }))
    bar.dispatchEvent(new PointerEvent('pointerup', { pointerId: 15, button: 0, clientX: cr.left + 8, clientY: cr.top + 8, bubbles: true }))
    finish()
    await sleep(0)
    const afterClick = bar.value
    const onC = await center(c)
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    const afterKey = bar.value
    const pipelines1 = stage.debug.stats().pipelineCreations
    bar.remove()
    simulateReducedMotion(null)
    calibrationScene()
    stage.debug.renderNow()

    const expected = other[0]! * 0.7 + 255 * 0.3
    const f = (x: readonly number[]): string => x.join('/')
    const detail =
      `选中的格 ${f(selected)}（栏 ${f(other)} × 0.7 + 白 × 0.3 = ${expected.toFixed(1)}）· 按住 ${f(pressed)} · ` +
      `点第三格 → ${afterClick}（那里 ${f(onC)}）· → 键回绕到 ${afterKey} · 事件 ${events.join(',')} · ` +
      `模糊 ${layers} 趟 · 管线 ${pipelines1 - pipelines0} 条新建`
    return Math.abs(selected[0]! - expected) <= 3 && Math.abs(pressed[0]! - other[0]!) < 10 && afterClick === 'c' &&
      Math.abs(onC[0]! - selected[0]!) <= 2 && afterKey === 'a' && events.join(',') === 'input,change,input,change' &&
      pipelines1 === pipelines0
      ? pass(detail)
      : fail(detail)
  })

  await check('tab-bar-minimize', async () => {
    // <glass-tab-bar minimize="scroll">：
    // 1) 缩起来：没选中的格收成 0 宽，栏只剩选中那一格加两侧的内边距；有过渡（不是瞬间跳）；气泡不画了；
    // 2) 玻璃跟着栏变短：原来栏上、现在栏外的一点，缩起时是场景，展开时是玻璃；
    // 3) 真的滚页面（往下 200px）缩起，滚回顶部展开；
    // 4) 缩着的时候按一下：只展开，不换选中、不派发 input；键盘焦点移进来也展开；
    // 5) 没写 minimize 的栏：格上没有这些过渡。
    stage.debug.setBackdrop({ scene: 'flat' })
    const bar = document.createElement('glass-tab-bar') as HTMLElement & { minimized: boolean; value: string }
    bar.setAttribute('minimize', 'scroll')
    bar.setAttribute('value', 'b')
    bar.setAttribute('shadow', '0')
    bar.innerHTML = '<button value="a">一</button><button value="b">二</button><button value="c">三</button><button value="d">四</button>'
    // 放在常驻的合并组（y 400–456）下面够远的地方：它的投影会落到栏的上半截
    Object.assign(bar.style, { position: 'absolute', left: '40px', top: '560px' })
    document.body.append(bar)
    await sleep(0)
    const finish = (): number => {
      let n = 0
      for (const t of bar.children) for (const a of t.getAnimations()) {
        a.finish()
        n++
      }
      for (const a of bar.shadowRoot!.getAnimations()) {
        a.finish()
        n++
      }
      return n
    }
    finish()
    stage.debug.renderNow()
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const pixel = async (x: number, y: number): Promise<number> => {
      const d = await readback({ x: Math.floor((x - canvasBox.left) * s), y: Math.floor((y - canvasBox.top) * s), width: 1, height: 1 })
      return d[0]!
    }
    const open = bar.getBoundingClientRect()
    const probeX = open.left + open.width - 40 // 最后一格上：缩起之后在栏外
    const probeY = open.top + open.height / 2
    const scene = await pixel(open.right + 40, probeY)
    const glassOpen = await pixel(probeX, probeY)
    const panelsOpen = stage.debug.stats().panels

    // 1) 2) 缩起来
    bar.minimized = true
    await sleep(0)
    const transitions = finish()
    stage.debug.renderNow()
    const small = bar.getBoundingClientRect()
    const selected = bar.children[1]!.getBoundingClientRect()
    const panelsSmall = stage.debug.stats().panels
    const glassSmall = await pixel(probeX, probeY)
    bar.minimized = false
    await sleep(0)
    finish()
    stage.debug.renderNow()
    const reopened = bar.getBoundingClientRect().width

    // 3) 真的滚页面：先把文档撑高
    const spacer = document.createElement('div')
    spacer.style.height = '4000px'
    document.body.append(spacer)
    const scroll = (y: number): void => {
      window.scrollTo(0, y)
      window.dispatchEvent(new Event('scroll')) // 滚动事件排在下一次渲染里；面板隐藏时不一定来，这里直接派发
    }
    scroll(200)
    const scrolledDown = bar.minimized
    scroll(0)
    const scrolledTop = bar.minimized
    spacer.remove()

    // 4) 缩着的时候按一下 / 焦点移进来
    bar.minimized = true
    let inputs = 0
    bar.addEventListener('input', () => inputs++)
    bar.children[1]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0, pointerId: 7 }))
    const tapExpanded = !bar.minimized
    bar.children[1]!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true, button: 0, pointerId: 7 }))
    const valueAfterTap = bar.value
    bar.minimized = true
    // 直接派发 focusin：窗口没有焦点时（浏览器面板常常如此）focus() 只改 activeElement、不派发焦点事件
    bar.children[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }))
    const focusExpanded = !bar.minimized
    bar.remove()

    // 5) 没写 minimize 的栏
    const plain = document.createElement('glass-tab-bar')
    plain.innerHTML = '<button value="a">一</button><button value="b">二</button>'
    Object.assign(plain.style, { position: 'absolute', left: '40px', top: '560px' })
    document.body.append(plain)
    await sleep(0)
    const plainTransition = getComputedStyle(plain.children[0]!).transitionDuration
    plain.remove()
    calibrationScene()
    stage.debug.renderNow()

    const inset = 4
    const detail =
      `宽 ${open.width.toFixed(0)} → ${small.width.toFixed(0)}（选中那一格 ${selected.width.toFixed(0)} + 两侧 ${inset}）→ ${reopened.toFixed(0)} · ` +
      `过渡 ${transitions} 个 · 面板 ${panelsOpen} → ${panelsSmall}（气泡不画） · ` +
      `最后一格那里：展开 ${glassOpen}、缩起 ${glassSmall}、场景 ${scene} · ` +
      `滚到 200：${scrolledDown ? '缩起' : '没缩'}，回到顶部：${scrolledTop ? '还缩着' : '展开'} · ` +
      `缩着按一下：${tapExpanded ? '展开' : '没展开'}、选中 ${valueAfterTap}、input ${inputs} 次 · 焦点移进来：${focusExpanded ? '展开' : '没展开'} · ` +
      `没写 minimize 的栏过渡 ${plainTransition}`
    const ok =
      Math.abs(small.width - (selected.width + 2 * inset)) < 1 && small.width < open.width / 2 &&
      Math.abs(reopened - open.width) < 1 && transitions > 0 && panelsSmall === panelsOpen - 1 &&
      Math.abs(glassSmall - scene) <= 1 && Math.abs(glassOpen - scene) > 3 &&
      scrolledDown && !scrolledTop && tapExpanded && valueAfterTap === 'b' && inputs === 0 && focusExpanded &&
      /^0s(, 0s)*$/.test(plainTransition)
    return ok ? pass(detail) : fail(detail)
  })

  await check('nav-bar', async () => {
    // <glass-nav-bar large-title>：宿主 display: contents，栏那一行 sticky，两侧各一个玻璃胶囊。
    // 1) 胶囊是 GPU 玻璃：栏上的材质属性（红色 tint）转给了它们，中心 R − G 大；层级检查没有问题
    // 2) 没贴住时（滚了 300，栏还在本来的位置往上走）模糊渐隐、磨砂、小标题都是 0
    // 3) 真的滚页面（scrollTo + 直接派发 scroll：面板隐藏时滚动事件不一定来）：栏贴在视口顶上；贴住后再滚 8px
    //    淡到一半、16px 满；大标题滚过栏的下沿时小标题淡入、data-collapsed；贴住时胶囊仍是 GPU 玻璃
    // 4) 一侧没有按钮：那个胶囊不画；改标题的字：小标题跟着；去掉 large-title：标题回到栏中间
    // 栏放在左半边：右边那块固定的报告面板有深色背景，会挡住它（层级检查会报）。
    // 撑高文档会冒出竖滚动条、视口变窄 15px（这一轮就作废了）：检查期间把根元素的滚动条藏起来
    stage.debug.setBackdrop({ scene: 'flat' })
    const rootStyle = document.documentElement.style
    const scrollbar = rootStyle.scrollbarWidth
    rootStyle.scrollbarWidth = 'none'
    const scrollTo = async (y: number): Promise<void> => {
      window.scrollTo(0, y)
      window.dispatchEvent(new Event('scroll'))
      await sleep(0)
    }
    await scrollTo(0)
    const wrap = document.createElement('div')
    Object.assign(wrap.style, { position: 'absolute', left: '20px', top: '600px', width: '400px', height: '3000px' })
    wrap.innerHTML =
      '<glass-nav-bar large-title tint="rgba(255, 60, 60, 0.45)">' +
      '<button slot="leading" aria-label="返回">‹</button><h1>设置</h1>' +
      '<button slot="trailing" aria-label="搜索">⌕</button><button slot="trailing" aria-label="更多">⋯</button>' +
      '</glass-nav-bar>'
    document.body.append(wrap)
    await sleep(0)
    const nav = wrap.querySelector('glass-nav-bar')! as HTMLElement & { scrolled: boolean; collapsed: boolean }
    const sr = nav.shadowRoot!
    const part = (name: string): HTMLElement => sr.querySelector<HTMLElement>(`[part='${name}']`)!
    const frost = sr.querySelector<HTMLElement>('.frost')!
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const centerPixel = async (el: HTMLElement): Promise<number[]> => {
      const r = el.getBoundingClientRect()
      // 不在视口里（比如栏没贴住、被滚出去了）：回读不了，记成「不是玻璃」
      if (r.top + r.height / 2 < 0 || r.top + r.height / 2 >= v.cssHeight) return [-1, -1, -1]
      const d = await readback({
        x: Math.floor((r.left + r.width / 2 - canvasBox.left) * s),
        y: Math.floor((r.top + r.height / 2 - canvasBox.top) * s),
        width: 1,
        height: 1
      })
      return [d[0]!, d[1]!, d[2]!]
    }
    const state = (): { edge: string; frost: string; inline: string; hidden: string; top: number } => ({
      edge: getComputedStyle(part('edge')).opacity,
      frost: getComputedStyle(frost).opacity,
      inline: getComputedStyle(part('inline-title')).opacity,
      hidden: getComputedStyle(part('edge')).visibility,
      top: Math.round(part('bar').getBoundingClientRect().top)
    })

    const atRest = state()
    const restPixel = await centerPixel(part('leading'))
    const panels0 = stage.debug.stats().panels
    const problems = stage.debug.checkLayers().filter((p) => wrap.contains(p.panel) || p.panel === part('leading') || p.panel === part('trailing'))
    await scrollTo(300)
    const moving = state()
    await scrollTo(600)
    const stuck = state()
    await scrollTo(608)
    const half = state()
    await scrollTo(700)
    const full = { ...state(), scrolled: nav.scrolled, collapsed: nav.collapsed }
    const stuckPixel = await centerPixel(part('leading'))
    await scrollTo(0)
    const back = { ...state(), scrolled: nav.scrolled, collapsed: nav.collapsed }
    for (const b of nav.querySelectorAll('[slot=trailing]')) b.remove()
    await sleep(0)
    stage.debug.renderNow()
    const trailingHidden = part('trailing').hidden && stage.debug.stats().panels === panels0 - 1
    nav.querySelector('h1')!.textContent = '通用'
    await sleep(0)
    const renamed = part('inline-title').textContent === '通用'
    nav.removeAttribute('large-title')
    await sleep(0)
    const inline = sr.querySelector('slot:not([name])')!.parentElement === part('title') && getComputedStyle(part('large-title')).display === 'none'
    wrap.remove()
    await scrollTo(0)
    rootStyle.scrollbarWidth = scrollbar
    calibrationScene()
    stage.debug.renderNow()

    const f = (c: readonly number[]): string => c.join('/')
    const glass = (c: readonly number[]): boolean => c[0]! - c[1]! > 20
    const o = (x: { edge: string; frost: string; inline: string }): string => `渐隐 ${x.edge}、磨砂 ${x.frost}、小标题 ${x.inline}`
    const detail =
      `静止：胶囊 ${f(restPixel)}、${o(atRest)}（${atRest.hidden}）、层级问题 ${problems.length} · ` +
      `滚 300（没贴住，栏在 ${moving.top}）：${o(moving)} · 滚 600：栏在 ${stuck.top}、${o(stuck)} · 滚 608：${o(half)} · ` +
      `滚 700：栏在 ${full.top}、${o(full)}、${full.collapsed ? 'collapsed' : '没 collapsed'}、胶囊 ${f(stuckPixel)} · ` +
      `滚回 0：${o(back)}、${back.scrolled || back.collapsed ? '标记没撤' : '标记撤了'} · ` +
      `没有按钮的一侧${trailingHidden ? '不画' : '还在画'} · 改标题${renamed ? '跟上了' : '没跟上'} · 去掉 large-title：${inline ? '回到栏中间' : '没回去'}`
    const ok =
      glass(restPixel) && atRest.edge === '0' && atRest.frost === '0' && atRest.hidden === 'hidden' && problems.length === 0 &&
      moving.top === 300 && moving.edge === '0' && moving.inline === '0' &&
      stuck.top === 0 && stuck.edge === '0' &&
      half.edge === '0.5' && half.frost === '0.5' &&
      full.top === 0 && full.edge === '1' && full.frost === '1' && full.inline === '1' && full.scrolled && full.collapsed && glass(stuckPixel) &&
      back.edge === '0' && back.inline === '0' && !back.scrolled && !back.collapsed &&
      trailingHidden && renamed && inline
    return ok ? pass(detail) : fail(detail)
  })

  await check('overlay', async () => {
    // 盖在 DOM 上的玻璃用 CSS 画（core/overlay.ts）：模态对话框里的卡片与开关、打开的 popover、写了 overlay 的卡片 ——
    // 都带上 data-glassium-overlay、不上 GPU（面板数不变），卡片的 backdrop-filter 是材质的 σ 与饱和度、背景是 tint，
    // 开关的旋钮与轨道由 CSS 画；对话框关上之后标记撤掉。
    const panelsNow = (): number => {
      stage.debug.renderNow()
      return stage.debug.stats().panels
    }
    const base = panelsNow()
    const dialog = document.createElement('dialog')
    Object.assign(dialog.style, { background: 'transparent', border: '0', padding: '0' })
    dialog.innerHTML =
      '<glass-card preset="thick" style="position:static;display:block;width:260px;height:120px">对话框<glass-switch checked></glass-switch></glass-card>'
    const pop = document.createElement('glass-card')
    pop.setAttribute('popover', 'manual')
    pop.setAttribute('preset', 'thin')
    Object.assign(pop.style, { position: 'fixed', inset: 'auto', left: '40px', top: '40px', width: '160px', height: '80px', margin: '0' })
    const loose = document.createElement('glass-card')
    loose.setAttribute('overlay', '')
    Object.assign(loose.style, { left: '440px', top: '500px', width: '160px', height: '80px' })
    document.body.append(dialog, pop, loose)
    await sleep(0)
    const withLoose = panelsNow()
    dialog.showModal()
    pop.showPopover()
    await sleep(0)
    const opened = panelsNow()
    const card = dialog.querySelector('glass-card')!
    const sw = dialog.querySelector('glass-switch')!
    const thumb = sw.shadowRoot!.querySelector('[part=thumb]')!
    const track = sw.shadowRoot!.querySelector('[part=track]')!
    const cs = getComputedStyle(card)
    const marked = [card, thumb, track, pop, loose].every((e) => e.hasAttribute('data-glassium-overlay'))
    const cardBackdrop = cs.backdropFilter
    const cardTint = cs.backgroundColor
    const popBackdrop = getComputedStyle(pop).backdropFilter
    const thumbBg = getComputedStyle(thumb).backgroundColor
    const trackBg = getComputedStyle(track).backgroundColor
    const problems = stage.debug.checkLayers().filter((p) => p.panel === card || p.panel === pop || p.panel === loose).length
    dialog.close()
    pop.hidePopover()
    await sleep(0)
    panelsNow()
    const unmarked = !card.hasAttribute('data-glassium-overlay') && !pop.hasAttribute('data-glassium-overlay')
    dialog.remove()
    pop.remove()
    loose.remove()
    stage.debug.renderNow()

    const detail =
      `面板数：原来 ${base}、加了 overlay 卡片 ${withLoose}、对话框与 popover 打开 ${opened}（都不上 GPU）· ` +
      `标记 ${marked ? '都在' : '缺'} · 对话框里的卡片 ${cardBackdrop}、${cardTint} · popover ${popBackdrop} · ` +
      `开关 旋钮 ${thumbBg}、轨道 ${trackBg} · 层级问题 ${problems} · 关上之后标记${unmarked ? '撤掉了' : '还在'}`
    return withLoose === base && opened === base && marked && cardBackdrop === 'blur(16px) saturate(1.5)' &&
      cardTint === 'rgba(255, 255, 255, 0.22)' && popBackdrop === 'blur(4px) saturate(1.25)' &&
      thumbBg === 'rgb(255, 255, 255)' && trackBg === 'rgb(52, 199, 89)' && problems === 0 && unmarked
      ? pass(detail)
      : fail(detail)
  })

  await check('morph', async () => {
    // <glass-container morph>：新成员从最近的成员边上以一滴的大小出现（缩放 0.2、中心在邻居的边上），那里画着
    // 玻璃（与邻居连成一组）；动画走完在自己的位置；dismiss 缩回去再从文档里拿掉；减少动效时不动、直接拿掉。
    stage.debug.setBackdrop({ scene: 'flat' })
    const box = document.createElement('glass-container') as HTMLElement & { dismiss(m: HTMLElement): Promise<void>; members: HTMLElement[] }
    box.setAttribute('morph', '')
    Object.assign(box.style, { position: 'absolute', left: '440px', top: '500px', display: 'flex', gap: '12px' })
    box.innerHTML = '<glass-button type="button" shadow="0" style="position:static;width:56px;height:56px"></glass-button>'
    document.body.append(box)
    await sleep(0)
    stage.debug.renderNow()
    const a = box.querySelector('glass-button')!
    const b = document.createElement('glass-button')
    b.setAttribute('type', 'button')
    b.setAttribute('shadow', '0')
    Object.assign(b.style, { position: 'static', width: '56px', height: '56px' })
    box.append(b)
    await sleep(0) // 容器的 MutationObserver 在微任务里刷新成员
    const anims = b.getAnimations()
    for (const x of anims) {
      x.pause()
      x.currentTime = 0
    }
    stage.debug.renderNow()
    const ar = a.getBoundingClientRect()
    const br = b.getBoundingClientRect()
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const pixel = async (x: number, y: number): Promise<number> => {
      const d = await readback({ x: Math.floor((x - canvasBox.left) * s), y: Math.floor((y - canvasBox.top) * s), width: 1, height: 1 })
      return d[0]!
    }
    const dropCenter: [number, number] = [br.left + br.width / 2, br.top + br.height / 2]
    const atDrop = await pixel(dropCenter[0] + 3, dropCenter[1]) // 滴的中心往外一点：邻居的边外面
    const scene = await pixel(ar.right + 40, ar.top - 20) // 远处的场景
    const groups = stage.debug.stats().groups
    for (const x of anims) x.finish()
    stage.debug.renderNow()
    const end = b.getBoundingClientRect()
    const gone = box.dismiss(b)
    for (const x of b.getAnimations()) x.finish()
    await gone
    const removed = !b.isConnected && box.members.length === 1
    // 减少动效：不动、直接拿掉
    simulateReducedMotion(true)
    const c = document.createElement('glass-button')
    Object.assign(c.style, { position: 'static', width: '56px', height: '56px' })
    box.append(c)
    await sleep(0)
    const quiet = c.getAnimations().length === 0
    void box.dismiss(c)
    const instant = !c.isConnected
    simulateReducedMotion(null)
    box.remove()
    calibrationScene()
    stage.debug.renderNow()

    const droplet = Math.abs(br.width - 56 * 0.2) < 1 && Math.abs(dropCenter[0] - ar.right) < 1 && Math.abs(dropCenter[1] - (ar.top + 28)) < 1
    const detail =
      `开始：B ${br.width.toFixed(1)}×${br.height.toFixed(1)}、中心 (${dropCenter.map((x) => x.toFixed(1)).join(', ')})，` +
      `A 的右边缘中点 (${ar.right.toFixed(1)}, ${(ar.top + 28).toFixed(1)}) · 滴那里 ${atDrop}、场景 ${scene} · 组 ${groups} · ` +
      `走完 B 在 x=${end.left.toFixed(1)}、宽 ${end.width.toFixed(1)} · dismiss ${removed ? '拿掉了' : '没拿掉'} · ` +
      `减少动效：${quiet ? '不动' : '还在动'}、${instant ? '立刻拿掉' : '没拿掉'}`
    return anims.length === 1 && droplet && atDrop - scene > 10 && Math.abs(end.width - 56) < 0.5 &&
      Math.abs(end.left - (ar.right + 12)) < 0.5 && removed && quiet && instant
      ? pass(detail)
      : fail(detail)
  })

  await check('linear-light', async () => {
    // 线性光模式（blendSpace: 'linear'）。同一组元素、同一个视口，两种模式各量一遍：
    // 1) 阶跃：calibration 场景模糊 16dp，最下面一行横跨黑白阶跃。两侧的平台两种模式相同；中段每一列都等于
    //    「按 sRGB 模式那一列反推出的权重，在线性光里混」—— 两种模式的核一模一样，只有混的空间不同；
    //    中点从 127 变成 180（0.04 与 0.96 在线性光里平均、再编码回去）
    // 2) tint：灰场景上一块只有 tint 的玻璃（rgba(255, 64, 0, 0.4)，关掉自适应），三个通道都等于在各自的空间里
    //    mix(灰, tint, 0.4) —— G 通道对「tint 有没有先换成线性值」最敏感
    // 3) 自适应（只看线性光）：白字的玻璃压暗到线性亮度正好 0.3，深色字、没有 tint 的玻璃在暗处提亮到正好 0.1
    //    （默认模式按 2.2 次方近似，只是大致到那里）
    // 4) 层：tint 很红的玻璃里嵌一块什么都不做的玻璃，里面那块的中心与外面那块同一处的颜色相同 ——
    //    层的来源是从画布拷来的 sRGB 编码值，线性光模式下要先解码
    // 5) 切回 sRGB：整帧与切过去之前逐位相同；再切过去不再新建管线
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const W = canvasBox.width
    const H = canvasBox.height
    const full: ReadbackRegion = { x: 0, y: 0, width: v.compositeWidth, height: v.compositeHeight }
    const pixel = async (x: number, y: number): Promise<[number, number, number]> => {
      const d = await readback({ x: Math.floor((x - canvasBox.left) * s), y: Math.floor((y - canvasBox.top) * s), width: 1, height: 1 })
      return [d[0]!, d[1]!, d[2]!]
    }
    const lum = (c: readonly number[]): number =>
      0.2126 * srgbToLinear(c[0]! / 255) + 0.7152 * srgbToLinear(c[1]! / 255) + 0.0722 * srgbToLinear(c[2]! / 255)
    const place = (left: number, top: number, width: number, height: number, parent: HTMLElement = document.body): HTMLElement => {
      const el = document.createElement('div')
      Object.assign(el.style, { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` })
      parent.append(el)
      return el
    }
    const plain = { blur: 0, refraction: 0, distortion: 0, highlight: 0, saturation: 1, dispersion: 0, shadow: 0, adaptive: 0 }

    calibrationScene()
    const hashBefore = await sha(await readback(full))

    // 1) 阶跃的那一行：画布最下面往上 40px，横跨中线左右各 120px
    const rowRegion: ReadbackRegion = {
      x: Math.floor((W / 2 - 120) * s),
      y: Math.floor((H - 40) * s),
      width: Math.floor(240 * s),
      height: 1
    }
    const row = async (): Promise<number[]> => {
      stage.debug.setBackdrop({ scene: 'calibration', blurDp: 16, saturation: 1, tint: 'rgba(255, 255, 255, 0)' })
      const d = await readback(rowRegion)
      return Array.from({ length: rowRegion.width }, (_, i) => d[i * 4]!)
    }

    // 2) tint 与 4) 层：灰场景上
    const tintEl = place(460, 40, 200, 120)
    const outerEl = place(460, 200, 240, 180)
    const innerEl = place(40, 40, 160, 100, outerEl)
    const panels = [
      stage.register(tintEl, { ...plain, tint: 'rgba(255, 64, 0, 0.4)', cornerRadius: 12 }),
      stage.register(outerEl, { ...plain, tint: 'rgba(255, 0, 0, 0.5)', cornerRadius: 16 }),
      stage.register(innerEl, { ...plain, tint: 'rgba(0, 0, 0, 0)', cornerRadius: 12 })
    ]
    const flatReadings = async (): Promise<{ gray: number; tint: [number, number, number]; inner: [number, number, number]; outer: [number, number, number] }> => {
      stage.debug.setBackdrop({ scene: 'flat', blurDp: 0 })
      const gray = (await pixel(740, 100))[0]
      return {
        gray,
        tint: await pixel(560, 100),
        inner: await pixel(580, 290), // 里面那块的中心
        outer: await pixel(480, 290) // 外面那块、里面那块左边
      }
    }
    const tintTarget = [1, 64 / 255, 0]
    const expectTint = (gray: number, linear: boolean): number[] =>
      tintTarget.map((t) =>
        linear
          ? linearToSrgb(srgbToLinear(gray / 255) * 0.6 + srgbToLinear(t) * 0.4) * 255
          : ((gray / 255) * 0.6 + t * 0.4) * 255
      )

    const stepSrgb = await row()
    const flatSrgb = await flatReadings()

    stage.setBlendSpace('linear')
    const stepLinear = await row()
    const pipelinesLinear = stage.debug.stats().pipelineCreations
    const flatLinear = await flatReadings()
    // 3) 自适应：白字的玻璃在灰上；深色字、没有 tint 的玻璃在 calibration 左下的暗处
    const whiteEl = place(460, 420, 200, 100)
    whiteEl.style.color = '#fff'
    const darkEl = place(60, H - 150, Math.max(80, Math.min(200, W / 2 - 210)), 80)
    darkEl.style.color = '#111'
    panels.push(
      stage.register(whiteEl, { ...plain, adaptive: 1, tint: 'rgba(255, 255, 255, 0.18)', cornerRadius: 12 }),
      stage.register(darkEl, { ...plain, adaptive: 1, tint: 'rgba(255, 255, 255, 0)', cornerRadius: 12 })
    )
    await sleep(0)
    stage.debug.setBackdrop({ scene: 'flat', blurDp: 0 })
    const white = await pixel(560, 470)
    stage.debug.setBackdrop({ scene: 'calibration', blurDp: 0 })
    const darkBox = darkEl.getBoundingClientRect()
    const dark = await pixel(darkBox.left + darkBox.width / 2, darkBox.top + darkBox.height / 2)

    stage.setBlendSpace('srgb')
    for (const panel of panels) panel.unregister()
    for (const el of [tintEl, outerEl, whiteEl, darkEl]) el.remove()
    calibrationScene()
    const hashAfter = await sha(await readback(full))
    // 再切过去一次：管线是第一次切过去时建的，不该再建
    stage.setBlendSpace('linear')
    stage.debug.renderNow()
    const pipelinesAgain = stage.debug.stats().pipelineCreations
    stage.setBlendSpace('srgb')
    stage.debug.renderNow()

    // —— 判据 ——
    const n = stepSrgb.length
    const [e0, e1] = [stepSrgb[0]!, stepSrgb[n - 1]!]
    const [l0, l1] = [stepLinear[0]!, stepLinear[n - 1]!]
    const L0 = srgbToLinear(l0 / 255)
    const L1 = srgbToLinear(l1 / 255)
    let central = 0
    let centralErr = 0
    let mid = 0
    for (let i = 0; i < n; i++) {
      const w = (stepSrgb[i]! - e0) / (e1 - e0)
      if (Math.abs(stepSrgb[i]! - (e0 + e1) / 2) < Math.abs(stepSrgb[mid]! - (e0 + e1) / 2)) mid = i
      if (w < 0.25 || w > 0.75) continue
      central++
      centralErr = Math.max(centralErr, Math.abs(linearToSrgb(L0 + w * (L1 - L0)) * 255 - stepLinear[i]!))
    }
    const expectedMid = linearToSrgb((srgbToLinear(0.04) + srgbToLinear(0.96)) / 2) * 255
    const tintSrgbExp = expectTint(flatSrgb.gray, false)
    const tintLinearExp = expectTint(flatLinear.gray, true)
    const within = (got: readonly number[], want: readonly number[], tol: number): boolean =>
      got.every((g, i) => Math.abs(g - want[i]!) <= tol)
    const f = (c: readonly number[]): string => c.map((x) => Math.round(x)).join('/')

    const stepOk =
      Math.abs(l0 - e0) <= 1 && Math.abs(l1 - e1) <= 1 &&
      Math.abs(stepSrgb[mid]! - 127.5) <= 4 && Math.abs(stepLinear[mid]! - expectedMid) <= 4 &&
      central >= 5 && centralErr <= 3
    const tintOk = within(flatSrgb.tint, tintSrgbExp, 2) && within(flatLinear.tint, tintLinearExp, 2)
    const adaptOk = Math.abs(lum(white) - 0.3) <= 0.006 && Math.abs(lum(dark) - 0.1) <= 0.006
    const layerOk = within(flatSrgb.inner, flatSrgb.outer, 2) && within(flatLinear.inner, flatLinear.outer, 2)
    const detail =
      `阶跃：平台 ${e0}/${e1} → ${l0}/${l1} · 中点 ${stepSrgb[mid]} → ${stepLinear[mid]}（预期 ${expectedMid.toFixed(1)}）· ` +
      `中段 ${central} 列与线性光里混的预测最多差 ${centralErr.toFixed(2)} · ` +
      `tint：sRGB ${f(flatSrgb.tint)}（预期 ${f(tintSrgbExp)}）、线性 ${f(flatLinear.tint)}（预期 ${f(tintLinearExp)}）· ` +
      `自适应：白字 ${lum(white).toFixed(3)}、深色字 ${lum(dark).toFixed(3)} · ` +
      `层：sRGB 里 ${f(flatSrgb.inner)} 外 ${f(flatSrgb.outer)}、线性 里 ${f(flatLinear.inner)} 外 ${f(flatLinear.outer)} · ` +
      `切回 sRGB ${hashAfter === hashBefore ? '逐位相同' : '不同'} · 再切过去新建管线 ${pipelinesAgain - pipelinesLinear} 条`
    return stepOk && tintOk && adaptOk && layerOk && hashAfter === hashBefore && pipelinesAgain === pipelinesLinear
      ? pass(detail)
      : fail(detail)
  })

  await check('morph-glass', async () => {
    // morphGlass(from, to)：按钮变成卡片。
    // 1) 起点：seek(0) 时按钮那一块与变形之前逐位相同（过渡玻璃不画、卡片看不见）；
    // 2) 途中：seek(0.5) 时过渡玻璃的矩形 = 两个矩形按缓动插值；它画着玻璃，按钮、卡片都看不见；
    // 3) 终点：seek(1) 时卡片那一块与 finish 之后逐位相同；
    // 4) 走完：过渡玻璃拿掉，按钮不透明度 0；再变回去（卡片 → 按钮），按钮回到原来的样子、卡片藏起来；
    // 5) 减少动效：直接换，不出过渡玻璃；6) to 量不到矩形（display: none）：警告一句、直接换。
    stage.debug.setBackdrop({ scene: 'flat' })
    const from = document.createElement('glass-button')
    from.setAttribute('type', 'button')
    Object.assign(from.style, { position: 'absolute', left: '440px', top: '200px', width: '56px', height: '56px' })
    const to = document.createElement('glass-card')
    to.setAttribute('tint', 'rgba(255, 60, 60, 0.45)')
    to.setAttribute('corner-radius', '24')
    Object.assign(to.style, { position: 'absolute', left: '500px', top: '320px', width: '220px', height: '140px' })
    document.body.append(from, to)
    await sleep(0)
    stage.debug.renderNow()
    const fromRegion = regionOf([from], 24)
    const toRegion = regionOf([to], 24)
    const a = from.getBoundingClientRect()
    const b = to.getBoundingClientRect()
    const before = await sha(await readback(fromRegion))

    const m = morphGlass(from, to)
    m.seek(0)
    const atStart = await sha(await readback(fromRegion))
    const ghostAt = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-glassium-morph]')
    m.seek(0.5)
    const ghost = ghostAt()
    const g = MORPH_GLASS_EASE(0.5)
    const want = { left: a.left + (b.left - a.left) * g, top: a.top + (b.top - a.top) * g, width: a.width + (b.width - a.width) * g }
    const got = ghost ? ghost.getBoundingClientRect() : null
    const rectOk = !!got && Math.abs(got.left - want.left) < 0.5 && Math.abs(got.top - want.top) < 0.5 && Math.abs(got.width - want.width) < 0.5
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const pixel = async (x: number, y: number): Promise<[number, number, number]> => {
      const d = await readback({ x: Math.floor((x - canvasBox.left) * s), y: Math.floor((y - canvasBox.top) * s), width: 1, height: 1 })
      return [d[0]!, d[1]!, d[2]!]
    }
    const mid = got ? await pixel(got.left + got.width / 2, got.top + got.height / 2) : [0, 0, 0]
    const scene = await pixel(a.left + a.width / 2, a.top + a.height / 2) // 按钮原来的地方：途中已经空了
    const hiddenMid = from.style.opacity === '0' && to.style.opacity === '0'
    m.seek(1)
    const atEnd = await sha(await readback(toRegion))
    m.finish()
    await m.finished
    stage.debug.renderNow()
    const after = await sha(await readback(toRegion))
    const ghostGone = ghostAt() === null
    const fromHidden = from.style.opacity === '0'
    // 变回去
    const back = morphGlass(to, from)
    back.finish()
    await back.finished
    const restored = from.style.opacity === '' && to.style.opacity === '0'
    const backBefore = await sha(await readback(fromRegion))
    // 减少动效
    simulateReducedMotion(true)
    const quick = morphGlass(from, to)
    const noGhost = ghostAt() === null
    await quick.finished
    const quickLanded = from.style.opacity === '0' && to.style.opacity === ''
    simulateReducedMotion(null)
    // 量不到矩形：卡片 → display: none 的按钮
    from.style.display = 'none'
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]): void => void warnings.push(String(args[0]))
    let unmeasured: ReturnType<typeof morphGlass>
    try {
      unmeasured = morphGlass(to, from)
    } finally {
      console.warn = realWarn
    }
    const unmeasuredGhost = ghostAt() !== null
    unmeasured.finish() // 真的变起来了（保护失效）就直接跳到终点，别等 rAF
    await unmeasured.finished
    const unmeasuredOk =
      !unmeasuredGhost && warnings.length === 1 && warnings[0]!.includes('没有排版') && to.style.opacity === '0' && from.style.opacity === ''
    from.remove()
    to.remove()
    calibrationScene()
    stage.debug.renderNow()

    const f = (c: readonly number[]): string => c.join('/')
    const detail =
      `起点 ${atStart === before ? '与变形之前逐位相同' : '不同'} · ` +
      `途中过渡玻璃 ${got ? `${got.left.toFixed(1)}, ${got.top.toFixed(1)}, 宽 ${got.width.toFixed(1)}` : '没有'}` +
      `（预期 ${want.left.toFixed(1)}, ${want.top.toFixed(1)}, 宽 ${want.width.toFixed(1)}）、中心 ${f(mid)}、按钮原处 ${f(scene)}、` +
      `两头${hiddenMid ? '都看不见' : '还看得见'} · 终点 ${atEnd === after ? '与走完之后逐位相同' : '不同'} · ` +
      `走完：过渡玻璃${ghostGone ? '拿掉了' : '还在'}、按钮${fromHidden ? '藏起来' : '还在'} · 变回去：${restored ? '按钮回来、卡片藏起来' : '没复原'}` +
      `${backBefore === before ? '，按钮那一块与最初逐位相同' : '，按钮那一块与最初不同'} · 减少动效：${noGhost && quickLanded ? '直接换' : '没直接换'}` +
      ` · 量不到矩形：${unmeasuredOk ? '警告一句、直接换' : `没按预期（警告 ${warnings.length} 条、过渡玻璃${unmeasuredGhost ? '出了' : '没出'}）`}`
    const ok =
      atStart === before && rectOk && mid[0]! - mid[1]! > 10 && Math.abs(scene[0]! - scene[1]!) <= 2 && hiddenMid &&
      atEnd === after && ghostGone && fromHidden && restored && backBefore === before && noGhost && quickLanded && unmeasuredOk
    return ok ? pass(detail) : fail(detail)
  })

  await check('component-equals-register', async () => {
    // 同一个位置先放组件、再放手动注册的 div，材质相同：区域哈希必须逐位相同
    const place = (el: HTMLElement): void => {
      Object.assign(el.style, { position: 'absolute', left: '40px', top: '480px', width: '200px', height: '80px' })
      document.body.append(el)
    }
    const comp = document.createElement('glass-card')
    comp.setAttribute('preset', 'regular')
    comp.setAttribute('corner-radius', '20')
    place(comp)
    await sleep(0)
    const region = regionOf([comp], 8)
    const compPixels = await readback(region)
    const a = await sha(compPixels)
    comp.remove()
    const div = document.createElement('div')
    place(div)
    const panel = stage.register(div, { ...GlassPresets.regular, cornerRadius: 20 })
    const manualPixels = await readback(region)
    const b = await sha(manualPixels)
    panel.unregister()
    div.remove()
    stage.debug.renderNow()
    const detail = `组件 ${a.slice(0, 12)} · 手动 ${b.slice(0, 12)}` + (a === b ? '' : ` · ${pixelDiff(compPixels, manualPixels, region.width)}`)
    return a === b ? pass(detail) : fail(detail)
  })

  await check('button-form', async () => {
    // <glass-button> 在表单里与原生按钮相同：默认提交，name / value 只在被按下时进表单数据；
    // click 里 preventDefault() 就不提交；祖先 fieldset 禁用时不提交；type="reset" 重置
    const form = document.createElement('form')
    form.innerHTML =
      '<input name="q" value="1">' +
      '<glass-button name="action" value="save">保存</glass-button>' +
      '<glass-button type="reset">重置</glass-button>' +
      '<fieldset disabled><glass-button name="action" value="locked">锁定</glass-button></fieldset>'
    Object.assign(form.style, { position: 'absolute', left: '40px', top: '620px' })
    document.body.append(form)
    await sleep(0)
    const [save, reset, locked] = [...form.querySelectorAll('glass-button')] as HTMLElement[]
    const submissions: string[] = []
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const data = new FormData(form, (e as SubmitEvent).submitter)
      submissions.push([...data].map(([k, v]) => `${k}=${String(v)}`).join('&'))
    })
    const settle = (): Promise<void> => sleep(20) // 激活在 click 派发完之后的下一个任务里
    save!.click()
    await settle()
    const cancel = (e: Event): void => e.preventDefault()
    save!.addEventListener('click', cancel)
    save!.click()
    await settle()
    save!.removeEventListener('click', cancel)
    locked!.click()
    await settle()
    const input = form.querySelector('input')!
    input.value = '2'
    reset!.click()
    await settle()
    const lockedAria = locked!.getAttribute('aria-disabled')
    form.remove()
    stage.debug.renderNow()
    const detail =
      `提交 ${submissions.length} 次（${submissions.join(' | ') || '无'}）· 改成 2 再重置后 q=${input.value}` +
      ` · fieldset 里的按钮 aria-disabled=${lockedAria}`
    const ok = submissions.length === 1 && submissions[0] === 'q=1&action=save' && input.value === '1' && lockedAria === 'true'
    return ok ? pass(detail) : fail(detail)
  })

  await check('group-merges', async () => {
    // 缝隙 10px：smoothing 24（> 2×缝宽）时缝隙中点被填上，0 时不填
    const [left, right] = duo.querySelectorAll('glass-button')
    const l = left!.getBoundingClientRect()
    const r = right!.getBoundingClientRect()
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvas = stage.canvas.getBoundingClientRect()
    const mid = {
      x: Math.floor(((l.right + r.left) / 2 - canvas.left) * s),
      y: Math.floor(((l.top + l.bottom) / 2 - canvas.top) * s),
      width: 1,
      height: 1
    }
    stage.debug.setPanelDebug('mask')
    try {
      duo.setAttribute('smoothing', '0')
      const off = (await readback(mid))[0]!
      duo.setAttribute('smoothing', '24')
      const on = (await readback(mid))[0]!
      const detail = `缝隙中点的覆盖率：smoothing 0 → ${off}/255，24 → ${on}/255`
      return off === 0 && on >= 250 ? pass(detail) : fail(detail)
    } finally {
      stage.debug.setPanelDebug('off')
    }
  })

  await check('group-far-equals-standalone', async () => {
    // 成员拉开 210px：合并组里没有一个像素真的在混合，必须与各自单独绘制逐位相同
    const right = duo.querySelectorAll<HTMLElement>('glass-button')[1]!
    right.style.left = '340px'
    const buttons = [...duo.querySelectorAll('glass-button')]
    const region = regionOf(buttons, 12)
    const groupedPixels = await readback(region)
    const grouped = await sha(groupedPixels)
    const groupsBefore = stage.debug.stats().groups
    const plain = document.createElement('div')
    plain.id = 'v-duo-plain'
    Object.assign(plain.style, { position: 'absolute', left: '40px', top: '400px' })
    duo.replaceWith(plain)
    for (const b of buttons) plain.append(b)
    await sleep(0)
    const standalonePixels = await readback(region)
    const standalone = await sha(standalonePixels)
    const groupsAfter = stage.debug.stats().groups
    // 复原
    plain.replaceWith(duo)
    for (const b of buttons) duo.append(b)
    right.style.left = '130px'
    await sleep(0)
    stage.debug.renderNow()
    const detail =
      `合并 ${grouped.slice(0, 12)}（${groupsBefore} 组）· 单独 ${standalone.slice(0, 12)}（${groupsAfter} 组）` +
      (grouped === standalone ? '' : ` · ${pixelDiff(groupedPixels, standalonePixels, region.width)}`)
    return grouped === standalone && groupsBefore === 1 && groupsAfter === 0 ? pass(detail) : fail(detail)
  })

  await check('layering', async () => {
    // 藏起来的面板（opacity: 0、visibility: hidden）不画，也就不该被报 —— 渐隐收起的提示条常这样
    const hidden = ['opacity: 0', 'visibility: hidden'].map((css) => {
      const el = document.createElement('glass-card')
      el.setAttribute('style', `position: absolute; left: 440px; top: 40px; width: 120px; height: 60px; ${css}`)
      document.body.append(el)
      return el
    })
    await sleep(0)
    const clean = stage.debug.checkLayers()
    for (const el of hidden) el.remove()
    const wrap = document.createElement('div')
    wrap.className = 'opaque-wrap'
    Object.assign(wrap.style, {
      position: 'absolute',
      left: '40px',
      top: '480px',
      width: '200px',
      height: '80px',
      background: '#fff'
    })
    const inner = document.createElement('glass-card')
    Object.assign(inner.style, { left: '0', top: '0', width: '100%', height: '100%' })
    wrap.append(inner)
    document.body.append(wrap)
    await sleep(0)
    const dirty = stage.debug.checkLayers()
    wrap.remove()
    const named = dirty.some((p) => p.kind === 'covered' && p.element === wrap)
    const detail = `干净页面 ${clean.length} 个问题；加一层白底后 ${named ? '点名了 div.opaque-wrap' : '没有点名'}`
    return clean.length === 0 && named ? pass(detail) : fail(detail)
  })

  await check('clipping', async () => {
    // 滚动容器 200×100，里面的卡片在 y 60–140：下面 40px 被容器裁掉。
    // 容器外、卡片盒子延伸到的那一块，有卡片与删掉卡片必须逐位相同（那里不能有玻璃）；
    // 容器里那一块必须不同（玻璃确实画了）。
    const box = document.createElement('div')
    Object.assign(box.style, { position: 'absolute', left: '40px', top: '480px', width: '200px', height: '100px', overflow: 'auto' })
    const content = document.createElement('div')
    content.style.height = '400px'
    const clipped = document.createElement('glass-card')
    Object.assign(clipped.style, { position: 'relative', left: '0', top: '0', display: 'block', width: '180px', height: '80px', marginTop: '60px' })
    content.append(clipped)
    box.append(content)
    document.body.append(box)
    await sleep(0)
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvas = stage.canvas.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    const c = clipped.getBoundingClientRect()
    const outside: ReadbackRegion = {
      x: Math.floor((c.left - canvas.left) * s),
      y: Math.ceil((b.bottom - canvas.top) * s) + 1,
      width: Math.floor(c.width * s),
      height: Math.floor((c.bottom - b.bottom) * s) - 2
    }
    const inside: ReadbackRegion = {
      x: Math.floor((c.left - canvas.left) * s),
      y: Math.floor((c.top - canvas.top) * s),
      width: Math.floor(c.width * s),
      height: Math.floor((b.bottom - c.top) * s) - 2
    }
    const outWith = await sha(await readback(outside))
    const inWith = await sha(await readback(inside))
    clipped.remove()
    await sleep(0)
    const outWithout = await sha(await readback(outside))
    const inWithout = await sha(await readback(inside))
    box.remove()
    stage.debug.renderNow()
    const detail =
      `容器外 ${outside.width}×${outside.height}：${outWith === outWithout ? '没有玻璃' : '漏出了玻璃'}；` +
      `容器内：${inWith !== inWithout ? '有玻璃' : '没有玻璃'}`
    return outWith === outWithout && inWith !== inWithout ? pass(detail) : fail(detail)
  })

  await check('scene-image', async () => {
    // 四象限图 fill 铺满：四个象限各占视口的四分之一 —— 同时验了方向（没有上下、左右翻转）。
    // 取样点都避开了左上那几块玻璃。静态图只该上传一次，之后的帧都用纹理里的。
    const { cssWidth: W, cssHeight: H } = stage.debug.stats().viewport!
    const img = quadrants(64)
    const u0 = stage.debug.stats().sceneUploads
    await stage.setScene(img, { fit: 'fill' })
    const bad: string[] = []
    const expect = async (label: string, x: number, y: number, want: Rgb): Promise<void> => {
      const got = await pixelAt(x, y)
      if (!near(got, want)) bad.push(`${label} (${Math.round(x)}, ${Math.round(y)}) = ${got.join(',')}`)
    }
    await expect('fill 左上', W / 4, 10, RED)
    await expect('fill 右上', (3 * W) / 4, H / 4, GREEN)
    await expect('fill 左下', W / 4, (3 * H) / 4, BLUE)
    await expect('fill 右下', (3 * W) / 4, (3 * H) / 4, WHITE)
    for (let i = 0; i < 4; i++) stage.debug.renderNow()
    const uploads = stage.debug.stats().sceneUploads - u0
    const kind = stage.debug.stats().scene

    // contain：图是正方形，长边方向留出底色（竖屏上下、横屏左右）
    await stage.setScene(img, { fit: 'contain', background: '#ff00ff' })
    const s = Math.min(W, H)
    await expect('contain 右上', W / 2 + s / 4, H / 2 - s / 4, GREEN)
    await expect('contain 右下', W / 2 + s / 4, H / 2 + s / 4, WHITE)
    const letterbox = Math.abs(W - H) > 40
    if (letterbox) {
      const [bx, by] = H > W ? [W / 2 + s / 4, (H - s) / 4] : [W - (W - s) / 4, H / 2 + s / 4]
      await expect('contain 留白', bx, by, MAGENTA)
    }

    await stage.setScene(null)
    const restored = stage.debug.stats().scene
    const detail =
      `${bad.length === 0 ? `fill 四象限与 contain${letterbox ? ' 留白' : ''}都对` : bad.join('；')}` +
      ` · 静态图 8 帧上传 ${uploads} 次 · 场景类型 ${kind} → ${restored}`
    return bad.length === 0 && uploads === 1 && kind === 'image' && restored === 'builtin' ? pass(detail) : fail(detail)
  })

  await check('scene-canvas', async () => {
    // 画布走的是原样上传（不经 ImageBitmap），上传时的翻转设置只对它起作用 ——
    // 所以上红下蓝，先验方向。之后：默认只在 refreshScene() 之后重传；dynamic 时每一帧都传。
    const { cssWidth: W, cssHeight: H } = stage.debug.stats().viewport!
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d')!
    const paint = (top: string, bottom: string): void => {
      ctx.fillStyle = top
      ctx.fillRect(0, 0, 32, 16)
      ctx.fillStyle = bottom
      ctx.fillRect(0, 16, 32, 16)
    }
    const upper: [number, number] = [(3 * W) / 4, H / 4]
    const lower: [number, number] = [(3 * W) / 4, (3 * H) / 4]
    paint('#ff0000', '#0000ff')
    const u0 = stage.debug.stats().sceneUploads
    await stage.setScene(canvas, { fit: 'fill' })
    const first = await pixelAt(...upper)
    const firstLower = await pixelAt(...lower)
    paint('#00ff00', '#00ff00')
    const stale = await pixelAt(...upper) // 没 refresh：还是红
    stage.refreshScene()
    const fresh = await pixelAt(...upper)
    const refreshUploads = stage.debug.stats().sceneUploads - u0

    await stage.setScene(canvas, { dynamic: true })
    const before = stage.debug.stats()
    for (let i = 0; i < 5; i++) stage.debug.renderNow()
    const after = stage.debug.stats()
    const dynUploads = after.sceneUploads - before.sceneUploads
    const dynFrames = after.frames - before.frames
    await stage.setScene(null)

    const ok = near(first, RED) && near(firstLower, BLUE) && near(stale, RED) && near(fresh, GREEN)
    const detail =
      `上半 ${first.join(',')} / 下半 ${firstLower.join(',')} · 改画未刷新 ${stale.join(',')}` +
      ` · refreshScene 之后 ${fresh.join(',')}` +
      ` · 共上传 ${refreshUploads} 次 · dynamic ${dynFrames} 帧上传 ${dynUploads} 次`
    return ok && refreshUploads === 2 && dynFrames >= 5 && dynUploads === dynFrames ? pass(detail) : fail(detail)
  })

  await check('clipping-rounded', async () => {
    // 圆角容器 200×100（border-radius 24px、overflow hidden），里面一张比它大的卡片把它整个盖住。
    // 容器左上角、圆角外面的那一小块：有卡片与删掉卡片必须逐位相同（玻璃被圆角裁掉了）；
    // 容器中间必须不同（玻璃确实画了）
    const box = document.createElement('div')
    Object.assign(box.style, {
      position: 'absolute',
      left: '40px',
      top: '480px',
      width: '200px',
      height: '100px',
      overflow: 'hidden',
      borderRadius: '24px'
    })
    const card = document.createElement('glass-card')
    card.setAttribute('corner-radius', '0')
    Object.assign(card.style, { position: 'absolute', left: '-30px', top: '-30px', width: '260px', height: '160px' })
    box.append(card)
    document.body.append(box)
    await sleep(0)
    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvas = stage.canvas.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    // 圆角外：离角 1–6 CSS 像素的方块，到圆心 (24, 24) 的距离都大于 25
    const corner: ReadbackRegion = {
      x: Math.floor((b.left - canvas.left + 1) * s),
      y: Math.floor((b.top - canvas.top + 1) * s),
      width: Math.floor(5 * s),
      height: Math.floor(5 * s)
    }
    const middle: ReadbackRegion = {
      x: Math.floor((b.left - canvas.left + 90) * s),
      y: Math.floor((b.top - canvas.top + 40) * s),
      width: Math.floor(20 * s),
      height: Math.floor(20 * s)
    }
    const cornerWith = await sha(await readback(corner))
    const middleWith = await sha(await readback(middle))
    card.remove()
    await sleep(0)
    const cornerWithout = await sha(await readback(corner))
    const middleWithout = await sha(await readback(middle))
    box.remove()
    stage.debug.renderNow()
    const detail =
      `圆角外 ${corner.width}×${corner.height}：${cornerWith === cornerWithout ? '没有玻璃' : '漏出了玻璃'}；` +
      `容器中间：${middleWith !== middleWithout ? '有玻璃' : '没有玻璃'}`
    return cornerWith === cornerWithout && middleWith !== middleWithout ? pass(detail) : fail(detail)
  })

  await check('clip-path', async () => {
    // clip-path 的基本形状与椭圆角的裁剪。一块比容器大的红玻璃，看几个有鉴别力的点是玻璃（R − G 大）还是场景（灰）：
    // 1) circle()：圆里是玻璃；外接正方形的角上是场景（只按矩形裁时那里是玻璃）
    // 2) ellipse()（300×100 上 rx 150、ry 50）：两个在椭圆外、按短半径画成圆角时却在里面的点是场景
    // 3) overflow: hidden + border-radius: 50%（裁剪祖先的椭圆角）：同样两点
    // 4) 面板自己写 clip-path: inset(10px round 30px / 10px)
    // 5) 圆被 overflow 的祖先从中间截断：截断处附近、圆外的一点是场景（只按交集的角算时那里是直角、是玻璃）
    // 6) circle(0%)：什么都看不见；url() 引用画不了：警告一次、照样画（与 DOM 一样不裁）
    stage.debug.setBackdrop({ scene: 'flat' })
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]): void => {
      if (String(args[0]).includes('clip-path')) warnings.push(String(args[0]))
      else realWarn(...args)
    }
    const made: HTMLElement[] = []
    const redCard = (w: number, h: number, css: Partial<CSSStyleDeclaration> = {}): HTMLElement => {
      const card = document.createElement('glass-card')
      card.setAttribute('corner-radius', '0')
      card.setAttribute('tint', 'rgba(255, 60, 60, 0.45)')
      Object.assign(card.style, { position: 'absolute', left: '-20px', top: '-20px', width: `${w + 40}px`, height: `${h + 40}px`, ...css })
      return card
    }
    const box = (left: number, top: number, w: number, h: number, css: Partial<CSSStyleDeclaration>, child?: HTMLElement): HTMLElement => {
      const el = document.createElement('div')
      Object.assign(el.style, { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`, ...css })
      el.append(child ?? redCard(w, h))
      document.body.append(el)
      made.push(el)
      return el
    }
    const circle = box(60, 480, 200, 100, { clipPath: 'circle()' })
    const ellipse = box(300, 480, 300, 100, { clipPath: 'ellipse()' })
    const oval = box(300, 620, 300, 100, { overflow: 'hidden', borderRadius: '50%' })
    const own = redCard(160, 60, { left: '60px', top: '620px', width: '200px', height: '100px', clipPath: 'inset(10px round 30px / 10px)' })
    document.body.append(own)
    made.push(own)
    const cutInner = document.createElement('div')
    Object.assign(cutInner.style, { position: 'absolute', left: '0', top: '0', width: '200px', height: '100px', clipPath: 'circle()' })
    cutInner.append(redCard(200, 100))
    const cut = box(60, 720, 130, 100, { overflow: 'hidden' }, cutInner)
    const none = box(300, 720, 200, 100, { clipPath: 'circle(0%)' })
    const missing = box(540, 720, 200, 100, { clipPath: 'url(#glassium-verify-missing)' })
    await sleep(0)

    const v = stage.debug.stats().viewport!
    const s = v.compositeWidth / v.cssWidth
    const canvasBox = stage.canvas.getBoundingClientRect()
    const at = async (el: HTMLElement, x: number, y: number): Promise<number[]> => {
      const r = el.getBoundingClientRect()
      const d = await readback({
        x: Math.floor((r.left + x - canvasBox.left) * s),
        y: Math.floor((r.top + y - canvasBox.top) * s),
        width: 1,
        height: 1
      })
      return [d[0]!, d[1]!, d[2]!]
    }
    const glass = (c: readonly number[]): boolean => c[0]! - c[1]! > 20
    const scene = (c: readonly number[]): boolean => Math.abs(c[0]! - c[1]!) <= 2
    type Probe = readonly [HTMLElement, number, number, 'glass' | 'scene']
    const probes: Record<string, readonly Probe[]> = {
      circle: [
        [circle, 138, 50, 'glass'],
        [circle, 100, 8, 'glass'],
        [circle, 140, 90, 'scene'], // 外接正方形的角上
        [circle, 60, 10, 'scene'],
        [circle, 20, 50, 'scene']
      ],
      ellipse: [
        [ellipse, 20, 20, 'scene'], // 椭圆外；按短半径 50 画成圆角时在里面
        [ellipse, 40, 12, 'scene'],
        [ellipse, 150, 6, 'glass'],
        [ellipse, 8, 50, 'glass']
      ],
      oval: [
        [oval, 20, 20, 'scene'],
        [oval, 40, 12, 'scene'],
        [oval, 150, 6, 'glass'],
        [oval, 8, 50, 'glass']
      ],
      own: [
        [own, 12, 12, 'scene'], // 椭圆角外
        [own, 5, 50, 'scene'], // inset 外
        [own, 25, 14, 'glass'],
        [own, 100, 50, 'glass']
      ],
      cut: [
        [cut, 125, 3, 'scene'], // 圆外、截断处附近 —— 只按交集的角算时是玻璃
        [cut, 120, 15, 'glass'],
        [cut, 70, 50, 'glass']
      ],
      none: [[none, 100, 50, 'scene']],
      missing: [[missing, 100, 50, 'glass']]
    }
    const f = (c: readonly number[]): string => c.join('/')
    const parts: string[] = []
    let ok = true
    for (const [name, list] of Object.entries(probes)) {
      const got: string[] = []
      for (const [el, x, y, want] of list) {
        const c = await at(el, x, y)
        const right = want === 'glass' ? glass(c) : scene(c)
        ok &&= right
        got.push(`(${x}, ${y}) ${f(c)}${right ? '' : `（应为${want === 'glass' ? '玻璃' : '场景'}）`}`)
      }
      parts.push(`${name} ${got.join('、')}`)
    }
    console.warn = realWarn
    const warned = warnings.length === 1 && warnings[0]!.includes('url()')
    ok &&= warned
    for (const el of made) el.remove()
    calibrationScene()
    stage.debug.renderNow()
    const detail = `${parts.join(' · ')} · url() 警告 ${warnings.length} 条${warned ? '' : '（应为 1 条）'}`
    return ok ? pass(detail) : fail(detail)
  })

  await check('cross-backend', async () => {
    // 同一个固定场景，两个后端各画一帧：calibration 一次，用户图片（cover，放大、带斜条纹硬边）一次；
    // 线性光模式下两个场景再各一次（内置场景与图片场景的线性化、层的解码都在里面）
    if (stage.backend !== 'webgpu') return skip(`当前是 ${stage.backend}，只在 WebGPU 起步时比两个后端`)
    // 加一对嵌套的透明玻璃（玻璃的第 1 层，layers.ts）：WebGL2 那边的重采样要把默认帧缓冲（左下原点）拷出来再
    // 翻一次，翻错了在对称的内容上看不出来 —— 这里的背景（calibration、斜条纹）上下不对称，翻错就是一大片不同
    const outer = document.createElement('glass-card')
    outer.setAttribute('preset', 'clear')
    Object.assign(outer.style, { left: '440px', top: '480px', width: '300px', height: '220px', padding: '40px', boxSizing: 'border-box' })
    const inner = document.createElement('glass-card')
    inner.setAttribute('preset', 'clear')
    inner.setAttribute('corner-radius', '16')
    Object.assign(inner.style, { position: 'static', display: 'block', width: '200px', height: '120px' })
    outer.append(inner)
    document.body.append(outer)
    await sleep(0)
    const full = { x: 0, y: 0, width: stage.canvas.width, height: stage.canvas.height }
    const photo = stripes(480, 320)
    const a = await readback(full)
    await stage.setScene(photo)
    const a2 = await readback(full)
    stage.setBlendSpace('linear')
    const a4 = await readback(full)
    await stage.setScene(null)
    const a3 = await readback(full)
    stage.dispose()
    stage = await createGlassStage({ backend: 'webgl2' })
    Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })
    if (stage.backend !== 'webgl2') return skip('WebGL2 起不来')
    calibrationScene()
    await sleep(0)
    stage.debug.renderNow()
    const b = await readback(full)
    await stage.setScene(photo)
    const b2 = await readback(full)
    stage.setBlendSpace('linear')
    const b4 = await readback(full)
    await stage.setScene(null)
    const b3 = await readback(full)
    stage.setBlendSpace('srgb')
    outer.remove()
    if (a.length !== b.length) return fail(`两帧尺寸不同：${a.length / 4} vs ${b.length / 4}`)
    const total = a.length / 4
    const W = stage.canvas.width
    const cal = diffFrames(a, b, W)
    const img = diffFrames(a2, b2, W)
    const calLinear = diffFrames(a3, b3, W)
    const imgLinear = diffFrames(a4, b4, W)
    const detail =
      `calibration：${total} 像素里 ${cal.changed} 个不同，最大差 ${cal.max}/255${cal.where}` +
      `；图片场景：${img.changed} 个不同，最大差 ${img.max}/255${img.where}（都含一对嵌套的玻璃）` +
      `；线性光：calibration ${calLinear.changed} 个、最大差 ${calLinear.max}/255${calLinear.where}，` +
      `图片 ${imgLinear.changed} 个、最大差 ${imgLinear.max}/255${imgLinear.where}`
    const ok = (d: typeof cal): boolean => d.max <= 2 && d.changed / total <= 1e-3
    // 线性光放宽：两个后端的 pow 末位不同，渐变上落在舍入边界的值差 1（图片场景要先解码，所以多）；硬边暗的一侧
    // 编码曲线最陡，亚纹素级的采样差被放大约 4 倍（同一个像素 sRGB 下差 2、线性光下差 4）。忘了解码、编码这类错
    // 都是成片的几十级差，照样抓得到
    const okLinear = (d: typeof cal): boolean => d.max <= 8 && d.changed / total <= 5e-3
    return ok(cal) && ok(img) && okLinear(calLinear) && okLinear(imgLinear) ? pass(detail) : fail(detail)
  })

  finish()
}

/**
 * 一轮跑完。这一轮不算数、重新加载页面再跑（最多 MAX_RETRIES 次，次数记在 sessionStorage，标题栏写明原因）的两种情况：
 * - 视口中途变过。重跑之后仍然不稳就判失败。
 * - 画布从头就没有 1:1 对上设备像素（见 viewportMismatch），并且有检查失败。重跑够了还是这样就照实报 ——
 *   失败的项留着，标题栏写着画布没对上。
 * 否则清掉重跑次数。
 */
function finish(): void {
  const failed = results.filter((r) => r.outcome.status === 'fail').map((r) => r.name)
  const reason =
    viewportChanges.length > 0
      ? `视口在运行中变了：${viewportChanges.join('；')}`
      : startMismatch && failed.length > 0
        ? `画布没有 1:1 对上设备像素（${startMismatch}），失败的项：${failed.join('、')}`
        : null
  if (reason === null || (attempt >= MAX_RETRIES && viewportChanges.length === 0)) {
    render(true)
    try {
      sessionStorage.removeItem(RETRY_KEY)
      sessionStorage.removeItem(RETRY_REASON_KEY)
    } catch {
      // sessionStorage 不可用：没有什么可清的
    }
    return
  }
  if (attempt < MAX_RETRIES) {
    try {
      sessionStorage.setItem(RETRY_KEY, String(attempt + 1))
      sessionStorage.setItem(RETRY_REASON_KEY, reason)
    } catch {
      // sessionStorage 不可用时 attempt 已经是 MAX_RETRIES，走不到这里
    }
    render(false)
    document.title = `这一轮作废，重跑（第 ${attempt + 1} 次）`
    location.reload()
    return
  }
  results.push({ name: 'viewport-stable', outcome: fail(`重跑 ${MAX_RETRIES} 次之后视口仍然在运行中变化`) })
  render(true)
}

run().catch((err) => {
  results.push({ name: 'run', outcome: fail(String(err)) })
  render(true)
})
