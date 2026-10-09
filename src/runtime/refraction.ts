/**
 * CSS 画的玻璃的折射与色散（Chromium）。
 *
 * GPU 玻璃的折射在着色器里做；CSS 画的玻璃（`backend: 'css'`、对话框 / popover 里、写了 `overlay` 的）以前只有模糊、
 * 着色和几道近似的亮边（overlay.ts），边上的东西不会被拉弯。Chromium 的 `backdrop-filter` 认 SVG 滤镜（`url(#id)`），
 * 这里给每块这样的玻璃建一个 `<filter>`：一张位移图（`feImage`）+ `feDisplacementMap`，把玻璃后面的东西在边上那一圈往外
 * 拉 —— 和 GPU 玻璃一样，边上看见的是外面一点的东西，越靠边拉得越多；有色散时红、绿、蓝各位移一次、拉得多少略有不同，
 * 再合起来，边上就分出颜色。
 *
 * - 位移图按元素的尺寸与圆角算（CSS 像素），只算边上那一圈，中间是中性色（不动）；用 `toBlob` 异步编码，
 *   编码不占主线程；同样尺寸、圆角、宽度的玻璃共用一张（引用计数；没人用的先留着几十张，来回切页不重算）。
 * - 边上那一圈多宽跟着 `refraction`（短边 × refraction × 0.5，3–48px），拉多远跟着 `distortion`，色散跟着 `dispersion`。
 * - 只管 CSS 画的玻璃：GPU 玻璃（`data-glassium-active` 且不是 overlay）不建，免得白生成位移图；
 *   两个属性变了跟着建或拆（MutationObserver 只看这两个属性）。尺寸变了重算（ResizeObserver，一帧合并一次）。
 * - 只在 Chromium 上做（别的浏览器的 backdrop-filter 不认 url()，整条声明会作废）；`configure({ cssRefraction: false })` 关掉。
 */

import type { GlassMaterial } from '../core/material.ts'
import { ACTIVE_ATTRIBUTE } from './binding.ts'
import { getConfig } from './config.ts'

/** 叠在 CSS 玻璃的 backdrop-filter 后面的变量（runtime 样式表里用，styles.ts）。 */
export const REFRACT_VAR = '--glassium-refract'
const OVERLAY = 'data-glassium-overlay'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** 边上那一圈最窄、最宽（CSS 像素）。 */
const BAND_MIN = 3
const BAND_MAX = 48
/** 拉得最远是边宽的这么多倍（distortion = 1 时）。 */
const PULL = 0.8
/** 色散：红、蓝两份比绿的多拉 / 少拉这么多（dispersion = 1 时）。 */
const SPREAD = 0.14

/** 浏览器是 Chromium 吗（只有它的 backdrop-filter 认 SVG 滤镜）。 */
export function refractionSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return false
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands
  if (brands?.some((b) => b.brand === 'Chromium')) return true
  return /\bChrome\/\d/.test(navigator.userAgent) && !/\bEdge\/\d/.test(navigator.userAgent)
}

/** 位移图的参数：决定图长什么样的那几样。 */
export interface MapShape {
  readonly width: number
  readonly height: number
  readonly radius: number
  readonly band: number
}

/** 边宽：短边 × refraction × 0.5，钳在 3–48px。refraction 不大于 0 时是 0（不折射）。 */
export function bandOf(refraction: number, width: number, height: number): number {
  if (!(refraction > 0)) return 0
  return Math.round(Math.min(BAND_MAX, Math.max(BAND_MIN, refraction * Math.min(width, height) * 0.5)))
}

/** feDisplacementMap 的 scale：位移图的通道值 0–1 映射成 ±scale/2 像素。最远拉 band × PULL × distortion。 */
export function scaleOf(band: number, distortion: number): number {
  return Math.round(band * PULL * Math.max(0, distortion) * 2 * 10) / 10
}

/**
 * 位移图的像素（RGBA）：R 管 x、G 管 y，128 是不动；边上那一圈沿着朝外的法线往外拉，越靠边越多（平方）。
 * 圆角矩形的有符号距离与法线和 GPU 那边同一个形状（导出给测试）。
 */
export function mapPixels(shape: MapShape): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h, band } = shape
  const r = Math.min(shape.radius, w / 2, h / 2)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128
    data[i + 1] = 128
    data[i + 2] = 128
    data[i + 3] = 255
  }
  if (band <= 0) return data
  // 有符号距离：里面为负
  const sdf = (x: number, y: number): number => {
    const qx = Math.abs(x - w / 2) - (w / 2 - r)
    const qy = Math.abs(y - h / 2) - (h / 2 - r)
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  }
  const fill = (x: number, y: number): void => {
    const px = x + 0.5
    const py = y + 0.5
    const inside = -sdf(px, py)
    if (inside < 0 || inside >= band) return
    // 法线：距离场的梯度（朝外）
    const gx = sdf(px + 0.5, py) - sdf(px - 0.5, py)
    const gy = sdf(px, py + 0.5) - sdf(px, py - 0.5)
    const len = Math.hypot(gx, gy) || 1
    const t = 1 - inside / band
    const k = t * t
    const i = (y * w + x) * 4
    data[i] = 128 + 127 * k * (gx / len)
    data[i + 1] = 128 + 127 * k * (gy / len)
  }
  // 只走边上那一圈：上下两条整行、左右两条
  for (let y = 0; y < h; y++) {
    if (y < band || y >= h - band) {
      for (let x = 0; x < w; x++) fill(x, y)
    } else {
      for (let x = 0; x < Math.min(band, w); x++) fill(x, y)
      for (let x = Math.max(w - band, band); x < w; x++) fill(x, y)
    }
  }
  return data
}

