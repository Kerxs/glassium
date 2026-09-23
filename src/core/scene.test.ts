import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sceneBitmapSize, sceneCssBackground, sceneUvTransform, type SceneFit } from './scene.ts'

const apply = (t: ReturnType<typeof sceneUvTransform>, u: number, v: number): [number, number] => [
  u * t.scale[0] + t.offset[0],
  v * t.scale[1] + t.offset[1]
]
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-12

test('fill：原样映射', () => {
  const t = sceneUvTransform(800, 600, 1000, 1000, 'fill')
  assert.deepEqual(apply(t, 0, 0), [0, 0])
  assert.deepEqual(apply(t, 1, 1), [1, 1])
})

test('cover：视口比图片宽时，横向铺满、纵向裁掉上下', () => {
  // 视口 2:1，图片 1:1 → 图片放大到视口宽，只看得到中间一半高
  const t = sceneUvTransform(1000, 500, 400, 400, 'cover')
  const [x0, y0] = apply(t, 0, 0)
  const [x1, y1] = apply(t, 1, 1)
  assert.ok(close(x0, 0) && close(x1, 1), '横向正好铺满')
  assert.ok(close(y0, 0.25) && close(y1, 0.75), '纵向只取中间一半')
})

test('cover：视口比图片窄时，纵向铺满、横向裁掉两边', () => {
  const t = sceneUvTransform(500, 1000, 400, 400, 'cover')
  const [x0, y0] = apply(t, 0, 0)
  const [x1, y1] = apply(t, 1, 1)
  assert.ok(close(y0, 0) && close(y1, 1))
  assert.ok(close(x0, 0.25) && close(x1, 0.75))
})

test('contain：装得下，空出来的部分落在 [0, 1] 之外', () => {
  const t = sceneUvTransform(1000, 500, 400, 400, 'contain')
  const [x0, y0] = apply(t, 0, 0)
  const [x1, y1] = apply(t, 1, 1)
  assert.ok(close(y0, 0) && close(y1, 1), '纵向正好装满')
  assert.ok(close(x0, -0.5) && close(x1, 1.5), '横向两边各空出半个图宽')
})

test('中心是不动点，比例保持', () => {
  for (const fit of ['cover', 'contain'] as SceneFit[]) {
    for (const [tw, th, iw, ih] of [[1280, 720, 3000, 2000], [390, 844, 1920, 1080], [800, 800, 640, 480]]) {
      const t = sceneUvTransform(tw!, th!, iw!, ih!, fit)
      const [cx, cy] = apply(t, 0.5, 0.5)
      assert.ok(close(cx, 0.5) && close(cy, 0.5), `${fit} 中心不动`)
      // 视口里一段长度在图片里占多少像素：两个方向的像素比例相同 = 不变形
      const pxPerScreenX = (t.scale[0] * iw!) / tw!
      const pxPerScreenY = (t.scale[1] * ih!) / th!
      assert.ok(Math.abs(pxPerScreenX - pxPerScreenY) < 1e-9, `${fit} 不变形`)
    }
  }
})

test('预缩放尺寸：视口里用得到多少像素就缩到多少，不放大', () => {
  // 4000×3000 的照片铺 1000×500 的视口：cover 缩到 1000×750（纵向裁掉），contain 缩到 667×500
  assert.deepEqual(sceneBitmapSize(1000, 500, 4000, 3000, 'cover'), [1000, 750])
  assert.deepEqual(sceneBitmapSize(1000, 500, 4000, 3000, 'contain'), [667, 500])
  assert.deepEqual(sceneBitmapSize(1000, 500, 4000, 3000, 'fill'), [1000, 500])
  // 图片比视口小：保持原样
  assert.deepEqual(sceneBitmapSize(1000, 500, 300, 200, 'cover'), [300, 200])
})

test('CSS 兜底：铺法对应 background-size，URL 里的引号与反斜杠被转义', () => {
  assert.equal(sceneCssBackground('/a.jpg', 'cover', '#000'), '#000 url("/a.jpg") center / cover no-repeat')
  assert.equal(sceneCssBackground('/a.jpg', 'fill', 'red'), 'red url("/a.jpg") center / 100% 100% no-repeat')
  assert.equal(
    sceneCssBackground('/x"y\\z.png', 'contain', '#fff'),
    '#fff url("/x\\"y\\\\z.png") center / contain no-repeat'
  )
})
