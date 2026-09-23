import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GlassPresets,
  glass,
  lowerMaterial,
  parseTint,
  resolveCornerRadii,
  type GlassMaterial
} from './material.ts'
import {
  assertCanonicalOrder,
  resolveMargins,
  sampleMargin,
  type GlassEffect
} from './pipeline.ts'
import type { Vec2 } from './optics.ts'

/* ------------------------------------------------------------------ *
 * 采样余量
 * ------------------------------------------------------------------ */

test('lens 的采样余量为 0 —— 折射只向面板内部采样', () => {
  // 上游在 Lens.kt 里把 refractionAmount 取负后才传给着色器，SDF 梯度又指向外侧，
  // 所以采样点往里走，读到的永远是面板内部的像素。
  //
  // 这条测试曾经断言余量等于 amountDp，理由是「上游欠补 2 倍」。那是个没验证过的
  // 推断，和上面的采样方向矛盾，已撤回（docs/porting-notes.md）。
  const lens: GlassEffect = {
    kind: 'lens',
    heightDp: 20,
    amountDp: 40,
    squircle: 2,
    dispersion: 0,
    highlight: 0.6,
    depthEffect: 1
  }
  assert.equal(sampleMargin(lens), 0)
})

test('blur 的采样余量按 3σ 截断', () => {
  assert.equal(sampleMargin({ kind: 'blur', sigmaDp: 4 }), 12)
  assert.equal(sampleMargin({ kind: 'blur', sigmaDp: 8 }), 24)
  // 非整数要向上取整，向下取会差那么一两个像素，而那正好落在边缘上
  assert.equal(sampleMargin({ kind: 'blur', sigmaDp: 2.5 }), 8)
})

test('colorFilter 不需要采样余量', () => {
  assert.equal(sampleMargin({ kind: 'colorFilter', saturation: 1.4, tint: [1, 1, 1, 0.2] }), 0)
})

test('整条链的余量目前只来自模糊', () => {
  const effects: GlassEffect[] = [
    { kind: 'colorFilter', saturation: 1.4, tint: [1, 1, 1, 0.2] },
    { kind: 'blur', sigmaDp: 4 },
    {
      kind: 'lens',
      heightDp: 20,
      amountDp: 40,
      squircle: 2,
      dispersion: 0,
      highlight: 0.6,
      depthEffect: 1
    }
  ]
  // 0 + ceil(3×4) + 0。在当前的效果集合里累加和取最大值给出同一个数，
  // 「累加」这条规则要等出现第二个向外读取的效果才观察得到 —— 这里不假装测到了它。
  assert.equal(resolveMargins(effects), 12)
})

test('空链的边距为 0', () => {
  assert.equal(resolveMargins([]), 0)
})

/* ------------------------------------------------------------------ *
 * 顺序
 * ------------------------------------------------------------------ */

test('合法顺序及其子序列都通过', () => {
  const cf: GlassEffect = { kind: 'colorFilter', saturation: 1.2, tint: [1, 1, 1, 0.1] }
  const bl: GlassEffect = { kind: 'blur', sigmaDp: 4 }
  const ln: GlassEffect = {
    kind: 'lens', heightDp: 10, amountDp: 20,
    squircle: 2, dispersion: 0, highlight: 0.5, depthEffect: 1
  }
  assert.doesNotThrow(() => assertCanonicalOrder([cf, bl, ln]))
  assert.doesNotThrow(() => assertCanonicalOrder([bl, ln]))
  assert.doesNotThrow(() => assertCanonicalOrder([ln]))
  assert.doesNotThrow(() => assertCanonicalOrder([]))
})

test('顺序颠倒会抛，而不是默默出一个难看的结果', () => {
  const bl: GlassEffect = { kind: 'blur', sigmaDp: 4 }
  const ln: GlassEffect = {
    kind: 'lens', heightDp: 10, amountDp: 20,
    squircle: 2, dispersion: 0, highlight: 0.5, depthEffect: 1
  }
  // 先折射再模糊会把折射出来的边缘一起糊掉，那不是玻璃是毛玻璃贴纸。
  assert.throws(() => assertCanonicalOrder([ln, bl]), /效果顺序非法/)
})

/* ------------------------------------------------------------------ *
 * 降级：两条缩放规则
 * ------------------------------------------------------------------ */

test('lowerMaterial 复现上游的两条缩放规则（300x200 面板，手算值）', () => {
  // minDimension = 200
  //   heightDp = refraction × 200 × 0.5 = 0.2 × 100 = 20
  //   amountDp = distortion × 200       = 0.2 × 200 = 40
  const size: Vec2 = [300, 200]
  const chain = lowerMaterial({ refraction: 0.2, distortion: 0.2 }, size)
  const lens = chain.effects.find((e) => e.kind === 'lens')
  assert.ok(lens && lens.kind === 'lens', '应当产出 lens')
  assert.equal(lens.heightDp, 20)
  assert.equal(lens.amountDp, 40)
})

