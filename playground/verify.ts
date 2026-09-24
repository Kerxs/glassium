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
  simulateMoreContrast,
  simulateReducedMotion,
  simulateReducedTransparency,
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
  const retried = attempt > 0 ? `\n这是第 ${attempt} 次重跑，上一轮作废（视口在运行中变了）：\n  ${retryReason}` : ''
  reportEl.innerHTML = `${head}${retried}${changes}\n\n${lines.join('\n')}`
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

/** 等视口稳定下来（连续 0.5 秒不变，最多等 5 秒）再开始。每一步同步出一帧，stats 里的视口才是新的。 */
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
    } else if (performance.now() - since >= 500) {
      return
    }
  }
}

function viewportKey(): string {
  const v = stage.debug.stats().viewport
  const box = stage.canvas.getBoundingClientRect()
  return `DPR ${devicePixelRatio} · 画布 ${box.width}×${box.height} CSS px · ` + (v ? `${v.compositeWidth}×${v.compositeHeight}` : '—')
}

async function check(name: string, fn: () => Promise<Outcome>): Promise<void> {
  const before = viewportKey()
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
  const after = viewportKey()
  if (after !== before) viewportChanges.push(`${name}：${before} → ${after}`)
  results.push({ name, outcome })
  render()
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
  return (await p).rgba
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
  await settleViewport()

  await check('backend', async () => {
    const report = stage.debug.probe
    const detail = `${stage.backend}${report ? `（${report.kind}）` : ''}`
    return stage.backend === 'none' ? fail(`${detail}：没有 GPU 后端，下面的检查都没有意义`) : pass(detail)
  })
  if (stage.backend === 'none') {
    render(true)
    return
  }

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
    const a = await sha(await readback(region))
    comp.remove()
    const div = document.createElement('div')
    place(div)
    const panel = stage.register(div, { ...GlassPresets.regular, cornerRadius: 20 })
    const b = await sha(await readback(region))
    panel.unregister()
    div.remove()
    stage.debug.renderNow()
    const detail = `组件 ${a.slice(0, 12)} · 手动 ${b.slice(0, 12)}`
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
    const grouped = await sha(await readback(region))
    const groupsBefore = stage.debug.stats().groups
    const plain = document.createElement('div')
    plain.id = 'v-duo-plain'
    Object.assign(plain.style, { position: 'absolute', left: '40px', top: '400px' })
    duo.replaceWith(plain)
    for (const b of buttons) plain.append(b)
    await sleep(0)
    const standalone = await sha(await readback(region))
    const groupsAfter = stage.debug.stats().groups
    // 复原
    plain.replaceWith(duo)
    for (const b of buttons) duo.append(b)
    right.style.left = '130px'
    await sleep(0)
    stage.debug.renderNow()
    const detail = `合并 ${grouped.slice(0, 12)}（${groupsBefore} 组）· 单独 ${standalone.slice(0, 12)}（${groupsAfter} 组）`
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

  await check('cross-backend', async () => {
    // 同一个固定场景，两个后端各画一帧：calibration 一次，用户图片（cover，放大、带斜条纹硬边）一次
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
    await stage.setScene(null)
    outer.remove()
    if (a.length !== b.length) return fail(`两帧尺寸不同：${a.length / 4} vs ${b.length / 4}`)
    const total = a.length / 4
    const W = stage.canvas.width
    const cal = diffFrames(a, b, W)
    const img = diffFrames(a2, b2, W)
    const detail =
      `calibration：${total} 像素里 ${cal.changed} 个不同，最大差 ${cal.max}/255${cal.where}` +
      `；图片场景：${img.changed} 个不同，最大差 ${img.max}/255${img.where}（都含一对嵌套的玻璃）`
    const ok = (d: typeof cal): boolean => d.max <= 2 && d.changed / total <= 1e-3
    return ok(cal) && ok(img) ? pass(detail) : fail(detail)
  })

  finish()
}

/**
 * 一轮跑完：视口中途变过的话这一轮不算数 —— 重新加载页面再跑（最多 MAX_RETRIES 次，次数记在 sessionStorage），
 * 标题栏写明原因；重跑之后仍然不稳就判失败。视口没变就清掉重跑次数。
 */
function finish(): void {
  const retries = attempt
  if (viewportChanges.length === 0) {
    render(true)
    try {
      sessionStorage.removeItem(RETRY_KEY)
      sessionStorage.removeItem(RETRY_REASON_KEY)
    } catch {
      // sessionStorage 不可用：没有什么可清的
    }
    return
  }
  if (retries < MAX_RETRIES) {
    try {
      sessionStorage.setItem(RETRY_KEY, String(retries + 1))
      sessionStorage.setItem(RETRY_REASON_KEY, viewportChanges.join('；'))
    } catch {
      // sessionStorage 不可用时 attempt 已经是 MAX_RETRIES，走不到这里
    }
    render(false)
    document.title = `视口在运行中变了，重跑（第 ${retries + 1} 次）`
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
