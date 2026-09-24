/**
 * 面板的姿态：自己与祖先的 CSS 变换合起来，是不是一个「旋转 + 缩放」的矩形，转了多少、缩了多少。
 *
 * getBoundingClientRect 只给轴对齐的包围盒。纯平移、缩放时它就是面板本身；有旋转时它比面板大，
 * 玻璃要按包围盒的中心、布局尺寸 × 缩放、这个角度画成一个转过的圆角矩形。
 *
 * 只看线性部分（2×2）：平移与 transform-origin 只挪位置，而位置由包围盒的中心给出 ——
 * 任何仿射变换下，矩形的像的中心都是它包围盒的中心。
 *
 * 一个元素自己的线性变换按 CSS Transforms 2 的顺序合成：`rotate · scale · transform`
 * （先 transform、再 scale、再 rotate，translate 不影响线性部分）；外层祖先的在左边。
 *
 * 画不了的（着色器只画「转过的矩形」）：倾斜、透视与 3D 旋转、带旋转的镜像。这些由 layering.ts 警告。
 * 不带旋转的镜像（`scale(-1, 1)`）画得了：镜像之后还是同一个轴对齐的矩形。
 */

/** 2×2 线性变换，CSS `matrix(a, b, c, d, …)` 的前四个数：x 轴映射到 (a, b)，y 轴映射到 (c, d)。 */
export interface Linear {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
}

export const IDENTITY: Linear = { a: 1, b: 0, c: 0, d: 1 }

/** m · n：先作用 n，再作用 m。 */
export function multiply(m: Linear, n: Linear): Linear {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d
  }
}

const EPS = 1e-6

/** `transform` 的计算值（`none` / `matrix(…)` / `matrix3d(…)`）→ 线性部分。3D 的、看不懂的返回 null。 */
export function linearOfTransform(css: string): Linear | null {
  const t = css.trim()
  if (t === '' || t === 'none') return IDENTITY
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(t)
  if (!m) return null
  const v = m[2]!.split(',').map(Number)
  if (v.some((x) => !Number.isFinite(x))) return null
  if (!m[1]) {
    if (v.length !== 6) return null
    return { a: v[0]!, b: v[1]!, c: v[2]!, d: v[3]! }
  }
  // matrix3d 列主序 16 个数。只收得下「其实是 2D 的」：z 相关的行列是单位阵、没有透视
  if (v.length !== 16) return null
  const zero = (i: number): boolean => Math.abs(v[i]!) <= EPS
  for (const i of [2, 3, 6, 7, 8, 9, 11]) if (!zero(i)) return null
  if (Math.abs(v[10]! - 1) > EPS || Math.abs(v[15]! - 1) > EPS) return null
  return { a: v[0]!, b: v[1]!, c: v[4]!, d: v[5]! }
}

/** 一个角度（`45deg` / `0.5turn` / `1rad` / `100grad`）→ 弧度。看不懂返回 null。 */
function angleOf(token: string): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(token.trim())
  if (!m) return null
  const n = Number(m[1])
  switch ((m[2] ?? 'deg').toLowerCase()) {
    case 'rad':
      return n
    case 'grad':
      return (n * Math.PI) / 200
    case 'turn':
      return n * 2 * Math.PI
    default:
      return (n * Math.PI) / 180
  }
}

const rotation = (theta: number): Linear => {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return { a: c, b: s, c: -s, d: c }
}

/**
 * `rotate` 独立属性的计算值：`none`、`45deg`、`z 45deg`、`0 0 1 45deg` → 绕 z 轴的旋转；
 * 绕别的轴的（3D）返回 null。
 */
export function linearOfRotate(css: string): Linear | null {
  const t = css.trim()
  if (t === '' || t === 'none') return IDENTITY
  const parts = t.split(/\s+/)
  if (parts.length === 1) {
    const theta = angleOf(parts[0]!)
    return theta === null ? null : rotation(theta)
  }
  if (parts.length === 2 && parts[0]!.toLowerCase() === 'z') {
    const theta = angleOf(parts[1]!)
    return theta === null ? null : rotation(theta)
  }
  if (parts.length === 4) {
    const [x, y, z] = parts.slice(0, 3).map(Number)
    const theta = angleOf(parts[3]!)
    if (theta === null || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    if (Math.abs(theta) <= EPS) return IDENTITY
    if (Math.abs(x!) > EPS || Math.abs(y!) > EPS || !(z! !== 0)) return null
    return rotation(z! > 0 ? theta : -theta)
  }
  return null
}

/** `scale` 独立属性的计算值：`none`、`2`、`2 3`、`2 3 1` → 对角阵（z 不管）。 */
export function linearOfScale(css: string): Linear | null {
  const t = css.trim()
  if (t === '' || t === 'none') return IDENTITY
  const v = t.split(/\s+/).map((p) => (p.endsWith('%') ? Number(p.slice(0, -1)) / 100 : Number(p)))
  if (v.length === 0 || v.length > 3 || v.some((x) => !Number.isFinite(x))) return null
  const sx = v[0]!
  const sy = v.length >= 2 ? v[1]! : sx
  return { a: sx, b: 0, c: 0, d: sy }
}

/** 计算值里与姿态有关的三项。 */
export interface PoseStyle {
  readonly transform: string
  readonly rotate: string
  readonly scale: string
}

export interface Pose {
  /** 着色器画得了吗（旋转 + 缩放的矩形，或者不带旋转的镜像）。 */
  readonly supported: boolean
  /** 屏幕上的旋转角（弧度，y 向下，正角是顺时针）。 */
  readonly angle: number
  /** 沿面板自己 x、y 轴的缩放。 */
  readonly scaleX: number
  readonly scaleY: number
}

const UNSUPPORTED: Pose = { supported: false, angle: 0, scaleX: 1, scaleY: 1 }

/** 一个元素自己的线性变换：rotate · scale · transform。 */
export function linearOfElement(s: PoseStyle): Linear | null {
  const t = linearOfTransform(s.transform)
  const r = linearOfRotate(s.rotate)
  const k = linearOfScale(s.scale)
  if (!t || !r || !k) return null
  return multiply(r, multiply(k, t))
}

/** 把合成好的线性变换拆成旋转与两个轴的缩放。 */
export function decompose(m: Linear): Pose {
  const sx = Math.hypot(m.a, m.b)
  const sy = Math.hypot(m.c, m.d)
  if (sx <= EPS || sy <= EPS) return UNSUPPORTED // 压扁成线或点了
  const det = m.a * m.d - m.b * m.c
  // 两列不正交：倾斜
  if (Math.abs(m.a * m.c + m.b * m.d) > 1e-4 * sx * sy) return UNSUPPORTED
  if (det < 0) {
    // 镜像：不带旋转（两列仍沿坐标轴）时还是同一个轴对齐的矩形；带旋转的画不了
    const axisAligned = Math.abs(m.b) <= EPS * sx && Math.abs(m.c) <= EPS * sy
    return axisAligned ? { supported: true, angle: 0, scaleX: sx, scaleY: sy } : UNSUPPORTED
  }
  return { supported: true, angle: Math.atan2(m.b, m.a), scaleX: sx, scaleY: sy }
}

/**
 * 面板（第 0 个）到外层祖先的计算样式 → 合成的姿态。外层的变换在左边：
 * total = M(最外层) · … · M(父) · M(自己)。
 */
export function poseOf(chain: readonly PoseStyle[]): Pose {
  let total = IDENTITY
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = linearOfElement(chain[i]!)
    if (!m) return UNSUPPORTED
    total = multiply(total, m)
  }
  return decompose(total)
}
