/**
 * 填充的渐变：`--glass-fill` 写成 `linear-gradient()` / `radial-gradient()`（以及 `repeating-` 两种）时的解析与几何。
 *
 * 纯函数，没有 DOM：颜色交给调用方传进来的解析器（渲染器那边用 fills.ts 的 parseFillColor，它会让浏览器
 * 换算具名颜色、oklch()、display-p3 这些）。几何按 CSS Images 的规则解算成「盒子里的一条线段 / 一个椭圆」，
 * 着色器按它逐像素求渐变位置 t，再在色标之间插值（fill.wgsl.ts）。
 *
 * 输入是浏览器给的计算值，不是作者写的原文。实测 Chrome 的写法：具名颜色、currentcolor、oklch() 原样保留，
 * hex / hsl 换成 rgb()；角度单位原样（0.25turn、1rad）；`to top right` 写成 `to right top`；带两个位置的色标
 * 展开成两个色标；径向的默认值（ellipse、at center）省略。
 */

/** 未预乘的 sRGB [r, g, b, a]，0–1。 */
export type Rgba = readonly [number, number, number, number]

/**
 * 一个长度：百分比、CSS 像素，或两者之和（计算值里的 `calc(100% - 24px)`：value 是百分比那一项，px 是像素那一项）。
 */
export type Length =
  | { readonly value: number; readonly unit: '%' | 'px' }
  | { readonly value: number; readonly unit: 'calc'; readonly px: number }

export interface GradientStop {
  readonly color: Rgba
  /** 没写位置是 null（按 CSS 的规则补，见 resolveStopOffsets）。 */
  readonly position: Length | null
}

/** 线性渐变的方向：角度（CSS 的约定：0deg 朝上、顺时针），或朝向一个角（x、y 各是 −1 或 +1）。 */
export type LinearDirection =
  | { readonly angle: number }
  | { readonly corner: readonly [number, number] }

export type RadialExtent = 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner'

export type RadialSize = RadialExtent | readonly [Length] | readonly [Length, Length]

export type FillPaint =
  | { readonly kind: 'solid'; readonly color: Rgba }
  | {
      readonly kind: 'linear'
      readonly repeating: boolean
      readonly direction: LinearDirection
      readonly stops: readonly GradientStop[]
    }
  | {
      readonly kind: 'radial'
      readonly repeating: boolean
      readonly shape: 'circle' | 'ellipse'
      /** 关键字，或显式的半径（圆一个、椭圆两个）。 */
      readonly size: RadialSize
      readonly at: readonly [Length, Length]
      readonly stops: readonly GradientStop[]
    }

/** 着色器里最多几个色标（uniform 的槽位是定长的，见 fill.wgsl.ts）。 */
export const MAX_GRADIENT_STOPS = 5

export interface ParsedPaint {
  readonly paint: FillPaint
  /** 做不到、只能近似的地方（颜色提示、色标太多），调用方警告一次。 */
  readonly warnings: readonly string[]
}

/** 按顶层的分隔符拆开（括号里的不算）。逗号保留空项（`a,,b` 是写错了）；空白分隔时连续的空白算一个。 */
export function splitTopLevel(text: string, separator: ',' | ' '): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (separator === ',' ? ch === ',' : /\s/.test(ch))) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  out.push(current.trim())
  return separator === ' ' ? out.filter((s) => s !== '') : out
}

const ANGLE_UNITS: Readonly<Record<string, number>> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }

/** 角度，换算成度。 */
function parseAngle(token: string): number | null {
  if (token === '0') return 0
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(deg|grad|rad|turn)$/i.exec(token)
  return m ? Number(m[1]) * ANGLE_UNITS[m[2]!.toLowerCase()]! : null
}

function parseLength(token: string): Length | null {
  const calc = /^calc\((.*)\)$/i.exec(token)
  if (calc) return parseCalc(calc[1]!)
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%|px)?$/i.exec(token)
  if (!m) return null
  const value = Number(m[1])
  if (m[2] === '%') return { value, unit: '%' }
  if (m[2] || value === 0) return { value, unit: 'px' }
  return null // 没有单位的非零数不是长度
}

