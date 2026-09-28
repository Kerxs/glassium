/**
 * 任意元素的果冻与飞行：跟着元素在屏幕上的位置走，只动玻璃（GlassPanel.setPresentation），元素与它的内容不动。
 *
 * - 果冻：元素动起来（拖动、CSS 过渡、JS 动画……不管谁动的），玻璃顺着速度拉长、垂直方向收一点，停下来平滑地圆回去，
 *   不晃（jelly.ts 的同一套曲线；两个方向各算各的：横着动横着拉，斜着动两边都拉一点）。
 * - 飞行：元素一帧里跳了一大段（改了 class、换了位置、布局变了），玻璃不跟着瞬移，而是从原来的地方抬起、飞过去、
 *   落下（glide.ts 的抬起时长与缓动），尺寸也一起过渡；飞的时候照样有果冻。
 *
 * 位置每帧读一次（timeline.ts 的帧观察者，在 stage 量面板之前），所以这一帧写的变换这一帧就画。页面滚动、窗口改尺寸的
 * 那几帧不算动（不然一滚动所有玻璃都拉长）。减少动效时不动。
 */

import { approach } from './motion.ts'
import { GLIDE_LIFT_MS, glideDuration, glideEase } from './glide.ts'
import { DRAG_JELLY, FLY_JELLY, jellyTarget, JELLY_SQUASH, type JellyResponse } from './jelly.ts'
import type { PanelPresentation } from '../renderer/panels.ts'
import { prefersReducedMotion } from '../renderer/stage.ts'
import { everyFrame } from '../animation/timeline.ts'

/** 一帧里挪了超过这么多（CSS 像素，或尺寸变了这么多）算「跳」：开了飞行就飞过去，没开就当瞬移（不算速度）。 */
export const JUMP_PX = 24
/** 飞的时候玻璃鼓起这么多（中段最大）。比组件的旋钮（1.2）小：任意元素可能是一整块卡片。 */
export const ELEMENT_FLY_SCALE = 1.06
/** 拉长量与速度都小于它时停下，回到元素的盒子。 */
const SETTLE = 1e-3

export interface ElementMotionOptions {
  readonly jelly: boolean
  readonly glide: boolean
}

/** 屏幕上的盒子（CSS 像素）。 */
export interface MotionBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

interface GlideState {
  readonly from: MotionBox
  readonly start: number
  readonly duration: number
}

let scrollStamp = 0
let listening = false

/** 页面滚动或改了尺寸（捕获阶段，任何滚动容器都算）：这一帧的位置变化不算动。 */
export function noteScroll(): void {
  scrollStamp++
}

function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('scroll', noteScroll, { capture: true, passive: true })
  window.addEventListener('resize', noteScroll, { passive: true })
}

/** 两个方向的拉长量 → 横向、纵向的缩放：各自拉长，再按另一个方向的拉长收（jelly.ts 的 sx^−JELLY_SQUASH）。 */
export function jellyScale2(stretchX: number, stretchY: number): readonly [number, number] {
  const ax = 1 + Math.max(0, stretchX)
  const ay = 1 + Math.max(0, stretchY)
  return [ax * Math.pow(ay, -JELLY_SQUASH), ay * Math.pow(ax, -JELLY_SQUASH)]
}

export class ElementMotion {
  readonly #apply: (p: PanelPresentation | null) => void
  #options: ElementMotionOptions
  #unsubscribe: (() => void) | null = null
  readonly #read: (() => MotionBox | null) | null

  /** 上一帧元素的盒子与时间。 */
  #last: MotionBox | null = null
  #lastT = 0
  #stamp = scrollStamp
  /** 上一帧玻璃（飞行插值之后）的中心。 */
  #visualCx = 0
  #visualCy = 0
  #vx = 0
  #vy = 0
  #stretchX = 0
  #stretchY = 0
  #glide: GlideState | null = null
  #applied: PanelPresentation | null = null

  /**
   * @param read 读元素这一帧的盒子（看不见、没尺寸时 null）；传 null 时只能手动 step（测试）
   * @param apply 写出玻璃的呈现变换（null 是回到元素的盒子）
   */
  constructor(read: (() => MotionBox | null) | null, apply: (p: PanelPresentation | null) => void, options: ElementMotionOptions) {
    this.#read = read
    this.#apply = apply
    this.#options = options
    if (read) {
      listen()
      this.#unsubscribe = everyFrame((now) => this.step(now, read()))
    }
  }

  static forElement(element: HTMLElement, apply: (p: PanelPresentation | null) => void, options: ElementMotionOptions): ElementMotion {
    return new ElementMotion(
      () => {
        if (!element.isConnected) return null
        const r = element.getBoundingClientRect()
        return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
      },
      apply,
      options
    )
  }

  setOptions(options: ElementMotionOptions): void {
    this.#options = options
    if (!options.glide) this.#glide = null
  }

  /** 正在飞（验证页读）。 */
  get flying(): boolean {
    return this.#glide !== null
  }

