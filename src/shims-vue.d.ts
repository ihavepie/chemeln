/**
 * 给 JS 用 tsc 检查时用的垫片：`.vue` 文件没有类型声明，`import X from './views/X.vue'`
 * 会被报「找不到模块」。这里统一声明成「随便一个 Vue 组件」，检查器就不会被这些噪音淹掉。
 * 只影响 `npm run check:types`，构建（Vite）完全不看这个文件。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
