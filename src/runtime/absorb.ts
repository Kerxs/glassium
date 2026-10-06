/**
 * 玻璃后面的 CSS 背景自动收进场景。
 *
 * GPU 玻璃画在页面底下的画布上、只折射场景（limitations.md 的 R1 / R2）：挡在玻璃与画布之间、画了背景的元素会把玻璃
 * 整块挡住。零配置时不能要求作者把背景挪进 `<glass-fill>`，所以 runtime 替他挪：
 * - 找：对每块 runtime 玻璃做一次命中测试（layering.ts 的 inspectPanel，不警告），`covered` 的那些元素就是要收的；
 * - 收：读出元素原来的背景（background.ts 认得纯色、一层渐变、一层同源图片），注册成场景里的背景层填充
 *   （registerFill 的 paint / back，图片用位图填充），再给元素挂 `data-glassium-absorbed`，runtime 的样式表把它的
 *   CSS 背景换成透明 —— 看上去没变，但背景现在在场景里，玻璃看得见、折射得到；
 * - 页面的根背景（`<html>` 的，或者传播过去的 `<body>` 的）画在画布底下，本来就被画布盖住：用一块铺满视口的
 *   填充画进场景，做场景的底色。
 * - 元素的 class / style 变了就重读背景（先摘掉属性读一次计算样式再挂回去）；`:hover` 这类不改属性的变化察觉不到。
 * - 画不了的（多层、fixed、跨源图片……）不收，照旧由 stage 的层级检查警告。
 * - runtime 玻璃一块都没了、或者 configure({ absorbBackgrounds: false })：全部还原。
 *
 * 只对 runtime 管的玻璃（`[glass]`、glass()）做；组件要 configure({ absorbForComponents: true })。
 */

import { sameOriginImage } from '../renderer/paint-content.ts'
import { inspectPanel } from '../renderer/layering.ts'
import type { SceneBitmapFill, SceneFill } from '../renderer/panels.ts'
import { currentStage, onStageChange, type GlassStage } from '../renderer/stage.ts'
import { placeImage, planBackground, type BackgroundPlan, type BackgroundStyle } from './background.ts'
import { isContentBlock, releaseContent, scanContent } from './content.ts'
import { getConfig, onConfigChange } from './config.ts'
import { ABSORBED_ATTRIBUTE, GLASS_ID_ATTRIBUTE } from './styles.ts'

/** runtime 自己的根背景元素（铺满视口、透明、不接收指针）。 */
export const ROOT_FILL_ATTRIBUTE = 'data-glassium-root'

interface Entry {
  readonly element: HTMLElement
  /** 读到的原背景（挂上 absorbed 属性之后计算样式里的 background-* 都被那条简写重置了，只能用这份）。 */
  style: BackgroundStyle
  plan: BackgroundPlan
  /** 颜色或渐变的 CSS 文本（给 registerFill 的 paint）。 */
  paint: string
  image: HTMLImageElement | null
  fill: SceneFill | SceneBitmapFill | null
  /** 根背景的元素：不挂 absorbed 属性（它自己本来就透明）。 */
  readonly root: boolean
}

const entries = new Map<HTMLElement, Entry>()
const warned = new WeakSet<Element>()
let rootEl: HTMLElement | null = null
let stageOf: GlassStage | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let frame = 0
let microtask = false
let subscribed = false
/** 滚动停下之后补一次全量扫描的定时器（见 scheduleScrollScan）。 */
let settle: ReturnType<typeof setTimeout> | null = null
/** 排着的那一帧是不是只扫动了的玻璃（滚动排的是；别的原因排的是全量，两种都排了就全量）。 */
let frameMovedOnly = true
/** 每块玻璃上一次扫描时在文档里的位置（视口矩形 + 页面的滚动量）。 */
const placed = new WeakMap<HTMLElement, string>()

/** 滚动停下这么久之后补一次全量扫描，毫秒。 */
const SCROLL_SETTLE_MS = 150

/** 排一次扫描：immediate 在微任务里（stage 刚建好、玻璃刚注册 —— 要赶在 stage 自己的层级检查之前），否则节流。 */
export function scheduleAbsorb(immediate = false): void {
  subscribe()
  if (immediate) {
    if (microtask) return
    microtask = true
    queueMicrotask(() => {
      microtask = false
      scan()
    })
    return
  }
  if (timer !== null) return
  timer = setTimeout(() => {
    timer = null
    scan()
  }, 150)
}

