/**
 * 调试面板的内容（拆出来是为了在 Node 里测、给面板以外的地方用）。每行一对 [名字, 值]。
 */

import { currentStage } from '../renderer/stage.ts'

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
    ['模糊', `${s.blurPasses} 趟 / ${s.blurLevels} 级`],
    ['创建', `管线 ${s.pipelineCreations} · 目标 ${s.targetAllocations}`]
  ]
  if (v) rows.push(['画布', `${v.compositeWidth}×${v.compositeHeight} · 场景 ${v.sceneWidth}×${v.sceneHeight}`])
  rows.push(['层级问题', String(stage.debug.checkLayers().length)])
  return rows
}
