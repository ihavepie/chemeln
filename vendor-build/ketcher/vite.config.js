import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/** 把 Indigo 的 wasm 一起拷到产物里：Ketcher 的 standalone 服务在运行时按 URL 找它们 */
function copyIndigoWasm() {
  return {
    name: 'copy-indigo-wasm',
    closeBundle() {
      const from = path.resolve('node_modules/ketcher-standalone/dist/binaryWasm')
      const to = path.resolve('../../vendor/ketcher/wasm')
      if (!existsSync(from)) return
      mkdirSync(to, { recursive: true })
      cpSync(from, to, { recursive: true })
      console.log('copied indigo wasm →', to)

      const rap = path.resolve('node_modules/raphael/raphael.min.js')
      const rapTo = path.resolve('../../vendor/ketcher/raphael.min.js')
      if (existsSync(rap)) {
        mkdirSync(path.dirname(rapTo), { recursive: true })
        cpSync(rap, rapTo)
        console.log('copied raphael →', rapTo)
      }
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), copyIndigoWasm()],
  assetsInclude: ['**/*.wasm'],
  /* ketcher-core 里 `import { EventEmitter } from 'events'`（Node 内置模块），
     浏览器没有，指到 npm 上的 polyfill 包 */
  resolve: { alias: { events: 'events' } },
  define: { global: 'globalThis' },
  optimizeDeps: { exclude: ['ketcher-standalone'] },
  worker: { format: 'es' },
  build: {
    target: 'es2020',
    outDir: path.resolve('../../vendor/ketcher'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        /* 有第三方库在模块顶层写了 `require("raphael")` / `require("acorn")`（Node 习惯写法，
           浏览器里没有 require 会直接抛 ReferenceError）。给一个空壳 require 兜住，
           这些分支本来就是「有就用、没有就算」的可选路径。 */
        banner: 'var require=function(n){return n==="raphael"?window.Raphael:undefined;};',
      },
    },
  },
})
