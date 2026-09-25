/**
 * 滚动时缩起、往回滚时展开 —— `<glass-tab-bar minimize="scroll">` 的判断（iOS 26 标签栏的
 * `tabBarMinimizeBehavior(.onScrollDown)`）。纯函数，没有 DOM。
 *
 * 往下滚（内容往上走）累计超过 MINIMIZE_THRESHOLD 缩起；往上滚累计超过同样的距离、或者回到顶部附近就展开。
 * 「累计」的起点：展开时是这之前滚到过的最高处（scrollY 最小的地方），缩着时是最低处 —— 往回滚的时候起点跟着走。
 * 这样手指的小幅抖动不会让栏来回闪。
 */

/** 往一个方向累计滚多远才切换，CSS 像素。 */
export const MINIMIZE_THRESHOLD = 32

/** 离顶部这么近时总是展开，CSS 像素。 */
export const MINIMIZE_TOP_ZONE = 8

export interface MinimizeState {
  readonly minimized: boolean
  /** 这一段同方向滚动开始的位置（上一次掉头的地方）。 */
  readonly anchor: number
}

export function initialMinimize(scrollY: number): MinimizeState {
  return { minimized: false, anchor: scrollY }
}

/** 滚到 scrollY 之后的状态。没变时返回同一个对象。 */
export function nextMinimize(state: MinimizeState, scrollY: number, threshold: number = MINIMIZE_THRESHOLD): MinimizeState {
  if (scrollY <= MINIMIZE_TOP_ZONE) {
    return state.minimized || state.anchor !== scrollY ? { minimized: false, anchor: scrollY } : state
  }
  const d = scrollY - state.anchor
  if (!state.minimized && d > threshold) return { minimized: true, anchor: scrollY }
  if (state.minimized && d < -threshold) return { minimized: false, anchor: scrollY }
  // 与要切换的方向相反：从这里重新累计（展开时往上走、缩着时往下走，锚点跟着走）
  if (state.minimized ? d > 0 : d < 0) return { minimized: state.minimized, anchor: scrollY }
  return state
}
