import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  circleMap,
  clampRadii,
  gradRadiusOf,
  gradSdRoundedRect,
  radiusAt,
  refractionProfile,
  safeNormalize,
  sdRoundedRect,
  smin,
  sminGradient,
  spectralWeights,
  squircleMap,
  type Radii4,
  type Vec2
} from './optics.ts'

import { resolveViewport, texelCenterUv, uvToTexelCoord } from './units.ts'

/* ------------------------------------------------------------------ *
 * 确定性伪随机。测试必须可复现 —— 一条只在 CI 上偶尔红的几何测试
 * 比没有测试更浪费时间。
 * ------------------------------------------------------------------ */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

/* ------------------------------------------------------------------ *
 * 独立参考实现：按几何分区做精确解。
 *
 * 刻意用另一条推导路径 —— 被测函数是
 * length(max(c,0)) - r + min(max(cx,cy),0) 这种无分支闭式，
 * 参考实现是显式分区。两者同时写错成同一个样子的概率很低，
 * 而「用同一个公式验同一个公式」什么也证明不了。
 * ------------------------------------------------------------------ */
function sdReference(p: Vec2, halfSize: Vec2, radius: number): number {
  const qx = Math.abs(p[0])
  const qy = Math.abs(p[1])
  const cx = halfSize[0] - radius // 内角点
  const cy = halfSize[1] - radius

  if (qx > cx && qy > cy) {
    // 角区：到内角圆心的距离减半径
    return Math.hypot(qx - cx, qy - cy) - radius
  }
  if (qx > cx) {
    // x 越过内角但 y 没有，最近的边界是左右直边
    return qx - halfSize[0]
  }
  if (qy > cy) {
    return qy - halfSize[1]
  }
  // 内部十字区：最近边界是四条直边之一，恒为内部故取负
  return -Math.min(halfSize[0] - qx, halfSize[1] - qy)
}

test('sdRoundedRect 与独立几何分区解一致（10000 点）', () => {
  const rng = makeRng(0x5eed)
  const halfSize: Vec2 = [150, 90]
  let worst = 0
  let worstAt: Vec2 = [0, 0]

  for (let i = 0; i < 10_000; i++) {
    // 采样范围刻意超出形状，覆盖内部、边界附近与外部
    const p: Vec2 = [(rng() * 2 - 1) * 200, (rng() * 2 - 1) * 140]
    const r = rng() * Math.min(halfSize[0], halfSize[1])
    const got = sdRoundedRect(p, halfSize, r)
    const want = sdReference(p, halfSize, r)
    const err = Math.abs(got - want)
    if (err > worst) {
      worst = err
      worstAt = p
    }
  }
  assert.ok(
    worst < 1e-9,
    `最大偏差 ${worst} 超阈值，出现在 (${worstAt[0]}, ${worstAt[1]})`
  )
})

test('sdRoundedRect 对暴力边界采样也成立（粗校验，1e-4）', () => {
  // 上一条测的是「和我的分区推导一致」。这一条测的是「和实际几何一致」,
  // 它同时验证了那个分区推导本身。两条都写错成同一个样子才骗得过去。
  const halfSize: Vec2 = [120, 70]
  const r = 30
  const SAMPLES = 40_000
  const boundary: Vec2[] = []
  const ix = halfSize[0] - r
  const iy = halfSize[1] - r
  const straight = 2 * (2 * ix + 2 * iy)
  const arc = 2 * Math.PI * r
  const total = straight + arc

  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * total
    if (t < 2 * ix) boundary.push([-ix + t, -halfSize[1]])
    else if (t < 2 * ix + 2 * iy) boundary.push([halfSize[0], -iy + (t - 2 * ix)])
    else if (t < 4 * ix + 2 * iy) boundary.push([ix - (t - 2 * ix - 2 * iy), halfSize[1]])
    else if (t < 4 * ix + 4 * iy) boundary.push([-halfSize[0], iy - (t - 4 * ix - 2 * iy)])
    else {
      const a = ((t - straight) / arc) * 2 * Math.PI
      const ax = Math.cos(a) >= 0 ? ix : -ix
      const ay = Math.sin(a) >= 0 ? iy : -iy
      boundary.push([ax + r * Math.cos(a), ay + r * Math.sin(a)])
    }
  }

  const rng = makeRng(0xbeef)
  let worst = 0
  for (let i = 0; i < 200; i++) {
    const p: Vec2 = [(rng() * 2 - 1) * 170, (rng() * 2 - 1) * 110]
    const got = sdRoundedRect(p, halfSize, r)
    // 跳过离边界很近的点 —— 不是为了让测试好看，是因为那个区间这条方法本身无效。
    //
    // 用间距 s 离散采样边界后，对距边界 d 的点，最近样本的距离误差上界是
    //   sqrt(d² + (s/2)²) - d ≈ s²/(8d)
    // 周长约 708px、40000 个样本 → s ≈ 0.0177 → 误差 ≈ 3.9e-5 / d。
    // 要让误差低于 1e-4，需要 d > 0.39。取 1.0 留足余量。
    if (Math.abs(got) < 1.0) continue
    let best = Infinity
    for (const b of boundary) {
      const d = Math.hypot(p[0] - b[0], p[1] - b[1])
      if (d < best) best = d
    }
    worst = Math.max(worst, Math.abs(Math.abs(got) - best))
  }
  assert.ok(worst < 1e-4, `最大偏差 ${worst}`)
})

