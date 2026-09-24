/**
 * 面板与画布之间有什么。
 *
 * Glassium 的玻璃画在画布上，画布在 DOM 内容**下面**。面板和画布之间只要有一层画了背景，
 * 玻璃就被挡住 —— 表现为完全不可见、没有任何报错。这是这套架构能产生的最难查的失效，
 * 这个文件把它变成一句**点名具体元素**的警告。
 *
 * ## 判据是浏览器自己的命中测试顺序，不是按规则推断层叠
 *
 * 计划里写的是「沿祖先链往上查背景」。那样会同时漏报和误报：
 *
 * - 漏报：挡住玻璃的不一定是祖先。一个与面板重叠的兄弟元素（整页的背景 div、
 *   另一张卡片）同样会挡住。
 * - 误报：不是每个有背景的祖先都挡得住。`<html>` 没有背景时，`<body>` 的背景会传播成
 *   根背景、画在画布下面 —— 给 body 设背景完全无害，按祖先链查却会报。
 *
 * 层叠上下文、z-index、定位、tree order 的组合规则太多，自己推断迟早漏掉一种。
 * `document.elementsFromPoint()` 返回的就是该点上从上到下的元素，也就是绘制顺序的逆序 ——
 * 这是浏览器已经算好的答案。于是判据变成：**命中栈里夹在面板和画布之间、并且画了背景的
 * 元素**。画布平时是 `pointer-events: none`，不参与命中测试；检查时临时打开，同步做完
 * 再关上，中间不会有任何事件派发。
 *
 * 同一个命中栈还顺带回答另一个问题：画布是不是画在了面板**上面**（面板所在的层比画布
 * 还低，比如它或它的祖先有负的 z-index）。那种情况下面板和它的文字一起被画布盖住。
 *
 * ## 查不到的
 *
 * 只在面板内的五个采样点上查。只挡住面板一角的元素、`pointer-events: none` 的遮挡层都查不到。
 * 裁剪不在这里管 —— 裁剪由 clipping.ts 直接施加到玻璃上，不需要警告。
 * 藏起来的面板（opacity: 0、visibility: hidden）也不查 —— 它们根本不画。
 */

import { isRendered } from './panels.ts'
import { decompose, linearOfElement, poseOf } from './pose.ts'

/** 计算值里与本检查有关的几项。拆出来是为了让分析逻辑能在 Node 里测。 */
export interface LayerStyle {
  readonly backgroundColor: string
  readonly backgroundImage: string
  readonly opacity: string
  readonly filter: string
  readonly transform: string
  /** CSS Transforms 2 的独立属性。`transform` 的计算值不包含它们。 */
  readonly rotate: string
  readonly scale: string
}

export type LayerRelation = 'self' | 'ancestor' | 'overlap'

export type LayerProblem<E> =
  | {
      /** 画布画在面板上面：面板连同里面的文字都被盖住。 */
      readonly kind: 'canvas-above'
      readonly panel: E
    }
  | {
      /** 面板与画布之间有一层画了背景。 */
      readonly kind: 'covered'
      readonly panel: E
      readonly element: E
      readonly relation: LayerRelation
      /** 背景色的 alpha。有背景图时恒按不透明处理。 */
      readonly alpha: number
      readonly image: boolean
      /** 原样的计算值，放进警告里。 */
      readonly value: string
    }
  | {
      /**
       * DOM 上的效果玻璃跟不上：filter、旋转或倾斜。
       * （opacity 不在这里：玻璃跟着元素的实际不透明度一起淡，见 panels.ts 的 fade。）
       */
      readonly kind: 'filter' | 'transform'
      readonly panel: E
      readonly element: E
      readonly relation: Exclude<LayerRelation, 'overlap'>
      readonly value: string
    }

/**
 * 计算值颜色的 alpha。
 *
 * getComputedStyle 给出的形式有 `rgb(r, g, b)`、`rgba(r, g, b, a)`、`rgb(r g b / a)`、
 * `color(srgb r g b / a)`、`oklch(l c h / a)` 等，alpha 总在最后。
 */
export function cssAlpha(color: string): number {
  const c = color.trim().toLowerCase()
  if (c === '' || c === 'transparent') return 0
  const open = c.indexOf('(')
  if (open < 0 || !c.endsWith(')')) return 1 // 计算值里不会出现具名颜色；万一出现，当不透明
  const body = c.slice(open + 1, -1)

  let raw: string | undefined
  const slash = body.lastIndexOf('/')
  if (slash >= 0) {
    raw = body.slice(slash + 1)
  } else {
    const parts = body.split(',')
    if (parts.length === 4) raw = parts[3]
  }
  if (raw === undefined) return 1

  const t = raw.trim()
  const v = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
}

