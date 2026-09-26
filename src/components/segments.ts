/**
 * 一排「段」里选一个：分段控件（`<glass-segmented>`）与标签栏（`<glass-tab-bar>`）共用。
 *
 * 管：各段的角色与选中标记（roving tabindex：只有选中的那段可以 Tab 到）、旋钮的位置（按选中那段的布局写成
 * 旋钮上的 `--_x` / `--_w`，程序换选中时的过渡交给 CSS）、指针（点一段选中它；按住选中的那段可以拖动旋钮，松手时选中
 * 旋钮中心所在的段）、键盘（方向键在段之间移动并选中、到头回绕，Home / End，空格）。
 *
 * 用户换选中（点、键盘、拖完松手）时旋钮「飞」过去（glide.ts）：宿主带 `data-flying`、按下（onPress(true)）—— 旋钮
 * 鼓起成透镜，位置逐帧写、喂给果冻（顺着速度拉长），落地后松开（onPress(false)）缩回。选中与事件照旧立刻生效。
 *
 * 不管：表单、初始值、选中之后派发什么事件、旋钮的材质 —— 这些经回调交给组件。
 */

import { Glide } from './glide.ts'
import { Jelly } from './jelly.ts'

/** 拖过这么多 CSS 像素才算拖动（否则是点击）。 */
const DRAG_THRESHOLD = 3

/** 一段的值：`value` 属性，没有就取文字。 */
export function segmentValue(segment: Element): string {
  return segment.getAttribute('value') ?? segment.textContent?.trim() ?? ''
}

export interface SegmentsOptions {
  readonly host: HTMLElement
  /** 垫在选中的段下面的那一块（玻璃旋钮或气泡）。 */
  readonly thumb: HTMLElement
  /** 与旋钮同一个位置、宽度的元素（按住时垫在透镜下面的那块白）：`--_x` / `--_w` 同样写给它们。 */
  readonly followers?: readonly HTMLElement[]
  /** 段的角色与表示选中的属性：分段控件是 radio / aria-checked，标签栏是 tab / aria-selected。 */
  readonly role: 'radio' | 'tab'
  readonly selectedAttribute: 'aria-checked' | 'aria-selected'
  /** 旋钮离宿主左右边缘至少这么远（宿主的内边距），CSS 像素。 */
  readonly inset: number
  readonly isDisabled: () => boolean
  /** 按下 / 松开：组件切旋钮的材质与大小。 */
  readonly onPress: (pressed: boolean) => void
  /** 用户（点、拖、键盘）换了选中：组件派发事件。 */
  readonly onUserSelect: () => void
  /** 选中变了（用户或程序，含变成没有选中）：组件更新表单值之类。 */
  readonly onSelectionChange: (value: string | null) => void
}

export class Segments {
  readonly #o: SegmentsOptions
  #selected = -1
  #lastValue: string | null = null
  /** 旋钮放到过一个真实的位置没有。第一次放不走过渡 —— 否则页面一加载它就从宽 0 的地方「长」出来。 */
  #placed = false
  /** 上一次 #mark 选中的段变没变。 */
  #changed = false

