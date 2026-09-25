/**
 * Playground（playground.html）：调材质、换背景，右边给出对应的 HTML 与 JS。
 *
 * 预览的玻璃是一个 `<glass-card>` 或 `<glass-button>`，材质写在它的 HTML 属性上 —— 与作者在标记里写属性是同一条路径；
 * 写的就是右边那段 HTML 里的属性（material-code.ts 算出来的最短写法），所以「看到的」与「拿到的代码」是同一份。
 */

import '../src/components/glassium.css'

import {
  createGlassStage,
  defineGlassElements,
  MATERIAL_ATTRIBUTES,
  simulateReducedTransparency,
  type GlassPresetName,
  type GlassStage,
  type PanelDebugMode,
  type SceneFit
} from 'glassium'

import { FIELDS, PREVIEW_SIZE, attributesOf, fmt, htmlSnippet, jsSnippet, stateFromPreset, type EditorState, type NumericField, type PreviewElement } from './material-code.ts'
import { userScenes, type UserScene } from './scenes.ts'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

let state: EditorState = stateFromPreset('glass-card', 'regular')
let preview: HTMLElement | null = null

/** 预览元素：换组件时换一个新的，内容跟着换。 */
function ensurePreview(): HTMLElement {
  if (preview && preview.localName === state.element) return preview
  preview?.remove()
  const el = document.createElement(state.element)
  if (state.element === 'glass-card') {
    el.innerHTML = '<h2>液态玻璃</h2><p>内容是普通 DOM，玻璃画在它背后的画布上。拖动左边的滑杆，右边的代码跟着变。</p>'
  } else {
    el.setAttribute('type', 'button')
    el.textContent = '按钮'
  }
  $('preview').append(el)
  preview = el
  return el
}

/** 把状态写到预览元素上（只写与基准不同的属性），再刷新代码与控件的显示。 */
function apply(): void {
  const el = ensurePreview()
  for (const name of MATERIAL_ATTRIBUTES) el.removeAttribute(name)
  const attrs = attributesOf(state)
  for (const [k, v] of attrs) el.setAttribute(k, v)
  el.style.width = `${state.width}px`
  el.style.height = `${state.height}px`
  // 兜底表面（没有 GPU 时）的圆角来自 CSS：跟着写一份
  el.style.borderRadius = state.cornerRadius === 'pill' ? '999px' : `${state.cornerRadius}px`

  $('html').textContent = htmlSnippet(state)
  $('js').textContent = jsSnippet(state)

  const changed = new Set(attrs.map(([k]) => k))
  for (const f of FIELDS) {
    const row = document.getElementById(`row-${f.key}`)!
    row.classList.toggle('changed', changed.has(f.attr))
    ;(row.querySelector('input') as HTMLInputElement).value = String(state.values[f.key])
    row.querySelector('output')!.textContent = fmt(state.values[f.key])
  }
  $('tintRow').classList.toggle('changed', changed.has('tint'))
  $('tintAlphaRow').classList.toggle('changed', changed.has('tint'))
  $('radiusRow').classList.toggle('changed', changed.has('corner-radius'))
  const [r, g, b, a] = state.tint
  $<HTMLInputElement>('tintColor').value = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
  $<HTMLInputElement>('tintAlpha').value = String(a)
  $('tintAlphaOut').textContent = fmt(a)
  const pill = state.cornerRadius === 'pill'
  $<HTMLInputElement>('pill').checked = pill
  $<HTMLInputElement>('radius').disabled = pill
  if (!pill) $<HTMLInputElement>('radius').value = String(state.cornerRadius)
  $('radiusOut').textContent = pill ? '1frac' : String(state.cornerRadius)
  $<HTMLInputElement>('width').value = String(state.width)
  $<HTMLInputElement>('height').value = String(state.height)
  $('widthOut').textContent = String(state.width)
  $('heightOut').textContent = String(state.height)
  $<HTMLSelectElement>('preset').value = state.preset ?? ''
  $<HTMLSelectElement>('element').value = state.element
}

/** 数值项的滑杆，按 FIELDS 生成。 */
function buildFields(): void {
  const host = $('fields')
  for (const f of FIELDS) {
    const row = document.createElement('label')
    row.className = 'row'
    row.id = `row-${f.key}`
    row.innerHTML = `<span title="${f.attr}">${f.label}</span><input type="range" min="${f.min}" max="${f.max}" step="${f.step}" /><output></output>`
    const input = row.querySelector('input')!
    input.addEventListener('input', () => {
      state = { ...state, values: { ...state.values, [f.key]: Number(input.value) } as Record<NumericField, number> }
      apply()
    })
    host.append(row)
  }
}

