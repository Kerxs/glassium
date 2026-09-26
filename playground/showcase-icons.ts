/**
 * 展示页用的图形：都是自己画的简单几何（24×24 的线稿），不是任何系统的图标。
 * 页面里写 `<span data-icon="名字">`，showcase.ts 把 SVG 填进去。
 */

/** 齿轮：内外两个圆 + 八个齿。 */
function gear(): string {
  let teeth = ''
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4
    const p = (r: number): string => `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`
    teeth += `M${p(6.6)}L${p(9.2)}`
  }
  return `<circle cx="12" cy="12" r="2.8"/><circle cx="12" cy="12" r="6.2"/><path d="${teeth}" stroke-width="2.6"/>`
}

const PATHS: Record<string, string> = {
  photos: '<rect x="3" y="4" width="18" height="16" rx="3.2"/><circle cx="8.6" cy="9" r="1.9"/><path d="M3.5 17.5l5-5.2 3.6 3.6 2.9-2.7 5.5 5.3"/>',
  camera:
    '<path d="M4.2 8h3.1l1.6-2.4h6.2L16.7 8h3.1A1.2 1.2 0 0121 9.2v8.6a1.2 1.2 0 01-1.2 1.2H4.2A1.2 1.2 0 013 17.8V9.2A1.2 1.2 0 014.2 8z"/><circle cx="12" cy="13.2" r="3.4"/>',
  weather:
    '<circle cx="9" cy="8.6" r="3"/><path d="M9 2.8v1.4M3.2 8.6H4.6M4.9 4.5l1 1M13.1 4.5l-1 1"/><path d="M8.6 19.2h8.6a3.4 3.4 0 00.2-6.8 5 5 0 00-9.5 1.4 2.7 2.7 0 00.7 5.4z"/>',
  music: '<path d="M9 17.5V6.2l11-2.2v11.3"/><circle cx="6.6" cy="17.5" r="2.4"/><circle cx="17.6" cy="15.3" r="2.4"/>',
  maps: '<path d="M9 4.2L3.5 6.4v13.4L9 17.6l6 2.2 5.5-2.2V4.2L15 6.4z"/><path d="M9 4.2v13.4M15 6.4v13.4"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7v5.2l3.4 2"/>',
  notes: '<rect x="5" y="3.5" width="14" height="17" rx="2.6"/><path d="M8.5 8.4h7M8.5 12h7M8.5 15.6h4.4"/>',
  reminders:
    '<circle cx="6.2" cy="7" r="1.5"/><circle cx="6.2" cy="12" r="1.5"/><circle cx="6.2" cy="17" r="1.5"/><path d="M10.2 7h9.3M10.2 12h9.3M10.2 17h9.3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.6"/><path d="M3.5 9.6h17M8 3v4M16 3v4M8 13.4h.01M12 13.4h.01M16 13.4h.01M8 16.8h.01M12 16.8h.01"/>',
  podcasts:
    '<circle cx="12" cy="10.2" r="2.2"/><path d="M12 13.4v6.8M8 14.6a5.6 5.6 0 118 0M5.4 17.1a9.2 9.2 0 1113.2 0"/>',
  health: '<path d="M12 20s-7.4-4.6-7.4-10.2A4.1 4.1 0 0112 7.3a4.1 4.1 0 017.4 2.5C19.4 15.4 12 20 12 20z"/>',
  wallet: '<rect x="3" y="6" width="18" height="13.5" rx="2.6"/><path d="M3 10.4h18M15.6 15h2.4"/>',
  files: '<path d="M3 7.2A2.2 2.2 0 015.2 5h4l2.2 2.2h7.4A2.2 2.2 0 0121 9.4v7.8a2.2 2.2 0 01-2.2 2.2H5.2A2.2 2.2 0 013 17.2z"/>',
  store: '<path d="M5.2 8.2h13.6l-1.1 11.6H6.3z"/><path d="M9 8.2V6.4a3 3 0 016 0v1.8"/>',
  calculator:
    '<rect x="5" y="3" width="14" height="18" rx="2.6"/><path d="M8.2 7h7.6M8.4 11h.01M12 11h.01M15.6 11h.01M8.4 14.4h.01M12 14.4h.01M15.6 14.4h.01M8.4 17.8h.01M12 17.8h.01M15.6 17.8h.01"/>',
  settings: gear(),
  phone:
    '<path d="M6.8 3.8l2.6-.6 1.8 4.2-1.8 1.4a11 11 0 005.8 5.8l1.4-1.8 4.2 1.8-.6 2.6a1.9 1.9 0 01-1.9 1.5C10.6 18.6 5.4 13.4 5.3 5.7a1.9 1.9 0 011.5-1.9z"/>',
  browser: '<circle cx="12" cy="12" r="8.6"/><path d="M15.6 8.4l-2 5.2-5.2 2 2-5.2z"/>',
  messages:
    '<path d="M12 4c5 0 9 3.1 9 7s-4 7-9 7c-1 0-2-.1-2.9-.4L4.4 19.6l1.2-3.8C4 14.6 3 12.9 3 11c0-3.9 4-7 9-7z"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.6"/><path d="M4 7.2l8 6 8-6"/>',
  trash: '<path d="M4 7h16M9.2 7V4.6h5.6V7M6.2 7l1 13h9.6l1-13"/>',
  search: '<circle cx="10.6" cy="10.6" r="5.8"/><path d="M15 15l4.6 4.6"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3"/>',
  share: '<path d="M12 3.5v11.5M8 7.5l4-4 4 4"/><path d="M6.5 11v8.5h11V11"/>',
  airplane:
    '<path d="M10.6 4.2a1.4 1.4 0 012.8 0v5l7 4v2.2l-7-2.2v4.8l2.2 1.6v1.8L12 20.4l-3.6 1v-1.8l2.2-1.6v-4.8l-7 2.2v-2.2l7-4z"/>',
  cellular: '<path d="M5 18.5v-2.5M9.4 18.5v-5.5M13.8 18.5v-8.5M18.2 18.5V5.5" stroke-width="2.6"/>',
  wifi: '<path d="M3 9.2a13 13 0 0118 0M6 12.6a8.6 8.6 0 0112 0M9 16a4.2 4.2 0 016 0"/><path d="M12 19.4h.01" stroke-width="3"/>',
  waves:
    '<path d="M12 12h.01" stroke-width="3"/><path d="M8.6 8.6a4.8 4.8 0 000 6.8M15.4 8.6a4.8 4.8 0 010 6.8M5.6 5.6a9 9 0 000 12.8M18.4 5.6a9 9 0 010 12.8"/>',
  rings: '<circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="12" r="5.4"/><circle cx="12" cy="12" r="9"/>',
  moon: '<path d="M19.6 14.6A7.9 7.9 0 019.4 4.4a7.9 7.9 0 1010.2 10.2z"/>',
  mirror: '<rect x="3" y="4.5" width="18" height="12" rx="2.2"/><path d="M8.6 20h6.8M12 16.5V20"/>',
  flashlight: '<path d="M8 3h8v4l-2 3v11h-4V10L8 7z"/><path d="M12 13.2v2"/>',
  timer: '<circle cx="12" cy="13.2" r="7.4"/><path d="M12 13.2V9.4M10 2.8h4M18.4 6.4l1.2-1.2"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v1.8M12 19.4v1.8M2.8 12h1.8M19.4 12h1.8M5.5 5.5l1.3 1.3M17.2 17.2l1.3 1.3M5.5 18.5l1.3-1.3M17.2 6.8l1.3-1.3"/>',
  speaker: '<path d="M4 9.6h3.4L12 5.6v12.8l-4.6-4H4z"/><path d="M15.4 9.2a4 4 0 010 5.6M17.8 6.8a7.4 7.4 0 010 10.4"/>',
  play: '<path d="M8 5.4v13.2L18.6 12z" fill="currentColor"/>',
  pause: '<path d="M8.4 5.6v12.8M15.6 5.6v12.8" stroke-width="3.2"/>',
  next: '<path d="M4.8 6.4v11.2L11.6 12zM12 6.4v11.2L18.8 12z" fill="currentColor"/>',
  prev: '<path d="M19.2 6.4v11.2L12.4 12zM12 6.4v11.2L5.2 12z" fill="currentColor"/>',
  battery:
    '<rect x="2.4" y="7.6" width="17.2" height="8.8" rx="2.6"/><rect x="4.4" y="9.6" width="11.4" height="4.8" rx="1.2" fill="currentColor" stroke="none"/><path d="M21.6 10.6v2.8"/>',
  signal:
    '<rect x="3" y="14" width="3" height="5" rx="1" fill="currentColor" stroke="none"/><rect x="8" y="11" width="3" height="8" rx="1" fill="currentColor" stroke="none"/><rect x="13" y="8" width="3" height="11" rx="1" fill="currentColor" stroke="none"/><rect x="18" y="5" width="3" height="14" rx="1" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 3.4l2 5.4 5.4 2-5.4 2-2 5.4-2-5.4-5.4-2 5.4-2z"/>',
  person: '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0114.4 0"/>',
  pin: '<path d="M12 21s-6.6-6-6.6-11.2a6.6 6.6 0 0113.2 0C18.6 15 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><path d="M10.2 9.4v5.2l4.4-2.6z"/>',
  heart: '<path d="M12 19.6s-7.2-4.4-7.2-9.8A4 4 0 0112 7.4a4 4 0 017.2 2.4c0 5.4-7.2 9.8-7.2 9.8z"/>',
  controls:
    '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2.2"/><circle cx="9" cy="16" r="2.2"/>',
  // 首页的几个场景用的
  today: '<rect x="5" y="3.5" width="14" height="17" rx="2.6"/><path d="M8.5 8h7M8.5 11.5h7"/><rect x="8.5" y="14.2" width="7" height="3" rx="0.8"/>',
  rocket:
    '<path d="M12 3.2c3.2 2.4 4.6 6 3.8 10.4H8.2C7.4 9.2 8.8 5.6 12 3.2z"/><circle cx="12" cy="9.4" r="1.6"/><path d="M8.4 12.2l-2.6 2.6v3.4l3-1.6M15.6 12.2l2.6 2.6v3.4l-3-1.6M10.4 16.8l1.6 3.4 1.6-3.4"/>',
  layers: '<path d="M12 3.6l8.4 4.4L12 12.4 3.6 8z"/><path d="M3.6 12L12 16.4l8.4-4.4"/><path d="M3.6 16L12 20.4l8.4-4.4"/>',
  gamepad:
    '<path d="M7.4 7.6h9.2a4.4 4.4 0 014.2 5.6l-1 3.6a2.4 2.4 0 01-4 1l-1.8-2H9.9l-1.8 2a2.4 2.4 0 01-4-1l-1-3.6a4.4 4.4 0 014.3-5.6z"/><path d="M8 10.6v3.2M6.4 12.2h3.2"/><circle cx="15.6" cy="11.2" r="0.9"/><circle cx="17.2" cy="13.2" r="0.9"/>',
  bluetooth: '<path d="M7.4 7.8l9.2 8.4L12 20.4V3.6l4.6 4.2-9.2 8.4"/>',
  lock: '<rect x="5.4" y="10.6" width="13.2" height="9.4" rx="2.2"/><path d="M8.4 10.6V8a3.6 3.6 0 017.2 0v2.6"/>',
  power: '<path d="M12 3.6v7.2"/><path d="M7.2 6.6a7.2 7.2 0 109.6 0"/>'
}

/** 某个图形的 SVG。没有这个名字就抛：展示页里写错名字要当场看出来。 */
export function icon(name: string): string {
  const body = PATHS[name]
  if (body === undefined) throw new Error(`[showcase] 没有叫 ${name} 的图形`)
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" ' +
    `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  )
}

/** 把 root 里所有 `[data-icon]` 填上图形。 */
export function fillIcons(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    if (el.firstElementChild) continue
    el.innerHTML = icon(el.dataset.icon!)
  }
}
