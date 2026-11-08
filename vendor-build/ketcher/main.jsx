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

window.__ketcherReady = false
window.sketcherApi = {
  /** 切回单键工具（载入结构后 Ketcher 有时会退回框选） */
  bond: () => pickBondTool(),
  ready: () => window.__ketcherReady,
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
  set: async (text) => {
    // **载入前先把缩放打回 100%**：Ketcher 的 `zoomAccordingContent` 只会缩、不会放大
    // （MAX_ZOOM_VALUE = 1），缩过的比例会一直留着。于是「上一次载入的是个大结构」之后，
    // 后面这张小分子也停在 87% —— 分子变小、周围一大片空白，看着像「画布漂移」（实测 40px/键 → 35px）。
    try {
      window.ketcher.editor?.zoom(1);
    } catch {
      /* 拿不到就当没这回事 */
    }
    try {
      if (text) await window.ketcher.setMolecule(text);
    } catch {
      /* 读不出来就当空白 */
    }
    // 再把视野对准结构（setMolecule 自己也会居中，这一步是兜底：画布被拖到空白处时拉回来）
    try {
      window.ketcher.editor?.centerViewportAccordingToStruct?.();
    } catch {
      /* 同上 */
    }
    pickBondTool(10)
  },
  clear: async () => {
    try {
      window.ketcher.editor?.zoom(1);
    } catch {
      /* 同上 */
    }
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
        pickBondTool()
      }}
    />
  )
}

createRoot(document.getElementById('root')).render(<App />)
