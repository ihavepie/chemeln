import React from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from 'ketcher-react'
import { StandaloneStructServiceProvider } from 'ketcher-standalone'
import 'ketcher-react/dist/index.css'

/* 外面（Vue 里的 SketcherModal）通过 iframe.contentWindow.sketcherApi 用这几个方法。
   Ketcher 的 API 是异步的，所以这里统一包成 async，调用方 await。 */
const structServiceProvider = new StandaloneStructServiceProvider()

/* 默认工具：Ketcher 出厂是「框选」，拖原子只会把结构挪走，连不到另一个原子上
   （用户反馈「没办法直接链接原子」）。这里在工具栏渲染出来后替它点一下单键按钮。
   工具栏是异步挂上的，所以找不到就重试几次。 */
function pickBondTool(tries = 60) {
  const btn = Array.from(document.querySelectorAll('[data-testid="bonds"]')).find(
    (b) => b.getBoundingClientRect().width > 0,
  )
  if (btn) {
    btn.click()
    return
  }
  if (tries > 0) setTimeout(() => pickBondTool(tries - 1), 100)
}

/* ⌘V 直接把结构 / 反应式粘进画板。
   Ketcher 自己不吃系统的粘贴（实测派发 paste 事件画布毫无反应），而 ChemDraw 里
   「Copy As → Molfile / SMILES」拿到的东西正好是纯文本，所以这里自己接管：
   MOL、反应式 SMILES、RXN、以及 ChemDraw 自己的剪贴板格式 CDXML（Indigo 都认得）。 */