test('lowerMaterial 的完整算例（200x120，与文档中的例子一致）', () => {
  const size: Vec2 = [200, 120] // minDimension = 120
  const chain = lowerMaterial(
    {
      blur: 4,
      refraction: 0.4,
      distortion: 0.2,
      saturation: 1.4,
      tint: '#ffffff22',
      cornerRadius: '0.5frac'
    },
    size
  )

  assert.deepEqual(
    chain.effects.map((e) => e.kind),
    ['colorFilter', 'blur', 'lens'],
    '顺序恒为 colorFilter → blur → lens'
  )

  const [cf, bl, ln] = chain.effects
  assert.ok(cf?.kind === 'colorFilter' && bl?.kind === 'blur' && ln?.kind === 'lens')

  assert.equal(cf.saturation, 1.4)
  assert.ok(Math.abs(cf.tint[3] - 34 / 255) < 1e-12, '0x22 = 34 → 34/255')
  assert.equal(bl.sigmaDp, 4)
  assert.equal(ln.heightDp, 24, '0.4 × 120 × 0.5')
  assert.equal(ln.amountDp, 24, '0.2 × 120')
  assert.deepEqual(chain.cornerRadiiDp, [30, 30, 30, 30], '0.5 × 120 / 2')
  assert.equal(chain.paddingDp, 12, 'ceil(3×4)，折射不向外读取')
})

test('lowerMaterial 省略无操作的效果', () => {
  const size: Vec2 = [200, 120]

  const noColor = lowerMaterial({ saturation: 1, tint: 'rgba(0,0,0,0)' }, size)
  assert.ok(
    !noColor.effects.some((e) => e.kind === 'colorFilter'),
    '饱和度为 1 且 tint 全透明时不该有 colorFilter'
  )

  const noBlur = lowerMaterial({ blur: 0 }, size)
  assert.ok(!noBlur.effects.some((e) => e.kind === 'blur'), 'blur=0 时不该有 blur')

  const noLens = lowerMaterial({ refraction: 0, distortion: 0 }, size)
  assert.ok(!noLens.effects.some((e) => e.kind === 'lens'), '折射为 0 时不该有 lens')
  // 注意 blur 还在（默认 8），所以余量不是 0 —— 只有把模糊也关掉才为 0。
  assert.equal(noLens.paddingDp, 24, '只剩模糊时余量是 ceil(3×8)')
  const nothing = lowerMaterial({ refraction: 0, distortion: 0, blur: 0 }, size)
  assert.equal(nothing.paddingDp, 0, '没有折射也没有模糊就不需要余量')
})

test('lowerMaterial 产出的链顺序恒合法', () => {
  const size: Vec2 = [240, 160]
  for (const [name, preset] of Object.entries(GlassPresets)) {
    const chain = lowerMaterial(preset, size)
    assert.doesNotThrow(() => assertCanonicalOrder(chain.effects), `预设 ${name} 顺序非法`)
    assert.equal(chain.paddingDp, resolveMargins(chain.effects), `预设 ${name} 的 padding 不一致`)
  }
})

test('没有折射时圆角仍然在 —— 形状属于面板，不属于 lens', () => {
  // 曾经形状挂在 lens 效果上。refraction 为 0 时 lens 被省略，
  // 一块只有模糊的玻璃就连圆角都没了。
  const chain = lowerMaterial(
    { refraction: 0, distortion: 0, blur: 8, cornerRadius: 16 },
    [200, 120]
  )
  assert.ok(!chain.effects.some((e) => e.kind === 'lens'), '这块玻璃确实没有折射')
  assert.deepEqual(chain.cornerRadiiDp, [16, 16, 16, 16], '但圆角必须还在')
})

test('squircle 指数被钳到 ≥ 1（否则着色器里 1/n 发散出 NaN）', () => {
  const chain = lowerMaterial({ squircle: 0 }, [200, 120])
  const lens = chain.effects.find((e) => e.kind === 'lens')
  assert.ok(lens && lens.kind === 'lens')
  assert.equal(lens.squircle, 1)
})

test('opacity 被钳到 0–1', () => {
  const size: Vec2 = [100, 100]
  assert.equal(lowerMaterial({ opacity: 1.5 }, size).opacity, 1)
  assert.equal(lowerMaterial({ opacity: -0.2 }, size).opacity, 0)
  assert.equal(lowerMaterial({ opacity: 0.4 }, size).opacity, 0.4)
})

/* ------------------------------------------------------------------ *
 * 预设
 * ------------------------------------------------------------------ */

test('厚度梯度单调：越厚模糊越大、折射越强', () => {
  // Apple 的说法是玻璃变厚时「透镜与折射更明显、光的散射更柔」，
  // 所以 thick 不能只是模糊更大。
  const order = ['ultraThin', 'thin', 'regular', 'thick'] as const
  for (let i = 1; i < order.length; i++) {
    const prev = GlassPresets[order[i - 1]!]
    const cur = GlassPresets[order[i]!]
    assert.ok(cur.blur! > prev.blur!, `${order[i]} 的 blur 应大于 ${order[i - 1]}`)
    assert.ok(cur.refraction! > prev.refraction!, `${order[i]} 的 refraction 应大于 ${order[i - 1]}`)
  }
})