/** calc() 里只有加减、每项是 px 或 % 的（计算值里的 calc 都是这样）。嵌套、乘除不认。 */
function parseCalc(inner: string): Length | null {
  if (/[()*/]/.test(inner)) return null
  const parts = inner.trim().split(/\s+/)
  if (parts.length % 2 === 0) return null
  let px = 0
  let pct = 0
  let sign = 1
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (i % 2 === 1) {
      if (p !== '+' && p !== '-') return null
      sign = p === '+' ? 1 : -1
      continue
    }
    const term = parseLength(p)
    if (!term || term.unit === 'calc') return null
    if (term.unit === '%') pct += sign * term.value
    else px += sign * term.value
  }
  if (pct === 0) return { value: px, unit: 'px' }
  if (px === 0) return { value: pct, unit: '%' }
  return { value: pct, unit: 'calc', px }
}

const SIDES: Readonly<Record<string, number>> = { top: 0, right: 90, bottom: 180, left: 270 }

function parseLinearDirection(arg: string): LinearDirection | null {
  const words = arg.toLowerCase().split(/\s+/)
  if (words[0] === 'to') {
    const rest = words.slice(1)
    if (rest.length === 1 && rest[0]! in SIDES) return { angle: SIDES[rest[0]!]! }
    if (rest.length === 2) {
      let x = 0
      let y = 0
      for (const w of rest) {
        if (w === 'left') x = -1
        else if (w === 'right') x = 1
        else if (w === 'top') y = -1
        else if (w === 'bottom') y = 1
      }
      if (x !== 0 && y !== 0) return { corner: [x, y] }
    }
    return null
  }
  if (words.length !== 1) return null
  const angle = parseAngle(words[0]!)
  return angle === null ? null : { angle }
}

const HALF: Length = { value: 50, unit: '%' }
const POSITION_KEYWORDS: Readonly<Record<string, { readonly axis: 'x' | 'y' | 'either'; readonly value: number }>> = {
  left: { axis: 'x', value: 0 },
  right: { axis: 'x', value: 100 },
  top: { axis: 'y', value: 0 },
  bottom: { axis: 'y', value: 100 },
  center: { axis: 'either', value: 50 }
}

/** `at` 后面的位置：一到两个分量，关键字或长度。关键字可以先写 y（`top left`）。 */
function parsePosition(words: readonly string[]): readonly [Length, Length] | null {
  if (words.length === 0 || words.length > 2) return null
  let x: Length | null = null
  let y: Length | null = null
  const pending: Length[] = []
  for (const w of words) {
    const k = POSITION_KEYWORDS[w]
    if (k) {
      const l: Length = { value: k.value, unit: '%' }
      if (k.axis === 'x') {
        if (x) return null
        x = l
      } else if (k.axis === 'y') {
        if (y) return null
        y = l
      } else {
        pending.push(l)
      }
      continue
    }
    const l = parseLength(w)
    if (!l) return null
    pending.push(l)
  }
  // 长度与 center 按先 x 后 y 填空
  for (const l of pending) {
    if (!x) x = l
    else if (!y) y = l
    else return null
  }
  return [x ?? HALF, y ?? HALF]
}

const EXTENTS: ReadonlySet<string> = new Set(['closest-side', 'closest-corner', 'farthest-side', 'farthest-corner'])

interface RadialShape {
  readonly shape: 'circle' | 'ellipse'
  readonly size: RadialSize
  readonly at: readonly [Length, Length]
}

/** 径向渐变的第一个参数（形状、大小、位置）。不是这种参数（比如它是第一个色标）返回 null。 */
function parseRadialShape(arg: string): RadialShape | null {
  const words = splitTopLevel(arg.toLowerCase(), ' ') // 按顶层切：calc(100% - 10px) 里的空白不算
  const atIndex = words.indexOf('at')
  const head = atIndex >= 0 ? words.slice(0, atIndex) : words
  const at = atIndex >= 0 ? parsePosition(words.slice(atIndex + 1)) : ([HALF, HALF] as const)
  if (!at) return null
  let shape: 'circle' | 'ellipse' | null = null
  let extent: RadialExtent | null = null
  const lengths: Length[] = []
  for (const w of head) {
    if (w === 'circle' || w === 'ellipse') {
      if (shape) return null
      shape = w
    } else if (EXTENTS.has(w)) {
      if (extent) return null
      extent = w as RadialExtent
    } else {
      const l = parseLength(w)
      if (!l) return null
      lengths.push(l)
    }
  }
  if (lengths.length > 2 || (extent && lengths.length > 0)) return null
  if (lengths.length === 1) {
    if (shape === 'ellipse' || lengths[0]!.unit !== 'px') return null // 圆的半径不能是百分比
    return { shape: 'circle', size: [lengths[0]!], at }
  }
  if (lengths.length === 2) {
    if (shape === 'circle') return null
    return { shape: 'ellipse', size: [lengths[0]!, lengths[1]!], at }
  }
  return { shape: shape ?? 'ellipse', size: extent ?? 'farthest-corner', at }
}

