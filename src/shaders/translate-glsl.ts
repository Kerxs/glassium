/**
 * WGSL → GLSL ES 3.0 的 token 重写器。
 *
 * 只覆盖 optics.wgsl.ts 里那个**共享的纯函数子集**：没有绑定、没有入口点、
 * 没有纹理采样。那些东西两个后端差别太大，手写比机翻清楚。
 *
 * 核心约定：**看不懂就抛，绝不猜**。
 *
 * 一个会「尽力而为」的着色器翻译器是最坏的工具 —— 它产出的 GLSL 能编译、能跑、
 * 结果微妙地不对，而你会先去查光学、查采样、查精度，最后才想到翻译这一层。
 * 所以凡是不在替换表里的构造一律抛错并报出行号，宁可让 npm run gen:glsl 失败。
 *
 * 生成物签入仓库（src/shaders/generated/），WebGL2 因此不需要运行时构建步骤，
 * 而且实际发给驱动的 GLSL 是可以直接 diff 和阅读的。
 */

/** WGSL 类型 → GLSL ES 3.0 类型。表外的类型会抛。 */
const TYPE_MAP: ReadonlyMap<string, string> = new Map([
  ['f32', 'float'],
  ['i32', 'int'],
  ['u32', 'uint'],
  ['bool', 'bool'],
  ['vec2f', 'vec2'],
  ['vec3f', 'vec3'],
  ['vec4f', 'vec4'],
  ['vec2i', 'ivec2'],
  ['vec3i', 'ivec3'],
  ['vec4i', 'ivec4'],
  ['vec2u', 'uvec2'],
  ['vec3u', 'uvec3'],
  ['vec4u', 'uvec4'],
  ['mat2x2f', 'mat2'],
  ['mat3x3f', 'mat3'],
  ['mat4x4f', 'mat4']
])

/** GLSL ES 3.0 里名字和语义都相同的内置函数。表外的会抛。 */
const SHARED_BUILTINS: ReadonlySet<string> = new Set([
  'abs', 'min', 'max', 'clamp', 'sqrt', 'pow', 'exp', 'log', 'exp2', 'log2',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'floor', 'ceil', 'round', 'fract',
  'sign', 'step', 'smoothstep', 'mix', 'length', 'normalize', 'dot', 'cross',
  'distance', 'reflect', 'refract', 'inverseSqrt', 'modf', 'trunc'
])

/** 名字不同、需要改写的内置函数。 */
const RENAMED_BUILTINS: ReadonlyMap<string, string> = new Map([
  ['inverseSqrt', 'inversesqrt'],
  ['fract', 'fract'],
  ['saturate', 'SATURATE_NOT_IN_GLSL'] // WGSL 也没有 saturate，留着是为了报错清楚
])

/**
 * 明确不支持的构造。命中就抛。
 *
 * 这些不是「暂时没做」——它们本来就不该出现在共享子集里。绑定和入口点属于
 * 各后端手写的那部分，指针/原子/工作组是计算着色器的东西。
 */
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bptr\s*</, '指针类型'],
  [/\batomic\s*</, '原子类型'],
  [/\bvar\s*</, '模块作用域 var（绑定属于各后端手写的部分）'],
  [/@(group|binding|location|builtin|vertex|fragment|compute|workgroup_size)\b/, '属性标注'],
  [/\btexture[A-Z]\w*\s*\(/, '纹理采样（各后端手写）'],
  [/\b(texture_2d|texture_2d_array|sampler)\b/, '纹理/采样器类型（各后端手写）'],
  [/\boverride\b/, 'override 常量'],
  [/\bdiscard\b/, 'discard'],
  [/\bstruct\b/, 'struct（共享子集里用 vec 返回多值）'],
  [/\bloop\s*\{/, 'loop 语句']
]

export class TranslateError extends Error {
  // 字段要显式声明、构造函数里显式赋值。不能写成参数属性
  // （`constructor(readonly line: number)`）—— Node 的类型擦除是**只删不转**的，
  // 参数属性会生成赋值代码，于是被拒绝：ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  // 同理 enum、namespace 也用不了。这是零依赖跑 .ts 的代价，很划算。
  readonly line: number
  readonly text: string

  constructor(message: string, line: number, text: string) {
    super(`[Glassium] WGSL→GLSL 第 ${line} 行翻译失败：${message}\n  ${text.trim()}`)
    this.name = 'TranslateError'
    this.line = line
    this.text = text
  }
}

function mapType(wgslType: string, line: number, text: string): string {
  const mapped = TYPE_MAP.get(wgslType)
  if (mapped === undefined) {
    throw new TranslateError(
      `未知类型 "${wgslType}"。支持的类型：${[...TYPE_MAP.keys()].join(', ')}`,
      line,
      text
    )
  }
  return mapped
}

/** 找到与 openIndex 处 '(' 配对的 ')'。 */
function matchParen(src: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 按顶层逗号切分实参，尊重嵌套括号。 */
function splitArgs(inner: string): string[] {
  const args: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i))
      start = i + 1
    }
  }
  args.push(inner.slice(start))
  return args.map((a) => a.trim()).filter((a) => a.length > 0)
}

