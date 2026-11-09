<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { store, loadBoot, loadList, setProject, addProject, createCompound, addCategory } from '../store.js';
import { api } from '../api.js';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { openCtxMenu } from '../lib/ctxmenu.js';

const route = useRoute();
const router = useRouter();

onMounted(() => {
  if (!store.boot) void loadBoot();
});

/** 实验记录的分类（带条数）：侧边栏直接点着筛 */
const expCats = computed(() =>
  (store.boot?.recordCategories || [])
    .filter((g) => g.scope === 'experiment')
    .filter((g) => !store.project || !g.project || g.project === store.project)
);

const catTotal = computed(() => (store.boot?.totals?.experiments ?? 0));

/** 未分类条数：总实验数 − 各分类 exp_count 之和 */
const uncatCount = computed(() => {
  const used = expCats.value.reduce((n, g) => n + (g.exp_count || 0), 0);
  return Math.max(0, catTotal.value - used);
});

async function pickCategory(value) {
  store.filters.category = value === '' ? '' : value;
  if (route.path !== '/list') router.push('/list');
  await loadList();
}

/** 分类上的右键菜单：重命名 / 删除 */
function catMenu(ev, g) {
  openCtxMenu(
    ev,
    [
      { key: 'rename', label: '重命名分类', icon: 'edit' },
      { key: 'delete', label: '删除分类', icon: 'trash', danger: true },
    ],
    async (key) => {
      if (key === 'rename') {
        const name = await prompt({ title: '重命名分类', value: g.name, confirmText: '改名' });
        if (!name) return;
        try {
          await api.saveCategory(g.id, { name });
          await loadBoot();
          toast('改好了');
        } catch (e) {
          toast(e.message || '改不了', 'err');
        }
        return;
      }
      const ok = await confirm({
        title: '删除这个分类？',
        body: `「${g.name}」里的记录会变成未分类，不会被删掉。`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteCategory(g.id);
        if (String(store.filters.category) === String(g.id)) store.filters.category = '';
        await loadBoot();
        await loadList();
        toast('分类已删除');
      } catch (e) {
        toast(e.message || '删不掉', 'err');
      }
    }
  );
}

async function newCategoryFromRail() {
  const name = await prompt({ title: '新建分类', placeholder: '比如：方法学 A、手性配体库', confirmText: '建' });
  if (!name) return;
  try {
    await addCategory(name, 'experiment');
    await loadBoot();
    toast(`建好了「${name}」`);
  } catch (e) {
    toast(e.message || '建不了这个分类', 'err');
  }
}

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

/** 现在是不是在化合物那一侧（库或某个化合物页）——决定大按钮建什么 */
const onCompounds = computed(() => active.value === 'compounds');

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

/** 在化合物库 / 化合物页时，那个大按钮改成「新建化合物」 */
async function newCompound() {
  try {
    const c = await createCompound();
    router.push(`/c/${c.id}`);
    toast('已新建化合物');
  } catch (e) {
    toast(e.message || '建不了这个化合物', 'err');
  }
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
      <button class="btn btn-primary" style="width: 100%" @click="onCompounds ? newCompound() : newExperiment()">
        <Icon name="plus" :size="14" /> {{ onCompounds ? '新建化合物' : '新建实验' }}
      </button>
    </div>

    <!-- 实验分类：就放在导航下面，「全部」一行，其余按分类点着筛 -->
    <nav v-if="!onCompounds" class="rail-cats">
      <button
        class="rail-cat"
        :aria-current="!store.filters.category ? 'true' : 'false'"
        @click="pickCategory('')"
      >
        <span class="label">全部</span>
        <span class="count">{{ catTotal }}</span>
      </button>
      <button
        v-for="g in expCats"
        :key="g.id"
        class="rail-cat"
        :aria-current="String(store.filters.category) === String(g.id) ? 'true' : 'false'"
        @click="pickCategory(g.id)"
        @contextmenu="catMenu($event, g)"
      >
        <span class="label">{{ g.name }}</span>
        <span v-if="g.exp_count" class="count">{{ g.exp_count }}</span>
      </button>
      <button
        v-if="uncatCount"
        class="rail-cat"
        :aria-current="store.filters.category === 'none' ? 'true' : 'false'"
        @click="pickCategory('none')"
      >
        <span class="label">未分类</span>
        <span class="count">{{ uncatCount }}</span>
      </button>
      <button class="rail-cat is-add" @click="newCategoryFromRail"><Icon name="plus" :size="12" /> 新建分类</button>
    </nav>

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
