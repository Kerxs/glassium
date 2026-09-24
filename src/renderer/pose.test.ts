import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decompose,
  IDENTITY,
  linearOfRotate,
  linearOfScale,
  linearOfTransform,
  multiply,
  poseOf,
  type PoseStyle
} from './pose.ts'

const style = (over: Partial<PoseStyle> = {}): PoseStyle => ({ transform: 'none', rotate: 'none', scale: 'none', ...over })
const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps
const deg = (d: number): number => (d * Math.PI) / 180
const cssMatrix = (theta: number, sx = 1, sy = 1): string => {
  // CSS 的 rotate(θ) scale(sx, sy)：先缩放再旋转
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return `matrix(${c * sx}, ${s * sx}, ${-s * sy}, ${c * sy}, 10, 20)`
}

test('transform 的计算值：none、matrix、只含 2D 的 matrix3d；透视与 3D 旋转收不下', () => {
  assert.deepEqual(linearOfTransform('none'), IDENTITY)
  assert.deepEqual(linearOfTransform('matrix(2, 0, 0, 3, 5, 6)'), { a: 2, b: 0, c: 0, d: 3 })
  const flat3d = [2, 0.5, 0, 0, -0.5, 2, 0, 0, 0, 0, 1, 0, 7, 8, 0, 1]
  assert.deepEqual(linearOfTransform(`matrix3d(${flat3d.join(', ')})`), { a: 2, b: 0.5, c: -0.5, d: 2 })
  const perspective = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -0.002, 0, 0, 0, 1]
  assert.equal(linearOfTransform(`matrix3d(${perspective.join(', ')})`), null)
  const rotateX = [1, 0, 0, 0, 0, 0.7, 0.7, 0, 0, -0.7, 0.7, 0, 0, 0, 0, 1]
  assert.equal(linearOfTransform(`matrix3d(${rotateX.join(', ')})`), null)
  assert.equal(linearOfTransform('rotate(45deg)'), null, '计算值不会是这种写法，看不懂就不收')
})

test('rotate 与 scale 独立属性', () => {
  const r = linearOfRotate('90deg')!
  assert.ok(close(r.a, 0) && close(r.b, 1) && close(r.c, -1) && close(r.d, 0))
  assert.ok(close(linearOfRotate('0.25turn')!.b, 1), 'turn 单位')
  assert.ok(close(linearOfRotate('z 90deg')!.b, 1), '绕 z 轴的写法')
  assert.ok(close(linearOfRotate('0 0 -1 90deg')!.b, -1), '反向的 z 轴等于反向旋转')
  assert.equal(linearOfRotate('x 45deg'), null, '绕 x 轴是 3D')
  assert.deepEqual(linearOfRotate('none'), IDENTITY)
  assert.deepEqual(linearOfScale('2'), { a: 2, b: 0, c: 0, d: 2 })
  assert.deepEqual(linearOfScale('2 3'), { a: 2, b: 0, c: 0, d: 3 })
  assert.deepEqual(linearOfScale('50%'), { a: 0.5, b: 0, c: 0, d: 0.5 })
})

test('拆解：旋转与缩放拆得回来，倾斜与带旋转的镜像拆不了', () => {
  const p = decompose(linearOfTransform(cssMatrix(deg(30), 2, 0.5))!)
  assert.ok(p.supported)
  assert.ok(close(p.angle, deg(30)) && close(p.scaleX, 2) && close(p.scaleY, 0.5))
  assert.equal(decompose({ a: 1, b: 0, c: 0.5, d: 1 }).supported, false, '倾斜')
  const flip = decompose({ a: -1, b: 0, c: 0, d: 1 })
  assert.ok(flip.supported && flip.angle === 0 && flip.scaleX === 1, '不带旋转的镜像：还是那个矩形')
  const rotatedFlip = multiply(linearOfTransform(cssMatrix(deg(30)))!, { a: -1, b: 0, c: 0, d: 1 })
  assert.equal(decompose(rotatedFlip).supported, false, '带旋转的镜像')
})

test('沿祖先链合成：外层在左；自己的 rotate · scale · transform 按 CSS 的顺序', () => {
  // 祖先转 20°，自己转 25°（用 rotate 属性）并缩放 0.5：合起来 45°、缩放 0.5
  const pose = poseOf([style({ rotate: '25deg', scale: '0.5' }), style({ transform: cssMatrix(deg(20)) })])
  assert.ok(pose.supported)
  assert.ok(close(pose.angle, deg(45)) && close(pose.scaleX, 0.5) && close(pose.scaleY, 0.5))
  // 没有任何变换：角度 0、缩放 1
  const none = poseOf([style(), style()])
  assert.ok(none.supported && none.angle === 0 && none.scaleX === 1 && none.scaleY === 1)
  // 非均匀缩放在旋转之后（在外层）：旋转过的矩形被斜着拉伸，成了平行四边形
  const sheared = poseOf([style({ transform: cssMatrix(deg(30)) }), style({ scale: '2 1' })])
  assert.equal(sheared.supported, false)
  // 任何一环看不懂：整条链都当画不了
  assert.equal(poseOf([style(), style({ rotate: 'x 30deg' })]).supported, false)
})
