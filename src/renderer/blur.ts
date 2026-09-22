/**
 * 模糊金字塔。
 *
 * 一张带 mip 的纹理：
 *   mip 0      = 锐利的场景本身（场景 pass 直接画进这一级，不需要额外拷贝）
 *   mip 1..K-1 = 逐级减半、逐级更模糊
 *
 * 所以「锐利背景」和「各档模糊背景」是同一张纹理的不同级，玻璃着色器一个绑定全拿到。
 *
 * **每帧的模糊趟数只和 K 有关，与面板数量无关。** 这是共享链的全部意义：
 * 十块玻璃和一块玻璃的模糊开销一样。
 */

import type { ResolvedViewport } from '../core/units.ts'

/** 第 1 级的屏幕空间 σ（场景目标像素）。之后每级翻倍。 */
export const SIGMA_BASE = 2

/**
 * 最大级数。σ_k = 2·2^(k−1)，所以 K=6 覆盖到 σ=32 —— 正好是 GlassMaterial
 * 里 blur 的上限，和上游 playground 的 blurRadiusDp 范围（0–32）一致。
 */
export const MAX_LEVELS = 6

/** 各级的局部 σ（目标纹素）。推导见 blur.wgsl.ts 的注释。 */
const LOCAL_SIGMA = 0.866

/**
 * σ（场景像素）→ 模糊链的浮点 mip 级。
 *
 * 分两段：
 *
 *   σ ∈ [0, SIGMA_BASE]  级 = σ / SIGMA_BASE，**在 σ 上线性**
 *   σ > SIGMA_BASE       级 = 1 + log2(σ / SIGMA_BASE)，几何级数
 *
 * 低段必须单独处理。纯用对数的话，级 = 1 + log2(σ/2)，σ=1 会算出 0、σ=0.5 算出 −1，
 * 钳完都是级 0 —— 也就是说 **blur 从 0 到 1 全都渲染成完全锐利**，
 * 材质写了 blur:1 而实际没有任何模糊。量很小，但它是错的，而且是那种
 * 「参数调了没反应」的错，比明显的错更浪费时间。
 *
 * 两段在 σ = SIGMA_BASE 处接得上（都等于 1），所以整体连续、单调。
 * 低段是「锐利」与「σ=2」的线性混合，不是真高斯 —— 但那一段的绝对模糊量本来就
 * 小于一个像素，差异不可见。
 */
export function levelForSigma(sigmaScenePx: number, levels: number): number {
  if (!(sigmaScenePx > 0)) return 0
  const level =
    sigmaScenePx <= SIGMA_BASE
      ? sigmaScenePx / SIGMA_BASE
      : 1 + Math.log2(sigmaScenePx / SIGMA_BASE)
  return Math.min(Math.max(level, 0), levels - 1)
}

/** 某一级对应的屏幕 σ。校准与测试用。 */
export function sigmaForLevel(level: number): number {
  if (level <= 0) return 0
  return SIGMA_BASE * Math.pow(2, level - 1)
}

export interface BlurChainTextures {
  /** mip 0 是锐利场景，mip 1+ 是各档模糊。 */
  readonly chain: GPUTexture
  /** 整链视图，供采样。 */
  readonly chainView: GPUTextureView
  /** 场景 pass 的渲染目标（mip 0）。 */
  readonly sceneView: GPUTextureView
  readonly levels: number
  readonly width: number
  readonly height: number
}

export const BACKDROP_FORMAT: GPUTextureFormat = 'rgba8unorm'

interface LevelResources {
  readonly hBind: GPUBindGroup
  readonly vBind: GPUBindGroup
  readonly hView: GPUTextureView
  readonly vView: GPUTextureView
  readonly hUniform: GPUBuffer
  readonly vUniform: GPUBuffer
}

export class BlurChain {
  readonly #device: GPUDevice
  readonly #pipeline: GPURenderPipeline
  readonly #sampler: GPUSampler

  #textures: BlurChainTextures | null = null
  #scratch: GPUTexture | null = null
  #levels: LevelResources[] = []
  #allocations = 0
  #passesLastFrame = 0

  constructor(device: GPUDevice, pipeline: GPURenderPipeline, sampler: GPUSampler) {
    this.#device = device
    this.#pipeline = pipeline
    this.#sampler = sampler
  }

  get textures(): BlurChainTextures | null {
    return this.#textures
  }

  get allocations(): number {
    return this.#allocations
  }

  /** 上一帧实际跑了多少趟模糊。应当等于 2×(K−1)，且与面板数量无关。 */
  get passesLastFrame(): number {
    return this.#passesLastFrame
  }