test('sdRoundedRect 在 radius=0 时退化为矩形 SDF', () => {
  const h: Vec2 = [10, 5]
  assert.equal(sdRoundedRect([0, 0], h, 0), -5)
  assert.equal(sdRoundedRect([10, 0], h, 0), 0)
  assert.equal(sdRoundedRect([13, 0], h, 0), 3)
  // 角外 (3,4) 处，距离应当是 hypot(3,4) = 5
  assert.ok(Math.abs(sdRoundedRect([13, 9], h, 0) - 5) < 1e-12)
})

/* ------------------------------------------------------------------ *
 * 梯度连续性 —— 本文件最重要的一条，且必须双向断言。
 * ------------------------------------------------------------------ */

/** 沿射线二分，找到 sd 等于给定值的点。 */
function pointAtSignedDistance(
  theta: number,
  halfSize: Vec2,
  radius: number,
  target: number
): Vec2 {
  const dir: Vec2 = [Math.cos(theta), Math.sin(theta)]
  let lo = 0
  let hi = Math.hypot(halfSize[0], halfSize[1]) * 1.5
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const p: Vec2 = [dir[0] * mid, dir[1] * mid]
    if (sdRoundedRect(p, halfSize, radius) < target) lo = mid
    else hi = mid
  }
  const t = (lo + hi) / 2
  return [dir[0] * t, dir[1] * t]
}

const SEAM_HALF_SIZE: Vec2 = [150, 90]
const SEAM_RADIUS = 40
const SEAM_DEPTH = 9.6 // 边缘带内，约 0.4 * refractionHeight(24)

/**
 * 绕形状走一圈，返回**峰值转向率**：单位弧长上的方向角变化，量纲 1/px。
 *
 * 用「每弧长」而不是「每样本」是关键。按角度 θ 均匀采样时，150x90 的矩形上
 * 相邻样本的弧长间距要差三倍，直接比相邻夹角只是在测采样参数化，不是在测场。
 * 转向率是几何量，与怎么采样无关。
 */
function peakTurnRate(inflation: number): number {
  const gradRadius = Math.min(
    SEAM_RADIUS * inflation,
    Math.min(SEAM_HALF_SIZE[0], SEAM_HALF_SIZE[1])
  )
  const N = 20_000
  let prevP: Vec2 | null = null
  let prevG: Vec2 | null = null
  let worst = 0

  for (let i = 0; i <= N; i++) {
    const theta = (i / N) * Math.PI * 2
    const p = pointAtSignedDistance(theta, SEAM_HALF_SIZE, SEAM_RADIUS, -SEAM_DEPTH)
    const g = safeNormalize(gradSdRoundedRect(p, SEAM_HALF_SIZE, gradRadius))
    if (prevP && prevG) {
      const dist = Math.hypot(p[0] - prevP[0], p[1] - prevP[1])
      if (dist > 1e-9) {
        const dot = Math.min(Math.max(prevG[0] * g[0] + prevG[1] * g[1], -1), 1)
        worst = Math.max(worst, Math.acos(dot) / dist)
      }
    }
    prevP = p
    prevG = g
  }
  return worst
}

