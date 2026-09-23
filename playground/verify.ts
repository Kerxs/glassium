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
    const clean = stage.debug.checkLayers()
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
