import { createRouter, createWebHashHistory } from 'vue-router';

/**
 * 每个页面都**懒加载**（`() => import(...)`）：以前一次性静态 import 进来，首屏要把
 * 编辑器、画板、筛选表、设置页全下完才出画面（1.5 MB 一个 chunk）。拆开之后各页各一个
 * chunk，Vite 的模块预取会在浏览器闲时把相邻页预取回来，点过去并不慢。
 * 只有外壳用到的组件留在 `App.vue` 里同步引（导轨、列表这类）。
 */
const DashboardView = () => import('./views/DashboardView.vue');
const EditorView = () => import('./views/EditorView.vue');
const EmptyEditor = () => import('./views/EmptyEditor.vue');
const CompoundsView = () => import('./views/CompoundsView.vue');
const CompoundDetail = () => import('./views/CompoundDetail.vue');
const ScreeningsView = () => import('./views/ScreeningsView.vue');
const ScreeningView = () => import('./views/ScreeningView.vue');
const SettingsView = () => import('./views/SettingsView.vue');
const TrashView = () => import('./views/TrashView.vue');
const ReagentLibView = () => import('./views/ReagentLibView.vue');
const BoardsView = () => import('./views/BoardsView.vue');
const BoardView = () => import('./views/BoardView.vue');
const MobileHome = () => import('./components/MobileHome.vue');

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
    // 「对照」页已撤（用户：排版板够了），老链接直接送到排版板
    { path: '/compare', redirect: '/boards' },
    { path: '/reagents', name: 'reagents', component: ReagentLibView },
    { path: '/boards', name: 'boards', component: BoardsView },
    { path: '/b/:id', name: 'board', component: BoardView },
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
  return PHONE_ALLOWED.includes(String(to.name)) ? true : { name: 'mobile' };
});
