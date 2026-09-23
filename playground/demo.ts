/**
 * Demo 页：一个「真实页面」只需要这些 —— 注册组件、建 stage、给它一张背景。
 * 玻璃的材质都写在 HTML 属性上；表单提交走 <glass-button> 自己的表单关联。
 */

import '../src/components/glassium.css'

import { createGlassStage, defineGlassElements } from 'glassium'

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

  // 订阅表单：<glass-button> 在表单里默认就是提交按钮，name / value 跟着进表单数据
  const form = document.getElementById('subscribe') as HTMLFormElement
  const toast = document.getElementById('toast')!
  let hideTimer = 0
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const data = new FormData(form, (e as SubmitEvent).submitter)
    toast.textContent = `已订阅 ${String(data.get('email'))}（${data.get('plan') === 'weekly' ? '每周' : '其它'}）`
    toast.hidden = false
    clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      toast.hidden = true
    }, 2600)
  })
}

void main()
