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

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: DashboardView },
    { path: '/list', name: 'list', component: EmptyEditor },
    { path: '/e/:id', name: 'editor', component: EditorView },
    { path: '/compounds', name: 'compounds', component: CompoundsView },
    {
      path: '/c/:id',
      name: 'compound',
      component: CompoundDetail,
      props: (route) => ({ compoundId: route.params.id }),
    },
    { path: '/screenings', name: 'screenings', component: ScreeningsView },
    {
      path: '/s/:id',
      name: 'screening',
      component: ScreeningView,
      props: (route) => ({ screeningId: route.params.id }),
    },
    { path: '/trash', name: 'trash', component: TrashView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
