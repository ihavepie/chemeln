import { createApp } from 'vue';
// Element Plus **按需引样式**：整个项目只用 Dialog / MessageBox / Notification 三个组件
// （见 AppModal.vue、lib/feedback.js），以前引 `element-plus/dist/index.css` 会把整套主题
// （含表格、日期选择器、级联…几十个组件）都打进产物 —— 构建产物里的 CSS 有一半是它。
// 每个 `style/css` 会自己带上 base 和它依赖的子组件（overlay / button / input…），不用手写。
import 'element-plus/es/components/base/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/message-box/style/css';
import 'element-plus/es/components/notification/style/css';
import './styles/eln.css';
import './styles/el-theme.css';
import App from './App.vue';
import { router } from './router.js';
import { growAll, growTextarea } from './lib/autogrow.js';

/** v1 的入场动画：CSS 里 [data-anim] 初始 opacity:0，进入视口后加 .in */
const animObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        animObserver.unobserve(e.target);
      }
    }
  },
  { rootMargin: '0px 0px -40px 0px', threshold: 0.01 }
);

const app = createApp(App);
app.directive('anim', {
  mounted(el, binding) {
    el.setAttribute('data-anim', '');
    if (binding.value != null) el.style.setProperty('--i', String(binding.value));
    animObserver.observe(el);
  },
  unmounted(el) {
    animObserver.unobserve(el);
  },
});

/** v-focus：挂上去就聚焦（弹窗里的搜索框用） */
app.directive('focus', {
  mounted(el) {
    el.focus();
    el.select?.();
  },
});

/** v-autogrow：文本域长到能装下内容，长表征不会被困在小滚动框里、打印时被截掉 */
app.directive('autogrow', {
  mounted(el) {
    el.dataset.autogrow = '';
    growTextarea(el);
    // 挂载那一下字体可能还没生效，下一帧再量一次才准
    requestAnimationFrame(() => growTextarea(el));
  },
  updated(el) {
    growTextarea(el);
  },
});

// v-model 改的是 property，不会触发指令的 updated，所以直接在 input 事件上补一刀
document.addEventListener(
  'input',
  (e) => {
    if (e.target?.dataset?.autogrow !== undefined) growTextarea(e.target);
  },
  true
);
window.addEventListener('resize', growAll);

// 不再 `app.use(ElementPlus)`：三个组件都是在用到处直接 import 的（`<script setup>` 里 import 了
// 就能在模板里当 `<el-dialog>` 用），全局注册只会把整个组件库拖进 JS 产物。
// 按钮文案一直是显式传的（`feedback.js` 里每个 confirmText / cancelText），所以也不需要 zh-cn locale。
app.use(router).mount('#app');

