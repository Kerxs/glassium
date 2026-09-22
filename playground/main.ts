/**
 * Playground 入口。
 *
 * T5 阶段它只做三件事：建 stage、把 stats 显示出来、提供那几个探测开关。
 * 控件与场景切换在 T12。
 */

// 按包名引用，和外部使用者写法一致 —— 免得 demo 里全是 ../src/…
import {
  createGlassStage,
  simulateNoWebGpu,
  simulateReducedMotion,
  type GlassStage
} from 'glassium'

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

const statsEl = document.getElementById('stats')!

function render(stage: GlassStage): void {
  const s = stage.debug.stats()
  const v = s.viewport
  const probe = stage.debug.probe

  const lines = [
    `<b>backend</b>  ${s.backend}`,
    `<b>fps</b>      ${s.fps}${s.reducedMotion ? '  (reduced-motion：不启动循环)' : ''}`,
    `<b>frames</b>   ${s.frames}`,
    `<b>draws</b>    ${s.drawCalls}`,
    `<b>allocs</b>   ${s.targetAllocations}`
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

  if (probe) {
    lines.push(
      `<b>layerIdx</b> ${probe.dynamicArrayLayerIndex ? '动态层索引可用' : '不可用'}`,
      `<b>align</b>    ${probe.minUniformBufferOffsetAlignment}B  (256 stride ${
        probe.stride256Valid ? '成立' : '不成立'
      })`
    )
  }

  statsEl.innerHTML = lines.join('\n')
}

async function main(): Promise<void> {
  const stage = await createGlassStage({
    onDegrade: (r) => {
      statsEl.textContent = `降级 ${r.from} → ${r.to}\n${r.detail}`
    }
  })

  // 供浏览器面板的 javascript_tool 读取 —— 验证靠读数值，不靠看截图猜。
  Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })

  render(stage)
  // stats 面板本身不该驱动渲染，所以用低频定时器读，而不是挂进 rAF。
  setInterval(() => render(stage), 250)

  console.info(`[Playground] stage 就绪，backend=${stage.backend}`)
}

void main()
