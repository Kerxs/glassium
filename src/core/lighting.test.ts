import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bodyLight,
  channelSampleOffsets,
  gradRadiusOf,
  gradSdRoundedRect,
  magnifyFactor,
  refractionDirection,
  refractionProfile,
  rimLight,
  rimMask,
  safeNormalize,
  sdRoundedRect,
  type Vec2
} from './optics.ts'

/**
 * T8：色散与高光的 CPU 侧性质。
 *
 * GPU 侧的对应实测（校准场景、逐扇区统计）在 docs/calibration.md。这里钉住的是
 * 模型本身的性质 —— 并且对每一条都给出上游模型作对照，证明测试确实分辨得出两者，
 * 而不是两种写法都能通过。
 */

const HALF: Vec2 = [150, 90]
const RADIUS = 40
const HEIGHT = 24
const AMOUNT = 48
const LIGHT: Vec2 = [0, -1] // 竖直，与着色器的 RIM_LIGHT_DIR 一致

/** 四个角各取一个边缘带内的点（沿 45° 方向走到 sd = -4）。 */
function cornerPoints(): Record<'TL' | 'TR' | 'BR' | 'BL', Vec2> {
  const at = (sx: number, sy: number): Vec2 => {
    let lo = 0
    let hi = Math.hypot(HALF[0], HALF[1])
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      const p: Vec2 = [(sx * mid) / Math.SQRT2, (sy * mid) / Math.SQRT2]
      if (sdRoundedRect(p, HALF, RADIUS) < -4) lo = mid
      else hi = mid
    }
    return [(sx * lo) / Math.SQRT2, (sy * lo) / Math.SQRT2]
  }
  return { TL: at(-1, -1), TR: at(1, -1), BR: at(1, 1), BL: at(-1, 1) }
}

function outwardNormal(p: Vec2): Vec2 {
  return safeNormalize(gradSdRoundedRect(p, HALF, gradRadiusOf(RADIUS, HALF)))
}

/** (红偏移 − 蓝偏移) 在外法线上的投影。正 = 红在外、蓝在里。 */
function redMinusBlueAlongNormal(offR: Vec2, offB: Vec2, n: Vec2): number {
  return (offR[0] - offB[0]) * n[0] + (offR[1] - offB[1]) * n[1]
}

/* ------------------------------------------------------------------ *
 * 色散
 * ------------------------------------------------------------------ */

test('色散：四个角上都是蓝通道采得比红通道更靠里', () => {
  const k = 0.5
  for (const [corner, p] of Object.entries(cornerPoints())) {
    const n = outwardNormal(p)
    const dir = refractionDirection(p, HALF, gradRadiusOf(RADIUS, HALF), 1)
    const d = refractionProfile(sdRoundedRect(p, HALF, RADIUS), HEIGHT, AMOUNT)
    assert.ok(d > 0, `${corner} 的取样点应当在折射带里`)
    const off = channelSampleOffsets(dir, d, k)
    const rb = redMinusBlueAlongNormal(off.r, off.b, n)
    assert.ok(rb > 0, `${corner}：红−蓝在外法线上的投影应为正（蓝更靠里），实得 ${rb}`)
  }
})

test('色散：四个角上的彩边强度完全对称', () => {
  const k = 0.5
  const values = Object.values(cornerPoints()).map((p) => {
    const n = outwardNormal(p)
    const dir = refractionDirection(p, HALF, gradRadiusOf(RADIUS, HALF), 1)
    const d = refractionProfile(sdRoundedRect(p, HALF, RADIUS), HEIGHT, AMOUNT)
    const off = channelSampleOffsets(dir, d, k)
    return redMinusBlueAlongNormal(off.r, off.b, n)
  })
  const spread = Math.max(...values) - Math.min(...values)
  assert.ok(spread < 1e-9, `四个角应当一样，实得 ${values.join(', ')}`)
})

test('对照：上游的鞍面调制在相邻两角给出相反的彩边次序', () => {
  // 上游：dispersedCoord = d * grad * k * (x·y)/(hx·hy)，红 = 折射点 + dispersed，
  // 蓝 = 折射点 − dispersed，且 d 取负（refractionAmount 传进去之前取了负号）。
  // 这条测试证明上面那两条确实分辨得出两种模型 —— 同一组取样点，上游的写法过不了。
  const k = 0.5
  const signs: Record<string, number> = {}
  for (const [corner, p] of Object.entries(cornerPoints())) {
    const n = outwardNormal(p)
    const grad = outwardNormal(p)
    const d = -refractionProfile(sdRoundedRect(p, HALF, RADIUS), HEIGHT, AMOUNT)
    const intensity = k * ((p[0] * p[1]) / (HALF[0] * HALF[1]))
    const dispersed: Vec2 = [d * grad[0] * intensity, d * grad[1] * intensity]
    const offR = dispersed
    const offB: Vec2 = [-dispersed[0], -dispersed[1]]
    signs[corner] = Math.sign(redMinusBlueAlongNormal(offR, offB, n))
  }
  assert.equal(signs.TL, signs.BR, '对角两个角同号')
  assert.equal(signs.TR, signs.BL, '另一对对角同号')
  assert.notEqual(signs.TL, signs.TR, '相邻两角异号 —— 彩边次序在角与角之间翻转')
})

