import React from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from 'ketcher-react'
import { StandaloneStructServiceProvider } from 'ketcher-standalone'
import { Bond, fromBondsAttrs } from 'ketcher-core'
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

/* ChemDraw 那套数字键改键的顺序：把鼠标停在某根键上按 1/2/3/4，
   直接改成单键 / 双键 / 三键 / 芳香键（Ketcher 3.18 自己没做这几个键）。
   没有悬停、但有选中的键时也对选中的生效。 */
const BOND_KEYS = { 1: 'single', 2: 'double', 3: 'triple', 4: 'aromatic' }
/* Ketcher 内部用的是数字：Bond.PATTERN.TYPE.SINGLE = 1、DOUBLE = 2 ……别传字符串，
   传字符串会被它的 action 丢掉（踩过：setBond 返回 true 但结构没变 / 结构被清空） */
const BOND_TYPE_NUM = {
  single: Bond.PATTERN.TYPE.SINGLE,
  double: Bond.PATTERN.TYPE.DOUBLE,
  triple: Bond.PATTERN.TYPE.TRIPLE,
  aromatic: Bond.PATTERN.TYPE.AROMATIC,
}

function hoveredOrSelectedBonds() {
  const editor = window.ketcher?.editor
  if (!editor) return { editor, ids: [] }
  const ctab = editor.render.ctab
  const ids = []
  ctab.molecule.bonds.forEach((bond, id) => {
    if (bond.hover) ids.push(id)
  })
  if (ids.length) return { editor, ids }
  const sel = (editor.selection && editor.selection()) || {}
  return { editor, ids: sel.bonds || [] }
}

function setBondType(name) {
  const { editor, ids } = hoveredOrSelectedBonds()
  const type = BOND_TYPE_NUM[name]
  if (!editor || !ids.length || !type) return false
  try {
    editor.update(fromBondsAttrs(editor.render.ctab, ids, { type }))
    return true
  } catch (err) {
    window.__lastBondErr = String((err && err.message) || err)
    return false
  }
}

/* 捕获阶段先拦：Ketcher 自己的快捷键认不出数字，别让它把事件吃掉 */
window.addEventListener(
  'keydown',
  (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    const type = BOND_KEYS[ev.key]
    if (!type) return
    if (setBondType(type)) {
      ev.preventDefault()
      ev.stopPropagation()
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
  /** 鼠标停着的那根键 / 选中的键改成什么键：single | double | triple | aromatic */
  setBond: (type) => setBondType(type),
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