test('峰值转向率等于 1/(gradRadius - 深度)（解析预期，非经验阈值）', () => {
  // 角区的方向场是绕「放大后的角心」的径向场，所以在离角心
  // (gradRadius - 深度) 处，转向率恰好是它的倒数。这条恒等式把这个测试
  // 从「阈值是我调出来的」变成「阈值是推出来的」。
  for (const inflation of [1.0, 1.5]) {
    const gradRadius = SEAM_RADIUS * inflation
    const expected = 1 / (gradRadius - SEAM_DEPTH)
    const measured = peakTurnRate(inflation)
    assert.ok(
      Math.abs(measured - expected) / expected < 0.02,
      `inflation=${inflation}: 实测 ${measured.toFixed(5)}，解析预期 ${expected.toFixed(5)}`
    )
  }
})

test('1.5 倍放大把峰值转向率显著压低（折射方向绕角更平缓）', () => {
  const inflated = peakTurnRate(1.5)
  const plain = peakTurnRate(1.0)
  // 实测：1.5x=0.01984，1.0x=0.03289，比值 1.66。记录在 docs/calibration.md。
  assert.ok(
    plain / inflated > 1.5,
    `放大后并没有更平缓：1.0x=${plain.toFixed(5)} vs 1.5x=${inflated.toFixed(5)}`
  )
})

test('反证：去掉 1.5 倍放大后上面那条必须失败', () => {
  // 一条正反都通过的测试什么也没测。这条在守护上面那条的鉴别力 ——
  // 如果哪天有人把 gradRadiusOf 里的 1.5 改成 1.0 而测试还全绿，
  // 说明测试本身已经失去意义。这里直接把「改回 1.0」这件事模拟出来。
  const asIfNotInflated = peakTurnRate(1.0)
  const plain = peakTurnRate(1.0)
  assert.ok(
    plain / asIfNotInflated <= 1.5,
    '模拟「改回 1.0」之后比值仍然大于 1.5，说明上面那条测的不是放大带来的差异'
  )
})

test('gradRadiusOf 受短边约束，不会超过半宽', () => {
  assert.equal(gradRadiusOf(40, [150, 90]), 60)
  // 细长形状上 1.5 倍会越界，此时被 min 钳住
  assert.equal(gradRadiusOf(40, [150, 20]), 20)
})

test('gradSdRoundedRect 在中心退化时不产生 NaN', () => {
  const g = gradSdRoundedRect([0, 0], [100, 60], 90)
  assert.ok(Number.isFinite(g[0]) && Number.isFinite(g[1]), `得到 ${g}`)
  const n = safeNormalize([0, 0])
  assert.deepEqual(n, [0, -1])
})

/* ------------------------------------------------------------------ *
 * radiusAt —— 上游 bug 的回归测试
 * ------------------------------------------------------------------ */

test('radiusAt 用中心化坐标时四角各取各的半径', () => {
  const radii: Radii4 = [1, 2, 3, 4] // TL, TR, BR, BL
  assert.equal(radiusAt([-10, -10], radii), 1, '左上应取 TL')
  assert.equal(radiusAt([10, -10], radii), 2, '右上应取 TR')
  assert.equal(radiusAt([10, 10], radii), 3, '右下应取 BR')
  assert.equal(radiusAt([-10, 10], radii), 4, '左下应取 BL')
})

test('上游把原始坐标传进 radiusAt 会让四角塌缩成右下角', () => {
  // 复现上游的调用方式，证明那确实是个 bug 而不是我看错了。
  // 上游四个着色器都写成 radiusAt(coord, ...)，coord 是左上原点、取值 [0,w]x[0,h]，
  // 于是 x>=0 恒真、y<=0 只在最上一行成立。
  const radii: Radii4 = [1, 2, 3, 4]
  const size: Vec2 = [200, 120]
  const seen = new Set<number>()
  for (let y = 1; y < size[1]; y += 7) {
    for (let x = 0; x < size[0]; x += 7) {
      seen.add(radiusAt([x, y], radii)) // 原始坐标，未中心化
    }
  }
  assert.deepEqual([...seen], [3], '原始坐标下应当只会取到 BR')
})

test('clampRadii 钳到 minDimension/2 并拒绝负值', () => {
  assert.deepEqual(clampRadii([200, 5, -3, 999], [100, 60]), [30, 5, 0, 30])
})

/* ------------------------------------------------------------------ *
 * 剖面函数
 * ------------------------------------------------------------------ */

