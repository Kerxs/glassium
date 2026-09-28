/**
 * 质量系数：自适应质量（performance/）交给 stage 的每一项效果的倍数，1 是原样。
 *
 * 只动数值（uniform）与场景分辨率，不改用户的材质、不新建管线。分辨率动的是场景目标（模糊链的第 0 级）的像素预算 ——
 * 那是最大的 GPU 成本；画布本身照旧按设备像素，玻璃的边缘不会变糊。
 */
export interface QualityFactors {
  /** 场景分辨率：像素预算乘它的平方。 */
  readonly resolution: number
  /** 模糊 σ。 */
  readonly blur: number
  /** 折射的位移量。 */
  readonly refraction: number
  /** 高级折射（depthEffect：边缘往中心的径向弯折）。 */
  readonly depth: number
  /** 色散（为 0 时着色器走单次采样，省两次采样）。 */
  readonly dispersion: number
  /** 投影。 */
  readonly shadow: number
}

export const FULL_QUALITY: QualityFactors = Object.freeze({
  resolution: 1,
  blur: 1,
  refraction: 1,
  depth: 1,
  dispersion: 1,
  shadow: 1
})

/**
 * 全局的系数 × 一块玻璃自己的系数（GlassPanel.setQuality）。分辨率只看全局的 —— 场景是整页共用的一张。
 */
export function combineQuality(global: QualityFactors, local: Partial<QualityFactors>): QualityFactors {
  return {
    resolution: global.resolution,
    blur: global.blur * (local.blur ?? 1),
    refraction: global.refraction * (local.refraction ?? 1),
    depth: global.depth * (local.depth ?? 1),
    dispersion: global.dispersion * (local.dispersion ?? 1),
    shadow: global.shadow * (local.shadow ?? 1)
  }
}

export function sameQuality(a: QualityFactors, b: QualityFactors): boolean {
  return (
    a.resolution === b.resolution &&
    a.blur === b.blur &&
    a.refraction === b.refraction &&
    a.depth === b.depth &&
    a.dispersion === b.dispersion &&
    a.shadow === b.shadow
  )
}
