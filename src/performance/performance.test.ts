import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FrameMonitor, WINDOW_MS } from './monitor.ts'
import { parseProfile, profileKey, PROFILE_TTL_MS } from './profile.ts'
import { allocateQuality, COMFORT_GPU, HEAVY_SHARE, LOCAL_SPAN, OVER_GPU } from './quality.ts'
import {
  DEGRADE_WINDOWS,
  factorsFor,
  PROBE_FALLBACK,
  QUALITY_MIN,
  QualityController,
  RECOVER_WINDOWS,
  type FrameWindow
} from './quality.ts'

const over: FrameWindow = { frames: 30, dropRatio: 0.4, cpuRatio: 0.3 }
const ok: FrameWindow = { frames: 30, dropRatio: 0, cpuRatio: 0.2 }
const middle: FrameWindow = { frames: 30, dropRatio: 0.1, cpuRatio: 0.4 }

test('系数：q = 1 逐项是 1；色散最先降、分辨率与折射后降、模糊最后；到底也不是 0', () => {
  assert.deepEqual(factorsFor(1), { dispersion: 1, depth: 1, resolution: 1, shadow: 1, refraction: 1, blur: 1 })
  const a = factorsFor(0.8)
  assert.ok(a.dispersion < 1 && a.depth === 1 && a.resolution === 1, '0.8：只有色散降了')
  const b = factorsFor(0.6)
  assert.equal(b.dispersion, 0)
  assert.equal(b.depth, 0)
  assert.ok(b.resolution < 1 && b.refraction === 1, '0.6：分辨率开始降，折射还没动')
  const low = factorsFor(0)
  assert.equal(low.resolution, 0.6)
  assert.equal(low.refraction, 0.6)
  assert.equal(low.blur, 0.7)
  assert.equal(low.shadow, 0.5)
  for (let q = QUALITY_MIN; q <= 1; q += 0.05) {
    const f = factorsFor(q)
    const g = factorsFor(q + 0.05)
    for (const k of Object.keys(f) as (keyof typeof f)[]) assert.ok(g[k] >= f[k] - 1e-12, `${k} 随 q 单调`)
  }
})

test('控制器：连续超预算快降，连续宽裕慢升，中间那段不动；不低于下限', () => {
  const c = new QualityController(1, false)
  for (let i = 0; i < DEGRADE_WINDOWS - 1; i++) c.sample(over)
  assert.equal(c.quality, 1, '还没到连续的次数')
  c.sample(over)
  assert.equal(c.quality, 0.9)
  for (let i = 0; i < 100; i++) c.sample(middle)
  assert.equal(c.quality, 0.9, '中间那段不升不降')
  for (let i = 0; i < RECOVER_WINDOWS; i++) c.sample(ok)
  assert.equal(c.quality, 0.95, '宽裕 8 个窗口升 0.05')
  for (let i = 0; i < 200; i++) c.sample(over)
  assert.equal(c.quality, QUALITY_MIN)
  // 一次超预算打断宽裕的计数
  const d = new QualityController(0.5, false)
  for (let i = 0; i < RECOVER_WINDOWS - 1; i++) d.sample(ok)
  d.sample(over)
  for (let i = 0; i < RECOVER_WINDOWS - 1; i++) d.sample(ok)
  assert.equal(d.quality, 0.5)
})

test('控制器：好坏交替的负载下不振荡（升的条件比降的严）', () => {
  const c = new QualityController(0.7, false)
  const seen = new Set<number>()
  for (let i = 0; i < 400; i++) seen.add(c.sample(i % 2 === 0 ? over : ok))
  assert.equal(seen.size, 1, `交替时应当一直停在原地，实际出现 ${[...seen].join(', ')}`)
})

test('探测：起步的几十帧掉帧多就直接从 0.7 起；不多就留在原地', () => {
  const bad = new QualityController(1, true)
  bad.sample(over)
  assert.ok(bad.probing || bad.quality === PROBE_FALLBACK)
  bad.sample(over)
  assert.equal(bad.probing, false)
  assert.equal(bad.quality, PROBE_FALLBACK)
  const good = new QualityController(1, true)
  good.sample(ok)
  good.sample(ok)
  assert.equal(good.quality, 1)
})

test('帧监测：认出刷新间隔，按 1.5 倍算掉帧，断开（隐藏）不算，静止的圈不进窗口', () => {
  const m = new FrameMonitor()
  let t = 0
  let w: FrameWindow | null = null
  // 120Hz，每 4 帧掉一帧（隔 2 个刷新间隔）
  for (let i = 1; w === null && i < 200; i++) {
    t += i % 4 === 0 ? 16.67 : 8.33
    w = m.frame(t, true, 2)
  }
  assert.ok(Math.abs(m.refreshMs - 8.33) < 0.01, `刷新间隔 ${m.refreshMs}`)
  assert.ok(w && Math.abs(w.dropRatio - 0.25) < 0.05, `掉帧比例 ${w?.dropRatio}`)
  assert.ok(w && Math.abs(w.cpuRatio - 2 / 8.33) < 0.01)
  // 断开 1 秒：从头攒，不产出一个满是掉帧的窗口
  t += 1000
  assert.equal(m.frame(t, true, 2), null)
  // 静止：没画的圈不算帧
  let quiet: FrameWindow | null = null
  for (let i = 0; quiet === null && i < 200; i++) {
    t += 8.33
    quiet = m.frame(t, false, 0.1)
  }
  assert.ok(quiet && quiet.frames === 0 && quiet.dropRatio === 0)
  assert.ok(WINDOW_MS === 500)
})

