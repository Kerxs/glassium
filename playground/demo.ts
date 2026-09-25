/**
 * Demo 页：一个「真实页面」只需要这些 —— 注册组件、建 stage、给它一张背景。
 * 玻璃的材质都写在 HTML 属性上；表单提交走 <glass-button> 自己的表单关联。
 */

import '../src/components/glassium.css'

import { createGlassStage, defineGlassElements, morphGlass } from 'glassium'

import { makePhoto } from './scenes.ts'

// 不用顶层 await：Vite 的默认构建目标（es2020）不支持，`vite build` 会直接失败
async function main(): Promise<void> {
  defineGlassElements()

  // 背景图：真实页面里通常是一个 URL（createGlassStage({ scene: '/bg.jpg' })）。
  // 这里是程序化生成的一张照片，先编码成 JPEG Blob。生成与解码期间组件显示 CSS 兜底表面。
  const stage = await createGlassStage({ scene: await makePhoto(), sceneOptions: { background: '#141233' } })
  Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })

  // 分享菜单：切换一个 class，剩下的交给 CSS 过渡。玻璃跟着菜单的缩放与淡入走，
  // 并且因为按钮与菜单在同一个 <glass-container> 里，菜单从按钮那里「长」出来
  const share = document.getElementById('share')!
  const shareBtn = document.getElementById('share-btn')!
  const setOpen = (open: boolean): void => {
    share.classList.toggle('open', open)
    shareBtn.setAttribute('aria-expanded', String(open))
  }
  shareBtn.addEventListener('click', () => setOpen(!share.classList.contains('open')))
  document.getElementById('share-menu')!.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button')) setOpen(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false)
  })

  // 按钮长成卡片：morphGlass(from, to) —— 一块过渡用的玻璃从按钮的位置、大小、材质变到卡片的，按钮淡出、卡片淡入。
  // 收起的那个用 visibility: hidden 藏着（仍然排版，变形开始时要量它）；变形途中再按不理
  const growOpen = document.getElementById('grow-open')!
  const growCard = document.getElementById('grow-card')!
  const growClose = document.getElementById('grow-close')!
  let growing = false
  const grow = async (open: boolean): Promise<void> => {
    if (growing || (growOpen.getAttribute('aria-expanded') === 'true') === open) return
    growing = true
    const [from, to] = open ? [growOpen, growCard] : [growCard, growOpen]
    to.classList.remove('collapsed')
    growOpen.setAttribute('aria-expanded', String(open))
    await morphGlass(from, to).finished
    from.classList.add('collapsed')
    growing = false
    ;(open ? growClose : growOpen).focus()
  }
  growOpen.addEventListener('click', () => void grow(true))
  growClose.addEventListener('click', () => void grow(false))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void grow(false)
  })

  // 订阅表单：<glass-button> 在表单里默认就是提交按钮，name / value 跟着进表单数据
  const form = document.getElementById('subscribe') as HTMLFormElement
  const toast = document.getElementById('toast')!
  let hideTimer = 0
  const say = (text: string): void => {
    toast.textContent = text
    toast.hidden = false
    clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      toast.hidden = true
    }, 2600)
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const data = new FormData(form, (e as SubmitEvent).submitter)
    say(`已订阅 ${String(data.get('email'))}（${data.get('plan') === 'weekly' ? '每周' : '其它'}）`)
  })

  // 变形：<glass-container morph> 里新加的成员从最近的成员边上像水滴一样分出来，dismiss() 融回去再拿掉
  const morph = document.getElementById('morph') as HTMLElement & { dismiss(member: HTMLElement): Promise<void> }
  const morphToggle = document.getElementById('morph-toggle')!
  let extras: HTMLElement[] = []
  morphToggle.addEventListener('click', () => {
    if (extras.length === 0) {
      extras = ['♡ 收藏', '↗ 分享'].map((label) => {
        const b = document.createElement('glass-button')
        b.setAttribute('preset', 'regular')
        b.setAttribute('type', 'button')
        b.textContent = label
        morph.append(b)
        return b
      })
      morphToggle.setAttribute('aria-expanded', 'true')
    } else {
      for (const b of extras) void morph.dismiss(b)
      extras = []
      morphToggle.setAttribute('aria-expanded', 'false')
    }
  })

  // 对话框：原生的 <dialog>。里面的玻璃在顶层里，stage 自动改用 CSS 画（不用写任何东西）
  const about = document.getElementById('about') as HTMLDialogElement
  document.getElementById('about-open')!.addEventListener('click', () => about.showModal())
  document.getElementById('about-close')!.addEventListener('click', () => about.close())

  // 导航栏：左边跳到设置，右边搜索（这里只给个提示）与关于
  const smooth = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
  document.getElementById('nav-settings')!.addEventListener('click', () =>
    document.getElementById('settings')!.scrollIntoView({ behavior: smooth(), block: 'center' })
  )
  document.getElementById('nav-search')!.addEventListener('click', () => say('搜索：这里只是个样子'))
  document.getElementById('nav-about')!.addEventListener('click', () => about.showModal())

  // 标签栏：换选中时派发 change（按住拖到别的格上再松手也算）
  const tabbar = document.getElementById('tabbar') as HTMLElement & { value: string }
  tabbar.addEventListener('change', () => {
    const label = tabbar.querySelector('[aria-selected="true"] .label')?.textContent ?? tabbar.value
    say(`切到「${label}」`)
  })

  // 设置：<glass-switch> 与 checkbox、<glass-slider> 与 range 一样派发 change
  document.getElementById('settings')!.addEventListener('change', (e) => {
    const target = e.target as HTMLElement & { checked?: boolean; value?: string }
    const label = target.closest('label')?.querySelector('span')?.textContent?.trim() ?? ''
    const text =
      target.localName === 'glass-slider'
        ? `${target.value}%`
        : target.localName === 'glass-segmented'
          ? (target.querySelector('[aria-checked="true"]')?.textContent ?? '')
          : target.checked
            ? '开'
            : '关'
    say(`${label}：${text}`)
  })
}

void main()
