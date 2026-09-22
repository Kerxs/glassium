/**
 * 渲染目标的分配与重建。
 *
 * 只在尺寸真的变了的时候重建。resize 期间每帧重建纹理会把 GPU 内存打满，
 * 而且 WebGPU 的纹理销毁是异步的，看起来像内存泄漏。
 */

import type { ResolvedViewport } from '../core/units.ts'

export interface SceneTarget {
  readonly texture: GPUTexture
  readonly view: GPUTextureView
  readonly width: number
  readonly height: number
}

/**
 * 场景目标的格式。
 *
 * 用 rgba8unorm 而不是 rgba16float：第一期在 sRGB 编码空间混合（见
 * docs/limitations.md），半浮点带来的精度在这里用不上，而它的带宽是两倍 ——
 * 在一个每帧要被玻璃着色器多次采样的目标上，带宽比精度值钱。
 *
 * 线性空间混合（T13+）落地时这里要换成 rgba16float，那时候精度才有意义。
 */
export const SCENE_FORMAT: GPUTextureFormat = 'rgba8unorm'

export class TargetPool {
  readonly #device: GPUDevice
  #scene: SceneTarget | null = null
  #allocations = 0

  constructor(device: GPUDevice) {
    this.#device = device
  }

  /** 已经分配过多少次。稳定状态下它应当不再增长 —— 增长说明有东西在抖动尺寸。 */
  get allocations(): number {
    return this.#allocations
  }

  get scene(): SceneTarget | null {
    return this.#scene
  }

  /** 按解析后的视口确保场景目标存在且尺寸正确。尺寸没变就直接复用。 */
  ensure(viewport: ResolvedViewport): SceneTarget {
    const { sceneWidth, sceneHeight } = viewport
    const existing = this.#scene
    if (existing && existing.width === sceneWidth && existing.height === sceneHeight) {
      return existing
    }

    existing?.texture.destroy()

    const texture = this.#device.createTexture({
      label: 'glassium:scene',
      size: { width: sceneWidth, height: sceneHeight },
      format: SCENE_FORMAT,
      // RENDER_ATTACHMENT 是写，TEXTURE_BINDING 是读。默认只有前者，
      // 漏掉后者的话呈现那一步会在 createBindGroup 时报验证错误。
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    })

    this.#allocations++
    this.#scene = {
      texture,
      view: texture.createView(),
      width: sceneWidth,
      height: sceneHeight
    }
    return this.#scene
  }

  destroy(): void {
    this.#scene?.texture.destroy()
    this.#scene = null
  }
}