/** `div#app.wrap.dark` —— 警告里点名元素用。类名多于三个时截断，Tailwind 一类的写法会很长。 */
export function describeElement(el: {
  readonly tagName: string
  readonly id: string
  readonly classList: Iterable<string>
}): string {
  const classes = Array.from(el.classList)
  const shown = classes.slice(0, 3).map((c) => `.${c}`).join('')
  return (
    el.tagName.toLowerCase() +
    (el.id ? `#${el.id}` : '') +
    shown +
    (classes.length > 3 ? '…' : '')
  )
}

/**
 * 分析一个采样点上的命中栈（最上层在前）。
 *
 * @returns 这个点上判断不了时返回 null（面板或画布不在栈里，比如带了 pointer-events: none）
 */
export function analyzeHitStack<E>(
  stack: readonly E[],
  panel: E,
  canvas: E,
  contains: (outer: E, inner: E) => boolean,
  style: (e: E) => LayerStyle
): LayerProblem<E>[] | null {
  const pi = stack.indexOf(panel)
  const ci = stack.indexOf(canvas)
  if (pi < 0 || ci < 0) return null
  if (ci < pi) return [{ kind: 'canvas-above', panel }]

  const out: LayerProblem<E>[] = []
  // 从面板自己开始（它自己的背景同样挡在玻璃前面），到画布为止
  for (let i = pi; i < ci; i++) {
    const element = stack[i]!
    const s = style(element)
    const alpha = cssAlpha(s.backgroundColor)
    const image = s.backgroundImage.trim() !== '' && s.backgroundImage.trim() !== 'none'
    if (alpha <= 0 && !image) continue
    out.push({
      kind: 'covered',
      panel,
      element,
      relation: element === panel ? 'self' : contains(element, panel) ? 'ancestor' : 'overlap',
      alpha: image ? 1 : alpha,
      image,
      value: image ? s.backgroundImage : s.backgroundColor
    })
  }
  return out
}

/**
 * 沿祖先链查玻璃跟不上的 DOM 效果。
 *
 * @param chain 面板自己、父元素、……，到**第一个同时包含画布的祖先之前**为止。
 *   共同祖先上的 filter / transform 同时作用在画布和面板上，两边一致，不算问题。
 *
 * opacity 不查：玻璃按元素的实际不透明度（自己与祖先的乘积）一起淡（panels.ts 的 fade）。
 */
export function analyzeAncestors<E>(
  chain: readonly E[],
  panel: E,
  style: (e: E) => LayerStyle
): LayerProblem<E>[] {
  const out: LayerProblem<E>[] = []
  for (const element of chain) {
    const s = style(element)
    const relation = element === panel ? 'self' : 'ancestor'
    if (s.filter.trim() !== '' && s.filter.trim() !== 'none') {
      out.push({ kind: 'filter', panel, element, relation, value: s.filter })
    }
    // 平移、缩放、旋转玻璃都跟得上（pose.ts）；倾斜、3D、带旋转的镜像跟不上
    const own = linearOfElement(s)
    if (!own || !decompose(own).supported) {
      out.push({ kind: 'transform', panel, element, relation, value: describeTransform(s) })
    }
  }
  // 每一层单独都画得了，合起来却是倾斜的：比如转过的元素外面套了一层不等比缩放
  if (!out.some((p) => p.kind === 'transform') && !poseOf(chain.map(style)).supported) {
    out.push({
      kind: 'transform',
      panel,
      element: panel,
      relation: 'self',
      value: '自己与祖先的变换合起来是倾斜的'
    })
  }
  return out
}

/** 警告里写出元素自己的变换（transform 与 rotate / scale 独立属性）。 */
function describeTransform(s: LayerStyle): string {
  const parts: string[] = []
  if (s.transform.trim() !== 'none') parts.push(s.transform)
  if (s.rotate.trim() !== 'none') parts.push(`rotate: ${s.rotate}`)
  if (s.scale.trim() !== 'none') parts.push(`scale: ${s.scale}`)
  return parts.join('; ') || 'none'
}

/** 问题的去重键。同一块面板上同一个问题只报一次。 */
export function problemKey<E>(p: LayerProblem<E>, name: (e: E) => string): string {
  if (p.kind === 'canvas-above') return p.kind
  return `${p.kind}|${name(p.element)}|${p.value}`
}

