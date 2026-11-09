import { createRouter, createWebHashHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import EditorView from './views/EditorView.vue';
import EmptyEditor from './views/EmptyEditor.vue';
import CompoundsView from './views/CompoundsView.vue';
import CompoundDetail from './views/CompoundDetail.vue';
import ScreeningsView from './views/ScreeningsView.vue';
import ScreeningView from './views/ScreeningView.vue';
import SettingsView from './views/SettingsView.vue';
import TrashView from './views/TrashView.vue';
import MobileHome from './components/MobileHome.vue';

/** 手机上只放这几页（扫瓶签看档案 / 看记录 / 拍照上传），其它一律送到 `#/m` */
const PHONE_ALLOWED = ['compound', 'editor', 'mobile'];

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: DashboardView },
    { path: '/list', name: 'list', component: EmptyEditor },
    { path: '/m', name: 'mobile', component: MobileHome },
    { path: '/e/:id', name: 'editor', component: EditorView },
    { path: '/compounds', name: 'compounds', component: CompoundsView },
    {
      path: '/c/:id',
      name: 'compound',
      component: CompoundDetail,
      props: (route) => ({ compoundId: route.params.id }),
    },
    { path: '/screenings', name: 'screenings', component: ScreeningsView },
    { path: '/s/:id', name: 'screening', component: ScreeningView },
    { path: '/trash', name: 'trash', component: TrashView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

// 手机上打开根地址 / 桌面版页面（工作台、化合物墙、设置…）→ 直接进「最近实验」
// 以前是在 App.vue 的 onMounted 里判断，那时 route.name 还没定，结果只显示「请到电脑上用」。
router.beforeEach((to) => {
  if (typeof window === 'undefined') return true;
  if (window.innerWidth > 820) return true;
  return PHONE_ALLOWED.includes(to.name) ? true : { name: 'mobile' };
});
