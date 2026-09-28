/**
 * 调试面板的内容（拆出来是为了在 Node 里测、给面板以外的地方用）。每行一对 [名字, 值]。
 */

import { currentStage } from '../renderer/stage.ts'
import { absorbedElements } from '../runtime/absorb.ts'
import { contentBlocks } from '../runtime/content.ts'
import { currentAdaptive } from '../runtime/quality-link.ts'

export function debugRows(): Array<[string, string]> {
  const stage = currentStage()
  if (!stage) return [['后端', '没有 stage（CSS 玻璃或还没启动）']]
  const s = stage.debug.stats()
  const v = s.viewport
  const rows: Array<[string, string]> = [
    ['后端', `${s.backend}${stage.active ? '' : '（没在画 —— CSS 兜底）'}`],
    ['FPS', String(s.fps)],
    ['CPU', `${s.cpuMs.total.toFixed(2)} ms（量 ${s.cpuMs.measure.toFixed(2)}）`],
    ['玻璃', `${s.panels} 块 · ${s.groups} 组 · ${s.fills} 填充`],
    ['draw calls', String(s.drawCalls)],
    ['模糊', `${s.blurPasses} 趟 / ${s.blurLevels} 级${s.sceneReused ? '（沿用场景）' : ''} · 沿用过 ${s.sceneReuses} 帧`],
    ['GPU', s.gpuMs === null ? '量不了（WebGL2，或设备没有 timestamp-query）' : `${s.gpuMs.toFixed(2)} ms / 帧`],
    ['创建', `管线 ${s.pipelineCreations} · 目标 ${s.targetAllocations}`]
  ]
  if (v) rows.push(['画布', `${v.compositeWidth}×${v.compositeHeight} · 场景 ${v.sceneWidth}×${v.sceneHeight}`])
  const a = currentAdaptive()
  const f = stage.quality
  if (a) {
    const w = a.lastWindow
    rows.push([
      '质量',
      `${a.quality.toFixed(2)}${a.fixed !== null ? '（固定）' : a.probing ? '（探测中）' : '（自适应）'} · 预算 ${a.budgetMs.toFixed(1)} ms`
    ])
    if (a.loweredCount > 0) rows.push(['局部质量', `单独降了 ${a.loweredCount} 块 · 整页那一档 ${a.globalQuality.toFixed(2)}`])
    if (w) rows.push(['上个窗口', `${w.frames} 帧 · 掉帧 ${(w.dropRatio * 100).toFixed(0)}% · CPU ${(w.cpuRatio * 100).toFixed(0)}% 预算`])
  } else {
    rows.push(['质量', '满（不是 runtime 建的 stage）'])
  }
  rows.push([
    '系数',
    `分辨率 ${f.resolution.toFixed(2)} · 模糊 ${f.blur.toFixed(2)} · 折射 ${f.refraction.toFixed(2)} · 深 ${f.depth.toFixed(2)} · 色散 ${f.dispersion.toFixed(2)} · 投影 ${f.shadow.toFixed(2)}`
  ])
  rows.push(['收进场景的背景', String(absorbedElements().length)])
  rows.push(['收进场景的内容块', String(contentBlocks().length)])
  rows.push(['层级问题', String(stage.debug.checkLayers().length)])
  return rows
}