/**
 * 在下一帧画之前扫（滚动时：玻璃后面换了一块内容，要赶在这一帧画出来之前收进场景，不然 DOM 里的字先露一帧）。
 */
export function scheduleAbsorbFrame(movedOnly = false): void {
  subscribe()
  if (!movedOnly) frameMovedOnly = false
  if (frame !== 0 || typeof requestAnimationFrame === 'undefined') return
  frame = requestAnimationFrame(() => {
    frame = 0
    const only = frameMovedOnly
    frameMovedOnly = true
    scan(only)
  })
}

/**
 * 滚动：下一帧只扫**相对页面动了**的玻璃（吸顶、固定定位的）。跟着页面一起滚的玻璃，下面的内容在滚动时不会换，
 * 每帧对它们重做命中测试是白做 —— 一页十几块玻璃时每帧上百次 elementsFromPoint，滚动一卡一卡的。
 * 已经收进来的块只要还靠近某块玻璃就不放（content.ts 的 RELEASE_MARGIN），跳过它们不会误放。
 * 滚动停下 SCROLL_SETTLE_MS 之后补一次全量扫描，兜住少见的情况（固定定位的内容在滚动的玻璃后面）。
 */
function scheduleScrollScan(): void {
  scheduleAbsorbFrame(true)
  if (settle !== null) clearTimeout(settle)
  settle = setTimeout(() => {
    settle = null
    scheduleAbsorbFrame()
  }, SCROLL_SETTLE_MS)
}

/** 玻璃在文档里的位置变了吗（顺手记下这一次的）。滚动只改视口矩形、不改这个；吸顶、固定定位的玻璃滚动时会变。 */
function movedInDocument(panel: HTMLElement): boolean {
  const r = panel.getBoundingClientRect()
  const key = `${r.left + window.scrollX},${r.top + window.scrollY},${r.width},${r.height}`
  if (placed.get(panel) === key) return false
  placed.set(panel, key)
  return true
}

/** 这个元素的样式变了：收进去的背景要重读。返回它是不是收进去的元素。 */
export function restyleAbsorbed(el: Element): boolean {
  const e = entries.get(el as HTMLElement)
  if (!e || e.root) return false
  apply(e, readBackground(el as HTMLElement, true))
  return true
}

/** 收进场景的元素（调试面板、验证页读）。 */
export function absorbedElements(): HTMLElement[] {
  return [...entries.keys()].filter((el) => el !== rootEl)
}

/** 全部还原：摘属性、注销填充、拿掉根背景元素。 */
export function releaseAbsorbed(): void {
  for (const e of entries.values()) {
    e.fill?.unregister()
    if (!e.root) e.element.removeAttribute(ABSORBED_ATTRIBUTE)
  }
  entries.clear()
  rootEl?.remove()
  rootEl = null
}

function subscribe(): void {
  if (subscribed || typeof window === 'undefined') return
  subscribed = true
  onStageChange(() => scheduleAbsorb(true))
  onConfigChange((c, prev) => {
    if (c.absorbBackgrounds !== prev.absorbBackgrounds || c.absorbForComponents !== prev.absorbForComponents) {
      releaseAbsorbed()
      scheduleAbsorb(true)
    }
    if (c.absorbContent !== prev.absorbContent) {
      releaseContent()
      scheduleAbsorb(true)
    }
  })
  window.addEventListener('scroll', scheduleScrollScan, { passive: true, capture: true })
  window.addEventListener('resize', () => scheduleAbsorbFrame(), { passive: true })
}

