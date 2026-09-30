/**
 * 站点外壳（index.html）：顶部的玻璃导航 + 五个标签，地址带 #标签（#overview、#controls、#devices、#editor、#dev）。
 *
 * - 整页一个 stage（R3）：runtime 看到页头的 [glass] 就建（configure 的 backend 在它建之前设好）；各标签共用它。
 * - 标签的正文在 index.html 的 <template> 里，第一次进入时克隆成 <section data-tab="…">、动态引入它的模块（分包，
 *   首屏只下载当前标签）、mount 一次。
 * - 切换 = 把旧 section 从文档里摘下、把新的挂上：组件的 disconnected / connected、runtime 的 MutationObserver
 *   自己注销 / 重新注册玻璃，收进场景的背景与内容块跟着放掉 —— 切走的标签一块玻璃都不画。
 *   模块的 activate / deactivate 管这一节自己对 stage 的设定（场景、位图填充、调试视图……）和它的动画。
 * - 认两个地址参数：?glassium.backend=webgl2 换后端，?glassium.simulate=no-webgpu 走一遍降级。
 */

import glassium, { configure, simulateNoWebGpu, type GlassStage } from 'glassium'

// —— 后端参数：模块一开始就设（runtime 在这个模块跑完之后的微任务里才开始建 stage） ——

const params = new URLSearchParams(location.search)
if (params.get('glassium.simulate') === 'no-webgpu') simulateNoWebGpu(true)
const requested = params.get('glassium.backend')
if (requested === 'webgl2' || requested === 'webgpu') configure({ backend: requested })

// —— 标签 ——

interface TabModule {
  mount?(section: HTMLElement): void
  activate?(stage: GlassStage | null): void
  deactivate?(stage: GlassStage | null): void
}

const TABS = ['overview', 'controls', 'devices', 'editor', 'dev'] as const
type TabName = (typeof TABS)[number]

const LOADERS: Record<TabName, () => Promise<TabModule>> = {
  overview: () => import('./tabs/overview.ts'),
  controls: () => import('./tabs/controls.ts'),
  devices: () => import('./tabs/devices.ts'),
  editor: () => import('./tabs/editor.ts'),
  dev: async () => devTab
}

const TITLES: Record<TabName, string> = {
  overview: 'Glassium · 网页上的液态玻璃',
  controls: 'Glassium · 控件',
  devices: 'Glassium · iPhone 与 Mac',
  editor: 'Glassium · 材质编辑器',
  dev: 'Glassium · 开发者'
}

/** 「开发者」只有静态的列表：场景是一块深色的底。 */
let devScene: Promise<Blob | HTMLCanvasElement> | null = null
const devTab: TabModule = {
  activate(stage) {
    if (!stage?.active) return
    devScene ??= new Promise((resolve) => {
      const c = document.createElement('canvas')
      c.width = 160
      c.height = 100
      const g = c.getContext('2d')!
      const lg = g.createLinearGradient(0, 0, 160, 100)
      lg.addColorStop(0, '#0b0e18')
      lg.addColorStop(1, '#120b18')
      g.fillStyle = lg
      g.fillRect(0, 0, 160, 100)
      c.toBlob((blob) => resolve(blob ?? c), 'image/png')
    })
    void devScene.then((s) => (current?.name === 'dev' ? stage.setScene(s, { background: '#0b0e18' }) : undefined)).catch(() => undefined)
  }
}

interface Entry {
  readonly name: TabName
  readonly section: HTMLElement
  readonly module: Promise<TabModule>
  mounted: TabModule | null
  active: boolean
}

const main = document.getElementById('site-main')!
const entries = new Map<TabName, Entry>()
let current: Entry | null = null
let token = 0

// runtime 建的 stage（没有 GPU、建不出来时是 null：玻璃留在 CSS 兜底）
const stageReady: Promise<GlassStage | null> = glassium.ready.then(
  () => glassium.stage,
  () => null
)
void stageReady.then((stage) => Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage }))

function entryOf(name: TabName): Entry {
  let e = entries.get(name)
  if (!e) {
    const template = document.getElementById(`tab-${name}`) as HTMLTemplateElement
    const section = document.createElement('section')
    section.dataset.tab = name
    section.setAttribute('aria-label', document.querySelector(`[data-tab-link="${name}"]`)?.textContent ?? name)
    section.append(template.content.cloneNode(true))
    e = { name, section, module: LOADERS[name](), mounted: null, active: false }
    entries.set(name, e)
  }
  return e
}

function markNav(name: TabName): void {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-tab-link]')) {
    const on = a.dataset.tabLink === name
    if (on) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
    // 窄屏上标签横向滚动：当前的那个滚进来
    if (on) {
      const nav = a.parentElement!
      nav.scrollTo({ left: a.offsetLeft - (nav.clientWidth - a.offsetWidth) / 2 })
    }
  }
  // 页面背景按标签换（概览是一个普通网页的渐变，其余透明、背景属于场景）：class 在 html 与 body 上都挂 ——
  // runtime 看着元素的 class 变化重读收进场景的背景
  for (const el of [document.documentElement, document.body]) {
    for (const t of TABS) el.classList.toggle(`tab-${t}`, t === name)
  }
  document.title = TITLES[name]
}

async function show(name: TabName, scroll: boolean): Promise<void> {
  if (current?.name === name) return
  const my = ++token
  const previous = current
  if (previous) {
    if (previous.active) {
      previous.active = false
      previous.mounted?.deactivate?.(await stageReady)
    }
    previous.section.remove()
  }
  if (my !== token) return
  const entry = entryOf(name)
  current = entry
  markNav(name)
  main.append(entry.section)
  if (scroll) scrollTo(0, 0)

  let mod: TabModule
  try {
    mod = await entry.module
  } catch (err) {
    console.error(`[Glassium 站点] 标签 ${name} 加载失败：`, err)
    return
  }
  if (!entry.mounted) {
    mod.mount?.(entry.section)
    entry.mounted = mod
  }
  const stage = await stageReady
  if (my !== token || current !== entry) return
  entry.active = true
  mod.activate?.(stage)
}

function tabFromHash(): TabName | null {
  const name = location.hash.slice(1)
  return (TABS as readonly string[]).includes(name) ? (name as TabName) : null
}

// 不认识的 #（页面里的锚点，比如 #content）：留在当前标签
addEventListener('hashchange', () => {
  const name = tabFromHash()
  if (name) void show(name, true)
})
void show(tabFromHash() ?? 'overview', false)
