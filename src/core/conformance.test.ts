import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  channelSampleOffsets,
  circleMap,
  clampRadii,
  gradSdRoundedRect,
  bodyLight,
  magnifyFactor,
  rimLight,
  radiusAt,
  refractionProfile,
  rimMask,
  safeNormalize,
  sdRoundedRect,
  smin,
  sminGradient,
  spectralWeights,
  squircleMap,
  type Radii4,
  type Vec2
} from './optics.ts'
import { evalMergedOptics, type MemberGeometry } from './merge.ts'

/**
 * 消费 spec/conformance/optics.json。
 *
 * 这个文件有两个作用，第二个更重要：
 *
 * 1. 守护签入的向量不与实现漂移 —— 改了光学却没跑 gen:conformance 会在这里红。
 * 2. **它是「未来的 Android / iOS 渲染器该怎么用 spec/」的可运行范例。**
 *    那些渲染器不读 TypeScript，读这份 JSON。这里的读法就是它们该抄的读法。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const VECTORS = join(HERE, '..', '..', 'spec', 'conformance', 'optics.json')

interface Case {
  input: Record<string, number | number[] | Radii4>
  expect: Record<string, unknown>
}
interface Doc {
  toleranceHint: number
  groups: Record<string, Case[]>
}

const doc = JSON.parse(readFileSync(VECTORS, 'utf8')) as Doc
const TOL = doc.toleranceHint

function close(a: number, b: number, what: string): void {
  assert.ok(
    Math.abs(a - b) <= TOL,
    `${what}: 实得 ${a}，向量为 ${b}，差 ${Math.abs(a - b)} 超过容差 ${TOL}`
  )
}

function closeVec(a: Vec2 | number[], b: number[], what: string): void {
  close(a[0] as number, b[0] as number, `${what}.x`)
  close(a[1] as number, b[1] as number, `${what}.y`)
}

test('符合性向量：有符号距离与梯度', () => {
  const cases = doc.groups.signedDistanceAndGradient
  assert.ok(cases && cases.length > 0, '向量组为空 —— 是不是忘了跑 gen:conformance')
  for (const [i, c] of cases.entries()) {
    const p = c.input.p as unknown as Vec2
    const halfSize = c.input.halfSize as unknown as Vec2
    const radius = c.input.radius as number
    const gradRadius = c.input.gradRadius as number
    close(sdRoundedRect(p, halfSize, radius), c.expect.sd as number, `#${i} sd`)
    closeVec(
      gradSdRoundedRect(p, halfSize, gradRadius),
      c.expect.grad as number[],
      `#${i} grad`
    )
    closeVec(
      safeNormalize(gradSdRoundedRect(p, halfSize, gradRadius)),
      c.expect.gradNormalized as number[],
      `#${i} gradNormalized`
    )
  }
})

test('符合性向量：折射剖面', () => {
  for (const [i, c] of doc.groups.refractionProfile!.entries()) {
    if ('displacement' in c.expect) {
      const got = refractionProfile(
        c.input.sd as number,
        c.input.heightPx as number,
        c.input.amountPx as number,
        c.input.squircleExponent as number
      )
      close(got, c.expect.displacement as number, `#${i} displacement`)
    } else {
      const x = c.input.x as number
      close(circleMap(x), c.expect.circleMap as number, `#${i} circleMap`)
      close(squircleMap(x, 2), c.expect.squircle2 as number, `#${i} squircle2`)
      close(squircleMap(x, 4), c.expect.squircle4 as number, `#${i} squircle4`)
    }
  }
})

test('符合性向量：角半径选取与钳制', () => {
  for (const [i, c] of doc.groups.cornerRadii!.entries()) {
    if ('radius' in c.expect) {
      const got = radiusAt(c.input.centered as unknown as Vec2, c.input.radii as Radii4)
      close(got, c.expect.radius as number, `#${i} radiusAt`)
    } else {
      const got = clampRadii(c.input.radii as Radii4, c.input.size as unknown as Vec2)
      assert.deepEqual(got, c.expect.clamped, `#${i} clampRadii`)
    }
  }
})

test('符合性向量：平滑合并', () => {
  for (const [i, c] of doc.groups.smoothMerge!.entries()) {
    const { value, h } = smin(c.input.a as number, c.input.b as number, c.input.k as number)
    close(value, c.expect.value as number, `#${i} smin.value`)
    close(h, c.expect.h as number, `#${i} smin.h`)
    closeVec(sminGradient([1, 0], [0, 1], h), c.expect.gradient as number[], `#${i} gradient`)
  }
})

test('符合性向量：色散', () => {
  for (const [i, c] of doc.groups.dispersion!.entries()) {
    const got = spectralWeights(c.input.k as number)
    const want = c.expect.weights as { r: number; g: number; b: number }
    close(got.r, want.r, `#${i} r`)
    close(got.g, want.g, `#${i} g`)
    close(got.b, want.b, `#${i} b`)
  }
})

test('符合性向量：亮边、边缘带、体光与放大', () => {
  const cases = doc.groups.lighting
  assert.ok(cases && cases.length > 0, '向量组为空 —— 是不是忘了跑 gen:conformance')
  for (const [i, c] of cases.entries()) {
    if ('rimMask' in c.expect) {
      close(rimMask(c.input.sd as number, c.input.rimPx as number), c.expect.rimMask as number, `#${i} rimMask`)
    } else if ('body' in c.expect) {
      close(bodyLight(c.input.t as number, c.input.shade as number, c.input.light as number), c.expect.body as number, `#${i} body`)
    } else if ('factor' in c.expect) {
      close(magnifyFactor(c.input.magnify as number), c.expect.factor as number, `#${i} magnify`)
    } else {
      const got = rimLight(
        c.input.n as unknown as Vec2,
        c.input.lightDir as unknown as Vec2,
        c.input.base as number,
        c.input.gloss as number
      )
      close(got, c.expect.rim as number, `#${i} rim`)
    }
  }
})

test('符合性向量：色散的逐通道偏移', () => {
  const cases = doc.groups.channelOffsets
  assert.ok(cases && cases.length > 0, '向量组为空 —— 是不是忘了跑 gen:conformance')
  for (const [i, c] of cases.entries()) {
    const got = channelSampleOffsets(
      c.input.dir as unknown as Vec2,
      c.input.displacement as number,
      c.input.k as number
    )
    const want = c.expect as { r: number[]; g: number[]; b: number[] }
    closeVec(got.r, want.r, `#${i} r`)
    closeVec(got.g, want.g, `#${i} g`)
    closeVec(got.b, want.b, `#${i} b`)
  }
})

test('符合性向量：多块玻璃合并', () => {
  const cases = doc.groups.mergedGroup
  assert.ok(cases && cases.length > 0, '向量里缺 mergedGroup 组')
  let blendedCount = 0
  for (const [i, c] of cases.entries()) {
    const input = c.input as unknown as { px: Vec2; k: number; members: MemberGeometry[] }
    const m = evalMergedOptics(input.px, input.members, input.k)
    close(m.sd, c.expect.sd as number, `#${i} sd`)
    closeVec(m.dir, c.expect.dir as number[], `#${i} dir`)
    closeVec(m.normal, c.expect.normal as number[], `#${i} normal`)
    close(m.displacement, c.expect.displacement as number, `#${i} displacement`)
    assert.equal(m.blended, c.expect.blended, `#${i} blended`)
    if (m.blended) blendedCount++
  }
  // 向量必须同时覆盖「混合了」与「没混合」两种像素，否则 blended 开关没被契约钉住
  assert.ok(blendedCount > 0 && blendedCount < cases.length)
})