  /** 按视口确保纹理与各级资源就绪。尺寸没变就复用。 */
  ensure(viewport: ResolvedViewport): BlurChainTextures {
    const width = viewport.sceneWidth
    const height = viewport.sceneHeight
    const existing = this.#textures
    if (existing && existing.width === width && existing.height === height) return existing

    this.#destroyTextures()

    // 级数受尺寸约束：最小的那一级至少要有 1 个像素。
    const maxBySize = Math.floor(Math.log2(Math.max(1, Math.min(width, height)))) + 1
    const levels = Math.max(1, Math.min(MAX_LEVELS, maxBySize))

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING

    const chain = this.#device.createTexture({
      label: 'glassium:backdrop-chain',
      size: { width, height },
      format: BACKDROP_FORMAT,
      mipLevelCount: levels,
      usage
    })
    const scratch = this.#device.createTexture({
      label: 'glassium:blur-scratch',
      size: { width, height },
      format: BACKDROP_FORMAT,
      mipLevelCount: levels,
      usage
    })

    this.#levels = []
    for (let k = 1; k < levels; k++) {
      const w = Math.max(1, width >> k)
      const h = Math.max(1, height >> k)

      // 水平与垂直**必须各有一个 uniform buffer**。
      // 共用一个是错的：writeBuffer 是排在队列上的，同一帧里给同一块 buffer 写两次，
      // 两趟 pass 读到的都会是后写的那个值，于是垂直趟会再做一次水平模糊 ——
      // 结果是横向糊两倍、纵向完全没糊，而它看起来只是「有点方向性的模糊」，
      // 很容易被当成核不对而不是绑定不对。
      const hUniform = this.#device.createBuffer({
        label: `glassium:blur-h-${k}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      const vUniform = this.#device.createBuffer({
        label: `glassium:blur-v-${k}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      // texelSize 与 σ 只取决于该级的尺寸，逐帧不变 —— 在这里写一次就够，
      // 不必每帧 writeBuffer。
      this.#device.queue.writeBuffer(hUniform, 0, new Float32Array([1 / w, 1 / h, LOCAL_SIGMA, 0]))
      this.#device.queue.writeBuffer(vUniform, 0, new Float32Array([1 / w, 1 / h, LOCAL_SIGMA, 1]))

      const srcView = chain.createView({ baseMipLevel: k - 1, mipLevelCount: 1 })
      const midView = scratch.createView({ baseMipLevel: k, mipLevelCount: 1 })
      const dstView = chain.createView({ baseMipLevel: k, mipLevelCount: 1 })

      this.#levels.push({
        hUniform,
        vUniform,
        hView: midView,
        vView: dstView,
        // 水平趟：读 chain 的 k−1 级（两倍分辨率），写 scratch 的 k 级。
        // 双线性采样顺带把降采样做掉，省一趟 pass。
        hBind: this.#device.createBindGroup({
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: hUniform } },
            { binding: 1, resource: this.#sampler },
            { binding: 2, resource: srcView }
          ]
        }),
        // 垂直趟：读 scratch 的 k 级，写 chain 的 k 级。
        // 两趟读写的都是不同纹理，所以同一个 pass 里不存在同资源读写冲突。
        vBind: this.#device.createBindGroup({
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: vUniform } },
            { binding: 1, resource: this.#sampler },
            { binding: 2, resource: midView }
          ]
        })
      })
    }

    this.#scratch = scratch
    this.#allocations++
    this.#textures = {
      chain,
      chainView: chain.createView(),
      sceneView: chain.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
      levels,
      width,
      height
    }
    return this.#textures
  }

  /**
   * 建链。必须在场景已经画进 mip 0 之后调用。
   *
   * 每级两趟，共 2×(K−1) 趟。每级的像素数是上一级的 1/4，所以整条链的总开销
   * 约等于第 1 级的 4/3，而第 1 级只有场景的 1/4 —— 合计约场景的 1/3。
   */
  build(encoder: GPUCommandEncoder): void {
    const textures = this.#textures
    if (!textures) return

    let passes = 0
    for (const level of this.#levels) {
      for (const [label, view, bind] of [
        ['h', level.hView, level.hBind],
        ['v', level.vView, level.vBind]
      ] as const) {
        const pass = encoder.beginRenderPass({
          label: `glassium:blur-${label}`,
          colorAttachments: [
            {
              view,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store'
            }
          ]
        })
        pass.setPipeline(this.#pipeline)
        pass.setBindGroup(0, bind)
        pass.draw(3)
        pass.end()
        passes++
      }
    }
    this.#passesLastFrame = passes
  }

  #destroyTextures(): void {
    for (const level of this.#levels) {
      level.hUniform.destroy()
      level.vUniform.destroy()
    }
    this.#levels = []
    this.#textures?.chain.destroy()
    this.#scratch?.destroy()
    this.#textures = null
    this.#scratch = null
  }

  destroy(): void {
    this.#destroyTextures()
  }
}