/** @param movedOnly 只对相对页面动了的玻璃做命中测试（滚动时，见 scheduleScrollScan） */
function scan(movedOnly = false): void {
  const stage = currentStage()
  const config = getConfig()
  if (stage !== stageOf) {
    // stage 换了（重建）：旧的填充跟着旧 stage 没了，重新注册
    for (const e of entries.values()) e.fill = null
    stageOf = stage
  }
  const selector = config.absorbForComponents ? `[${GLASS_ID_ATTRIBUTE}], [data-glassium-active]` : `[${GLASS_ID_ATTRIBUTE}]`
  const panels = typeof document === 'undefined' ? [] : [...document.querySelectorAll<HTMLElement>(selector)]
  // 每次扫描都记下每块玻璃的位置；只扫动了的时候，没动的跳过命中测试
  const moved = new Set(panels.filter(movedInDocument))
  const probe = (list: readonly HTMLElement[]): readonly HTMLElement[] => (movedOnly ? list.filter((p) => moved.has(p)) : list)
  const content = stage && stage.active && config.absorbContent && panels.length > 0
  if (!content) releaseContent()
  if (!stage || !stage.active || !config.absorbBackgrounds || panels.length === 0) {
    if (entries.size > 0) releaseAbsorbed()
    if (content) {
      const runtime = runtimePanels()
      scanContent(stage!, runtime, takeOverBackground, probe(runtime))
    }
    return
  }
  // 摘出文档的元素（单页应用换页、标签切走）：放掉它的填充、摘掉属性 —— 挂回来时按那时的样式重新收
  for (const e of [...entries.values()]) if (!e.root && !e.element.isConnected) drop(e)
  let added = false
  if (!rootEl) {
    ensureRoot()
    added = true
  } else {
    const root = entries.get(rootEl)
    if (root) apply(root, rootBackground())
  }
  for (const panel of probe(panels)) {
    if (!panel.isConnected) continue
    const problems = inspectPanel(panel, stage.canvas) ?? []
    for (const p of problems) {
      if (p.kind !== 'covered') continue
      const el = p.element as HTMLElement
      if (entries.has(el) || isContentBlock(el) || el === document.documentElement || !(el instanceof HTMLElement)) continue
      if (absorb(el)) added = true
    }
  }
  if (added) reorder(stage)
  else for (const e of entries.values()) if (!e.fill) register(stage, e)
  if (content) {
    const runtime = runtimePanels()
    scanContent(stage, runtime, takeOverBackground, probe(runtime))
  }
}

