/**
 * 单位与分辨率。
 *
 * 这个文件存在的唯一理由是：把**半纹素偏移**和**设备像素换算**各自收敛到一处。
 * 这两个 bug 的表现完全一样（玻璃略软、略偏），叠在一起时极难分辨，而它们只要
 * 在代码里出现两次就迟早会不一致。
 */

/**
 * dp → CSS px，**恒等映射，不设换算系数**。
 *
 * density 1.0 下的 Android dp 按定义就是一个 CSS px。凭空造一个缩放常数会让每个
 * 从上游抄来的数值都无从追溯 —— 差异交给无量纲的分数参数
 * （cornerRadiusFrac / refractionHeightFrac / refractionAmountFrac）去吸收，
 * 那几个可以精确迁移。校准记录见 docs/calibration.md。
 */
export function dpToCssPx(dp: number): number {
  return dp
}

/** CSS px → 设备像素。 */
export function cssToDevicePx(cssPx: number, dpr: number): number {
  return cssPx * dpr
}

/** 设备像素 → CSS px。 */
export function deviceToCssPx(devicePx: number, dpr: number): number {
  return devicePx / dpr
}

/**
 * 像素坐标 → 归一化纹理坐标，**取纹素中心**。
 *
 * 半个纹素的偏移不是细节：漏掉它，整块玻璃会稳定偏移半个像素并轻微发虚，
 * 而这看起来和「采样器该用 nearest 却用了 linear」一模一样。
 * 全项目只有这一处做这个换算。
 */
export function texelCenterUv(coord: Vec2Like, size: Vec2Like): [number, number] {
  return [(coord[0] + 0.5) / size[0], (coord[1] + 0.5) / size[1]]
}

/** texelCenterUv 的逆运算，测试用它验往返一致。 */
export function uvToTexelCoord(uv: Vec2Like, size: Vec2Like): [number, number] {
  return [uv[0] * size[0] - 0.5, uv[1] * size[1] - 0.5]
}

type Vec2Like = readonly [number, number]

/** 默认像素预算。沿用 meshora 实测下来的那个数量级。 */
export const MAX_PIXELS = 1_300_000

/**
 * 场景目标的最低缩放比。
 *
 * meshora 同时传 minPixelRatio: 1 和 MAX_PIXELS —— 在 4K 屏上这两个约束互相矛盾，
 * 库必须违反其中一个，而**违反哪一个从调用点读不出来**。这里把地板定在 0.5，
 * 意味着 MAX_PIXELS 恒定胜出，分辨率是可确定的。
 */
export const MIN_SCENE_RATIO = 0.5

export interface ResolvedViewport {
  /** CSS 像素的视口尺寸。 */
  readonly cssWidth: number
  readonly cssHeight: number
  readonly dpr: number
  /** 合成目标：走满 DPR。它是眼睛直接看到的东西。 */
  readonly compositeWidth: number
  readonly compositeHeight: number
  /** 场景目标：受像素预算约束，可以比合成目标低。 */
  readonly sceneWidth: number
  readonly sceneHeight: number
  /** 场景相对 **CSS 像素** 的缩放。1 表示 CSS 像素分辨率，dpr 表示设备像素分辨率。 */
  readonly sceneScale: number
  /**
   * 预算与地板冲突、最终由地板胜出时为 true。
   *
   * 这个字段是这套策略的全部意义所在。meshora 同时传 minPixelRatio: 1 和 MAX_PIXELS，
   * 在 4K 屏上两者互相矛盾，库必须违反其中一个 —— 而**违反了哪一个，从调用点根本读不出来**。
   * Glassium 不假装这个冲突不存在（它是真实的：既要保底清晰度又要限总像素，本来就可能
   * 同时满足不了），而是定死优先级并**把结果报出来**：地板胜出，且这里置 true，
   * stage 启动时会 console.warn。
   */
  readonly budgetExceeded: boolean
}

/**
 * 解析三个分辨率。
 *
 * 合成目标走满 DPR 而场景目标可以降 —— 这是刻意的不对称：降采样合成目标会让
 * 面板边缘在锐利的 DOM 文字旁边发虚，而降采样场景只是让**被折射的内容**略软，
 * 那本来就要过一遍模糊和位移，看不出来。
 *
 * 优先级，从高到低：
 *   1. 不超过设备像素分辨率（再高没有意义，只是烧 GPU）
 *   2. 不低于 minSceneRatio（保底清晰度）
 *   3. 不超过 maxPixels（性能预算）
 *
 * 2 和 3 冲突时 2 胜出，并置 budgetExceeded。
 */
export function resolveViewport(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxPixels: number = MAX_PIXELS,
  minSceneRatio: number = MIN_SCENE_RATIO
): ResolvedViewport {
  const compositeWidth = Math.max(1, Math.round(cssWidth * dpr))
  const compositeHeight = Math.max(1, Math.round(cssHeight * dpr))

  // 注意这里以 **CSS 像素** 为基准算比例，不是以 dpr 为基准。
  // 以 dpr 为基准的话，同一个 minSceneRatio 在 dpr=1 和 dpr=2 上含义不同,
  // 那正是 meshora 那组参数读不出来的根源。
  const cssPixels = Math.max(1, cssWidth * cssHeight)
  const budgetRatio = Math.sqrt(maxPixels / cssPixels)

  const capped = Math.min(budgetRatio, dpr) // 优先级 1
  const ratio = Math.max(capped, minSceneRatio) // 优先级 2 覆盖优先级 3

  const sceneWidth = Math.max(1, Math.round(cssWidth * ratio))
  const sceneHeight = Math.max(1, Math.round(cssHeight * ratio))

  return {
    cssWidth,
    cssHeight,
    dpr,
    compositeWidth,
    compositeHeight,
    sceneWidth,
    sceneHeight,
    sceneScale: ratio,
    // 判据是「地板是否抬高了比例」，不是「最终像素数是否超了 maxPixels」。
    //
    // 后者会误报：取整会让恰好贴着预算的尺寸溢出几百个像素
    //（实测 1512x982@2x 溢出 385 个），那是取整不是冲突，报出来只会让人白查一趟。
    // 这个标志要么精确表示「保底清晰度压过了性能预算」，要么就没有价值。
    budgetExceeded: ratio > capped + 1e-9
  }
}

/** 启动时打印一次。解析结果不可见的话，4K 屏上的性能问题会查很久。 */
export function describeViewport(v: ResolvedViewport): string {
  const pixels = v.sceneWidth * v.sceneHeight
  return (
    `viewport ${v.cssWidth}x${v.cssHeight} css @${v.dpr}x` +
    ` · composite ${v.compositeWidth}x${v.compositeHeight}` +
    ` · scene ${v.sceneWidth}x${v.sceneHeight}` +
    ` (${v.sceneScale.toFixed(3)}x css, ${(pixels / 1e6).toFixed(2)}MP)` +
    (v.budgetExceeded ? ' · 超出像素预算（保底清晰度优先）' : '')
  )
}
