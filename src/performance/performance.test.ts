import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FrameMonitor, WINDOW_MS } from './monitor.ts'
import { parseProfile, profileKey, PROFILE_TTL_MS } from './profile.ts'
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