  /** 最后写到旋钮上的位置与宽度（飞行从这里起飞）。 */
  #x = 0
  #w = 0
  /** 用户换选中之后正在飞（glide.ts）。 */
  #flying = false
  readonly #glide = new Glide(
    (box, now) => {
      this.#set('--_x', `${box.x}px`)
      this.#set('--_w', `${box.w}px`)
      this.#jelly.move(box.x, now, 0)
    },
    () => this.#land()
  )

  #pointerId: number | null = null
  #startX = 0
  #dragging = false
  #grab = 0
  /** 拖动时的果冻：旋钮与跟随者顺着速度拉长，停下来平滑地回去（jelly.ts）。 */
  readonly #jelly = new Jelly((sx, sy) => {
    for (const el of this.#movers()) {
      el.style.setProperty('--_jx', String(sx))
      el.style.setProperty('--_jy', String(sy))
    }
  })

  constructor(options: SegmentsOptions) {
    this.#o = options
    const host = options.host
    host.addEventListener('pointerdown', this.#onPointerDown)
    host.addEventListener('pointermove', this.#onPointerMove)
    host.addEventListener('pointerup', this.#onPointerUp)
    host.addEventListener('pointercancel', this.#onPointerCancel)
    host.addEventListener('keydown', this.#onKeyDown)
  }

  /** 各段：宿主的子元素。 */
  get items(): HTMLElement[] {
    return Array.from(this.#o.host.children) as HTMLElement[]
  }

  get selected(): number {
    return this.#selected
  }

  /** 选中的那段的值（按选中时记下的，子元素变了也还在）；一个都没选时是 null。 */
  get lastValue(): string | null {
    return this.#lastValue
  }

  indexOf(value: string): number {
    return this.items.findIndex((s) => segmentValue(s) === value)
  }

  /** 选中第 index 段（越界是都不选）：刷新各段的标记与 tabindex、放旋钮。返回选中的段变没变。 */
  select(index: number): boolean {
    this.#mark(index)
    this.place()
    return this.#changed
  }

  /** 选中第 index 段的标记与 tabindex（不放旋钮）。 */
  #mark(index: number): void {
    const items = this.items
    const i = index >= 0 && index < items.length ? index : -1
    const changed = i !== this.#selected
    this.#selected = i
    this.#lastValue = i >= 0 ? segmentValue(items[i]!) : null
    const disabled = this.#o.isDisabled()
    items.forEach((s, k) => {
      if (!s.hasAttribute('role')) s.setAttribute('role', this.#o.role)
      s.setAttribute(this.#o.selectedAttribute, String(k === i))
      // roving tabindex：只有选中的那段（都没选时是第一段）可以 Tab 到
      s.tabIndex = !disabled && (k === i || (i < 0 && k === 0)) ? 0 : -1
    })
    this.#changed = changed
    this.#o.onSelectionChange(this.#lastValue)
  }

  /**
   * 旋钮放到选中的段下面（拖动时由指针决定，不在这里）。第一次放到一个真实的位置时关掉过渡：
   * 之后换选中才滑过去。段还没有布局（宽 0）时不算放过，等 ResizeObserver 下次再放。
   */
  place(): void {
    if (this.#dragging || this.#flying) return
    const s = this.items[this.#selected]
    if (!s) {
      this.#set('--_w', '0px')
      return
    }
    const first = !this.#placed && s.offsetWidth > 0
    const movers = this.#movers()
    if (first) for (const el of movers) el.style.transition = 'none'
    this.#set('--_x', `${s.offsetLeft}px`)
    this.#set('--_w', `${s.offsetWidth}px`)
    if (first) {
      void this.#o.thumb.offsetWidth // 先让没有过渡的位置生效，再把过渡还回去
      for (const el of movers) el.style.removeProperty('transition')
      this.#placed = true
    }
  }

  /** 旋钮与跟随者。 */
  #movers(): readonly HTMLElement[] {
    const f = this.#o.followers
    return f && f.length > 0 ? [this.#o.thumb, ...f] : [this.#o.thumb]
  }

  #set(name: '--_x' | '--_w', value: string): void {
    const n = parseFloat(value)
    if (name === '--_x') this.#x = n
    else this.#w = n
    for (const el of this.#movers()) el.style.setProperty(name, value)
  }

  /** 松开指针、结束拖动（禁用、离开文档时）。 */
  release(): void {
    this.#jelly.reset()
    const pressed = this.#pointerId !== null || this.#flying
    this.#glide.stop()
    this.#setFlying(false)
    this.#endPointer()
    if (pressed) this.#o.onPress(false)
    this.place()
  }

  /**
   * 用户换选中（点、键盘、拖完松手）：旋钮从现在的位置飞过去，变了就通知组件派发事件。
   * 旋钮还没放过（没有布局）时直接放，不飞；飞不了（减少动效）时 Glide 直接落地。
   */
  #userSelect(index: number): void {
    const s = this.items[index]
    // 没放过（没有布局）、或者就在原地（空格键、点回选中的那段）：不飞
    if (!s || !this.#placed || (index === this.#selected && Math.abs(s.offsetLeft - this.#x) < 0.5)) {
      this.#o.onPress(false)
      if (this.select(index)) this.#o.onUserSelect()
      return
    }
    this.#setFlying(true)
    this.#o.onPress(true)
    this.#mark(index)
    const changed = this.#changed
    this.#glide.start({ x: this.#x, w: this.#w }, { x: s.offsetLeft, w: s.offsetWidth })
    if (changed) this.#o.onUserSelect()
  }

  /** 落地：松开（透镜缩回），旋钮按选中的段放好（布局在飞的时候变过也对得上）。 */
  #land(): void {
    this.#setFlying(false)
    this.#jelly.release()
    this.#o.onPress(false)
    this.place()
  }

  #setFlying(on: boolean): void {
    this.#flying = on
    this.#o.host.toggleAttribute('data-flying', on)
  }

  /** 指针下面是第几段（按水平位置，落在两段之间的缝里算离得近的那段）。 */
  #segmentAt(clientX: number): number {
    let best = -1
    let bestDistance = Infinity
    this.items.forEach((s, k) => {
      const r = s.getBoundingClientRect()
      const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
      if (d < bestDistance) {
        bestDistance = d
        best = k
      }
    })
    return best
  }

  #onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.#o.isDisabled() || this.items.length === 0) return
    // 正在飞：停在半路，接着按下 / 拖动（松手时再从这里飞）
    if (this.#glide.cancel()) this.#setFlying(false)
    this.#pointerId = e.pointerId
    this.#startX = e.clientX
    this.#dragging = false
    const t = this.#o.thumb.getBoundingClientRect()
    this.#grab = e.clientX - (t.left + t.width / 2)
    try {
      this.#o.host.setPointerCapture(e.pointerId)
    } catch {
      // 合成的事件没有活的指针
    }
    this.#o.onPress(true)
  }

  #onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    if (!this.#dragging && Math.abs(e.clientX - this.#startX) < DRAG_THRESHOLD) return
    // 只有按在选中的那段（旋钮）上才拖得动旋钮；按在别的段上移动不算拖
    const current = this.items[this.#selected]
    const host = this.#o.host
    if (!this.#dragging) {
      if (!current || this.#segmentAt(this.#startX) !== this.#selected) return
      this.#dragging = true
      host.toggleAttribute('data-dragging', true)
    }
    // 旋钮中心跟着指针（扣掉按下时的偏移），钳在宿主的内容区里
    const r = host.getBoundingClientRect()
    const w = current ? current.offsetWidth : 0
    const scale = host.offsetWidth > 0 ? r.width / host.offsetWidth : 1
    const center = (e.clientX - this.#grab - r.left) / scale
    const inset = this.#o.inset
    const x = Math.min(host.offsetWidth - inset - w, Math.max(inset, center - w / 2))
    this.#set('--_x', `${x}px`)
    this.#jelly.move(e.clientX, e.timeStamp)
  }

  #onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    const dragged = this.#dragging
    const t = this.#o.thumb.getBoundingClientRect()
    const target = dragged ? this.#segmentAt(t.left + t.width / 2) : this.#segmentAt(e.clientX)
    this.#endPointer()
    // 点了选中的那段（没拖）：松开就好；别的都飞过去（拖完松手也是从手指放下的地方飞到那一段）
    if (target >= 0 && (dragged || target !== this.#selected)) this.#userSelect(target)
    else {
      this.#o.onPress(false)
      this.place()
    }
  }

  #onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.#pointerId) return
    this.#endPointer()
    this.#o.onPress(false)
    this.place()
  }

  #endPointer(): void {
    this.#jelly.release()
    this.#pointerId = null
    this.#dragging = false
    this.#o.host.removeAttribute('data-dragging')
  }

  #onKeyDown = (e: KeyboardEvent): void => {
    if (this.#o.isDisabled() || e.defaultPrevented) return
    const items = this.items
    const n = items.length
    if (n === 0) return
    const from = this.#selected >= 0 ? this.#selected : 0
    let next: number
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (from + 1) % n
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (from - 1 + n) % n
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = n - 1
        break
      case ' ':
        next = from
        break
      default:
        return
    }
    e.preventDefault()
    this.#userSelect(next)
    items[next]?.focus()
  }
}
