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
  reportEl.innerHTML = `${head}\n\n${lines.join('\n')}`
  if (done) {
    document.title = `${passed === ran.length ? 'PASS' : 'FAIL'} ${passed}/${ran.length}`
    console.info(`[verify] ${head}`)
  }
}

async function check(name: string, fn: () => Promise<Outcome>): Promise<void> {
  let outcome: Outcome
  try {
    outcome = await fn()
  } catch (err) {
    outcome = fail(`抛出：${err instanceof Error ? err.message : String(err)}`)
  }
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
  await sleep(50)
  stage.debug.renderNow()

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
    const inset = Math.ceil(probe.panel.heightPx) + 8
    const region: ReadbackRegion = {
      x: probe.origin[0] + inset,
      y: probe.origin[1] + inset,
      width: probe.width - 2 * inset,
      height: probe.height - 2 * inset
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
    if (a.length !== b.length) return fail(`两帧尺寸不同：${a.length / 4} vs ${b.length / 4}`)
    const total = a.length / 4
    const W = stage.canvas.width
    const cal = diffFrames(a, b, W)
    const img = diffFrames(a2, b2, W)
    const detail =
      `calibration：${total} 像素里 ${cal.changed} 个不同，最大差 ${cal.max}/255${cal.where}` +
      `；图片场景：${img.changed} 个不同，最大差 ${img.max}/255${img.where}`
    const ok = (d: typeof cal): boolean => d.max <= 2 && d.changed / total <= 1e-3
    return ok(cal) && ok(img) ? pass(detail) : fail(detail)
  })

  render(true)
}

run().catch((err) => {
  results.push({ name: 'run', outcome: fail(String(err)) })
  render(true)
})
