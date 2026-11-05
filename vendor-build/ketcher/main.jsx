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

window.__ketcherReady = false
window.sketcherApi = {
  /** 切回单键工具（载入结构后 Ketcher 有时会退回框选） */
  bond: () => pickBondTool(),
  ready: () => window.__ketcherReady,
  getSmiles: async () => {
    try { return (await window.ketcher.getSmiles()) || '' } catch { return '' }
  },
  getMol: async () => {
    try { return (await window.ketcher.getMolfile()) || '' } catch { return '' }
  },
  set: async (text) => {
    try { if (text) await window.ketcher.setMolecule(text) } catch { /* 读不出来就当空白 */ }
    pickBondTool(10)
  },
  clear: async () => {
    try { await window.ketcher.setMolecule('') } catch { /* noop */ }
  },
}

function App() {
  return (
    <Editor
      staticResourcesUrl=""
      structServiceProvider={structServiceProvider}
      onInit={(ketcher) => {
        window.ketcher = ketcher
        window.__ketcherReady = true
        pickBondTool()
      }}
    />
  )
}

createRoot(document.getElementById('root')).render(<App />)