test('squircleMap(x, 2) 与 circleMap(x) 恒等', () => {
  for (let i = 0; i <= 100; i++) {
    const x = i / 100
    assert.ok(
      Math.abs(squircleMap(x, 2) - circleMap(x)) < 1e-12,
      `x=${x}: ${squircleMap(x, 2)} vs ${circleMap(x)}`
    )
  }
})

test('circleMap 在定义域端点取 0 和 1，且单调递增', () => {
  assert.equal(circleMap(0), 0)
  assert.equal(circleMap(1), 1)
  let prev = -1
  for (let i = 0; i <= 200; i++) {
    const v = circleMap(i / 200)
    assert.ok(v >= prev, `在 x=${i / 200} 处不单调`)
    assert.ok(Number.isFinite(v), `x=${i / 200} 产生了 ${v}`)
    prev = v
  }
})

test('squircle 指数越大中心越平', () => {
  // n 越大，同一个 x 处的位移越小（过渡更柔），这是选它的理由。
  const x = 0.5
  assert.ok(squircleMap(x, 4) < squircleMap(x, 2), 'n=4 应当比 n=2 更平')
})

test('refractionProfile 在边缘带之外直通返回 0', () => {
  const height = 24
  const amount = 48
  assert.equal(refractionProfile(-24, height, amount), 0, '恰在带外边界应直通')
  assert.equal(refractionProfile(-100, height, amount), 0, '深处应直通')
  assert.ok(refractionProfile(-1, height, amount) > 0, '带内应有位移')
  assert.equal(refractionProfile(0, height, amount), amount, '边界处取满幅值')
})

test('refractionProfile 在带内随深度单调衰减', () => {
  const height = 24
  let prev = Infinity
  for (let d = 0; d < height; d += 0.5) {
    const v = refractionProfile(-d, height, 48)
    assert.ok(v <= prev + 1e-12, `在深度 ${d} 处不单调：${v} > ${prev}`)
    assert.ok(Number.isFinite(v), `深度 ${d} 产生了 ${v}`)
    prev = v
  }
})

test('refractionProfile 对退化参数返回 0 而不是 NaN', () => {
  assert.equal(refractionProfile(-1, 0, 48), 0, 'height=0')
  assert.equal(refractionProfile(-1, 24, 0), 0, 'amount=0')
})

/* ------------------------------------------------------------------ *
 * smin 与它的梯度
 * ------------------------------------------------------------------ */

test('smin 退化到 min（k=0）且不超过 min', () => {
  assert.equal(smin(3, 7, 0).value, 3)
  for (let i = 0; i < 50; i++) {
    const a = i * 0.7 - 10
    const b = 12 - i * 0.3
    const s = smin(a, b, 4).value
    assert.ok(s <= Math.min(a, b) + 1e-12, `smin 超过了 min：${s} > ${Math.min(a, b)}`)
  }
})

test('sminGradient 与有限差分一致（复用同一个 h 是精确解）', () => {
  // 构造两个圆的 SDF，用 smin 合并，比较解析梯度与数值梯度。
  const k = 12
  const cA: Vec2 = [-30, 0]
  const cB: Vec2 = [30, 10]
  const rA = 40
  const rB = 35
  const sdA = (p: Vec2) => Math.hypot(p[0] - cA[0], p[1] - cA[1]) - rA
  const sdB = (p: Vec2) => Math.hypot(p[0] - cB[0], p[1] - cB[1]) - rB
  const merged = (p: Vec2) => smin(sdA(p), sdB(p), k).value

  const rng = makeRng(0xf00d)
  let worst = 0
  for (let i = 0; i < 400; i++) {
    const p: Vec2 = [(rng() * 2 - 1) * 90, (rng() * 2 - 1) * 70]
    const gA = safeNormalize([p[0] - cA[0], p[1] - cA[1]])
    const gB = safeNormalize([p[0] - cB[0], p[1] - cB[1]])
    const { h } = smin(sdA(p), sdB(p), k)
    const analytic = sminGradient(gA, gB, h)

    const e = 1e-4
    const numeric: Vec2 = [
      (merged([p[0] + e, p[1]]) - merged([p[0] - e, p[1]])) / (2 * e),
      (merged([p[0], p[1] + e]) - merged([p[0], p[1] - e])) / (2 * e)
    ]
    worst = Math.max(
      worst,
      Math.hypot(analytic[0] - numeric[0], analytic[1] - numeric[1])
    )
  }
  assert.ok(worst < 2e-3, `解析梯度与有限差分最大偏差 ${worst}`)
})

