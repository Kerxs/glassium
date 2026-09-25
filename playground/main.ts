/**
 * Playground 入口。
 *
 * 注册组件、建 stage、把 stats 显示出来，再接上左下角的控件与那几个 URL 开关。
 * 页面上的三块玻璃都是 <glass-card> / <glass-button>，材质写在 HTML 属性上。
 */

// 兜底样式。正式页面里应当用 <link> 放进 <head>，好在 JS 执行之前生效；
// playground 是开发服务器，这里 import 就够了。
import '../src/components/glassium.css'

// 按包名引用，和外部使用者写法一致 —— 免得 demo 里全是 ../src/…
import {
  compareOptics,
  createGlassStage,
  defineGlassElements,
  simulateForcedColors,
  simulateNoWebGpu,
  simulateMoreContrast,
  simulateReducedMotion,
  simulateReducedTransparency,
  type GlassStage,
  type PanelDebugMode,
  type SceneFit
} from 'glassium'

import { userScenes, type UserScene } from './scenes.ts'

const params = new URLSearchParams(location.search)

// 本机只有 Edge，它永远会选 WebGPU，于是探测与降级那条路径平时根本跑不到。
// 这个开关就是为了能真的走一遍它 —— 降级阶梯写错了平时不会有人发现。
if (params.get('glassium.simulate') === 'no-webgpu') {
  console.info('[Playground] 模拟 navigator.gpu 不存在')
  simulateNoWebGpu(true)
}

// 同理：改不了 OS 设置，而 matchMedia 每次调用返回的是新对象，
// 从外面 dispatchEvent 到不了 stage 持有的那个监听器。
if (params.get('glassium.reducedMotion') === '1') {
  console.info('[Playground] 强制 prefers-reduced-motion: reduce')
  simulateReducedMotion(true)
}

// 强制后端：本机平时永远选 WebGPU，WebGL2 那条路径要靠这个才走得到。
const backendParam = params.get('glassium.backend')
const backend = backendParam === 'webgl2' || backendParam === 'webgpu' ? backendParam : 'auto'
if (backend !== 'auto') console.info(`[Playground] 强制后端 ${backend}`)

// 同理：打开系统高对比度要改系统设置。
if (params.get('glassium.forcedColors') === '1') {
  console.info('[Playground] 强制 forced-colors: active')
  simulateForcedColors(true)
}

// 同理：系统的「减少透明度」。左下角也有开关。
if (params.get('glassium.reducedTransparency') === '1') {
  console.info('[Playground] 强制 prefers-reduced-transparency: reduce')
  simulateReducedTransparency(true)
}

// 同理：系统的「更高对比度」（只模拟得了 stage 的磨砂，CSS 里那圈边框要真的打开系统设置）
if (params.get('glassium.moreContrast') === '1') {
  console.info('[Playground] 强制 prefers-contrast: more')
  simulateMoreContrast(true)
}

const statsEl = document.getElementById('stats')!
let clicks = 0

function render(stage: GlassStage): void {
  const s = stage.debug.stats()
  const v = s.viewport
  const probe = stage.debug.probe

  const lines = [
    `<b>backend</b>  ${s.backend}`,
    `<b>fps</b>      ${s.fps}${s.reducedMotion ? '  (reduced-motion：不启动循环)' : ''}`,
    `<b>frames</b>   ${s.frames}  <b>skipped</b> ${s.skippedFrames}（没变，不画）`,
    `<b>draws</b>    ${s.drawCalls}`,
    `<b>allocs</b>   ${s.targetAllocations}`,
    `<b>blur</b>     ${s.blurPasses} 趟 / ${s.blurLevels} 级`,
    `<b>panels</b>   ${s.panels}  <b>groups</b> ${s.groups}`,
    `<b>cpu</b>      ${s.cpuMs.total.toFixed(2)} ms（测量 ${s.cpuMs.measure.toFixed(2)}）`,
    `<b>pipelines</b> ${s.pipelineCreations}  <b>bindGroups</b> ${s.bindGroupCreations}`,
    `<b>source</b>   ${s.scene}  <b>uploads</b> ${s.sceneUploads}  <b>blend</b> ${stage.blendSpace}`,
    `<b>clicks</b>   ${clicks}${s.forcedColors ? '  (forced-colors：stage 停用)' : ''}${
      s.reducedTransparency ? '  (reduced-transparency：磨砂)' : ''
    }${s.moreContrast ? '  (more-contrast：磨砂)' : ''}`
  ]

  if (v) {
    lines.push(
      `<b>css</b>      ${v.cssWidth}×${v.cssHeight} @${v.dpr}x`,
      `<b>composite</b> ${v.compositeWidth}×${v.compositeHeight}`,
      `<b>scene</b>    ${v.sceneWidth}×${v.sceneHeight}  (${v.sceneScale.toFixed(3)}x css)`,
      `<b>budget</b>   ${((v.sceneWidth * v.sceneHeight) / 1e6).toFixed(2)}MP${
        v.budgetExceeded ? '  ⚠ 超出预算（保底优先）' : ''
      }`
    )
  }

  if (probe?.kind === 'webgpu') {
    lines.push(
      `<b>layerIdx</b> ${probe.dynamicArrayLayerIndex ? '动态层索引可用' : '不可用'}`,
      `<b>align</b>    ${probe.minUniformBufferOffsetAlignment}B  (256 stride ${
        probe.stride256Valid ? '成立' : '不成立'
      })`
    )
  } else if (probe?.kind === 'webgl2') {
    lines.push(
      `<b>align</b>    ${probe.uniformBufferOffsetAlignment}B  (UBO 偏移对齐)`,
      `<b>float</b>    ${probe.colorBufferFloat ? 'EXT_color_buffer_float 有，探针可用' : '无，探针不可用'}`
    )
  }

  statsEl.innerHTML = lines.join('\n')
}

