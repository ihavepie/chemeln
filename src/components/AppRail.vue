<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { store, loadBoot, loadList, setProject, addProject } from '../store.js';
import { api } from '../api.js';
import { prompt, toast } from '../lib/feedback.js';

const route = useRoute();
const router = useRouter();

onMounted(() => {
  if (!store.boot) void loadBoot();
});

const nav = computed(() => {
  const b = store.boot;
  return [
    { key: 'home', to: '/', label: '工作台', ic: 'flask', count: '' },
    { key: 'list', to: '/list', label: '实验记录', ic: 'file', count: b?.totals?.experiments ?? '' },
    { key: 'compounds', to: '/compounds', label: '化合物库', ic: 'molecule', count: b?.compoundCount ?? '' },
    { key: 'screenings', to: '/screenings', label: '条件筛选', ic: 'table', count: b?.totals?.screenings ?? '' },
    { key: 'trash', to: '/trash', label: '回收站', ic: 'trash', count: b?.trashCount || '' },
    { key: 'settings', to: '/settings', label: '设置', ic: 'settings', count: '' },
  ];
});

const active = computed(() => {
  const n = route.name;
  if (n === 'editor') return 'list';
  if (n === 'compound') return 'compounds';
  // v1 里筛选表的详情页不点亮任何一个导航项（route.name 就叫 screening）
  return n || 'home';
});

/* ------------------------------------------------------------ 课题切换 */

const projOpen = ref(false);
const projBtn = ref(null);
const projPos = ref({ top: 0, left: 0, width: 0 });
const projects = computed(() => store.boot?.projects || []);

/** 侧栏是滚动容器，菜单用 fixed 定位才不会被裁掉 */
function toggleProjects() {
  if (!projOpen.value && projBtn.value) {
    const r = projBtn.value.getBoundingClientRect();
    // 菜单宽度跟着触发器走（.cat-menu 自身有 min-width:100%，在 fixed 定位下会算成整屏，
    // 所以这里用内联 minWidth:0 把它按住），比触发器宽一点点就够
    projPos.value = { top: Math.round(r.bottom + 5), left: Math.round(r.left), width: Math.max(140, Math.round(r.width) + 16) };
  }
  projOpen.value = !projOpen.value;
}

/** 当前课题的前缀（品牌副标题跟着显示，一眼知道自己在哪个本子里） */
const activePrefix = computed(() => {
  const p = projects.value.find((x) => x.name === store.project);
  return p?.prefix || store.boot?.settings?.code_prefix || 'EXP';
});

function onDocClick(ev) {
  if (!ev.target.closest?.('.proj-switch')) projOpen.value = false;
}
function onKey(ev) {
  if (ev.key === 'Escape') projOpen.value = false;
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});

async function pickProject(name) {
  projOpen.value = false;
  if (name === store.project) return;
  await setProject(name);
  // 停在原地：工作台统计和列表已经跟着换过了
}

async function newProject() {
  projOpen.value = false;
  const name = await prompt({ title: '新建课题', placeholder: '比如：手性配体、光催化方法学', confirmText: '建' });
  if (!name) return;
  try {
    await addProject(name);
    await router.push('/list');
    toast(`已切换到课题「${name}」，此后新建的实验归入该课题`);
  } catch (e) {
    toast(e.message || '建不了这个课题', 'err');
  }
}

async function newExperiment() {
  const exp = await api.createExperiment({
    title: '',
    date: new Date().toISOString().slice(0, 10),
    status: '进行中',
    project: store.project,
  });
  await loadBoot();
  await loadList();          // 左栏列表也要立刻出现这一条
  router.push(`/e/${exp.id}`);
  toast('已新建实验记录');
}
</script>

<template>
  <aside class="rail">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M12 7.5h8M16 7.5v8.8l-5.6 7.6h11.2L16 16.3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" />
        <path d="M9.4 23.9h13.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
      </svg>
      <div class="brand-text">
        <div class="brand-title">{{ store.boot?.settings?.lab_heading || '方法学实验记录' }}</div>
        <div class="brand-sub">{{ activePrefix }} · ELN</div>
      </div>
    </div>

    <!-- 课题 = 一个「空间」：切过来以后列表、卡片墙、工作台统计都只看这个课题 -->
    <div class="proj-switch">
      <button
        ref="projBtn"
        type="button"
        class="proj-trigger"
        :title="store.project ? `当前课题：${store.project}` : '全部课题（不筛）'"
        @click.stop="toggleProjects"
      >
        <span class="proj-trigger-label">{{ store.project || '全部课题' }}</span>
        <Icon name="down" :size="10" class="cat-caret" />
      </button>

      <div
        v-if="projOpen"
        class="qmenu cat-menu cat-menu--fixed"
        :style="{ position: 'fixed', top: `${projPos.top}px`, left: `${projPos.left}px`, width: `${projPos.width}px` }"
        @click.stop
      >
        <button type="button" class="cat-menu-opt" :aria-selected="!store.project" @click="pickProject('')">
          <span class="cat-menu-name">全部课题</span>
        </button>
        <template v-if="projects.length">
          <div class="cat-menu-sep" />
          <button
            v-for="p in projects"
            :key="p.name"
            type="button"
            class="cat-menu-opt"
            :aria-selected="store.project === p.name"
            @click="pickProject(p.name)"
          >
            <span class="cat-menu-name">{{ p.name }}</span>
            <span class="cat-menu-n mono">{{ p.n }}</span>
          </button>
        </template>
        <div class="cat-menu-sep" />
        <button type="button" class="cat-menu-opt cat-menu-new" @click="newProject">
          <Icon name="plus" :size="10" /> 新建课题
        </button>
      </div>
    </div>

    <div class="rail-actions">
      <button class="btn btn-primary" style="width: 100%" @click="newExperiment">
        <Icon name="plus" :size="14" /> 新建实验
      </button>
    </div>

    <nav class="nav">
      <button
        v-for="it in nav"
        :key="it.key"
        class="nav-item"
        :aria-current="active === it.key ? 'true' : 'false'"
        @click="router.push(it.to)"
      >
        <Icon :name="it.ic" :size="15" />
        <span class="label">{{ it.label }}</span>
        <span v-if="it.count !== ''" class="count">{{ it.count }}</span>
      </button>
    </nav>

    <div class="rail-foot">
      <div class="rail-stat"><span>本月实验</span><b>{{ store.boot?.thisMonth ?? 0 }}</b></div>
      <div class="rail-stat"><span>中位产率</span><b>{{ store.boot?.yieldMedian == null ? '—' : `${Math.round(store.boot.yieldMedian * 10) / 10}%` }}</b></div>
      <div class="rail-stat"><span>附件</span><b>{{ store.boot?.totals?.attachments ?? 0 }}</b></div>
    </div>
  </aside>
</template>
