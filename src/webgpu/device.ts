/**
 * WebGPU adapter / device 的会话级单例。
 *
 * 一个会话只要一个 device。浏览器对 GPU 上下文有硬上限（WebGL 约 16 个，WebGPU 的
 * device 虽然没那么紧但 adapter 请求本身也不便宜），而 meshora 那边已经踩过一次
 * 路由切换导致上下文 churn 的坑 —— 常驻一个比反复创建销毁既省又稳。
 *
 * 模块顶层不碰 navigator：SSG / SSR 阶段在 Node 里跑，没有 navigator 也没有
 * navigator.gpu，顶层访问会直接让构建挂掉。
 */

/** 拿不到 device 的原因。给调用方做降级决策用，也用于日志。 */
export type DeviceFailure =
  | { readonly kind: 'no-navigator'; readonly detail: string }
  | { readonly kind: 'no-webgpu'; readonly detail: string }
  | { readonly kind: 'no-adapter'; readonly detail: string }
  | { readonly kind: 'no-device'; readonly detail: string }

export interface AcquiredDevice {
  readonly adapter: GPUAdapter
  readonly device: GPUDevice
  /** 画布首选格式。不要写死 bgra8unorm —— 不同平台不一样。 */
  readonly format: GPUTextureFormat
}

export type DeviceResult =
  | { readonly ok: true; readonly value: AcquiredDevice }
  | { readonly ok: false; readonly failure: DeviceFailure }

let current: AcquiredDevice | null = null
let pending: Promise<DeviceResult> | null = null
let lossCount = 0
let pipelinesCreated = 0
let bindGroupsCreated = 0

/**
 * 主动释放过的设备。它们的 lost 也会触发（reason 为 'destroyed'），但那不是丢失 ——
 * 不区分的话，每次 dispose 都会在控制台留一条「设备丢失」的警告，把真正的丢失淹掉。
 */
const released = new WeakSet<GPUDevice>()

/** 测试与 playground 的探测用：假装没有 WebGPU。 */
let simulateMissing = false

/**
 * 模拟 navigator.gpu 不存在。
 *
 * 这不是玩具开关：本机只有 Edge，它**永远**会选 WebGPU，于是探测与警告那条路径
 * 平时根本跑不到。而降级阶梯写错了是不会有人发现的——直到某个 Firefox 用户打开页面。
 * playground 的 ?glassium.simulate=no-webgpu 就接在这里。
 */
export function simulateNoWebGpu(on: boolean): void {
  simulateMissing = on
}

/**
 * 在设备上数「一共建了多少条管线、多少个 bind group」。
 *
 * 数在设备上，而不是在各个已知的创建点上：这两个数存在的意义是抓住**意料之外**的创建 ——
 * 比如某处拿逐面板的值当了管线的 key，于是每帧、每块面板新建一条。只在已知的创建点计数的话，
 * 恰好漏掉的就是要抓的那一种。
 *
 * 预热之后两个数都应当走平：管线只在建设备时建，bind group 只在视口尺寸变化时重建。
 */
function countCreations(device: GPUDevice): void {
  const renderPipeline = device.createRenderPipeline.bind(device)
  const renderPipelineAsync = device.createRenderPipelineAsync.bind(device)
  const computePipeline = device.createComputePipeline.bind(device)
  const computePipelineAsync = device.createComputePipelineAsync.bind(device)
  const bindGroup = device.createBindGroup.bind(device)
  device.createRenderPipeline = (d) => {
    pipelinesCreated++
    return renderPipeline(d)
  }
  device.createRenderPipelineAsync = (d) => {
    pipelinesCreated++
    return renderPipelineAsync(d)
  }
  device.createComputePipeline = (d) => {
    pipelinesCreated++
    return computePipeline(d)
  }
  device.createComputePipelineAsync = (d) => {
    pipelinesCreated++
    return computePipelineAsync(d)
  }
  device.createBindGroup = (d) => {
    bindGroupsCreated++
    return bindGroup(d)
  }
}

/** 本会话（跨设备累计）建过的管线与 bind group 总数。见 countCreations。 */
export function gpuCreationCounts(): { readonly pipelines: number; readonly bindGroups: number } {
  return { pipelines: pipelinesCreated, bindGroups: bindGroupsCreated }
}