test('色散为 0 时三个通道的偏移逐位相等', () => {
  const dir: Vec2 = [0.6, -0.8]
  const off = channelSampleOffsets(dir, 17.25, 0)
  assert.deepEqual(off.r, off.g)
  assert.deepEqual(off.b, off.g)
})

/* ------------------------------------------------------------------ *
 * 高光
 * ------------------------------------------------------------------ */

test('亮边：一整圈都亮 —— 最暗的地方正好是 base，没有哪里是 0', () => {
  for (let deg = 0; deg < 360; deg += 5) {
    const a = (deg * Math.PI) / 180
    const v = rimLight([Math.cos(a), Math.sin(a)], LIGHT, 0.5, 1)
    assert.ok(v >= 0.5 - 1e-12 && v <= 1 + 1e-12, `${deg}° 处 ${v} 超出 [base, 1]`)
  }
})

test('亮边：上下两侧最亮（双面、等亮），左右是 base —— iOS 26 截图上就是这样', () => {
  const at = (x: number, y: number): number => rimLight(safeNormalize([x, y]), LIGHT, 0.5, 1)
  assert.ok(Math.abs(at(0, -1) - 1) < 1e-12, '上缘满强度')
  assert.ok(Math.abs(at(0, 1) - 1) < 1e-12, '下缘满强度（双面）')
  assert.ok(Math.abs(at(1, 0) - 0.5) < 1e-12, '右缘是 base')
  assert.ok(Math.abs(at(-1, 0) - 0.5) < 1e-12, '左缘是 base')
})

test('对照：旧的单面模型（只在受光一侧亮）在下缘是 0，分得出来', () => {
  const oneSided = (n: Vec2): number => Math.pow(Math.max(n[0] * LIGHT[0] + n[1] * LIGHT[1], 0), 1)
  assert.equal(oneSided([0, 1]), 0)
  assert.ok(rimLight([0, 1], LIGHT, 0.5, 1) > 0.9)
})

test('体光：顶上是 −shade，往下单调变亮，40% 往下满亮', () => {
  assert.ok(Math.abs(bodyLight(0, 0.05, 0.06) + 0.05) < 1e-12, '顶上是 −shade')
  assert.ok(bodyLight(0.1, 0.05, 0.06) < 0, '上面 10% 处还是暗的')
  assert.ok(bodyLight(0.3, 0.05, 0.06) > 0, '30% 处已经亮了')
  assert.ok(Math.abs(bodyLight(0.4, 0.05, 0.06) - 0.06) < 1e-12, '40% 处满亮')
  assert.ok(Math.abs(bodyLight(1, 0.05, 0.06) - 0.06) < 1e-12, '到底都是满亮')
  let prev = -1
  for (let t = 0; t <= 1; t += 0.01) {
    const v = bodyLight(t, 0.05, 0.06)
    assert.ok(v >= prev - 1e-12, `t = ${t} 处不单调`)
    prev = v
  }
})

test('放大：m = 0 时系数恰好是 0；放大 1 + m 倍 —— 离中心 v 的像素采 v / (1 + m) 处', () => {
  assert.equal(magnifyFactor(0), 0)
  assert.equal(magnifyFactor(-1), 0)
  for (const m of [0.1, 0.25, 1]) {
    const k = magnifyFactor(m)
    const v = 40
    assert.ok(Math.abs(v - v * k - v / (1 + m)) < 1e-12, `m = ${m}`)
  }
})

/* ------------------------------------------------------------------ *
 * 边缘带
 * ------------------------------------------------------------------ */

test('rimMask：边界处为 1，深入 rimPx 之后为 0，其间单调', () => {
  const rim = 2.25
  assert.equal(rimMask(0, rim), 1)
  assert.equal(rimMask(-rim, rim), 0)
  assert.equal(rimMask(-10, rim), 0)
  let prev = 2
  for (let d = 0; d <= rim; d += 0.05) {
    const v = rimMask(-d, rim)
    assert.ok(v <= prev + 1e-12, `深度 ${d} 处不单调`)
    prev = v
  }
})

test('rimMask：宽度为 0 时不产生 NaN（smoothstep 两端相等时结果未定义）', () => {
  assert.ok(Number.isFinite(rimMask(-1, 0)))
  assert.ok(Number.isFinite(rimMask(0, 0)))
})
