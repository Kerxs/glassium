import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evalMergedOptics, memberOptics, mergeBleed, type MemberGeometry } from './merge.ts'
import { refractionProfile, type Vec2 } from './optics.ts'

/** 两块并排的胶囊，中间留 gap 的缝。 */
function pair(gap: number): [MemberGeometry, MemberGeometry] {
  const base = { radii: [25, 25, 25, 25] as const, heightPx: 12, amountPx: 18, squircle: 2, depthEffect: 1 }
  return [
    { ...base, rect: [0, 0, 100, 50] },
    { ...base, rect: [100 + gap, 0, 100, 50] }
  ]
}

test('单个成员：与单块面板的计算逐位相同，且不算混合', () => {
  const [a] = pair(10)
  for (const px of [[3.5, 3.5], [50.5, 2.5], [97.5, 40.5], [50.5, 25.5], [-3.5, 25.5]] as Vec2[]) {
    const merged = evalMergedOptics(px, [a], 24)
    const single = memberOptics(px, a)
    assert.equal(merged.blended, false)
    assert.equal(merged.sd, single.sd)
    assert.deepEqual(merged.dir, single.dir)
    assert.equal(merged.displacement, refractionProfile(single.sd, a.heightPx, a.amountPx, a.squircle))
  }
})

test('相距足够远时，成员内部每个像素都逐位取自最近的成员', () => {
  // 缝隙 200px，k = 24：成员内部任一点离另一个成员都远超 k，h 恰为 0 或 1
  const [a, b] = pair(200)
  let checked = 0
  for (let y = 0.5; y < 50; y += 3) {
    for (let x = 0.5; x < 100; x += 3) {
      const merged = evalMergedOptics([x, y], [a, b], 24)
      const own = memberOptics([x, y], a)
      assert.equal(merged.blended, false, `(${x}, ${y}) 不该混合`)
      assert.equal(merged.sd, own.sd)
      assert.deepEqual(merged.dir, own.dir)
      checked++
    }
  }
  assert.ok(checked > 400)
})

test('缝隙小于 k/2 时颈部闭合，大于时不闭合', () => {
  // 缝隙中点：两个 sd 都是 gap/2，h = 0.5，smin = gap/2 − k/4
  const mid = (gap: number): Vec2 => [100 + gap / 2, 25]
  const [a, b] = pair(10)
  assert.ok(evalMergedOptics(mid(10), [a, b], 24).sd < 0, 'gap 10 < k/2 = 12：中点在形状内')
  assert.ok(evalMergedOptics(mid(10), [a, b], 16).sd > 0, 'gap 10 > k/2 = 8：中点在形状外')
  assert.ok(Math.abs(evalMergedOptics(mid(10), [a, b], 20).sd) < 1e-12, 'gap = k/2：恰在边界上')
  // k = 0 是硬并集：缝隙永远不闭合
  const hard = evalMergedOptics(mid(10), [a, b], 0)
  assert.equal(hard.sd, 5)
  assert.equal(hard.blended, false)
})

test('颈部中线上两侧方向相对，位移衰减为 0，而不是硬翻转', () => {
  const [a, b] = pair(10)
  const m = evalMergedOptics([105, 25], [a, b], 24)
  assert.ok(m.blended)
  assert.ok(m.sd < 0 && -m.sd < a.heightPx, '中点落在折射带里 —— 这正是会出接缝的地方')
  assert.ok(Math.abs(m.displacement) < 1e-9, `位移应当衰减到 0，实际 ${m.displacement}`)
  // 稍微离开中线，位移连续地回升
  const off = evalMergedOptics([105, 12], [a, b], 24)
  assert.ok(off.displacement > 0)
})

test('跨过混合区边界时各量连续', () => {
  // 沿 y = 9.5 从成员 a 内部往缝隙走：约在 x ≈ 91 处 |sdA − sdB| 降到 k 以下、开始混合，
  // 这时这个点还在折射带里（sd ≈ −2.6）—— 混合开关就在这里拨动，接缝会出在这里。
  //
  // 只比较两个相邻点都在折射带内部（−10 < sd < −1）的情形。带的外沿 sd → 0 处
  // circleMap 的斜率本来就发散（单块面板也一样），0.01px 的步长在那里走出零点几像素的位移差，
  // 那不是合并引入的跳变。
  const [a, b] = pair(10)
  let prev: { off: [number, number]; sd: number; blended: boolean } | null = null
  let worst = 0
  let crossed = false
  for (let x = 60; x <= 150; x += 0.01) {
    const m = evalMergedOptics([x, 9.5], [a, b], 24)
    const off: [number, number] = [m.dir[0] * m.displacement, m.dir[1] * m.displacement]
    const inBand = m.sd < -1 && m.sd > -10
    if (prev && inBand && prev.sd < -1 && prev.sd > -10) {
      worst = Math.max(worst, Math.hypot(off[0] - prev.off[0], off[1] - prev.off[1]))
      if (prev.blended !== m.blended) crossed = true
    }
    prev = { off, sd: m.sd, blended: m.blended }
  }
  assert.ok(crossed, '路径必须真的在折射带里跨过混合开关，否则这条测试什么也没测')
  assert.ok(worst < 0.1, `相邻 0.01px 的偏移跳了 ${worst}px`)
})

test('两个成员的顺序不影响结果', () => {
  const [a, b] = pair(8)
  for (const px of [[104, 25], [98, 5], [110, 45], [50, 25]] as Vec2[]) {
    const ab = evalMergedOptics(px, [a, b], 24)
    const ba = evalMergedOptics(px, [b, a], 24)
    assert.ok(Math.abs(ab.sd - ba.sd) < 1e-12)
    assert.ok(Math.abs(ab.displacement - ba.displacement) < 1e-9)
  }
})

test('合并形状不超出「并集外扩 k/4」—— 裁剪矩形按这个外扩就不会裁掉像素', () => {
  const [a, b] = pair(6)
  const k = 32
  const bleed = mergeBleed(k)
  let insideOutsideBox = 0
  for (let y = -20; y <= 70; y += 0.5) {
    for (let x = -20; x <= 226; x += 0.5) {
      const inBox = x >= -bleed && x <= 206 + bleed && y >= -bleed && y <= 50 + bleed
      if (inBox) continue
      if (evalMergedOptics([x, y], [a, b], k).sd <= 0) insideOutsideBox++
    }
  }
  assert.equal(insideOutsideBox, 0)
})

test('没有成员时抛错', () => {
  assert.throws(() => evalMergedOptics([0, 0], [], 10))
})
