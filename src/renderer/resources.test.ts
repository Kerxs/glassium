import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatBytes, textureBytes, usage } from './resources.ts'

test('纹理字节数：各级尺寸向下取整、至少 1；mip 链接近原图的 4/3', () => {
  assert.equal(textureBytes(100, 50), 100 * 50 * 4)
  assert.equal(textureBytes(4, 4, 4, 3), (16 + 4 + 1) * 4)
  assert.equal(textureBytes(5, 1, 4, 3), (5 + 2 + 1) * 4, '窄的那一边到 1 就不再缩')
  const full = textureBytes(1024, 1024, 4, 11)
  assert.ok(Math.abs(full / (1024 * 1024 * 4) - 4 / 3) < 0.01)
  assert.equal(textureBytes(64, 64, 16), 64 * 64 * 16, 'rgba32float')
})

test('资源账：合计、纹理数；没分配（0、null）的不列', () => {
  const u = usage({ chain: 400, scratch: 400, atlas: 0, layerBackup: null, canvas: 200 })
  assert.equal(u.bytes, 1000)
  assert.equal(u.textures, 3)
  assert.deepEqual(Object.keys(u.items), ['chain', 'scratch', 'canvas'])
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(3.5 * 1024 * 1024), '3.5 MB')
})