function looksLikeChem(text) {
  const s = String(text || '').trim()
  if (s.length < 2 || s.length > 300000) return false
  if (/V2000|V3000/.test(s) && /M\s+END/.test(s)) return true          // molfile
  if (s.startsWith('$RXN') || /^\$RXN/.test(s)) return true            // rxn
  if (/<CDXML/i.test(s.slice(0, 3000))) return true                    // ChemDraw 的 CDXML
  if (/^[A-Za-z0-9@+\[\]()=#$:\/\\.\-*%]+(>>|>)[A-Za-z0-9@+\[\]()=#$:\/\\.\-*%]+/.test(s)) return true // 反应式 SMILES
  // SMILES：只有结构字符、没有空白、至少一个字母
  if (!/\s/.test(s) && /[A-Za-z]/.test(s) && /^[A-Za-z0-9@+\[\]()=#$:\/\\.\-*%]+$/.test(s)) return true
  return false
}

window.addEventListener(
  'paste',
  async (ev) => {
    const data = ev.clipboardData
    if (!data) return
    const text = data.getData('text/plain') || ''
    if (!looksLikeChem(text)) return
    ev.preventDefault()
    ev.stopPropagation()
    try {
      await window.ketcher.setMolecule(text)
      pickBondTool(10)
      window.__lastPaste = 'ok'
    } catch (err) {
      window.__lastPaste = 'err: ' + ((err && err.message) || err)
    }
  },
  true,
)

/* 视野「居中 + 100%」。
   Ketcher 的 `zoomAccordingContent()`（`setMolecule` 里自动调的）**只缩不放**（MAX_ZOOM_VALUE = 1），
   而且算的时候要拿画布真实尺寸：**弹窗还没显示出来**（display:none，尺寸 0）时载入一次，
   缩放会被算成下限 0.1 —— 结构缩成拇指大、缩在左上角，画布一片空白还有滚动条（用户截图报过）。
   所以载入前后都打一次 `zoom(1)` + `centerViewportAccordingToStruct()`，载完再补两次。 */
function recenter() {
  try {
    const ed = window.ketcher?.editor
    ed?.zoom?.(1)
    ed?.centerViewportAccordingToStruct?.()
  } catch {
    /* 拿不到就当没这回事 */
  }
}

/* 等画板容器真正有尺寸再载入结构（弹窗打开的那一瞬间 iframe 还是 0×0） */
async function waitForSize() {
  for (let i = 0; i < 40; i++) {
    const box = document.body.getBoundingClientRect()
    if (box.width > 40 && box.height > 40) return true
    await new Promise((r) => window.setTimeout(r, 60))
  }
  return false
}

/* **ACS Document 1996**（ChemDraw 里那个“Apply Document Settings from → ACS Document 1996”）：
   键长 14.4 pt、键粗 0.6 pt、标签 10 pt Arial、原子不上色（黑）、芳环画成 Kekulé 交替双键。
   这两个地方都要跟着它走：① 画板上看到的；② `generateImage` 出 SVG 时把这份 settings 一起
   交给 Indigo（Ketcher 的 `generateImage` 会把 `serverSettings` 和传进去的 options 合并）。 */
const ACS_1996 = {
  atomColoring: false,
  font: 'Arial',
  fontsz: 10,
  fontszUnit: 'pt',
  fontszsub: 10,
  fontszsubUnit: 'pt',
  bondLength: 14.4,
  bondLengthUnit: 'pt',
  bondThickness: 0.6,
  bondThicknessUnit: 'pt',
  bondSpacing: 18,
  stereoBondWidth: 2,
  stereoBondWidthUnit: 'pt',
  hashSpacing: 2.5,
  hashSpacingUnit: 'pt',
  reactionComponentMarginSize: 1.6,
  reactionComponentMarginSizeUnit: 'pt',
  imageResolution: 600,
  aromaticCircle: false,
  carbonExplicitly: false,
  showHydrogenLabels: 'Terminal and Hetero',
}

function applyAcs() {
  try {
    window.ketcher?.setSettings?.(ACS_1996)
    return true
  } catch (err) {
    window.__acsErr = String((err && err.message) || err)
    return false
  }
}

window.__ketcherReady = false
window.sketcherApi = {
  /** 切回单键工具（载入结构后 Ketcher 有时会退回框选） */
  bond: () => pickBondTool(),
  ready: () => window.__ketcherReady,
  /** 重新套一遍 ACS 1996 文档设置（换页面 / 设置被冲掉时用） */
  acs: () => applyAcs(),
  settings: () => {
    try {
      return window.ketcher?.getSettings?.() || null
    } catch {
      return null
    }
  },
  /** 整理一下：Indigo 重新算一遍 2D 坐标（画得歪的键、挤在一起的环都会摆正） */
  layout: async () => {
    try {
      await window.ketcher.layout()
      return true
    } catch {
      return false
    }
  },
  getSmiles: async () => {
    try { return (await window.ketcher.getSmiles()) || '' } catch { return '' }
  },
  getMol: async () => {
    try { return (await window.ketcher.getMolfile()) || '' } catch { return '' }
  },
  /** 整张反应式（反应物 + 箭头 + 产物）存成 RXN，方便下次接着改 */
  getRxn: async () => {
    try { return (await window.ketcher.getRxn()) || '' } catch { return '' }
  },
  /** 画板上的东西 → SVG 文本：用 Ketcher 自带的 Indigo 渲染，
      反应式的 +、箭头、条件文字都能画进去（openchemlib 画不了反应式） */
  image: async (data) => {
    try {
      const blob = await window.ketcher.generateImage(data, { outputFormat: 'svg' })
      return (await blob.text()) || ''
    } catch { return '' }
  },
  /** **画布原样导出**：把画布里那块 <svg> 直接序列化出来（跟 Ketcher 自带的
      「导出 SVG」同一套做法：只留 .drawn-structures，去掉选区框 / 动态元素，
      再按它的外框算 viewBox）。存下来的图＝画板上看到的那张，标签是真文字。 */
  canvasSvg: (margin = 10) => {
    try {
      const drawn = document.querySelector('.drawn-structures')
      const canvas = drawn && drawn.closest('svg')
      if (!canvas || !drawn) return ''
      const r = drawn.getBoundingClientRect()
      if (!r.width || !r.height) return ''
      const pad = 10 + margin
      const x = r.x - 50 - pad
      const y = r.y - 54 - pad
      const w = r.width + pad * 2
      const h = r.height + pad * 2
      const clone = canvas.cloneNode(true)
      clone.querySelector('#rectangle-selection-area')?.remove()
      clone.querySelectorAll('.dynamic-element').forEach((e) => e.remove())
      clone.querySelectorAll('text').forEach((e) => e.setAttribute('cursor', 'default'))
      clone.querySelectorAll('rect[cursor="text"]').forEach((e) => e.removeAttribute('cursor'))
      clone.querySelectorAll('g[opacity]').forEach((e) => e.removeAttribute('opacity'))
      const inner = clone.innerHTML.replace(/\bcursor:\s*pointer;\s*/g, '')
      if (!inner || !inner.includes('<')) return ''
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="${x} ${y} ${w} ${h}">${inner}</svg>`
    } catch {
      return ''
    }
  },
  set: async (text) => {
    await waitForSize()
    // **载入前先把缩放打回 100%**：Ketcher 的 `zoomAccordingContent` 只会缩、不会放大
    // （MAX_ZOOM_VALUE = 1），缩过的比例会一直留着。于是「上一次载入的是个大结构」之后，
    // 后面这张小分子也停在 87% —— 分子变小、周围一大片空白，看着像「画布漂移」（实测 40px/键 → 35px）。
    recenter()
    try {
      if (text) await window.ketcher.setMolecule(text);
    } catch {
      /* 读不出来就当空白 */
    }
    // 再居中一次，并在弹窗动画停下来之后补两次（容器尺寸刚定下来时算出来的视野是错的）
    recenter()
    window.setTimeout(recenter, 250)
    window.setTimeout(recenter, 700)
    pickBondTool(10)
  },
  clear: async () => {
    await waitForSize()
    recenter()
    try {
      await window.ketcher.setMolecule('')
    } catch {
      /* noop */
    }
  },
}

function App() {
  return (
    <Editor
      staticResourcesUrl=""
      structServiceProvider={structServiceProvider}
      /* 只用「分子」编辑器：不要大分子 / 序列那一套（monomer 库、RNA/DNA 按钮），
         那些按钮在画小分子时只会添乱 */
      disableMacromoleculesEditor
      onInit={(ketcher) => {
        window.ketcher = ketcher
        window.__ketcherReady = true
        applyAcs()
        pickBondTool()
      }}
    />
  )
}

createRoot(document.getElementById('root')).render(<App />)
