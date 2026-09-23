/**
 * 生成 spec/conformance/*.json —— 与语言无关的数值向量。
 *
 * 这些向量是 spec/ 作为「平台中立契约」的实际载体：将来的 Android / iOS 渲染器
 * 不读这里的 TypeScript，读这份 JSON，然后断言自己的实现落在同样的数上。
 * 没有它，「一份规格，多个渲染器」就只是文档里的一句话。
 *
 * 数值一律以字符串形式的十进制写出到 17 位有效数字（JS 的 Number.prototype.toString
 * 已经是最短可往返表示），避免不同语言的 JSON 解析器在末位上分歧。
 *
 * 用法：node scripts/gen-conformance.ts
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  channelSampleOffsets,
  circleMap,
  clampRadii,
  gradRadiusOf,
  gradSdRoundedRect,
  highlightTerms,
  radiusAt,
  refractionProfile,
  rimMask,
  sdRoundedRect,
  smin,
  sminGradient,
  spectralWeights,
  squircleMap,
  safeNormalize,
  type Radii4,
  type Vec2
} from '../src/core/optics.ts'
import { evalMergedOptics, type MemberGeometry } from '../src/core/merge.ts'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'conformance')

/** 确定性伪随机，和测试里用的是同一个 —— 向量必须可复现。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
}

interface Case {
  readonly input: Record<string, unknown>
  readonly expect: Record<string, unknown>
}

function buildSdfCases(): Case[] {
  const rng = makeRng(0x5eed)
  const halfSize: Vec2 = [150, 90]
  const cases: Case[] = []
  for (let i = 0; i < 64; i++) {
    const p: Vec2 = [
      Math.round((rng() * 2 - 1) * 200 * 100) / 100,
      Math.round((rng() * 2 - 1) * 140 * 100) / 100
    ]
    const radius = Math.round(rng() * 90 * 100) / 100
    const gradRadius = gradRadiusOf(radius, halfSize)
    cases.push({
      input: { p, halfSize, radius, gradRadius },
      expect: {
        sd: sdRoundedRect(p, halfSize, radius),
        grad: gradSdRoundedRect(p, halfSize, gradRadius),
        gradNormalized: safeNormalize(gradSdRoundedRect(p, halfSize, gradRadius))
      }
    })
  }
  return cases
}

function buildProfileCases(): Case[] {
  const cases: Case[] = []
  const heightPx = 24
  const amountPx = 48
  for (let i = 0; i <= 32; i++) {
    const sd = -(i / 32) * 32 // 覆盖带内与带外
    for (const n of [2, 4]) {
      cases.push({
        input: { sd, heightPx, amountPx, squircleExponent: n },
        expect: { displacement: refractionProfile(sd, heightPx, amountPx, n) }
      })
    }
  }
  for (let i = 0; i <= 20; i++) {
    const x = i / 20
    cases.push({
      input: { x },
      expect: { circleMap: circleMap(x), squircle2: squircleMap(x, 2), squircle4: squircleMap(x, 4) }
    })
  }
  return cases
}

function buildRadiiCases(): Case[] {
  const radii: Radii4 = [8, 16, 24, 32]
  const size: Vec2 = [200, 120]
  const cases: Case[] = []
  for (const p of [
    [-50, -30],
    [50, -30],
    [50, 30],
    [-50, 30],
    [0, 0]
  ] as Vec2[]) {
    cases.push({
      input: { centered: p, radii },
      // 注意：入参是**中心化坐标**。上游传的是左上原点的原始坐标，
      // 那会让四角塌缩成 BR，详见 docs/porting-notes.md。
      expect: { radius: radiusAt(p, radii) }
    })
  }
  cases.push({
    input: { radii: [200, 5, -3, 999], size },
    expect: { clamped: clampRadii([200, 5, -3, 999], size) }
  })
  return cases
}

function buildMergeCases(): Case[] {
  const cases: Case[] = []
  const k = 12
  for (let i = 0; i <= 16; i++) {
    const a = -20 + i * 2.5
    const b = 10 - i * 1.5
    const { value, h } = smin(a, b, k)
    cases.push({
      input: { a, b, k },
      expect: { value, h, gradient: sminGradient([1, 0], [0, 1], h) }
    })
  }
  return cases
}

function buildLightingCases(): Case[] {
  const cases: Case[] = []
  const light: Vec2 = [-Math.SQRT1_2, -Math.SQRT1_2]
  for (let deg = 0; deg < 360; deg += 30) {
    const a = (deg * Math.PI) / 180
    const n: Vec2 = [Math.cos(a), Math.sin(a)]
    for (const gloss of [1, 2]) {
      cases.push({ input: { n, lightDir: light, gloss }, expect: highlightTerms(n, light, gloss) })
    }
  }
  for (const sd of [0.5, 0, -0.3, -1, -1.5, -2.25, -4]) {
    cases.push({ input: { sd, rimPx: 2.25 }, expect: { rimMask: rimMask(sd, 2.25) } })
  }
  return cases
}

function buildChannelOffsetCases(): Case[] {
  const cases: Case[] = []
  for (const k of [0, 0.25, 0.5]) {
    for (const dir of [[1, 0], [0, -1], [Math.SQRT1_2, Math.SQRT1_2]] as Vec2[]) {
      const off = channelSampleOffsets(dir, 20, k)
      cases.push({ input: { dir, displacement: 20, k }, expect: off })
    }
  }
  return cases
}

/**
 * 多块玻璃合并（`<glass-container>`）。覆盖折叠的全部规则：成员顺序、h 为 0 或 1 时
 * 原样取最近成员（blended = false）、颈部方向相对时位移按一致度衰减、k = 0 的硬并集。
 */
