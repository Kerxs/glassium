import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_LEVELS, SIGMA_BASE, levelForSigma, sigmaForLevel } from './blur.ts'

/**
 * 模糊链的 σ↔级 映射。
 *
 * 这是 T6 里**唯一能在 Node 里测的东西** —— 纹理分配和建链都要 GPUDevice。
 * 其余部分由 playground 实测（见 docs/calibration.md）。
 * 与其假装能测，不如把能测的测死，剩下的诚实地写清楚在哪儿验。
 */

test('σ=0 落在级 0（锐利），负数同理', () => {
  assert.equal(levelForSigma(0, MAX_LEVELS), 0)
  assert.equal(levelForSigma(-5, MAX_LEVELS), 0)
  assert.equal(levelForSigma(Number.NaN, MAX_LEVELS), 0, 'NaN 也必须落到锐利而不是传播出去')
})

test('级与 σ 互为逆运算（σ ≥ SIGMA_BASE 的几何级数段）', () => {
  for (let k = 1; k < MAX_LEVELS; k++) {
    const sigma = sigmaForLevel(k)
    assert.ok(
      Math.abs(levelForSigma(sigma, MAX_LEVELS) - k) < 1e-12,
      `级 ${k} 的 σ=${sigma} 反解回来是 ${levelForSigma(sigma, MAX_LEVELS)}`
    )
  }
})

test('各级的 σ 依次翻倍，覆盖到 32', () => {
  const sigmas = Array.from({ length: MAX_LEVELS }, (_, k) => sigmaForLevel(k))
  assert.deepEqual(sigmas, [0, 2, 4, 8, 16, 32])
  // 32 是 GlassMaterial 里 blur 的上限，也是上游 playground 的 blurRadiusDp 上限。
  assert.equal(sigmas[MAX_LEVELS - 1], 32)
})

test('映射单调递增 —— σ 变大不能让级变小', () => {
  let prev = -1
  for (let sigma = 0; sigma <= 64; sigma += 0.25) {
    const level = levelForSigma(sigma, MAX_LEVELS)
    assert.ok(level >= prev, `σ=${sigma} 处不单调：${level} < ${prev}`)
    assert.ok(Number.isFinite(level), `σ=${sigma} 产生了 ${level}`)
    prev = level
  }
})

test('超出上限的 σ 被钳到最高级，而不是溢出', () => {
  assert.equal(levelForSigma(1000, MAX_LEVELS), MAX_LEVELS - 1)
  assert.equal(levelForSigma(Number.POSITIVE_INFINITY, MAX_LEVELS), MAX_LEVELS - 1)
})

test('级数少时（小视口）仍然钳在可用范围内', () => {
  // 视口很小的时候链建不了那么多级，此时大 σ 只能落在最高的那一级。
  for (const levels of [1, 2, 3]) {
    assert.equal(levelForSigma(32, levels), levels - 1)
    assert.equal(levelForSigma(0, levels), 0)
  }
})

test('小 σ 不会被吞掉 —— blur:1 必须真的有模糊', () => {
  // 纯对数映射在这里会塌陷：1 + log2(1/2) = 0，1 + log2(0.25/2) = −2，钳完都是级 0，
  // 于是 blur 从 0 到 1 全渲染成完全锐利。材质写了 blur:1 却没有任何模糊，
  // 是那种「参数调了没反应」的错，比明显的错更浪费时间。
  const half = levelForSigma(SIGMA_BASE / 2, MAX_LEVELS)
  assert.ok(half > 0 && half < 1, `σ=${SIGMA_BASE / 2} 应落在 (0,1)，实得 ${half}`)
  assert.equal(half, 0.5, '低段在 σ 上线性')
  assert.ok(levelForSigma(0.5, MAX_LEVELS) < half, '更小的 σ 应当更靠近锐利端')
  assert.ok(levelForSigma(0.25, MAX_LEVELS) > 0, '再小也不该被吞成 0')
})

test('两段在 σ = SIGMA_BASE 处接得上', () => {
  const eps = 1e-9
  const below = levelForSigma(SIGMA_BASE - eps, MAX_LEVELS)
  const at = levelForSigma(SIGMA_BASE, MAX_LEVELS)
  const above = levelForSigma(SIGMA_BASE + eps, MAX_LEVELS)
  assert.ok(Math.abs(at - 1) < 1e-12, `接点应为级 1，实得 ${at}`)
  assert.ok(Math.abs(below - at) < 1e-6, '左极限必须接上 —— 断开会在扫描时看到跳变')
  assert.ok(Math.abs(above - at) < 1e-6, '右极限必须接上')
})