function describeLimits(adapter: GPUAdapter, device: GPUDevice): void {
  const l = device.limits
  // 这几个数直接决定 PanelUniforms 的排布能不能按 256B stride 走。
  // 计划里是按「WebGPU 默认上限值 256」假设的，但 adapter 可以报更小的值，
  // 所以必须实测一次并记进 docs/calibration.md，而不是照着规范猜。
  console.info(
    '[Glassium] adapter 限制：' +
      `minUniformBufferOffsetAlignment=${l.minUniformBufferOffsetAlignment}` +
      ` · maxUniformBufferBindingSize=${l.maxUniformBufferBindingSize}` +
      ` · maxTextureDimension2D=${l.maxTextureDimension2D}` +
      ` · maxTextureArrayLayers=${l.maxTextureArrayLayers}` +
      ` · maxBindGroups=${l.maxBindGroups}`
  )
  const info = adapter.info as GPUAdapterInfo | undefined
  if (info) {
    console.info(
      `[Glassium] adapter：vendor=${info.vendor || '?'} architecture=${info.architecture || '?'}` +
        ` device=${info.device || '?'} description=${info.description || '?'}`
    )
  }
}

/**
 * 取得（或复用）device。
 *
 * 失败时**不抛**，返回 failure 让调用方走降级阶梯 —— 拿不到 GPU 是预期内的情况
 * （Firefox on Linux、Chrome 在部分 Android GPU 上都没有），不是异常。
 */
export async function acquireDevice(): Promise<DeviceResult> {
  if (current) return { ok: true, value: current }
  if (pending) return pending

  pending = (async (): Promise<DeviceResult> => {
    if (typeof navigator === 'undefined') {
      return { ok: false, failure: { kind: 'no-navigator', detail: '不在浏览器环境（SSR/SSG？）' } }
    }
    if (simulateMissing) {
      return { ok: false, failure: { kind: 'no-webgpu', detail: '被 simulateNoWebGpu 强制关闭' } }
    }
    if (!('gpu' in navigator) || !navigator.gpu) {
      return {
        ok: false,
        failure: {
          kind: 'no-webgpu',
          detail:
            'navigator.gpu 不存在。Firefox 无 Linux/Intel Mac/Android，' +
            'Chrome 的 Linux 受 GPU 门禁、Android 受厂商门禁。'
        }
      }
    }

    let adapter: GPUAdapter | null = null
    try {
      adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    } catch (err) {
      return { ok: false, failure: { kind: 'no-adapter', detail: String(err) } }
    }
    if (!adapter) {
      return { ok: false, failure: { kind: 'no-adapter', detail: 'requestAdapter 返回 null' } }
    }

    let device: GPUDevice
    try {
      device = await adapter.requestDevice()
    } catch (err) {
      return { ok: false, failure: { kind: 'no-device', detail: String(err) } }
    }

    const format = navigator.gpu.getPreferredCanvasFormat()
    countCreations(device)
    describeLimits(adapter, device)

    // 设备丢失在 Windows 笔记本上是常态（睡眠/唤醒会触发驱动重置），
    // 失效表现是画布静默冻结 —— 不报出来的话会被当成「代码卡死了」。
    //
    // 这里**只陈述事实**：丢了、第几次、原因。怎么恢复是 stage 的事（重建或降级），
    // 由 stage 自己报。这条日志早先写的是「将尝试重新初始化」，而当时根本没有任何代码
    // 在重建 —— 画布冻在最后一帧，控制台却说会重试。
    //
    // 这个回调必须先于 stage 的回调执行，好让 stage 重新 acquire 时拿到的是新设备：
    // 同一个 Promise 上的回调按注册顺序执行，而这里的注册早于 stage 拿到设备。
    void device.lost.then((info) => {
      if (current?.device === device) {
        current = null
        pending = null
      }
      if (released.has(device)) return
      lossCount++
      console.warn(
        `[Glassium] WebGPU 设备丢失（第 ${lossCount} 次）：${info.reason}` +
          (info.message ? ` —— ${info.message}` : '')
      )
    })

    current = { adapter, device, format }
    return { ok: true, value: current }
  })()

  const result = await pending
  if (!result.ok) pending = null
  return result
}

/** 意外丢失过几次设备（主动释放不算）。 */
export function deviceLossCount(): number {
  return lossCount
}

/** 释放单例。dispose() 会调用它，之后可以重新 acquire。这不算丢失。 */
export function releaseDevice(): void {
  if (current) {
    released.add(current.device)
    current.device.destroy()
    current = null
  }
  pending = null
}

/**
 * 模拟一次意外的设备丢失：销毁当前设备，但**不**记为主动释放。
 *
 * 和 simulateNoWebGpu 是同一类东西。真实的丢失来自驱动重置（睡眠/唤醒、驱动更新、
 * GPU 超时），在本机没法按需复现；而恢复路径写错了平时不会有人发现 —— 直到某台笔记本
 * 唤醒之后画布冻住。真实丢失的 reason 是 'unknown'，这里是 'destroyed'，
 * 但 stage 不看 reason，走的是同一条恢复路径。
 *
 * @returns 当前没有设备时返回 false
 */
export function simulateDeviceLoss(): boolean {
  if (!current) return false
  current.device.destroy()
  return true
}