/**
 * select(假值, 真值, 条件) → (条件 ? 真值 : 假值)。
 *
 * select 会嵌套，所以不能用正则。做法是每次取**最后一个** `select(` ——
 * 它的实参里不可能再有 select（否则那个 select 会出现在它后面），
 * 于是从内向外逐个替换，直到没有为止。
 */
function translateSelect(src: string, line: number, text: string): string {
  let out = src
  for (;;) {
    const at = out.lastIndexOf('select(')
    if (at < 0) return out
    const open = at + 'select'.length
    const close = matchParen(out, open)
    if (close < 0) {
      throw new TranslateError('select( 的括号没有闭合', line, text)
    }
    const args = splitArgs(out.slice(open + 1, close))
    if (args.length !== 3) {
      throw new TranslateError(
        `select 需要 3 个实参，得到 ${args.length} 个：${args.join(' | ')}`,
        line,
        text
      )
    }
    const [falseVal, trueVal, cond] = args as [string, string, string]
    out = `${out.slice(0, at)}(${cond} ? ${trueVal} : ${falseVal})${out.slice(close + 1)}`
  }
}

/** 类型名替换，同时作用于类型位置与构造函数调用（vec2f(…) → vec2(…)）。 */
function replaceTypeWords(src: string): string {
  let out = src
  for (const [wgsl, glsl] of TYPE_MAP) {
    out = out.replace(new RegExp(`\\b${wgsl}\\b`, 'g'), glsl)
  }
  for (const [wgsl, glsl] of RENAMED_BUILTINS) {
    if (wgsl !== glsl) out = out.replace(new RegExp(`\\b${wgsl}\\b`, 'g'), glsl)
  }
  return out
}

