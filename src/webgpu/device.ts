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
    describeLimits(adapter, device)

    // 设备丢失在 Windows 笔记本上是常态（睡眠/唤醒会触发驱动重置），
    // 失效表现是画布静默冻结 —— 不报出来的话会被当成「代码卡死了」。
    void device.lost.then((info) => {
      lossCount++
      console.warn(
        `[Glassium] WebGPU 设备丢失（第 ${lossCount} 次）：${info.reason} ${info.message}。` +
          (lossCount === 1
            ? '将尝试重新初始化。'
            : '已丢失多次，不再重试 —— 应当降级到 WebGL2。')
      )
      current = null
      pending = null
    })

    current = { adapter, device, format }
    return { ok: true, value: current }
  })()

  const result = await pending
  if (!result.ok) pending = null
  return result
}

/** 已经丢失过几次设备。降级决策用：丢过两次就别再试 WebGPU 了。 */
export function deviceLossCount(): number {
  return lossCount
}

/** 释放单例。dispose() 会调用它，之后可以重新 acquire。 */
export function releaseDevice(): void {
  if (current) {
    current.device.destroy()
    current = null
  }
  pending = null
}