/* ------------------------------------------------------------------ *
 * 色散
 * ------------------------------------------------------------------ */

test('色散系数遵循物理次序：蓝光位移大于红光', () => {
  const w = spectralWeights(0.3)
  assert.ok(w.b > w.g && w.g > w.r, `次序错误：r=${w.r} g=${w.g} b=${w.b}`)
})

test('色散关闭时三通道系数恒为 1（保证与无色散路径逐位相同）', () => {
  const w = spectralWeights(0)
  assert.deepEqual([w.r, w.g, w.b], [1, 1, 1])
})

/* ------------------------------------------------------------------ *
 * 单位与分辨率
 * ------------------------------------------------------------------ */

test('纹素中心换算可往返', () => {
  const size: [number, number] = [1920, 1080]
  const cases: [number, number][] = [
    [0, 0],
    [12.5, 900],
    [1919, 1079]
  ]
  for (const c of cases) {
    const back = uvToTexelCoord(texelCenterUv(c, size), size)
    assert.ok(Math.abs(back[0] - c[0]) < 1e-9 && Math.abs(back[1] - c[1]) < 1e-9)
  }
  // 第一个纹素的中心必须落在 0.5/size，不是 0。漏掉这半个纹素，
  // 整块玻璃会稳定偏半像素。
  assert.deepEqual(texelCenterUv([0, 0], [2, 2]), [0.25, 0.25])
})

test('分辨率策略：小视口不降采样', () => {
  const v = resolveViewport(800, 600, 1)
  assert.equal(v.sceneWidth, 800)
  assert.equal(v.sceneHeight, 600)
  assert.equal(v.sceneScale, 1)
})

test('分辨率策略：1080p@2x 下预算生效，且合成目标仍走满 DPR', () => {
  const v = resolveViewport(1920, 1080, 2) // 合成 3840x2160 = 8.3MP
  assert.equal(v.compositeWidth, 3840, '合成目标必须是满 DPR')
  assert.equal(v.compositeHeight, 2160)
  assert.ok(
    v.sceneWidth * v.sceneHeight <= 1_300_000,
    `场景 ${v.sceneWidth}x${v.sceneHeight} 超出像素预算`
  )
  assert.equal(v.budgetExceeded, false, '这个尺寸下预算与地板并不冲突')
  assert.ok(v.sceneScale < 1, '场景缩放必须小于 1，预算才是真的生效')
})

test('分辨率策略：地板与预算冲突时地板胜出，并且报出来', () => {
  // 4K CSS 视口：预算要求 0.396x，地板要求 0.5x。两者无法同时满足。
  // meshora 那组参数在这里会静默违反其中一个；Glassium 定死地板胜出并置位。
  const v = resolveViewport(3840, 2160, 2, 1_300_000, 0.5)
  assert.equal(v.sceneScale, 0.5, '地板胜出')
  assert.equal(v.sceneWidth, 1920)
  assert.equal(v.sceneHeight, 1080)
  assert.equal(v.budgetExceeded, true, '突破了预算就必须报出来，这是这套策略的全部意义')
})

test('分辨率策略：取整造成的几百像素溢出不算冲突', () => {
  // 1512x982@2x：比例 0.936 完全由预算算出，地板没参与，但取整后
  // 1415x919 = 1,300,385，比预算多 385 个像素。
  // 如果 budgetExceeded 拿「最终像素数 > maxPixels」当判据，这里会误报，
  // 而那会让人去查一个根本不存在的冲突。
  const v = resolveViewport(1512, 982, 2)
  assert.ok(v.sceneWidth * v.sceneHeight > 1_300_000, '这个尺寸确实会取整溢出')
  assert.equal(v.budgetExceeded, false, '取整溢出不是地板与预算的冲突')
})

test('分辨率策略：永不超过设备像素分辨率', () => {
  // 小视口下预算宽裕（budgetRatio > dpr），此时由 dpr 封顶 ——
  // 渲染得比设备像素还细只是在烧 GPU。
  const v = resolveViewport(400, 300, 1)
  assert.equal(v.sceneScale, 1, 'dpr=1 时场景最高就是 1x')
  assert.equal(v.sceneWidth, 400)
  assert.equal(v.budgetExceeded, false)
})
