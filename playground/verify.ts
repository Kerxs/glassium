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

  await check('cross-backend', async () => {
    if (stage.backend !== 'webgpu') return skip(`当前是 ${stage.backend}，只在 WebGPU 起步时比两个后端`)
    const full = { x: 0, y: 0, width: stage.canvas.width, height: stage.canvas.height }
    const a = await readback(full)
    stage.dispose()
    stage = await createGlassStage({ backend: 'webgl2' })
    Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })
    if (stage.backend !== 'webgl2') return skip('WebGL2 起不来')
    calibrationScene()
    await sleep(0)
    stage.debug.renderNow()
    const b = await readback(full)
    if (a.length !== b.length) return fail(`两帧尺寸不同：${a.length / 4} vs ${b.length / 4}`)
    let changed = 0
    let max = 0
    const W = stage.canvas.width
    let bx0 = Infinity
    let by0 = Infinity
    let bx1 = -Infinity
    let by1 = -Infinity
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!))
      if (d > 0) {
        changed++
        const px = (i / 4) % W
        const py = Math.floor(i / 4 / W)
        bx0 = Math.min(bx0, px)
        by0 = Math.min(by0, py)
        bx1 = Math.max(bx1, px)
        by1 = Math.max(by1, py)
      }
      if (d > max) max = d
    }
    const total = a.length / 4
    const where = changed > 0 ? `，差异集中在 (${bx0}, ${by0})–(${bx1}, ${by1})` : ''
    const detail = `${total} 像素里 ${changed} 个不同，最大差 ${max}/255${where}`
    return max <= 2 && changed / total <= 1e-3 ? pass(detail) : fail(detail)
  })

  render(true)
}

run().catch((err) => {
  results.push({ name: 'run', outcome: fail(String(err)) })
  render(true)
})