type BuiltinScene = 'gradient' | 'calibration' | 'radial' | 'flat'

function wireControls(stage: GlassStage): void {
  const scene = document.getElementById('scene') as HTMLSelectElement
  const fit = document.getElementById('fit') as HTMLSelectElement
  const file = document.getElementById('file') as HTMLInputElement
  const debug = document.getElementById('debug') as HTMLSelectElement
  debug.addEventListener('change', () => {
    stage.debug.setPanelDebug(debug.value as PanelDebugMode)
  })
  const blur = document.getElementById('blur') as HTMLInputElement
  const sat = document.getElementById('sat') as HTMLInputElement
  const tint = document.getElementById('tint') as HTMLInputElement
  const blurOut = document.getElementById('blurOut') as HTMLOutputElement
  const satOut = document.getElementById('satOut') as HTMLOutputElement
  const tintOut = document.getElementById('tintOut') as HTMLOutputElement

  const apply = (): void => {
    const a = Number(tint.value)
    blurOut.textContent = blur.value
    satOut.textContent = Number(sat.value).toFixed(2)
    tintOut.textContent = a.toFixed(2)
    const card = document.getElementById('card')!.getBoundingClientRect()
    stage.debug.setBackdrop({
      blurDp: Number(blur.value),
      saturation: Number(sat.value),
      tint: `rgba(255, 255, 255, ${a})`,
      // setScene 的场景（user:…）盖在内置场景上面；内置的那个保持不变
      ...(scene.value.startsWith('user:') ? {} : { scene: scene.value as BuiltinScene }),
      // radial 以卡片中心为圆心：折射往里采就是往暗处采，色散让蓝比红更暗
      radialCenter: [card.left + card.width / 2, card.top + card.height / 2],
      radialRadius: 0.6
    })
  }

  for (const el of [blur, sat, tint]) el.addEventListener('input', apply)

  // —— setScene：图片、动画画布、视频、本地文件 ——
  const scenes = userScenes(stage)
  /** 最后一个真正显示出来的选项。换场景失败、选文件时取消，都回到它。 */
  let shown = scene.value
  const failed = (err: unknown): void => {
    if (err instanceof DOMException && err.name === 'AbortError') return // 被后一次切换取代，不算失败
    console.warn('[Playground] 换场景失败：', err)
    scene.value = shown
  }
  const userSceneOf = (value: string): UserScene | null =>
    value.startsWith('user:') ? (value.slice('user:'.length) as UserScene) : null
  const showScene = (value: string): void => {
    scenes.show(userSceneOf(value), fit.value as SceneFit).then(() => {
      shown = value
    }, failed)
    apply()
  }
  scene.addEventListener('change', () => {
    // 本地文件：先弹选择框，选好之后在 file 的 change 里显示
    if (scene.value === 'user:file') file.click()
    else showScene(scene.value)
  })
  file.addEventListener('change', () => {
    const picked = file.files?.[0]
    file.value = '' // 同一个文件可以再选一次
    if (!picked) {
      scene.value = shown
      return
    }
    scenes.pickFile(picked, fit.value as SceneFit).then(() => {
      shown = 'user:file'
    }, failed)
  })
  file.addEventListener('cancel', () => {
    scene.value = shown
  })
  fit.addEventListener('change', () => {
    if (userSceneOf(shown)) showScene(shown)
  })

  // ?scene=… 直接从某个场景开始（截图、验证用）：内置的写名字，setScene 的写 user:photo 这样
  const initial = new URLSearchParams(location.search).get('scene')
  if (initial && initial !== 'user:file' && [...scene.options].some((o) => o.value === initial)) {
    scene.value = initial
    showScene(initial)
  } else {
    apply()
  }
}