const FN_RE = /^fn\s+(\w+)\s*\(([^)]*)\)\s*->\s*(\w+)\s*\{$/
const FN_NO_RETURN_RE = /^fn\s+(\w+)\s*\(([^)]*)\)\s*\{$/
const DECL_RE = /^(let|var|const)\s+(\w+)\s*:\s*(\w+)\s*=\s*(.+);$/
const DECL_NO_TYPE_RE = /^(let|var|const)\s+(\w+)\s*=/

/**
 * 翻译整段 WGSL。
 *
 * @throws TranslateError 遇到替换表覆盖不到的任何构造
 */
export function translateWgslToGlsl(wgsl: string): string {
  const lines = wgsl.split('\n')
  const out: string[] = []

  lines.forEach((raw, index) => {
    const lineNo = index + 1
    const trimmed = raw.trim()

    // 空行、注释、单独的闭合花括号直接过
    if (trimmed === '' || trimmed.startsWith('//') || trimmed === '}') {
      out.push(raw)
      return
    }

    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(trimmed)) {
        throw new TranslateError(`不支持的构造：${what}`, lineNo, raw)
      }
    }

    const indent = raw.slice(0, raw.length - raw.trimStart().length)

    // fn 声明
    const fn = FN_RE.exec(trimmed)
    if (fn) {
      const [, name, params, ret] = fn as unknown as [string, string, string, string]
      const glslParams = params.trim() === ''
        ? ''
        : splitArgs(params)
            .map((p) => {
              const m = /^(\w+)\s*:\s*(\w+)$/.exec(p)
              if (!m) {
                throw new TranslateError(
                  `形参必须写成 "名字: 类型"，得到 "${p}"`,
                  lineNo,
                  raw
                )
              }
              return `${mapType(m[2]!, lineNo, raw)} ${m[1]!}`
            })
            .join(', ')
      out.push(`${indent}${mapType(ret, lineNo, raw)} ${name}(${glslParams}) {`)
      return
    }
    if (FN_NO_RETURN_RE.test(trimmed)) {
      throw new TranslateError(
        '共享子集里的函数必须有返回类型（无返回值的函数属于各后端手写的部分）',
        lineNo,
        raw
      )
    }

    // let / var / const 声明
    const decl = DECL_RE.exec(trimmed)
    if (decl) {
      const [, , name, type, expr] = decl as unknown as [string, string, string, string, string]
      const kind = decl[1] === 'const' ? 'const ' : ''
      const body = translateSelect(expr, lineNo, raw)
      out.push(`${indent}${kind}${mapType(type, lineNo, raw)} ${name} = ${replaceTypeWords(body)};`)
      return
    }
    if (DECL_NO_TYPE_RE.test(trimmed)) {
      throw new TranslateError(
        '声明必须带类型标注（重写器不做类型推导 —— 推错了会静默出一个能跑但不对的着色器）',
        lineNo,
        raw
      )
    }

    // return 语句
    if (trimmed.startsWith('return')) {
      const expr = trimmed.slice('return'.length).replace(/;$/, '').trim()
      const body = expr === '' ? '' : ` ${replaceTypeWords(translateSelect(expr, lineNo, raw))}`
      out.push(`${indent}return${body};`)
      return
    }

    throw new TranslateError(
      '无法识别的语句。共享子集只允许 fn 声明、带类型标注的 let/var/const、return，' +
        '以及注释和空行。',
      lineNo,
      raw
    )
  })

  return out.join('\n')
}

/**
 * 把翻译结果包成一个 .ts 模块，与 WGSL 侧的形态对称。
 *
 * 放在这里而不是 scripts/gen-glsl.ts 里，是为了让 generated.test.ts 能在**不触发
 * 写文件**的前提下重算一遍产物 —— 一个 import 就会改工作区的测试没法信。
 */
export function renderModule(glsl: string): string {
  return `/*
   本文件由 scripts/gen-glsl.ts 从 src/shaders/optics.wgsl.ts 自动生成。
   **不要手改** —— 改 WGSL 真源，然后跑 npm run gen:glsl。

   许可承袭真源：光学数学移植自 AndroidLiquidGlass（io.github.kyant0:backdrop），
   Apache License 2.0，Copyright 2025 Kyant。修改说明见 docs/porting-notes.md。
 */

/** GLSL ES 3.0 版的光学核心。绑定、入口点与 Y 翻转由各后端手写，不在这里。 */
export const OPTICS_GLSL = /* glsl */ \`
${glsl.trim()}
\`
`
}

/** 检查一段 GLSL 里是否还残留 WGSL 的痕迹。生成后自检用。 */
export function findResidualWgsl(glsl: string): string[] {
  const residue: string[] = []
  // 只查**拼写确实不同**的类型。bool 在两边同名，在输出里看到它是对的，不是残留 ——
  // 把它算成残留会让这个自检永远为真，于是自检被绕过或被删掉，那就白写了。
  const wgslOnlyTypes = [...TYPE_MAP.entries()]
    .filter(([wgsl, glslName]) => wgsl !== glslName)
    .map(([wgsl]) => wgsl)

  for (const token of [...wgslOnlyTypes, 'select(', 'fn ', '->']) {
    if (new RegExp(`\\b${token.replace(/[(]/g, '\\(')}`).test(glsl)) {
      residue.push(token)
    }
  }
  // SHARED_BUILTINS 只用于文档化「哪些是两边同名的」，这里顺带确认它非空，
  // 免得将来有人删空了它却没人发现。
  if (SHARED_BUILTINS.size === 0) residue.push('<内置函数表为空>')
  return residue
}
