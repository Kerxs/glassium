/**
 * 运行期能力探测。
 *
 * 这里回答的是两个**计划阶段无法确定、必须实测**的问题。把它们写成代码而不是
 * 一次性手工试验，是因为答案会随驱动和浏览器版本变，而设计依赖这些答案：
 *
 *   1. WGSL 能不能用**动态层索引**做 textureSampleLevel？
 *      模糊分档的设计依赖它（K 层放一个 texture_2d_array，按 σ 选层）。
 *      不行的话就得退回三个静态 texture_2d 绑定加 uniform 分支链 ——
 *      合法，但多占两个绑定槽。
 *
 *   2. adapter 实际报的 minUniformBufferOffsetAlignment 是多少？
 *      PanelUniforms 按 256B stride 排布是照 WebGPU 的默认上限值假设的，
 *      但 adapter 可以报更小的值。实测值要记进 docs/calibration.md。
 */

export interface ProbeReport {
  readonly kind: 'webgpu'
  /** 动态层索引采样是否可用。 */
  readonly dynamicArrayLayerIndex: boolean
  /** 若不可用，这里是编译错误原文。 */
  readonly dynamicArrayLayerError: string | null
  readonly minUniformBufferOffsetAlignment: number
  readonly maxUniformBufferBindingSize: number
  readonly maxTextureArrayLayers: number
  readonly maxTextureDimension2D: number
  /** 256B stride 的假设是否成立（对齐值能整除 256）。 */
  readonly stride256Valid: boolean
}

/** 只为验证「层索引来自 uniform」能否编译。不求好看，求最小。 */
const LAYER_INDEX_PROBE_WGSL = /* wgsl */ `
struct Probe { layer: u32, pad0: u32, pad1: u32, pad2: u32 }

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var layers: texture_2d_array<f32>;
@group(0) @binding(2) var<uniform> probe: Probe;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // 关键一行：层索引是 uniform 里来的动态值，不是常量。
  // 同时用 textureSampleLevel 而不是 textureSample —— 玻璃着色器要按 SDF 符号
  // 逐像素分支，属非统一控制流，而 textureSample 因隐式导数要求统一控制流。
  return textureSampleLevel(layers, samp, pos.xy * 0.001, probe.layer, 0.0);
}
`

async function probeDynamicLayerIndex(
  device: GPUDevice
): Promise<{ ok: boolean; error: string | null }> {
  device.pushErrorScope('validation')

  const module = device.createShaderModule({ code: LAYER_INDEX_PROBE_WGSL })

  // getCompilationInfo 才能拿到真正的着色器编译诊断；validation scope 只报管线层面的问题。
  const info = await module.getCompilationInfo()
  const errors = info.messages.filter((m) => m.type === 'error')

  let pipelineError: GPUError | null = null
  if (errors.length === 0) {
    try {
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' }
      })
    } catch (err) {
      pipelineError = err as GPUError
    }
  }

  const scoped = await device.popErrorScope()

  if (errors.length > 0) {
    return { ok: false, error: errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ') }
  }
  if (pipelineError) return { ok: false, error: String(pipelineError) }
  if (scoped) return { ok: false, error: scoped.message }
  return { ok: true, error: null }
}

export async function probeCapabilities(device: GPUDevice): Promise<ProbeReport> {
  const dynamic = await probeDynamicLayerIndex(device)
  const l = device.limits
  const alignment = l.minUniformBufferOffsetAlignment

  const report: ProbeReport = {
    kind: 'webgpu',
    dynamicArrayLayerIndex: dynamic.ok,
    dynamicArrayLayerError: dynamic.error,
    minUniformBufferOffsetAlignment: alignment,
    maxUniformBufferBindingSize: l.maxUniformBufferBindingSize,
    maxTextureArrayLayers: l.maxTextureArrayLayers,
    maxTextureDimension2D: l.maxTextureDimension2D,
    // 256 必须是对齐值的整数倍。对齐值一定是 2 的幂，所以这等价于 alignment <= 256。
    stride256Valid: 256 % alignment === 0
  }

  console.info(
    `[Glassium] 能力探测：动态层索引采样=${report.dynamicArrayLayerIndex ? '可用' : '不可用'}` +
      ` · 256B stride=${report.stride256Valid ? '成立' : '不成立'}` +
      `（对齐要求 ${alignment}B）`
  )
  if (!report.dynamicArrayLayerIndex) {
    console.warn(
      '[Glassium] 动态层索引采样不可用，模糊分档需要退回三个静态 texture_2d 绑定：' +
        report.dynamicArrayLayerError
    )
  }
  if (!report.stride256Valid) {
    console.warn(
      `[Glassium] 对齐要求 ${alignment}B 不整除 256，PanelUniforms 的 stride 需要重排。`
    )
  }

  return report
}
