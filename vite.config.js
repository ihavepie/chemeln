import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** indigo-ketcher 的 WASM（11 MB）我们是从 `/vendor/indigo/` 拿的（`src/lib/indigo.js` 里
    传了 locateFile），但打包时 Vite 还会顺手把 node_modules 里那份再抄进 public/assets/
    —— 白占一倍体积，而且 public/ 是进 git 的。这里删掉，反正那条兜底 URL 永远走不到。 */
function dropIndigoWasm() {
  return {
    name: 'drop-indigo-wasm',
    closeBundle() {
      const dir = path.resolve('public/assets');
      let files = [];
      try {
        files = readdirSync(dir);
      } catch {
        return;
      }
      for (const f of files) if (/^indigo-ketcher-.*\.wasm$/.test(f)) rmSync(path.join(dir, f));
    },
  };
}

/**
 * 构建产物直接写进 public/，所以 server/index.js 一行都不用改：
 * 它本来就是“把 public/ 发出去”。
 * 开发时 `npm run dev` 起 Vite，/api 转发到 4780 的本地服务。
 */
export default defineConfig({
  plugins: [vue(), dropIndigoWasm()],
  publicDir: false,
  // 已经切换到 v2：构建产物直接进 public/，4780 跑的就是这套
  // （旧 v1 备份在 .backup/public-v1-<时间>/，要回退把那份拷回来再改回 outDir 即可）
  build: {
    outDir: 'public',
    emptyOutDir: true,
    target: 'es2020',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4780', changeOrigin: false },
    },
  },
});
