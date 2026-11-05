import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
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

app.use(router).use(ElementPlus, { locale: zhCn }).mount('#app');

