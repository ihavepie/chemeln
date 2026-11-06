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

/** Ketcher 3.18 的 bug 补丁（「环闭不上」的根因）：
    键的 hover 探测 `hpU()` 里对每个可见键都无条件算 `molecule.halfBonds.get(bond.hb1)`
    ——`.p` 取中点、`.dir` 取方向。可拖键过程中画出来的那根预览键还没配 half-bond，
    `get()` 返回 undefined，于是抛 TypeError，**整个拖拽当场断掉**。
    用户看到的就是「原子之间能连，但环闭不上」：从环的一头拖到另一头，鼠标必然划过环内的键，
    一划就炸。这里在每个键的开头加一道：没有 half-bond 的键不参与 hover 探测（直接 return）。
    压缩后的变量名可能变，所以按形状抓一小段窗口匹配（别对 29 MB 整串跑正则，会卡死）；
    匹配不上直接报错，别默默失效。 */
function patchBondHover() {
  const MARK = '.visibleBonds.forEach(function('
  const WIN = /(\w+)\.visibleBonds\.forEach\(function\((\w+),(\w+)\)\{var (\w+)=\3===(\w+)\|\|\2\.b\.isPreview;if\(!\4\)\{/
  return {
    name: 'patch-ketcher-bond-hover',
    enforce: 'post',
    // 补丁是在算完 hash 之后才改字节的，所以手动把版本号掺进 hash：
    // 每改一次上面的补丁，就把它 +1，浏览器才不会继续用缓存里的旧文件（/vendor 是 immutable）
    augmentChunkHash() {
      return 'bond-hover-patch-11'
    },
    generateBundle(_opts, bundle) {
      let hits = 0
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue
        let pos = 0
        for (;;) {
          const k = file.code.indexOf(MARK, pos)
          if (k < 0) break
          const from = Math.max(0, k - 32)
          const seg = file.code.slice(from, k + 460)
          const m = WIN.exec(seg)
          if (!m) {
            pos = k + MARK.length
            continue
          }
          const [whole, obj, bond, idx, flag, skip] = m
          const start = from + m.index
          const repl =
            `${obj}.visibleBonds.forEach(function(${bond},${idx}){` +
            `var ${flag}=${idx}===${skip}||${bond}.b.isPreview;` +
            `if(!${flag}){if(!${obj}.molecule.halfBonds.get(${bond}.b.hb1))return;`
          file.code = file.code.slice(0, start) + repl + file.code.slice(start + whole.length)
          pos = start + repl.length
          hits++
        }
      }
      if (!hits) this.error('Ketcher 的键 hover 探测代码没找到，补丁没打上（见 vite.config.js）')
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), copyIndigoWasm(), patchBondHover()],
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
