import React from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from 'ketcher-react'
import { StandaloneStructServiceProvider } from 'ketcher-standalone'
import 'ketcher-react/dist/index.css'

/* 外面（Vue 里的 SketcherModal）通过 iframe.contentWindow.sketcherApi 用这几个方法。
   Ketcher 的 API 是异步的，所以这里统一包成 async，调用方 await。 */
const structServiceProvider = new StandaloneStructServiceProvider()

window.__ketcherReady = false
window.sketcherApi = {
  ready: () => window.__ketcherReady,
  getSmiles: async () => {
    try { return (await window.ketcher.getSmiles()) || '' } catch { return '' }
  },
  getMol: async () => {
    try { return (await window.ketcher.getMolfile()) || '' } catch { return '' }
  },
  set: async (text) => {
    try { if (text) await window.ketcher.setMolecule(text) } catch { /* 读不出来就当空白 */ }
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
      }}
    />
  )
}

createRoot(document.getElementById('root')).render(<App />)
