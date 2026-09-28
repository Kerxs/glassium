/**
 * runtime 建的 stage 上的自适应质量（performance/adaptive.ts）：configure({ quality }) 是 auto 就按实测帧时间升降，
 * 是固定档就定死。自己调 createGlassStage 的 stage 不挂（满质量）。
 */

import { AdaptiveQuality } from '../performance/adaptive.ts'
import type { GlassStage } from '../renderer/stage.ts'
import { VERSION } from '../version.ts'
import { fixedQuality, getConfig, onConfigChange } from './config.ts'
import { adaptiveTargets } from './glass.ts'

let adaptive: AdaptiveQuality | null = null
let subscribed = false

export function attachQuality(stage: GlassStage): void {
  adaptive?.dispose()
  const c = getConfig()
  adaptive = new AdaptiveQuality(stage, {
    fixed: fixedQuality(c.quality),
    remember: c.rememberQuality,
    version: VERSION,
    // 局部质量：整页吃紧时先降最贵的那几块 runtime 玻璃
    locals: adaptiveTargets
  })
  if (!subscribed) {
    subscribed = true
    onConfigChange((next, prev) => {
      if (next.quality !== prev.quality) adaptive?.setFixed(fixedQuality(next.quality))
    })
  }
}

/** 当前的自适应质量（调试面板读；runtime 没建 stage 时是 null）。 */
export function currentAdaptive(): AdaptiveQuality | null {
  return adaptive
}