function wireMaterial(): void {
  $('preset').addEventListener('change', () => {
    const preset = ($<HTMLSelectElement>('preset').value || null) as GlassPresetName | null
    // 换预设：数值回到那个预设的值，尺寸保留
    state = { ...stateFromPreset(state.element, preset), width: state.width, height: state.height }
    apply()
  })
  $('reset').addEventListener('click', () => {
    state = { ...stateFromPreset(state.element, state.preset), width: state.width, height: state.height }
    apply()
  })
  $('element').addEventListener('change', () => {
    const element = $<HTMLSelectElement>('element').value as PreviewElement
    // 换组件：尺寸换成那个组件的默认尺寸，圆角回到那个组件的默认值，别的调过的项保留
    const fresh = stateFromPreset(element, state.preset)
    state = { ...state, element, cornerRadius: fresh.cornerRadius, width: PREVIEW_SIZE[element][0], height: PREVIEW_SIZE[element][1] }
    apply()
  })
  $('tintColor').addEventListener('input', () => {
    const hex = $<HTMLInputElement>('tintColor').value
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    state = { ...state, tint: [c[0]!, c[1]!, c[2]!, state.tint[3]] }
    apply()
  })
  $('tintAlpha').addEventListener('input', () => {
    state = { ...state, tint: [state.tint[0], state.tint[1], state.tint[2], Number($<HTMLInputElement>('tintAlpha').value)] }
    apply()
  })
  $('radius').addEventListener('input', () => {
    state = { ...state, cornerRadius: Number($<HTMLInputElement>('radius').value) }
    apply()
  })
  $('pill').addEventListener('change', () => {
    state = { ...state, cornerRadius: $<HTMLInputElement>('pill').checked ? 'pill' : 24 }
    apply()
  })
  for (const id of ['width', 'height'] as const) {
    $(id).addEventListener('input', () => {
      state = { ...state, [id]: Number($<HTMLInputElement>(id).value) }
      apply()
    })
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', () => {
      const text = $(button.dataset.copy!).textContent ?? ''
      navigator.clipboard.writeText(text).then(
        () => {
          button.textContent = '已复制'
          setTimeout(() => (button.textContent = '复制'), 1200)
        },
        () => {
          button.textContent = '复制失败'
        }
      )
    })
  }
}

type BuiltinScene = 'gradient' | 'calibration' | 'radial' | 'flat'

function wireScene(stage: GlassStage): void {
  const scene = $<HTMLSelectElement>('scene')
  const fit = $<HTMLSelectElement>('fit')
  const file = $<HTMLInputElement>('file')
  const scenes = userScenes(stage)
  let shown = scene.value
  const userSceneOf = (value: string): UserScene | null => (value.startsWith('user:') ? (value.slice(5) as UserScene) : null)
  const failed = (err: unknown): void => {
    if (err instanceof DOMException && err.name === 'AbortError') return // 被后一次切换取代
    console.warn('[Playground] 换背景失败：', err)
    scene.value = shown
  }
  const show = (value: string): void => {
    const user = userSceneOf(value)
    if (!user) stage.debug.setBackdrop({ scene: value as BuiltinScene })
    scenes.show(user, fit.value as SceneFit).then(() => {
      shown = value
    }, failed)
  }
  scene.addEventListener('change', () => {
    if (scene.value === 'user:file') file.click()
    else show(scene.value)
  })
  file.addEventListener('change', () => {
    const picked = file.files?.[0]
    file.value = ''
    if (!picked) {
      scene.value = shown
      return
    }
    scenes.pickFile(picked, fit.value as SceneFit).then(() => {
      shown = 'user:file'
    }, failed)
  })
  file.addEventListener('cancel', () => {
    scene.value = shown
  })
  fit.addEventListener('change', () => {
    if (userSceneOf(shown)) show(shown)
  })
  show(scene.value)
}

function wireView(stage: GlassStage): void {
  const debug = $<HTMLSelectElement>('debug')
  debug.addEventListener('change', () => stage.debug.setPanelDebug(debug.value as PanelDebugMode))
  const linear = $<HTMLInputElement>('linear')
  linear.addEventListener('change', () => stage.setBlendSpace(linear.checked ? 'linear' : 'srgb'))
  const rt = $<HTMLInputElement>('rt')
  rt.addEventListener('change', () => simulateReducedTransparency(rt.checked ? true : null))
}

function showStats(stage: GlassStage): void {
  const s = stage.debug.stats()
  const v = s.viewport
  $('stats').textContent =
    `${s.backend} · ${s.fps} fps · CPU ${s.cpuMs.total.toFixed(2)} ms` + (v ? ` · ${v.compositeWidth}×${v.compositeHeight}` : '')
}

async function main(): Promise<void> {
  defineGlassElements()
  buildFields()
  wireMaterial()
  apply()
  const stage = await createGlassStage()
  Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })
  wireScene(stage)
  wireView(stage)
  showStats(stage)
  setInterval(() => showStats(stage), 500)
}

void main()