  dispose(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.reset()
  }

  /** 回到元素的盒子、忘掉上一帧（元素离开文档时）。 */
  reset(): void {
    this.#last = null
    this.#glide = null
    this.#vx = this.#vy = this.#stretchX = this.#stretchY = 0
    this.#write(null)
  }

  /** 一帧：box 是元素这一帧的盒子。 */
  step(now: number, box: MotionBox | null): void {
    if (!box || prefersReducedMotion()) {
      this.reset()
      return
    }
    const last = this.#last
    const scrolled = this.#stamp !== scrollStamp
    this.#stamp = scrollStamp
    this.#last = box
    const dt = last ? now - this.#lastT : 0
    this.#lastT = now

    if (!last || scrolled || !(dt > 0)) {
      // 第一帧、滚动的那一帧：只记下位置。正在飞的照旧飞（飞行是相对元素当前盒子的）
      const v = this.#visual(now, box)
      this.#visualCx = v.x + v.w / 2
      this.#visualCy = v.y + v.h / 2
      this.#compose(now, box, v, 0)
      return
    }

    const jumped =
      Math.hypot(box.x - last.x, box.y - last.y) > JUMP_PX || Math.abs(box.w - last.w) > JUMP_PX || Math.abs(box.h - last.h) > JUMP_PX
    if (jumped) {
      if (this.#options.glide) {
        // 从玻璃现在在的地方（可能正飞到一半）飞到新的盒子
        const from = this.#glide ? this.#visual(now, last) : last
        const distance = Math.hypot(box.x - from.x, box.y - from.y)
        this.#glide = { from, start: now, duration: GLIDE_LIFT_MS + glideDuration(distance) }
      } else {
        // 瞬移：不算速度
        this.#visualCx = box.x + box.w / 2
        this.#visualCy = box.y + box.h / 2
      }
    }

    const v = this.#visual(now, box)
    const cx = v.x + v.w / 2
    const cy = v.y + v.h / 2
    const response: JellyResponse = this.#glide ? FLY_JELLY : DRAG_JELLY
    this.#vx = approach(this.#vx, (cx - this.#visualCx) / dt, dt, response.velocityTau)
    this.#vy = approach(this.#vy, (cy - this.#visualCy) / dt, dt, response.velocityTau)
    this.#visualCx = cx
    this.#visualCy = cy
    this.#compose(now, box, v, dt)
  }

  /** 玻璃这一帧的盒子：没在飞就是元素的盒子；在飞就是从起点往元素当前的盒子按缓动插值。 */
  #visual(now: number, box: MotionBox): MotionBox {
    const g = this.#glide
    if (!g) return box
    const elapsed = now - g.start
    if (elapsed >= g.duration) {
      this.#glide = null
      return box
    }
    const p = glideEase((elapsed - GLIDE_LIFT_MS) / (g.duration - GLIDE_LIFT_MS))
    return {
      x: g.from.x + (box.x - g.from.x) * p,
      y: g.from.y + (box.y - g.from.y) * p,
      w: g.from.w + (box.w - g.from.w) * p,
      h: g.from.h + (box.h - g.from.h) * p
    }
  }

  #compose(now: number, box: MotionBox, v: MotionBox, dt: number): void {
    const response: JellyResponse = this.#glide ? FLY_JELLY : DRAG_JELLY
    if (this.#options.jelly) {
      this.#stretchX = approach(this.#stretchX, jellyTarget(this.#vx), dt, response.shapeTau)
      this.#stretchY = approach(this.#stretchY, jellyTarget(this.#vy), dt, response.shapeTau)
    } else {
      this.#stretchX = this.#stretchY = 0
    }
    if (!this.#glide && this.#stretchX < SETTLE && this.#stretchY < SETTLE && Math.abs(this.#vx) < SETTLE && Math.abs(this.#vy) < SETTLE) {
      this.#stretchX = this.#stretchY = this.#vx = this.#vy = 0
      this.#write(null)
      return
    }
    const [jx, jy] = jellyScale2(this.#stretchX, this.#stretchY)
    // 飞的时候鼓起：抬起时鼓到一半，中段最大，落地时收回
    let lift = 1
    const g = this.#glide
    if (g) {
      const t = Math.min(1, Math.max(0, (now - g.start) / g.duration))
      lift = 1 + (ELEMENT_FLY_SCALE - 1) * Math.sin(Math.PI * t)
    }
    this.#write({
      dx: v.x + v.w / 2 - (box.x + box.w / 2),
      dy: v.y + v.h / 2 - (box.y + box.h / 2),
      sx: (v.w / box.w) * jx * lift,
      sy: (v.h / box.h) * jy * lift
    })
  }

  #write(p: PanelPresentation | null): void {
    const a = this.#applied
    if (p === a) return
    if (p && a && p.dx === a.dx && p.dy === a.dy && p.sx === a.sx && p.sy === a.sy) return
    this.#applied = p
    this.#apply(p)
  }
}
