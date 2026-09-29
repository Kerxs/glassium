/**
 * 调试面板的内容（拆出来是为了在 Node 里测、给面板以外的地方用）。每行一对 [名字, 值]。
 */

import type { SceneSnapshot } from '../renderer/inspect.ts'
import { describeElement } from '../renderer/layering.ts'
import { formatBytes } from '../renderer/resources.ts'
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
    [
      '显存（估计）',
      `${formatBytes(s.gpuMemory.bytes)}${s.memoryBudget === null ? '' : ` / 预算 ${formatBytes(s.memoryBudget)}${s.memoryScale < 1 ? `（场景 × ${s.memoryScale.toFixed(2)}）` : ''}${s.memoryOverBudget ? '（到保底了还超）' : ''}`} · ${s.gpuMemory.textures} 张 · ` +
        Object.entries(s.gpuMemory.items)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ${formatBytes(v)}`)
          .join(' · ')
    ],
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

/** 场景页的一行：[序号, 类型, 元素, 层, 尺寸, 备注]。 */
export type SceneRow = readonly [string, string, string, string, string, string]

const fmt = (n: number, d = 0): string => (Number.isFinite(n) ? n.toFixed(d) : String(n))

/** 场景检查器的表格（stage.debug.scene() 的结果）。 */
export function sceneRows(scene: SceneSnapshot | null): { rows: SceneRow[]; elements: HTMLElement[] } {
  const rows: SceneRow[] = []
  const elements: HTMLElement[] = []
  if (!scene) return { rows, elements }
  scene.glasses.forEach((g) => {
    const notes = [
      g.fade < 1 ? `淡 ${fmt(g.fade, 2)}` : '',
      g.visualScale !== 1 ? `缩放 ${fmt(g.visualScale, 2)}` : '',
      Math.abs(g.rotationDeg) > 0.01 ? `转 ${fmt(g.rotationDeg, 1)}°` : '',
      g.localQuality ? '局部质量' : '',
      g.presentation ? '呈现变换' : ''
    ].filter(Boolean)
    rows.push([
      String(rows.length + 1),
      g.group === null ? '玻璃' : `组 ${g.group + 1}`,
      describeElement(g.element),
      String(g.layer),
      `${fmt(g.rect[2])}×${fmt(g.rect[3])}`,
      notes.join(' · ')
    ])
    elements.push(g.element)
  })
  for (const f of scene.fills) {
    rows.push([
      String(rows.length + 1),
      f.kind === 'bitmap' ? '位图填充' : f.kind === 'gradient' ? '渐变填充' : '填充',
      describeElement(f.element),
      String(f.layer),
      `${fmt(f.rect[2])}×${fmt(f.rect[3])}`,
      f.kind === 'color' ? `rgba(${f.color.slice(0, 3).map((c) => Math.round(c * 255)).join(', ')}, ${fmt(f.color[3], 2)})` : ''
    ])
    elements.push(f.element)
  }
  return { rows, elements }
}

/** 材质检查器：选中的那一块的材质、效果链、质量、呈现变换（一行一句）。 */
export function detailLines(scene: SceneSnapshot | null, element: HTMLElement): string[] {
  if (!scene) return []
  const g = scene.glasses.find((x) => x.element === element)
  if (!g) {
    const f = scene.fills.find((x) => x.element === element)
    return f ? [`填充 · ${f.kind} · 层 ${f.layer}`, `矩形 ${f.rect.map((n) => fmt(n)).join(', ')}`] : ['不在上一帧里（屏外、藏起来了，或者不是玻璃）']
  }
  const lines = [
    `${describeElement(g.element)} · 层 ${g.layer}${g.group === null ? '' : ` · 组 ${g.group + 1}`}`,
    `矩形 ${g.rect.map((n) => fmt(n)).join(', ')}（CSS px）`,
    `材质 ${JSON.stringify(g.material)}`,
    `圆角 ${g.chain.cornerRadiiDp.map((r) => fmt(r, 1)).join(' / ')} dp · 不透明 ${fmt(g.chain.opacity, 2)} · 投影 ${fmt(g.chain.shadow, 2)} · 放大 ${fmt(g.chain.magnify, 2)}`
  ]
  for (const e of g.chain.effects) {
    const { kind, ...rest } = e as unknown as { kind: string } & Record<string, unknown>
    lines.push(`${kind} ${Object.entries(rest).map(([k, v]) => `${k} ${typeof v === 'number' ? fmt(v, 3) : JSON.stringify(v)}`).join(' · ')}`)
  }
  if (g.quality) lines.push(`质量系数 ${Object.entries(g.quality).map(([k, v]) => `${k} ${fmt(v as number, 2)}`).join(' · ')}`)
  if (g.localQuality) lines.push(`局部质量 ${JSON.stringify(g.localQuality)}`)
  if (g.presentation) lines.push(`呈现变换 dx ${fmt(g.presentation.dx, 1)} dy ${fmt(g.presentation.dy, 1)} sx ${fmt(g.presentation.sx, 3)} sy ${fmt(g.presentation.sy, 3)}`)
  return lines
}

/** 资源页：显存每一项与创建计数。 */
export function resourceRows(): Array<[string, string]> {
  const stage = currentStage()
  if (!stage) return [['后端', '没有 stage']]
  const s = stage.debug.stats()
  const rows: Array<[string, string]> = [['合计', `${formatBytes(s.gpuMemory.bytes)} · ${s.gpuMemory.textures} 张纹理（估计）`]]
  for (const [k, v] of Object.entries(s.gpuMemory.items).sort((a, b) => b[1] - a[1])) rows.push([k, formatBytes(v)])
  rows.push(['目标分配', String(s.targetAllocations)])
  rows.push(['管线创建', String(s.pipelineCreations)])
  rows.push(['场景上传', String(s.sceneUploads)])
  return rows
}