// —— 位移图缓存（同样形状的共用一张，引用计数；没人用的先留着，最多 SPARE_MAPS 张，按最近使用淘汰） ——

/** 没人用了还留着的位移图最多几张：单页应用来回切页时，同样尺寸的玻璃又会出现，不必重算、重编码 */
const SPARE_MAPS = 48

interface MapEntry {
  url: Promise<string | null>
  refs: number
}
const maps = new Map<string, MapEntry>()

const keyOf = (s: MapShape): string => `${s.width}x${s.height}r${s.radius}b${s.band}`

function acquireMap(shape: MapShape): Promise<string | null> {
  const key = keyOf(shape)
  let entry = maps.get(key)
  if (!entry) entry = { url: renderMap(shape), refs: 0 }
  // 挪到最后：Map 按插入顺序，最前面的是最久没用的
  maps.delete(key)
  maps.set(key, entry)
  entry.refs++
  return entry.url
}

function releaseMap(shape: MapShape): void {
  const entry = maps.get(keyOf(shape))
  if (!entry || --entry.refs > 0) return
  // 没人用了：先留着，超过 SPARE_MAPS 张时从最久没用的放起
  let spare = 0
  for (const e of maps.values()) if (e.refs <= 0) spare++
  for (const [key, e] of maps) {
    if (spare <= SPARE_MAPS) break
    if (e.refs > 0) continue
    maps.delete(key)
    spare--
    void e.url.then((url) => url && URL.revokeObjectURL(url))
  }
}

function renderMap(shape: MapShape): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = shape.width
  canvas.height = shape.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.putImageData(new ImageData(mapPixels(shape), shape.width, shape.height), 0, 0)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png'))
}

// —— 每块玻璃的滤镜 ——

interface Tracked {
  readonly element: HTMLElement
  readonly id: string
  material: GlassMaterial
  shape: MapShape | null
  filter: SVGFilterElement | null
  /** 这一块现在是 CSS 画的、要折射。 */
  on: boolean
}

const tracked = new Map<string, Tracked>()
const byElement = new WeakMap<Element, Tracked>()
let svgRoot: SVGSVGElement | null = null
let resize: ResizeObserver | null = null
let attrs: MutationObserver | null = null
let frame = 0
const dirty = new Set<Tracked>()
let setVar: (id: string, value: string | null) => void = () => {}

/** styles.ts 注册：这块玻璃的 `--glassium-refract` 写成什么（null 是不写）。 */
export function onRefractVar(fn: (id: string, value: string | null) => void): void {
  setVar = fn
}

/** 这块玻璃的材质（或者连没连着）变了：建、更新或者拆它的滤镜。 */
export function syncRefraction(element: HTMLElement, id: string, material: GlassMaterial, connected = true): void {
  if (!connected || !getConfig().cssRefraction || !refractionSupported()) {
    dropRefraction(id)
    return
  }
  let t = tracked.get(id)
  if (!t) {
    t = { element, id, material, shape: null, filter: null, on: false }
    tracked.set(id, t)
    byElement.set(element, t)
    observe(t)
  }
  t.material = material
  schedule(t)
}

/** 玻璃没了：拆滤镜、放掉位移图、不再看它。 */
export function dropRefraction(id: string): void {
  const t = tracked.get(id)
  if (!t) return
  tracked.delete(id)
  dirty.delete(t)
  resize?.unobserve(t.element)
  teardown(t)
}

function observe(t: Tracked): void {
  if (typeof ResizeObserver !== 'undefined') {
    resize ??= new ResizeObserver((entries) => {
      for (const e of entries) {
        const hit = byElement.get(e.target)
        if (hit && tracked.get(hit.id) === hit) schedule(hit)
      }
    })
    resize.observe(t.element)
  }
  if (typeof MutationObserver !== 'undefined') {
    attrs ??= new MutationObserver((records) => {
      for (const r of records) {
        const hit = byElement.get(r.target as Element)
        if (hit && tracked.get(hit.id) === hit) schedule(hit)
      }
    })
    attrs.observe(t.element, { attributes: true, attributeFilter: [ACTIVE_ATTRIBUTE, OVERLAY] })
  }
}

function schedule(t: Tracked): void {
  dirty.add(t)
  if (frame || typeof requestAnimationFrame === 'undefined') return
  frame = requestAnimationFrame(() => {
    frame = 0
    const batch = [...dirty]
    dirty.clear()
    for (const one of batch) if (tracked.get(one.id) === one) update(one)
  })
}

