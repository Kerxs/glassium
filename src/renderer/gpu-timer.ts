/**
 * GPU 计时（WebGPU 的 timestamp-query）：一帧的 GPU 时间与各段的分账，给自适应质量与调试面板。
 *
 * - 一帧里按顺序打几个时间戳（`mark`）：开头、场景画完、模糊链建完、上屏（背景 + 第 0 层的玻璃）画完、结尾。
 *   每个时间戳是一个空的 compute pass 的 beginningOfPassWriteIndex —— 不用改各个 render pass，沿用场景、分层都不影响。
 *   相邻两个的差就是那一段：场景（含场景里的填充）、模糊、玻璃（背景上屏、填充、玻璃、合并组）、层（更高的层、探针、回读）。
 *   沿用场景的帧里场景那一段是 0，模糊那一段是局部复原的量。
 * - 结果异步读回（mapAsync），同一时间只有一次在路上：上一次还没读回来，这一帧就不计时 —— 从不等 GPU。
 * - 设备不支持（没有 timestamp-query）时不建；WebGL2 的计时扩展在浏览器里默认关着，那边没有 GPU 时间。
 * - 浏览器会把时间戳量化（Chrome 默认 100µs 级），读数是近似值，够自适应质量判断「GPU 吃不吃紧」。
 *   各段是两个量化读数的差，偶尔差出负数：按 0 算（合计照旧是首尾之差）。
 */

/** 一帧里打时间戳的几个点，按顺序。 */
export const GPU_MARKS = ['begin', 'scene', 'blur', 'glass', 'end'] as const
export type GpuMark = (typeof GPU_MARKS)[number]

/** 一帧 GPU 时间的分账（ms）。 */
export interface GpuPasses {
  /** 场景与场景里的填充。沿用场景的帧是 0。 */
  readonly scene: number
  /** 模糊链（整帧建，或沿用时局部复原）。 */
  readonly blur: number
  /** 背景上屏、画布上的填充、第 0 层的玻璃与合并组。 */
  readonly glass: number
  /** 更高的层（拷画布、重采样、局部模糊、上屏），以及探针、回读。 */
  readonly layers: number
}

/** 各点的时间戳（纳秒）→ 合计与分账（ms）。某一点没打（-1）时并进下一段。负的差按 0。纯计算，单元测试测它。 */
export function passesFrom(ns: readonly number[]): { total: number; passes: GpuPasses } | null {
  const at = (i: number): number => ns[i] ?? -1
  const first = at(0)
  const last = at(GPU_MARKS.length - 1)
  if (!(first >= 0 && last >= first) || last - first >= 1e10) return null
  const out = [0, 0, 0, 0]
  let prev = first
  for (let i = 1; i < GPU_MARKS.length; i++) {
    const t = at(i)
    if (t < 0) continue
    out[i - 1] = Math.max(0, t - prev) / 1e6
    prev = Math.max(prev, t)
  }
  return { total: (last - first) / 1e6, passes: { scene: out[0]!, blur: out[1]!, glass: out[2]!, layers: out[3]! } }
}

export class GpuTimer {
  readonly #device: GPUDevice
  readonly #querySet: GPUQuerySet
  readonly #resolve: GPUBuffer
  readonly #read: GPUBuffer
  #busy = false
  #armed = false
  #destroyed = false
  /** 这一帧打了哪几个点。 */
  readonly #marked: boolean[] = GPU_MARKS.map(() => false)
  /** 最近一次读回的 GPU 时间（ms）；还没有是 null。 */
  lastMs: number | null = null
  /** 最近一次读回的分账（ms）；还没有是 null。 */
  lastPasses: GpuPasses | null = null
  /** 读回过几次。 */
  samples = 0

  private constructor(device: GPUDevice) {
    this.#device = device
    const n = GPU_MARKS.length
    this.#querySet = device.createQuerySet({ label: 'glassium:gpu-timer', type: 'timestamp', count: n })
    this.#resolve = device.createBuffer({
      label: 'glassium:gpu-timer-resolve',
      size: 8 * n,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    })
    this.#read = device.createBuffer({
      label: 'glassium:gpu-timer-read',
      size: 8 * n,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    })
  }

  /** 设备支持 timestamp-query 才建，否则 null。 */
  static create(device: GPUDevice): GpuTimer | null {
    if (!device.features.has('timestamp-query')) return null
    try {
      return new GpuTimer(device)
    } catch {
      return null
    }
  }

  /** 一帧开头：上一次读回完了才计时（返回这一帧计不计时）。 */
  begin(encoder: GPUCommandEncoder): boolean {
    this.#armed = !this.#busy && !this.#destroyed
    if (!this.#armed) return false
    this.#marked.fill(false)
    this.mark(encoder, 'begin')
    return true
  }

  /** 在这里打一个时间戳（这一帧不计时时什么都不做）。 */
  mark(encoder: GPUCommandEncoder, at: GpuMark): void {
    if (!this.#armed) return
    const i = GPU_MARKS.indexOf(at)
    const pass = encoder.beginComputePass({
      label: `glassium:gpu-timer-${at}`,
      timestampWrites: { querySet: this.#querySet, beginningOfPassWriteIndex: i }
    })
    pass.end()
    this.#marked[i] = true
  }

  /** 一帧结尾：写结束的时间戳、解析到可读的缓冲。 */
  end(encoder: GPUCommandEncoder): void {
    if (!this.#armed) return
    this.mark(encoder, 'end')
    const n = GPU_MARKS.length
    encoder.resolveQuerySet(this.#querySet, 0, n, this.#resolve, 0)
    encoder.copyBufferToBuffer(this.#resolve, 0, this.#read, 0, 8 * n)
  }

  /** 提交之后：异步读回。 */
  afterSubmit(): void {
    if (!this.#armed) return
    this.#armed = false
    this.#busy = true
    const marked = [...this.#marked]
    this.#read
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (this.#destroyed) return
        const t = new BigUint64Array(this.#read.getMappedRange())
        // 没打的点（这一帧没走到那一步）是上一次留下的旧值：记成 -1
        const ns = marked.map((m, i) => (m ? Number(t[i]!) : -1))
        this.#read.unmap()
        const r = passesFrom(ns)
        if (r) {
          this.lastMs = r.total
          this.lastPasses = r.passes
          this.samples++
        }
      })
      .catch(() => {
        // 设备丢了、缓冲销毁了：这一次不算
      })
      .finally(() => {
        this.#busy = false
      })
  }

  destroy(): void {
    this.#destroyed = true
    this.#querySet.destroy()
    this.#resolve.destroy()
    this.#read.destroy()
  }
}