/**
 * 解析 `--glass-fill` 的计算值：纯色、线性渐变、径向渐变。别的（conic-gradient、url()、解析不了的颜色）返回 null。
 * parseColor 解析单个颜色（渲染器里是 fills.ts 的 parseFillColor，currentcolor 由调用方换成元素的 color）。
 */
export function parseFillPaint(text: string, parseColor: (css: string) => Rgba | null): ParsedPaint | null {
  const s = text.trim()
  const m = /^(repeating-)?(linear|radial)-gradient\((.*)\)$/is.exec(s)
  if (!m) {
    const color = parseColor(s)
    return color ? { paint: { kind: 'solid', color }, warnings: [] } : null
  }
  const repeating = m[1] !== undefined
  const kind = m[2]!.toLowerCase() as 'linear' | 'radial'
  const args = splitTopLevel(m[3]!, ',')
  if (args.some((a) => a === '')) return null

  // 第一个参数是方向 / 形状，还是第一个色标
  let direction: LinearDirection = { angle: 180 } // 默认 to bottom
  let radial: RadialShape = { shape: 'ellipse', size: 'farthest-corner', at: [HALF, HALF] }
  let first = 0
  if (kind === 'linear') {
    const d = parseLinearDirection(args[0]!)
    if (d) {
      direction = d
      first = 1
    }
  } else {
    const r = parseRadialShape(args[0]!)
    if (r) {
      radial = r
      first = 1
    }
  }

  const stops: GradientStop[] = []
  let hints = 0
  for (const arg of args.slice(first)) {
    const parts = splitTopLevel(arg, ' ')
    if (parts.length === 1 && parseLength(parts[0]!)) {
      hints++ // 颜色提示（单独一个位置）：着色器按线性插值，不挪中点
      continue
    }
    if (parts.length > 3) return null
    const color = parseColor(parts[0]!)
    if (!color) return null
    const positions = parts.slice(1).map(parseLength)
    if (positions.some((p) => p === null)) return null
    if (positions.length === 0) stops.push({ color, position: null })
    for (const p of positions) stops.push({ color, position: p })
  }
  if (stops.length === 0) return null
  if (stops.length === 1) stops.push({ color: stops[0]!.color, position: null }) // 一个色标：整块同色

  const warnings: string[] = []
  if (hints > 0) warnings.push('颜色提示（单独的位置）按没写处理：中点不挪')
  if (stops.length > MAX_GRADIENT_STOPS) {
    warnings.push(`色标超过 ${MAX_GRADIENT_STOPS} 个，只留前 ${MAX_GRADIENT_STOPS - 1} 个与最后一个`)
  }
  if (kind === 'linear') return { paint: { kind, repeating, direction, stops }, warnings }
  return { paint: { kind, repeating, shape: radial.shape, size: radial.size, at: radial.at, stops }, warnings }
}

/** 解算到一个盒子上的渐变：着色器直接用的量。 */
export interface ResolvedPaint {
  readonly kind: 'linear' | 'radial'
  readonly repeating: boolean
  /**
   * 线性：起点 x、y 与终点 x、y（0% 与 100% 所在的两点）；径向：中心 x、y 与半径 x、y（100% 所在的椭圆）。
   * CSS 像素，盒子左上角为原点，变换之前。
   */
  readonly geometry: readonly [number, number, number, number]
  /** 2 到 MAX_GRADIENT_STOPS 个。 */
  readonly colors: readonly Rgba[]
  /** 每个色标在渐变线（径向是渐变射线）上的位置：0–1 是 0%–100%，可以超出，单调不减。 */
  readonly offsets: readonly number[]
}

const toPx = (l: Length, basis: number): number => {
  if (l.unit === 'calc') return (l.value / 100) * basis + l.px
  return l.unit === '%' ? (l.value / 100) * basis : l.value
}

/**
 * 按 CSS 的规则补色标的位置（CSS Images 3 §3.4.3）：第一个默认 0%、最后一个默认 100%；比前面小的抬到前面的
 * 最大值；中间没写的在前后两个写了的之间等分。length 是渐变线（射线）的长度，px 位置按它换算。
 */