test('profile：键里有版本、后端、尺寸、DPR；过期、坏数据、未来的时间都不认', () => {
  assert.equal(profileKey('0.3.0', 'webgpu', 1280.4, 720, 1.5), 'glassium:quality:0.3.0:webgpu:1280x720@1.5')
  const now = 1_000_000_000_000
  const good = JSON.stringify({ q: 0.8, frameMs: 8.3, resolution: 0.9, at: now - 1000 })
  assert.deepEqual(parseProfile(good, now), { q: 0.8, frameMs: 8.3, resolution: 0.9, at: now - 1000 })
  assert.equal(parseProfile(JSON.stringify({ q: 0.8, at: now - PROFILE_TTL_MS - 1 }), now), null)
  assert.equal(parseProfile(JSON.stringify({ q: 0.8, at: now + 5000 }), now), null)
  assert.equal(parseProfile(JSON.stringify({ q: 3, at: now }), now), null)
  assert.equal(parseProfile('{oops', now), null)
  assert.equal(parseProfile(null, now), null)
})

test('局部质量：先降贵的那几块（整页不动），再往下整页才降；没有贵的、只有一块时就是整页降', () => {
  const costs = [600, 100, 100, 100] // 第 0 块占 2/3
  const full = allocateQuality(1, costs)
  assert.deepEqual(full, { global: 1, local: [null, null, null, null] }, '满质量：谁都不降')
  const early = allocateQuality(0.9, costs)
  assert.equal(early.global, 1, '头几步只降贵的')
  assert.ok(early.local[0]! < 1 && early.local[0]! > 0.35)
  assert.deepEqual(early.local.slice(1), [null, null, null])
  const edge = allocateQuality(1 - LOCAL_SPAN, costs)
  assert.equal(edge.global, 1)
  assert.ok(Math.abs(edge.local[0]! - 0.35) < 1e-12, '到 0.7 时贵的降到底')
  const deep = allocateQuality(0.5, costs)
  assert.ok(deep.global < 1 && deep.global > 0.35, `再往下整页降（${deep.global}）`)
  assert.ok(Math.abs(allocateQuality(0.35, costs).global - 0.35) < 1e-12, '到底时整页也到底')
  // 连续：q 往下走，整页那一档不往上跳
  let prev = 1
  for (let q = 1; q >= 0.35; q -= 0.01) {
    const g = allocateQuality(q, costs).global
    assert.ok(g <= prev + 1e-12)
    prev = g
  }
  assert.deepEqual(allocateQuality(0.8, [100, 100, 100, 100, 100]), { global: 0.8, local: [null, null, null, null, null] }, '成本差不多（各 20% < 25%）：整页降')
  assert.ok(0.2 < HEAVY_SHARE)
  assert.deepEqual(allocateQuality(0.8, [1000]), { global: 0.8, local: [null] }, '只有一块：它就是整页')
})

test('GPU 时间：CPU 与掉帧都好但 GPU 超预算 → 照样降；GPU 不宽裕时不升；量不了（null）时与原来一样', () => {
  const gpuHeavy: FrameWindow = { frames: 30, dropRatio: 0, cpuRatio: 0.2, gpuRatio: OVER_GPU + 0.1 }
  const c = new QualityController(1, false)
  for (let i = 0; i < DEGRADE_WINDOWS; i++) c.sample(gpuHeavy)
  assert.ok(c.quality < 1, 'GPU 吃紧就降')
  const warm: FrameWindow = { frames: 30, dropRatio: 0, cpuRatio: 0.2, gpuRatio: (OVER_GPU + COMFORT_GPU) / 2 }
  const d = new QualityController(0.8, false)
  for (let i = 0; i < RECOVER_WINDOWS * 2; i++) d.sample(warm)
  assert.equal(d.quality, 0.8, 'GPU 在中间那一段：不升不降')
  const unknown: FrameWindow = { frames: 30, dropRatio: 0, cpuRatio: 0.2, gpuRatio: null }
  const e = new QualityController(0.8, false)
  for (let i = 0; i < RECOVER_WINDOWS; i++) e.sample(unknown)
  assert.ok(e.quality > 0.8, '量不了 GPU：按 CPU 与掉帧照常升')
})

test('帧监测：窗口里的 GPU 时间取平均、除以刷新间隔；没有 GPU 时间时是 null', () => {
  const m = new FrameMonitor()
  let w: FrameWindow | null = null
  for (let t = 0; t <= 600 && !w; t += 16) w = m.frame(t, true, 2, 8)
  assert.ok(w && w.gpuRatio !== null && w.gpuRatio !== undefined && Math.abs(w.gpuRatio - 0.5) < 0.01, `8ms / 16ms ≈ 0.5（${w?.gpuRatio}）`)
  const n = new FrameMonitor()
  let v: FrameWindow | null = null
  for (let t = 0; t <= 600 && !v; t += 16) v = n.frame(t, true, 2)
  assert.equal(v?.gpuRatio, null)
})