/** CSS 画的吗：GPU 玻璃生效了、又不是 overlay 的，不用这里管。 */
function drawnWithCss(el: HTMLElement): boolean {
  return !el.hasAttribute(ACTIVE_ATTRIBUTE) || el.hasAttribute(OVERLAY)
}

function update(t: Tracked): void {
  const el = t.element
  const m = t.material
  const width = Math.round(el.offsetWidth)
  const height = Math.round(el.offsetHeight)
  const band = bandOf(m.refraction ?? 0, width, height)
  if (!el.isConnected || !drawnWithCss(el) || band <= 0 || width < 4 || height < 4) {
    teardown(t)
    return
  }
  const style = getComputedStyle(el)
  const radius = Math.round(Math.min(parseFloat(style.borderTopLeftRadius) || 0, width / 2, height / 2))
  const shape: MapShape = { width, height, radius, band }
  const filter = (t.filter ??= makeFilter(t.id))
  if (t.shape !== null && keyOf(t.shape) === keyOf(shape)) {
    writeFilter(filter, shape, m, true)
  } else {
    // 换了形状：换一张位移图（异步编码好了再写进去；这期间又换了、或者拆了就不写）
    const previous = t.shape
    t.shape = shape
    const url = acquireMap(shape)
    if (previous) releaseMap(previous)
    writeFilter(filter, shape, m, false)
    void url.then((href) => {
      if (t.shape === shape && t.filter === filter && href) filter.querySelector('feImage')?.setAttribute('href', href)
    })
  }
  if (!t.on) {
    t.on = true
    setVar(t.id, `url(#${filter.id})`)
  }
}

function teardown(t: Tracked): void {
  if (t.on) {
    t.on = false
    setVar(t.id, null)
  }
  t.filter?.remove()
  t.filter = null
  if (t.shape) releaseMap(t.shape)
  t.shape = null
}

function makeFilter(id: string): SVGFilterElement {
  if (!svgRoot || !svgRoot.isConnected) {
    svgRoot = document.createElementNS(SVG_NS, 'svg')
    svgRoot.setAttribute('aria-hidden', 'true')
    svgRoot.setAttribute('width', '0')
    svgRoot.setAttribute('height', '0')
    svgRoot.style.position = 'absolute'
    svgRoot.style.pointerEvents = 'none'
    document.body.append(svgRoot)
  }
  const filter = document.createElementNS(SVG_NS, 'filter')
  filter.id = `glassium-refract-${id}`
  for (const [k, v] of Object.entries({ x: '0', y: '0', width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' })) {
    filter.setAttribute(k, v)
  }
  svgRoot.append(filter)
  return filter
}

/**
 * 滤镜的内容：位移图一张，按色散位移一次或三次（红、绿、蓝各一次，再合起来）。参数没变不重写。
 * `keepMap`：还是同一张位移图（形状没变），重写时把它带上
 */
function writeFilter(filter: SVGFilterElement, shape: MapShape, m: GlassMaterial, keepMap: boolean): void {
  const scale = scaleOf(shape.band, m.distortion ?? 0)
  const dispersion = Math.max(0, m.dispersion ?? 0)
  const signature = `${keyOf(shape)}|${scale}|${dispersion}`
  if (filter.dataset.signature === signature) return
  filter.dataset.signature = signature
  const href = keepMap ? (filter.querySelector('feImage')?.getAttribute('href') ?? null) : null
  const el = (tag: string, attrs: Record<string, string | number>): SVGElement => {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
    return node
  }
  const image = el('feImage', { x: 0, y: 0, width: shape.width, height: shape.height, preserveAspectRatio: 'none', result: 'map' })
  if (href) image.setAttribute('href', href)
  const shift = (s: number, result: string): SVGElement =>
    el('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: Math.round(s * 10) / 10, xChannelSelector: 'R', yChannelSelector: 'G', result })
  if (dispersion < 0.01) {
    filter.replaceChildren(image, shift(scale, 'out'))
    return
  }
  const spread = SPREAD * Math.min(dispersion, 2)
  const only = (channel: 0 | 1 | 2, input: string, result: string): SVGElement => {
    const rows = [0, 1, 2].map((c) => (c === channel ? [0, 0, 0, 0, 0].map((_, k) => (k === c ? 1 : 0)) : [0, 0, 0, 0, 0]).join(' '))
    return el('feColorMatrix', { in: input, type: 'matrix', values: `${rows.join('  ')}  0 0 0 1 0`, result })
  }
  filter.replaceChildren(
    image,
    shift(scale * (1 + spread), 'r0'),
    only(0, 'r0', 'r'),
    shift(scale, 'g0'),
    only(1, 'g0', 'g'),
    shift(scale * (1 - spread), 'b0'),
    only(2, 'b0', 'b'),
    el('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }),
    el('feBlend', { in: 'rg', in2: 'b', mode: 'screen' })
  )
}
