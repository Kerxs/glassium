import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { OPTICS_WGSL } from './optics.wgsl.ts'
import { OPTICS_GLSL } from './generated/optics.glsl.ts'
import {
  TranslateError,
  findResidualWgsl,
  renderModule,
  translateWgslToGlsl
} from './translate-glsl.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GENERATED = join(HERE, 'generated', 'optics.glsl.ts')

/* ------------------------------------------------------------------ *
 * 重生成同一性 —— T4 的核心门禁
 * ------------------------------------------------------------------ */

test('签入的 GLSL 与从 WGSL 重新翻译的结果逐字节一致', () => {
  const expected = renderModule(translateWgslToGlsl(OPTICS_WGSL))
  const actual = readFileSync(GENERATED, 'utf8')
  assert.equal(
    actual,
    expected,
    '签入的 GLSL 与真源漂了。改了 optics.wgsl.ts 就要跑 npm run gen:glsl。'
  )
})

test('生成的 GLSL 里没有 WGSL 残留', () => {
  assert.deepEqual(findResidualWgsl(OPTICS_GLSL), [])
})

test('WGSL 与 GLSL 导出同一组函数', () => {
  const wgslFns = [...OPTICS_WGSL.matchAll(/^fn\s+(\w+)\s*\(/gm)].map((m) => m[1]).sort()
  const glslFns = [...OPTICS_GLSL.matchAll(/^\w+\s+(\w+)\s*\(/gm)].map((m) => m[1]).sort()
  assert.ok(wgslFns.length >= 13, `WGSL 侧只找到 ${wgslFns.length} 个函数，太少了`)
  assert.deepEqual(glslFns, wgslFns, '两侧的函数集合必须完全一致')
})

/* ------------------------------------------------------------------ *
 * select → 三元 的翻译，含嵌套
 * ------------------------------------------------------------------ */

test('select 翻译成三元，实参顺序是 (假值, 真值, 条件)', () => {
  const out = translateWgslToGlsl(`fn f(a: f32, b: f32) -> f32 {
  let r: f32 = select(a, b, a > b);
  return r;
}`)
  assert.match(out, /float r = \(a > b \? b : a\);/)
})

test('嵌套 select 从内向外正确展开', () => {
  // 这是重写器最容易写错的地方：用正则匹配 select(...) 会在嵌套时抓错括号。
  const out = translateWgslToGlsl(`fn f(a: f32, b: f32, c: f32) -> f32 {
  let r: f32 = select(select(a, b, a > b), c, c > 0.0);
  return r;
}`)
  assert.match(out, /float r = \(c > 0\.0 \? c : \(a > b \? b : a\)\);/)
})

test('实参里含逗号的函数调用不会被切错', () => {
  const out = translateWgslToGlsl(`fn f(p: vec2f) -> vec2f {
  let r: vec2f = select(vec2f(0.0, -1.0), max(p, vec2f(0.0, 0.0)), p.x > 0.0);
  return r;
}`)
  assert.match(out, /vec2 r = \(p\.x > 0\.0 \? max\(p, vec2\(0\.0, 0\.0\)\) : vec2\(0\.0, -1\.0\)\);/)
})

/* ------------------------------------------------------------------ *
 * 「看不懂就抛」—— 这些测试在守护重写器最重要的性质
 *
 * 一个会「尽力而为」的着色器翻译器是最坏的工具：产出的 GLSL 能编译、能跑、
 * 结果微妙地不对，而你会先去查光学、查采样、查精度，最后才想到翻译这一层。
 * ------------------------------------------------------------------ */

test('没有类型标注的声明会抛（重写器不做类型推导）', () => {
  assert.throws(
    () => translateWgslToGlsl('fn f() -> f32 {\n  let x = 1.0;\n  return x;\n}'),
    (e: unknown) => e instanceof TranslateError && /类型标注/.test(e.message)
  )
})

test('未知类型会抛，并报出是哪个类型', () => {
  assert.throws(
    () => translateWgslToGlsl('fn f() -> f32 {\n  let m: mat2x3f = q;\n  return 1.0;\n}'),
    (e: unknown) => e instanceof TranslateError && /未知类型 "mat2x3f"/.test(e.message)
  )
})

test('明确不支持的构造会抛', () => {
  const cases: [string, RegExp][] = [
    ['fn f() -> f32 {\n  var<storage> x: f32;\n  return 1.0;\n}', /模块作用域 var/],
    // 只放属性、不带 var<，否则会先命中上面那条 var< 规则 ——
    // 两条都对，但这里要单独验属性这一条确实存在
    ['@fragment\nfn main() -> vec4f {\n  return q;\n}', /属性标注/],
    ['fn f() -> f32 {\n  let c: vec4f = textureSample(t, s, uv);\n  return 1.0;\n}', /纹理采样/],
    ['struct Foo {\n  a: f32,\n}', /struct/],
    ['fn f() -> f32 {\n  discard;\n}', /discard/],
    ['fn f() -> f32 {\n  let p: ptr<function, f32> = q;\n  return 1.0;\n}', /指针类型/]
  ]
  for (const [src, pattern] of cases) {
    assert.throws(
      () => translateWgslToGlsl(src),
      (e: unknown) => e instanceof TranslateError && pattern.test(e.message),
      `这段应当抛 ${pattern}：${src.split('\n')[1] ?? src}`
    )
  }
})

test('无法识别的语句会抛，而不是原样放过', () => {
  // 原样放过是最危险的行为：那一行会以 WGSL 的形态进入 GLSL，
  // 要么编译失败（还算好），要么碰巧合法而语义不同（灾难）。
  assert.throws(
    () => translateWgslToGlsl('fn f() -> f32 {\n  for (var i = 0; i < 4; i++) {}\n  return 1.0;\n}'),
    (e: unknown) => e instanceof TranslateError
  )
})

test('无返回类型的函数会抛', () => {
  assert.throws(
    () => translateWgslToGlsl('fn f(a: f32) {\n  return;\n}'),
    (e: unknown) => e instanceof TranslateError && /必须有返回类型/.test(e.message)
  )
})

test('形参写法不对会抛', () => {
  assert.throws(
    () => translateWgslToGlsl('fn f(f32) -> f32 {\n  return 1.0;\n}'),
    (e: unknown) => e instanceof TranslateError && /形参必须写成/.test(e.message)
  )
})

test('抛错带行号，且行号指向真正出问题的那一行', () => {
  try {
    translateWgslToGlsl('fn f() -> f32 {\n  let a: f32 = 1.0;\n  let b = 2.0;\n  return a;\n}')
    assert.fail('应当抛错')
  } catch (e) {
    assert.ok(e instanceof TranslateError)
    assert.equal(e.line, 3, '出问题的是第 3 行')
    assert.match(e.message, /第 3 行/)
  }
})

/* ------------------------------------------------------------------ *
 * 类型与结构翻译
 * ------------------------------------------------------------------ */

test('函数签名的类型位置正确调换', () => {
  const out = translateWgslToGlsl('fn f(p: vec2f, r: f32) -> vec4f {\n  return q;\n}')
  assert.match(out, /^vec4 f\(vec2 p, float r\) \{$/m)
})

test('构造函数调用也被映射（vec2f( → vec2( ）', () => {
  const out = translateWgslToGlsl('fn f() -> vec2f {\n  return vec2f(1.0, 2.0);\n}')
  assert.match(out, /return vec2\(1\.0, 2\.0\);/)
})

test('注释、空行与缩进原样保留', () => {
  const src = 'fn f() -> f32 {\n  // 这是注释\n\n  let x: f32 = 1.0;\n  return x;\n}'
  const out = translateWgslToGlsl(src)
  assert.match(out, /^  \/\/ 这是注释$/m, '注释应原样保留')
  assert.match(out, /^  float x = 1\.0;$/m, '缩进应保留')
  assert.ok(out.includes('\n\n'), '空行应保留')
})

test('const 声明保留 const 关键字', () => {
  const out = translateWgslToGlsl('fn f() -> f32 {\n  const k: f32 = 3.0;\n  return k;\n}')
  assert.match(out, /const float k = 3\.0;/)
})

/* ------------------------------------------------------------------ *
 * 与 CPU 参考实现的符号约定一致性
 * ------------------------------------------------------------------ */

test('符号约定用 >= 0 而不是 sign()（面板中心线正好落在这个差异上）', () => {
  // sign(0.0) 是 0，而 (0.0 >= 0.0 ? 1.0 : -1.0) 是 1。
  // 面板的中心线 x=0 / y=0 恰好落在这里，用 sign 会让中心线上的一整排像素
  // 拿到零向量，随后 normalize 出 NaN。两边必须一致。
  assert.ok(
    !/\bsign\s*\(/.test(OPTICS_GLSL),
    'GLSL 里不该出现 sign()，符号要用显式的 >= 0 三元'
  )
  assert.match(OPTICS_GLSL, /float sx = \(p\.x >= 0\.0 \? 1\.0 : -1\.0\);/)
  assert.match(OPTICS_GLSL, /float sy = \(p\.y >= 0\.0 \? 1\.0 : -1\.0\);/)
})

test('gradRadiusOf 的 1.5 倍放大在 GLSL 侧也在', () => {
  // 这一行最容易被当成笔误删掉，两侧都要钉住。
  assert.match(OPTICS_GLSL, /min\(radius \* 1\.5,/)
})
