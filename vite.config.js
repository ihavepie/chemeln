import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 构建产物直接写进 public/，所以 server/index.js 一行都不用改：
 * 它本来就是“把 public/ 发出去”。
 * 开发时 `npm run dev` 起 Vite，/api 转发到 4780 的本地服务。
 */
export default defineConfig({
  plugins: [vue()],
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
