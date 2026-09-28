/**
 * 统一的时间轴：材质、形变、飞行、变形的动画都在这里排下一帧，一帧只有一个 requestAnimationFrame。
 *
 * - 用法与 requestAnimationFrame 相同：`nextFrame(cb)` → id，`cancelFrame(id)`。回调拿到这一帧的时间（ms）。
 * - 与画同步：stage 的帧循环在量面板之前先 `flushFrame(now)` —— 动画在这一帧写下的材质、呈现变换，这一帧就画出来，
 *   不会晚一帧。stage 不在跑（没有 GPU、减少动效时帧循环停着）时，时间轴自己排一个 rAF。同一帧只跑一遍（按时间戳）。
 * - 减少动效：回调拿到的时间一下子跳到很远以后（REDUCED_MOTION_SKIP），按时间走的动画（趋近、飞行、变形）
 *   一步走到终点 —— 不用每个动画各自判断，中途打开减少动效时正在走的也一步落地。
 * - 帧观察者：`everyFrame(cb)` 每一帧都跑（在排着的回调之前），但自己不排帧 —— 搭 stage 帧循环的车。帧循环停着
 *   （减少动效、没有 GPU）时它们也不跑。跟着元素位置走的果冻、飞行（interaction/element-motion.ts）用它：在量面板之前
 *   读到元素这一帧的位置。
 * - 测试：`setFrameSource` 换掉 rAF 与时钟。
 */

export type FrameCallback = (now: number) => void

/** 减少动效时时间往前跳这么多（ms）：比任何动画都长。 */
export const REDUCED_MOTION_SKIP = 1e6

interface FrameSource {
  request(cb: (now: number) => void): number
  cancel(id: number): void
}

const browserSource: FrameSource = {
  request: (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(() => cb(nowMs()), 16) as unknown as number)),
  cancel: (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id))
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

let source: FrameSource = browserSource
let reducedMotion: () => boolean = () => false
let pending = new Map<number, FrameCallback>()
const observers = new Set<FrameCallback>()
let nextId = 1
let rafId = 0
let lastFlush = -Infinity

/** 下一帧调一次 cb。 */
export function nextFrame(cb: FrameCallback): number {
  const id = nextId++
  pending.set(id, cb)
  if (rafId === 0) rafId = source.request(flushFrame)
  return id
}

export function cancelFrame(id: number): void {
  pending.delete(id)
  if (pending.size === 0 && rafId !== 0) {
    source.cancel(rafId)
    rafId = 0
  }
}

/** 每一帧都调 cb（不自己排帧，见上）。返回取消订阅。 */
export function everyFrame(cb: FrameCallback): () => void {
  observers.add(cb)
  return () => observers.delete(cb)
}

/** 排着的回调数（调试、测试用）。 */
export function pendingFrames(): number {
  return pending.size
}

/**
 * 跑这一帧排着的回调（回调里再排的留到下一帧）。stage 的帧循环在画之前调；时间轴自己的 rAF 也调它 ——
 * 同一个时间戳只跑一遍。
 */
export function flushFrame(now: number): void {
  // 同一帧（同一个时间戳）stage 与时间轴自己的 rAF 都会来，只跑一遍
  if (now === lastFlush) return
  lastFlush = now
  if (rafId !== 0) {
    source.cancel(rafId)
    rafId = 0
  }
  for (const cb of [...observers]) {
    try {
      cb(now)
    } catch (e) {
      console.error('[Glassium] 帧观察者出错：', e)
    }
  }
  if (pending.size === 0) return
  const batch = pending
  pending = new Map()
  const t = reducedMotion() ? now + REDUCED_MOTION_SKIP : now
  for (const cb of batch.values()) {
    try {
      cb(t)
    } catch (e) {
      // 一个动画抛了不能拖垮别的动画与这一帧的画
      console.error('[Glassium] 动画回调出错：', e)
    }
  }
  if (pending.size > 0 && rafId === 0) rafId = source.request(flushFrame)
}

/** stage 注入「减少动效」的判断（避免时间轴反过来依赖 stage）。 */
export function setTimelineReducedMotion(fn: () => boolean): void {
  reducedMotion = fn
}

/** 测试用：换掉 rAF；null 换回浏览器的。排着的回调清空。 */
export function setFrameSource(next: FrameSource | null): void {
  if (rafId !== 0) source.cancel(rafId)
  rafId = 0
  source = next ?? browserSource
  pending = new Map()
  observers.clear()
  lastFlush = -Infinity
}