test('clear 预设不是「更淡的 regular」：不模糊但折射不减', () => {
  // Apple 的 Clear 变体没有自适应行为、更透，只该用在媒体内容上。
  assert.equal(GlassPresets.clear.blur, 0)
  assert.ok(GlassPresets.clear.distortion! >= GlassPresets.regular.distortion!)
  assert.equal(parseTint(GlassPresets.clear.tint!)[3], 0, 'clear 不该有叠加色')
  // Clear 变体没有自适应；其余预设用默认值（自适应）
  assert.equal(lowerMaterial(GlassPresets.clear, [200, 100]).adaptive, 0)
  assert.equal(lowerMaterial(GlassPresets.regular, [200, 100]).adaptive, 1)
})

test('glass() 覆盖预设字段', () => {
  const m: GlassMaterial = glass(GlassPresets.thick, { tint: '#0af3', blur: 2 })
  assert.equal(m.blur, 2, '覆盖生效')
  assert.equal(m.refraction, GlassPresets.thick.refraction, '未覆盖的字段保留')
  assert.equal(m.tint, '#0af3')
})

/* ------------------------------------------------------------------ *
 * tint 解析
 * ------------------------------------------------------------------ */

test('parseTint 支持 hex 的 3/4/6/8 位', () => {
  assert.deepEqual(parseTint('#fff'), [1, 1, 1, 1])
  assert.deepEqual(parseTint('#000f'), [0, 0, 0, 1])
  assert.deepEqual(parseTint('#ffffff'), [1, 1, 1, 1])
  const t = parseTint('#ffffff22')
  assert.deepEqual(t.slice(0, 3), [1, 1, 1])
  assert.ok(Math.abs(t[3] - 34 / 255) < 1e-12)
})

test('parseTint 支持 rgb() / rgba()，含百分数与斜杠写法', () => {
  assert.deepEqual(parseTint('rgb(255, 255, 255)'), [1, 1, 1, 1])
  assert.deepEqual(parseTint('rgba(0, 0, 0, 0.5)'), [0, 0, 0, 0.5])
  assert.deepEqual(parseTint('rgb(100% 0% 0% / 50%)'), [1, 0, 0, 0.5])
})

test('parseTint 对不支持的写法抛错，而不是静默当成黑色', () => {
  // 一块本该发白的玻璃默默变暗，会被当成光学 bug 查上半天。
  assert.throws(() => parseTint('white'), /无法解析 tint/)
  assert.throws(() => parseTint('hsl(200 50% 50%)'), /无法解析 tint/)
  assert.throws(() => parseTint('oklch(0.7 0.1 200)'), /无法解析 tint/)
  // 太短压根匹配不上 hex 的形状，走通用分支
  assert.throws(() => parseTint('#ff'), /无法解析 tint/)
  // 形状像 hex 但位数不对（5 位、7 位），走专门的位数报错 —— 这种最容易是手滑
  assert.throws(() => parseTint('#fffff'), /位数不合法/)
  assert.throws(() => parseTint('#fffffff'), /位数不合法/)
})

/* ------------------------------------------------------------------ *
 * 角半径
 * ------------------------------------------------------------------ */

test('resolveCornerRadii 三种写法', () => {
  const size: Vec2 = [200, 120]
  assert.deepEqual(resolveCornerRadii(16, size), [16, 16, 16, 16], '绝对 dp')
  assert.deepEqual(resolveCornerRadii('0.5frac', size), [30, 30, 30, 30], '0.5 × 120 / 2')
  assert.deepEqual(resolveCornerRadii('1frac', size), [60, 60, 60, 60], '胶囊形')
  assert.deepEqual(resolveCornerRadii([4, 8, 12, 16], size), [4, 8, 12, 16], '四角各自指定')
})

test('四角半径各不相同时能被完整保留（上游做不到这件事）', () => {
  // 上游给了四角半径这个参数，但由于 radiusAt 传的是左上原点的原始坐标，
  // 实际上四角会塌缩成右下角那一个。修掉之后这个参数才真的可用。
  const size: Vec2 = [300, 200]
  const chain = lowerMaterial({ cornerRadius: [4, 8, 12, 16] }, size)
  assert.deepEqual(chain.cornerRadiiDp, [4, 8, 12, 16])
  assert.equal(new Set(chain.cornerRadiiDp).size, 4, '四个值必须仍然互不相同')
})

test('resolveCornerRadii 钳到 minDimension/2', () => {
  const size: Vec2 = [200, 120]
  assert.deepEqual(resolveCornerRadii(999, size), [60, 60, 60, 60])
  assert.deepEqual(resolveCornerRadii('3frac', size), [60, 60, 60, 60])
})

test('adaptive 钳到 [0, 1]，没写时是 1', () => {
  assert.equal(lowerMaterial({}, [100, 100]).adaptive, 1)
  assert.equal(lowerMaterial({ adaptive: 0.4 }, [100, 100]).adaptive, 0.4)
  assert.equal(lowerMaterial({ adaptive: -1 }, [100, 100]).adaptive, 0)
  assert.equal(lowerMaterial({ adaptive: 3 }, [100, 100]).adaptive, 1)
})