const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 警告文本。一句话说清是哪个元素、出了什么事、怎么改。 */
export function describeProblem<E>(p: LayerProblem<E>, name: (e: E) => string): string {
  const panel = name(p.panel)
  if (p.kind === 'canvas-above') {
    return (
      `[Glassium] ${panel} 被画布盖住了：画布画在这块面板上面，面板连同里面的文字都看不见。` +
      '画布在 z-index: -1 的层，面板所在的层比它还低 —— 检查面板和它的祖先有没有负的 z-index。'
    )
  }

  const who = p.relation === 'self' ? panel : `${panel} 的祖先 ${name(p.element)}`
  if (p.kind === 'covered') {
    const opaque = p.image || p.alpha >= 0.999
    const what = p.image
      ? `背景图（${clip(p.value)}）`
      : `${opaque ? '不透明' : `半透明（alpha ${p.alpha.toFixed(2)}）`}背景（${p.value}）`
    const effect = opaque ? '把后面的玻璃整块挡住了 —— 玻璃完全看不见' : '在玻璃上蒙了一层颜色'
    if (p.relation === 'overlap') {
      return (
        `[Glassium] ${name(p.element)} 与 ${panel} 重叠，并且画在面板和画布之间：` +
        `它的${what}${effect}。`
      )
    }
    if (p.relation === 'self') {
      return (
        `[Glassium] ${panel} 自身有${what}，${effect}。` +
        '面板元素的背景应当透明 —— 玻璃就是它的背景。'
      )
    }
    return (
      `[Glassium] ${who} 有${what}，${effect}。` +
      'R1：面板与画布之间的每一层都必须背景透明 —— 页面背景属于场景，不属于 CSS。'
    )
  }
  if (p.kind === 'filter') {
    return `[Glassium] ${who} 有 filter: ${clip(p.value)}：它只作用在 DOM 上，玻璃不受影响。`
  }
  return (
    `[Glassium] ${who} 有倾斜或 3D 变换（${clip(p.value)}）：玻璃只跟得上平移、缩放与旋转，` +
    '这种变换下形状会和元素对不上。'
  )
}

// —— 以下是 DOM 侧 ——

/** 采样点，按面板宽高的比例。中心加四个象限的中心 —— 圆角再大也落在形状内部。 */
const SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75]
]

/**
 * 根背景传播（CSS Backgrounds 3 §2.11.2）：`<html>` 自己没有背景时，`<body>` 的背景
 * 画成整个画布的根背景（最底层），body 自己不再画。计算值里却还是那个颜色 ——
 * 不特判的话，给 body 设背景（极常见的写法）会被误报成挡住了玻璃。
 */
function propagatesToRoot(el: Element): boolean {
  if (el !== document.body) return false
  const root = getComputedStyle(document.documentElement)
  return cssAlpha(root.backgroundColor) === 0 && root.backgroundImage === 'none'
}

function styleOf(el: Element): LayerStyle {
  const s = getComputedStyle(el)
  const propagated = propagatesToRoot(el)
  return {
    backgroundColor: propagated ? 'transparent' : s.backgroundColor,
    backgroundImage: propagated ? 'none' : s.backgroundImage,
    opacity: s.opacity,
    filter: s.filter,
    transform: s.transform,
    rotate: s.rotate,
    scale: s.scale
  }
}

/** 渲染树（flat tree）上的父元素：被 slot 分配的元素按 slot 的位置渲染，影子根的父是宿主。 */
function flatParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot
  if (el.parentElement) return el.parentElement
  const root = el.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

/** 跨影子边界的 contains。原生的 contains 不穿过影子根。 */
function composedContains(outer: Element, inner: Element): boolean {
  for (let e: Element | null = inner; e; e = flatParent(e)) if (e === outer) return true
  return false
}

/**
 * 查一块面板。面板不在视口里、或者根本没画（完全透明、visibility: hidden）时返回 null。
 */