function buildMergedGroupCases(): Case[] {
  const capsule = (x: number, y: number, w: number, h: number): MemberGeometry => ({
    rect: [x, y, w, h],
    radii: [h / 2, h / 2, h / 2, h / 2],
    heightPx: 12,
    amountPx: 18,
    squircle: 2,
    depthEffect: 1
  })
  const pair = [capsule(0, 0, 100, 50), capsule(110, 0, 100, 50)]
  const triple = [
    capsule(0, 0, 100, 50),
    { ...capsule(106, 0, 80, 50), heightPx: 9, amountPx: 22, squircle: 3, depthEffect: 0.5 },
    { ...capsule(40, 58, 90, 40), radii: [6, 18, 12, 20] as const }
  ]
  const configs: { members: MemberGeometry[]; k: number; points: Vec2[] }[] = [
    { members: pair, k: 0, points: [[105, 25], [98.5, 12.5], [50.5, 25.5]] },
    { members: pair, k: 16, points: [[105, 25], [101.5, 20.5], [96.5, 8.5], [50.5, 3.5]] },
    {
      members: pair,
      k: 24,
      points: [[105, 25], [105, 12], [103.5, 30.5], [96.5, 8.5], [92.5, 9.5], [5.5, 25.5], [150.5, 1.5]]
    },
    {
      members: triple,
      k: 20,
      points: [[103, 25], [95.5, 52.5], [60.5, 54.5], [120.5, 56.5], [150.5, 3.5], [20.5, 30.5]]
    }
  ]
  const cases: Case[] = []
  for (const { members, k, points } of configs) {
    for (const px of points) {
      const m = evalMergedOptics(px, members, k)
      cases.push({
        input: { px, k, members },
        expect: {
          sd: m.sd,
          dir: m.dir,
          normal: m.normal,
          displacement: m.displacement,
          blended: m.blended
        }
      })
    }
  }
  return cases
}

function buildDispersionCases(): Case[] {
  return [0, 0.25, 0.5, 1].map((k) => ({
    input: { k },
    expect: { weights: spectralWeights(k) }
  }))
}

const doc = {
  $comment:
    '由 scripts/gen-conformance.ts 生成，请勿手改。这是 Glassium 光学的平台中立契约：' +
    '任何新渲染器（Android/iOS/…）都应当对这些输入产出同样的输出。容差建议 1e-6。',
  generator: 'scripts/gen-conformance.ts',
  toleranceHint: 1e-6,
  groups: {
    signedDistanceAndGradient: buildSdfCases(),
    refractionProfile: buildProfileCases(),
    cornerRadii: buildRadiiCases(),
    smoothMerge: buildMergeCases(),
    mergedGroup: buildMergedGroupCases(),
    dispersion: buildDispersionCases(),
    lighting: buildLightingCases(),
    channelOffsets: buildChannelOffsetCases()
  }
}

const path = join(OUT_DIR, 'optics.json')
writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8')

const total = Object.values(doc.groups).reduce((n, g) => n + g.length, 0)
console.log(`写入 ${path}`)
console.log(`共 ${total} 条向量，分 ${Object.keys(doc.groups).length} 组`)