/** 内容块只看 runtime 的玻璃（组件里的字本来就在组件自己的层里）。 */
function runtimePanels(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${GLASS_ID_ATTRIBUTE}]`)]
}

/** 内容块接管它自己的背景（背景色由内容的 painter 画）：背景层那一份放手。 */
function takeOverBackground(el: HTMLElement): void {
  const e = entries.get(el)
  if (e && !e.root) drop(e)
}

/** 放掉一个收进去的元素：注销填充、摘属性（元素的 CSS 背景回来）。 */
function drop(e: Entry): void {
  e.fill?.unregister()
  e.element.removeAttribute(ABSORBED_ATTRIBUTE)
  entries.delete(e.element)
}

function ensureRoot(): void {
  const el = document.createElement('div')
  el.setAttribute(ROOT_FILL_ATTRIBUTE, '')
  el.setAttribute('aria-hidden', 'true')
  Object.assign(el.style, { position: 'fixed', inset: '0', pointerEvents: 'none', background: 'transparent' })
  document.body.prepend(el)
  rootEl = el
  const style = rootBackground()
  const e: Entry = { element: el, style, plan: { kind: 'none' }, paint: 'transparent', image: null, fill: null, root: true }
  entries.set(el, e)
  apply(e, style)
}

/** 页面的根背景：`<html>` 有背景就是它的，否则是传播过去的 `<body>` 的。 */
function rootBackground(): BackgroundStyle {
  const html = readBackground(document.documentElement, false)
  const empty = (b: BackgroundStyle): boolean => planBackground(b).kind === 'none'
  if (!empty(html) || !document.body) return html
  return readBackground(document.body, false)
}

function readBackground(el: HTMLElement, absorbed: boolean): BackgroundStyle {
  const had = absorbed && el.hasAttribute(ABSORBED_ATTRIBUTE)
  if (had) el.removeAttribute(ABSORBED_ATTRIBUTE)
  const s = getComputedStyle(el)
  const out: BackgroundStyle = {
    color: s.backgroundColor,
    image: s.backgroundImage,
    size: s.backgroundSize,
    position: s.backgroundPosition,
    repeat: s.backgroundRepeat,
    attachment: s.backgroundAttachment
  }
  if (had) el.setAttribute(ABSORBED_ATTRIBUTE, '')
  return out
}

function absorb(el: HTMLElement): boolean {
  const style = readBackground(el, false)
  const plan = planBackground(style)
  if (plan.kind === 'none') return false
  const why =
    plan.kind === 'unsupported'
      ? plan.reason
      : plan.kind === 'image' && !sameOriginImage(plan.url, document.baseURI)
        ? '跨源的背景图（画进画布会污染它）'
        : null
  if (why) {
    if (!warned.has(el)) {
      warned.add(el)
      console.warn(`[Glassium] 玻璃后面这个元素的背景收不进场景（${why}），它会挡住玻璃：`, el)
    }
    return false
  }
  const e: Entry = { element: el, style, plan: { kind: 'none' }, paint: 'transparent', image: null, fill: null, root: false }
  entries.set(el, e)
  apply(e, style)
  el.setAttribute(ABSORBED_ATTRIBUTE, '')
  return true
}

/** 换上新的背景：颜色 / 渐变只换文本（填充每帧读 paint），种类变了或换了图要重新注册。 */
function apply(e: Entry, style: BackgroundStyle): void {
  const plan = planBackground(style)
  const before = e.plan
  e.style = style
  e.plan = plan
  if (plan.kind === 'color' || plan.kind === 'gradient') {
    if (plan.kind === 'gradient' && plan.droppedColor && !warned.has(e.element)) {
      warned.add(e.element)
      console.warn('[Glassium] 这个元素的背景色与半透明的渐变叠在一起，收进场景时只画渐变：', e.element)
    }
    e.paint = plan.paint
  } else {
    e.paint = 'transparent'
  }
  if (plan.kind === 'image') {
    if (!e.image || e.image.src !== new URL(plan.url, document.baseURI).href) {
      const img = new Image()
      img.decoding = 'async'
      img.src = plan.url
      e.image = img
      img.decode().then(
        () => (e.fill as SceneBitmapFill | null)?.invalidate?.(),
        () => undefined
      )
    }
    ;(e.fill as SceneBitmapFill | null)?.invalidate?.()
  }
  const kindChanged = (before.kind === 'image') !== (plan.kind === 'image')
  if (kindChanged && e.fill) {
    e.fill.unregister()
    e.fill = null
    if (stageOf) register(stageOf, e)
  }
}

function register(stage: GlassStage, e: Entry): void {
  if (e.plan.kind === 'image') {
    e.fill = stage.registerBitmapFill(
      e.element,
      (ctx, w, h) => {
        const plan = e.plan
        if (plan.kind === 'image' && plan.color) {
          ctx.fillStyle = plan.color
          ctx.fillRect(0, 0, w, h)
        }
        const img = e.image
        if (!img || !img.complete || !(img.naturalWidth > 0)) return
        const bg = e.style
        const at = placeImage(w, h, img.naturalWidth, img.naturalHeight, bg.size, bg.position, bg.repeat)
        if (!(at.w > 0 && at.h > 0)) return
        const x0 = at.repeatX ? at.x - Math.ceil(at.x / at.w) * at.w : at.x
        const y0 = at.repeatY ? at.y - Math.ceil(at.y / at.h) * at.h : at.y
        for (let y = y0; y < h; y += at.h) {
          for (let x = x0; x < w; x += at.w) {
            ctx.drawImage(img, x, y, at.w, at.h)
            if (!at.repeatX) break
          }
          if (!at.repeatY) break
        }
      },
      { back: true }
    )
  } else {
    e.fill = stage.registerFill(e.element, { paint: () => e.paint, back: true })
  }
}

/** 注册顺序就是画的顺序：根背景最先，其余按文档顺序（祖先在子孙前面）。新收了元素时整排重来。 */
function reorder(stage: GlassStage): void {
  for (const e of entries.values()) {
    e.fill?.unregister()
    e.fill = null
  }
  const list = [...entries.values()].sort((a, b) => {
    if (a.root !== b.root) return a.root ? -1 : 1
    const pos = a.element.compareDocumentPosition(b.element)
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0
  })
  for (const e of list) register(stage, e)
}