export function inspectPanel(
  panel: HTMLElement,
  canvas: HTMLCanvasElement
): LayerProblem<Element>[] | null {
  // opacity: 0 / visibility: hidden（自身或祖先）的面板根本不画（panels.ts 的 isRendered），
  // 它上面的 opacity 当然也就不是问题 —— 渐隐收起的提示条、菜单常这样藏着
  if (!isRendered(panel)) return null
  const rect = panel.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight

  const points: [number, number][] = []
  for (const [fx, fy] of SAMPLES) {
    const x = rect.left + rect.width * fx
    const y = rect.top + rect.height * fy
    if (x >= 0 && y >= 0 && x < vw && y < vh) points.push([x, y])
  }
  if (points.length === 0) return null

  // 面板在别的组件的影子树里时，要在那棵树上做命中测试才能拿到面板本身（否则拿到的是宿主）
  const root = panel.getRootNode()
  const scope: DocumentOrShadowRoot = root instanceof ShadowRoot ? root : document

  const previous = canvas.style.pointerEvents
  canvas.style.pointerEvents = 'auto'
  let stacks: Element[][]
  try {
    stacks = points.map(([x, y]) => scope.elementsFromPoint(x, y))
  } finally {
    canvas.style.pointerEvents = previous
  }

  const problems: LayerProblem<Element>[] = []
  for (const stack of stacks) {
    const found = analyzeHitStack<Element>(stack, panel, canvas, composedContains, styleOf)
    if (found) problems.push(...found)
  }

  const chain: Element[] = []
  for (let e: Element | null = panel; e && !composedContains(e, canvas); e = flatParent(e)) {
    chain.push(e)
  }
  problems.push(...analyzeAncestors<Element>(chain, panel, styleOf))

  // 五个采样点会重复报同一个元素
  const seen = new Set<string>()
  return problems.filter((p) => {
    const key = problemKey(p, describeElement)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 盯着所有面板，在该查的时候查、查出来就警告（同一个问题只报一次）。
 *
 * 什么时候查：
 * - 注册时，以及面板进入视口时（IntersectionObserver）。命中测试只对视口内的点有效，
 *   所以首屏以下的面板要等滚到它才查得了。
 * - 页面上任何元素的 style / class 变了之后（MutationObserver，节流）。
 *   给外层容器加个背景这种事，大多是通过这两个属性发生的。
 * - 手动调用 check()。
 */
export class LayerWatcher {
  /** 取当前画布 —— 降级时 stage 会换一块新画布，所以不能在构造时存死。 */
  readonly #canvas: () => HTMLCanvasElement
  readonly #enabled: () => boolean
  readonly #io: IntersectionObserver
  readonly #mo: MutationObserver
  readonly #panels = new Set<HTMLElement>()
  readonly #reported = new WeakMap<HTMLElement, Set<string>>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #observingMutations = false

  /** 节流间隔。检查本身不到 1ms，节流是为了不在连续的 class 切换里反复强制布局。 */
  static readonly THROTTLE_MS = 250

  /**
   * @param enabled 当前是否真的在画玻璃。没有 GPU、高对比度模式下玻璃不画，查了也没意义。
   */
  constructor(canvas: () => HTMLCanvasElement, enabled: () => boolean) {
    this.#canvas = canvas
    this.#enabled = enabled
    // IntersectionObserver 只当触发器用，不拿它记「谁在视口里」：它的回调挂在渲染步骤上，
    // 渲染被暂停（标签页或面板隐藏）时一条都不来。在不在视口里由 inspectPanel 当场量。
    this.#io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) this.schedule()
    })
    this.#mo = new MutationObserver((records) => {
      // 检查自己会改画布的 style（临时打开 pointer-events）—— 不排除的话会自己触发自己
      const canvas = this.#canvas()
      if (records.every((r) => r.target === canvas)) return
      this.schedule()
    })
  }

  watch(panel: HTMLElement): void {
    if (this.#panels.has(panel)) return
    this.#panels.add(panel)
    this.#io.observe(panel)
    this.schedule()
    if (!this.#observingMutations) {
      this.#mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class'],
        subtree: true
      })
      this.#observingMutations = true
    }
  }

  unwatch(panel: HTMLElement): void {
    if (!this.#panels.delete(panel)) return
    this.#io.unobserve(panel)
    if (this.#panels.size === 0 && this.#observingMutations) {
      this.#mo.disconnect()
      this.#observingMutations = false
    }
  }

  /** 排一次检查（节流）。 */
  schedule(): void {
    if (this.#timer !== null) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.check()
    }, LayerWatcher.THROTTLE_MS)
  }

  /**
   * 立即检查所有在视口里的面板。新问题 console.warn，并返回**全部**问题（含已经报过的），
   * 供调试与验证读取。
   */
  check(): LayerProblem<Element>[] {
    if (!this.#enabled()) return []
    const all: LayerProblem<Element>[] = []
    for (const panel of this.#panels) {
      if (!panel.isConnected) continue
      const problems = inspectPanel(panel, this.#canvas()) // 不在视口里的返回 null
      if (!problems) continue
      let reported = this.#reported.get(panel)
      if (!reported) {
        reported = new Set()
        this.#reported.set(panel, reported)
      }
      for (const p of problems) {
        all.push(p)
        const key = problemKey(p, describeElement)
        if (reported.has(key)) continue
        reported.add(key)
        // 第二个参数是元素本身：DevTools 里可以直接点过去
        console.warn(describeProblem(p, describeElement), p.kind === 'canvas-above' ? p.panel : p.element)
      }
    }
    return all
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#io.disconnect()
    this.#mo.disconnect()
    this.#observingMutations = false
    this.#panels.clear()
  }
}
