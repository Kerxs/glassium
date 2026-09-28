/**
 * GPU 计时（WebGPU 的 timestamp-query）：一帧的 GPU 时间，给自适应质量与调试面板。
 *
 * - 一帧开头、结尾各一个空的 compute pass，带 timestampWrites：量的是这两点之间这一帧的全部 GPU 工作（场景、模糊链、
 *   上屏、玻璃、层），与这一帧怎么分 pass 无关（沿用场景、分层都不用改这里）。
 * - 结果异步读回（mapAsync），同一时间只有一次在路上：上一次还没读回来，这一帧就不计时 —— 从不等 GPU。
 * - 设备不支持（没有 timestamp-query）时不建；WebGL2 的计时扩展在浏览器里默认关着，那边没有 GPU 时间。
 * - 浏览器会把时间戳量化（Chrome 默认 100µs 级），读数是近似值，够自适应质量判断「GPU 吃不吃紧」。
 */

export class GpuTimer {
  readonly #device: GPUDevice
  readonly #querySet: GPUQuerySet
  readonly #resolve: GPUBuffer
  readonly #read: GPUBuffer
  #busy = false
  #armed = false
  #destroyed = false
  /** 最近一次读回的 GPU 时间（ms）；还没有是 null。 */
  lastMs: number | null = null
  /** 读回过几次。 */
  samples = 0

  private constructor(device: GPUDevice) {
    this.#device = device
    this.#querySet = device.createQuerySet({ label: 'glassium:gpu-timer', type: 'timestamp', count: 2 })
    this.#resolve = device.createBuffer({
      label: 'glassium:gpu-timer-resolve',
      size: 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    })
    this.#read = device.createBuffer({
      label: 'glassium:gpu-timer-read',
      size: 16,
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
    const pass = encoder.beginComputePass({
      label: 'glassium:gpu-timer-begin',
      timestampWrites: { querySet: this.#querySet, beginningOfPassWriteIndex: 0 }
    })
    pass.end()
    return true
  }

  /** 一帧结尾：写结束的时间戳、解析到可读的缓冲。 */
  end(encoder: GPUCommandEncoder): void {
    if (!this.#armed) return
    const pass = encoder.beginComputePass({
      label: 'glassium:gpu-timer-end',
      timestampWrites: { querySet: this.#querySet, endOfPassWriteIndex: 1 }
    })
    pass.end()
    encoder.resolveQuerySet(this.#querySet, 0, 2, this.#resolve, 0)
    encoder.copyBufferToBuffer(this.#resolve, 0, this.#read, 0, 16)
  }

  /** 提交之后：异步读回。 */
  afterSubmit(): void {
    if (!this.#armed) return
    this.#armed = false
    this.#busy = true
    this.#read
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (this.#destroyed) return
        const t = new BigUint64Array(this.#read.getMappedRange())
        const ns = Number(t[1]! - t[0]!)
        this.#read.unmap()
        // 量化、乱序时偶尔会是 0 或负的（BigUint64 下溢成很大的数）：不认
        if (ns >= 0 && ns < 1e10) {
          this.lastMs = ns / 1e6
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