export function resolveStopOffsets(stops: readonly GradientStop[], length: number): number[] {
  const n = stops.length
  const at: (number | null)[] = stops.map((s) => (s.position ? toPx(s.position, length) / Math.max(length, 1e-6) : null))
  if (at[0] === null) at[0] = 0
  if (at[n - 1] === null) at[n - 1] = 1
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    if (at[i] === null) continue
    max = Math.max(max, at[i]!)
    at[i] = max
  }
  for (let i = 1; i < n; i++) {
    if (at[i] !== null) continue
    let j = i
    while (at[j] === null) j++
    const from = at[i - 1]!
    const to = at[j]!
    for (let k = i; k < j; k++) at[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1)
    i = j
  }
  return at as number[]
}

/** 色标多于着色器的槽位时：留前 MAX−1 个与最后一个（两头的颜色不变）。 */
function capStops<T>(items: readonly T[]): T[] {
  if (items.length <= MAX_GRADIENT_STOPS) return [...items]
  return [...items.slice(0, MAX_GRADIENT_STOPS - 1), items[items.length - 1]!]
}

/** 径向渐变的两个半径（CSS Images 3 §3.2.1 的大小关键字）。 */
function radialRadii(shape: 'circle' | 'ellipse', size: RadialSize, cx: number, cy: number, w: number, h: number): [number, number] {
  if (typeof size !== 'string') {
    if (size.length === 1) {
      const r = toPx(size[0], w)
      return [r, r]
    }
    return [toPx(size[0], w), toPx(size[1], h)]
  }
  const closest = size.startsWith('closest')
  const pick = closest ? Math.min : Math.max
  const sideX = pick(Math.abs(cx), Math.abs(w - cx))
  const sideY = pick(Math.abs(cy), Math.abs(h - cy))
  if (size.endsWith('side')) {
    if (shape === 'circle') {
      const r = pick(sideX, sideY)
      return [r, r]
    }
    return [sideX, sideY]
  }
  // *-corner：离中心最近 / 最远的那个角
  const corners = [
    [cx, cy],
    [w - cx, cy],
    [cx, h - cy],
    [w - cx, h - cy]
  ].map(([x, y]) => ({ x: Math.abs(x!), y: Math.abs(y!), d: Math.hypot(x!, y!) }))
  corners.sort((a, b) => (closest ? a.d - b.d : b.d - a.d))
  const corner = corners[0]!
  if (shape === 'circle') return [corner.d, corner.d]
  // 椭圆：与 *-side 同样的长宽比，放大到正好过那个角
  if (sideX <= 0 || sideY <= 0) return [corner.x, corner.y]
  const k = sideY / sideX
  const rx = Math.hypot(corner.x, corner.y / k)
  return [rx, k * rx]
}

/** 把渐变解算到 width × height（CSS 像素）的盒子上。纯色返回 null。 */
export function resolvePaint(paint: FillPaint, width: number, height: number): ResolvedPaint | null {
  if (paint.kind === 'solid') return null
  const w = Math.max(width, 0)
  const h = Math.max(height, 0)
  if (paint.kind === 'linear') {
    let dx: number
    let dy: number
    if ('corner' in paint.direction) {
      // 垂直于连接另外两个角的那条线、指向这个角所在的象限（CSS Images 3 §3.1.1）
      const [sx, sy] = paint.direction.corner
      const n = Math.hypot(w, h) || 1
      dx = (sx! * h) / n
      dy = (sy! * w) / n
    } else {
      const a = (paint.direction.angle * Math.PI) / 180
      dx = Math.sin(a)
      dy = -Math.cos(a)
    }
    // 渐变线过盒子中心，长度让 0% 与 100% 的垂线正好过两个角
    const length = Math.abs(w * dx) + Math.abs(h * dy)
    const cx = w / 2
    const cy = h / 2
    return {
      kind: 'linear',
      repeating: paint.repeating,
      geometry: [cx - (dx * length) / 2, cy - (dy * length) / 2, cx + (dx * length) / 2, cy + (dy * length) / 2],
      colors: capStops(paint.stops.map((s) => s.color)),
      offsets: capStops(resolveStopOffsets(paint.stops, length))
    }
  }
  const cx = toPx(paint.at[0], w)
  const cy = toPx(paint.at[1], h)
  const [rx, ry] = radialRadii(paint.shape, paint.size, cx, cy, w, h).map((r) => Math.max(r, 1e-3))
  return {
    kind: 'radial',
    repeating: paint.repeating,
    geometry: [cx, cy, rx!, ry!],
    colors: capStops(paint.stops.map((s) => s.color)),
    // 径向的 px 位置沿水平的那条渐变射线量
    offsets: capStops(resolveStopOffsets(paint.stops, rx!))
  }
}