async function main(): Promise<void> {
  // 先注册组件、再建 stage。组件 upgrade 时 stage 还没好，它们会等着，
  // stage 建好时统一注册 —— 反过来写也一样，顺序不重要。
  defineGlassElements()

  const stage = await createGlassStage({
    backend,
    // ?glassium.blend=linear：一开始就在线性光里模糊与调色（侧栏的「线性光」随时可以切）
    blendSpace: params.get('glassium.blend') === 'linear' ? 'linear' : 'srgb',
    onDegrade: (r) => {
      statsEl.textContent = `降级 ${r.from} → ${r.to}
${r.detail}`
    }
  })

  // 供浏览器面板的 javascript_tool 读取 —— 验证靠读数值，不靠看截图猜。
  Object.assign(window as unknown as Record<string, unknown>, {
    glassiumStage: stage,
    glassiumCompareOptics: compareOptics
  })

  // 滑杆改的是组件的 HTML 属性 —— 和作者在标记里写属性是同一条路径。
  const glassElements = [...document.querySelectorAll<HTMLElement>('glass-card, glass-button')]
  const disp = document.getElementById('disp') as HTMLInputElement
  const hl = document.getElementById('hl') as HTMLInputElement
  const dispOut = document.getElementById('dispOut') as HTMLOutputElement
  const hlOut = document.getElementById('hlOut') as HTMLOutputElement
  const syncPanels = (): void => {
    dispOut.textContent = Number(disp.value).toFixed(2)
    hlOut.textContent = Number(hl.value).toFixed(2)
    for (const el of glassElements) {
      el.setAttribute('dispersion', disp.value)
      el.setAttribute('highlight', hl.value)
    }
  }
  for (const el of [disp, hl]) el.addEventListener('input', syncPanels)

  const pill = document.getElementById('pill')!
  pill.addEventListener('click', () => {
    clicks++
    render(stage)
  })

  // R1 反例：给内容层加不透明背景。玻璃被整块挡住，控制台点名 main.content ——
  // 触发靠的是 stage 对 class 变化的监听，这里不用手动调 checkLayers()。
  const r1 = document.getElementById('r1') as HTMLInputElement
  r1.addEventListener('change', () => {
    document.querySelector('main.content')!.classList.toggle('r1-demo', r1.checked)
  })
  const disable = document.getElementById('disable') as HTMLInputElement
  disable.addEventListener('change', () => pill.toggleAttribute('disabled', disable.checked))

  // 减少透明度：勾上是强制打开，去掉勾是回到系统设置（不是强制关闭）
  const rt = document.getElementById('rt') as HTMLInputElement
  rt.checked = params.get('glassium.reducedTransparency') === '1'
  rt.addEventListener('change', () => simulateReducedTransparency(rt.checked ? true : null))

  // 线性光：模糊与调色在线性光里做（blendSpace）。亮暗交界模糊之后不再发灰
  const linear = document.getElementById('linear') as HTMLInputElement
  linear.checked = stage.blendSpace === 'linear'
  linear.addEventListener('change', () => stage.setBlendSpace(linear.checked ? 'linear' : 'srgb'))

  // 合并：smoothing 滑杆改的是 <glass-container> 的属性
  const duo = document.getElementById('duo')!
  const smooth = document.getElementById('smooth') as HTMLInputElement
  const smoothOut = document.getElementById('smoothOut') as HTMLOutputElement
  smooth.addEventListener('input', () => {
    smoothOut.textContent = smooth.value
    duo.setAttribute('smoothing', smooth.value)
  })

  wireControls(stage)
  render(stage)
  // stats 面板本身不该驱动渲染，所以用低频定时器读，而不是挂进 rAF。
  setInterval(() => render(stage), 250)

  console.info(`[Playground] stage 就绪，backend=${stage.backend}`)
}

void main()
