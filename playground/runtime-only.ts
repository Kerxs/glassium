/**
 * 只引 `glassium/runtime` 的页面：自己查一遍，结果写进标题栏（PASS / FAIL）。
 * - `<div glass>` 变成了玻璃（data-glassium-active）；
 * - `<glass-*>` 组件没有注册（customElements.get 是 undefined）；
 * - window.glassium 与 ready 的能力都在。
 */
import glassium, { glassOf, VERSION } from 'glassium/runtime'

const report = document.getElementById('report')!
const card = document.querySelector<HTMLElement>('.card')!

void glassium.ready.then(async (caps) => {
  await new Promise((r) => setTimeout(r, 300))
  const checks: Array<[string, boolean, string]> = [
    ['玻璃生效', card.hasAttribute('data-glassium-active'), `renderer ${caps.renderer}`],
    ['glass() 句柄', glassOf(card) !== null, glassOf(card)?.material.tint ?? ''],
    ['组件没有注册', customElements.get('glass-card') === undefined && customElements.get('glass-switch') === undefined, ''],
    ['window.glassium', (window as unknown as { glassium?: unknown }).glassium === glassium, `VERSION ${VERSION}`]
  ]
  const passed = checks.filter(([, ok]) => ok).length
  report.textContent = checks.map(([name, ok, detail]) => `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`).join('\n')
  document.title = `${passed === checks.length ? 'PASS' : 'FAIL'} ${passed}/${checks.length}`
})
