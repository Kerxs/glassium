/**
 * Demo 页：一个「真实页面」只需要这些 —— 注册组件、建 stage、给它一张背景。
 * 玻璃的材质都写在 HTML 属性上；表单提交走 <glass-button> 自己的表单关联。
 */

import '../src/components/glassium.css'

import { createGlassStage, defineGlassElements } from 'glassium'

import { makePhoto } from './scenes.ts'

defineGlassElements()

// 背景图：真实页面里通常是一个 URL（createGlassStage({ scene: '/bg.jpg' })）。
// 这里是程序化生成的一张照片，先编码成 JPEG Blob。生成与解码期间组件显示 CSS 兜底表面。
const stage = await createGlassStage({ scene: await makePhoto(), sceneOptions: { background: '#141233' } })
Object.assign(window as unknown as Record<string, unknown>, { glassiumStage: stage })

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
