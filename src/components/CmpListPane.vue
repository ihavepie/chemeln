<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import CatPick from './CatPick.vue';
import { loadBoot, loadCompounds, setProject, store, recordCategories, addCategory } from '../store.js';
import { api } from '../api.js';
import { COMPOUND_KINDS } from '../lib/ui.js';
import { prompt, toast } from '../lib/feedback.js';
import { compoundMenu } from '../lib/rowmenu.js';
import { round } from '../lib/reagent.js';

const route = useRoute();
const router = useRouter();
const q = ref(store.compoundFilters.q);
let timer = null;

onMounted(() => {
  if (!store.compounds.length) void loadCompounds();
});

watch(q, (v) => {
  store.compoundFilters.q = v;
  clearTimeout(timer);
  timer = setTimeout(() => void loadCompounds(), 220);
});

/** 下拉里的一个值：分类 id / 'none' / 'kind:底物' —— 两者互斥，选一个清另一个 */
const filterValue = computed(
  () => store.compoundFilters.category || (store.compoundFilters.kind ? `kind:${store.compoundFilters.kind}` : '')
);

/* ---- 中栏列表拖动：拖到某张卡片上 = 插到它前面（同时换到它那个分类） ---- */
const dragId = ref(null);
const dropId = ref(null);

function onDragStart(ev, c) {
  dragId.value = c.id;
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(c.id));   // Firefox 必须要有一份数据才会真的开始拖
  }
}

function onDragEnd() {
  dragId.value = null;
  dropId.value = null;
}

function onCardDragOver(ev, c) {
  if (!dragId.value || dragId.value === c.id) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  dropId.value = c.id;
}

async function onDrop(ev, target) {
  ev.preventDefault();
  const id = Number((ev.dataTransfer && ev.dataTransfer.getData('text/plain')) || dragId.value);
  dragId.value = null;
  dropId.value = null;
  if (!id || !target || target.id === id) return;
  const c = store.compounds.find((x) => x.id === id);
  if (!c) return;
  // 列表里拖 = **只排顺序**：跨分类不在这条路上改归属（换分类去卡片视图里拖，那里有分组看得见）
  if ((c.category_id ?? null) !== (target.category_id ?? null)) {
    toast('列表里只能在同一分类内排序；换分类请到卡片视图拖', 'warn');
    return;
  }
  try {
    await api.moveCompound(id, { category_id: c.category_id ?? null, before_id: target.id });
    await loadCompounds();
    await loadBoot();
  } catch (e) {
    toast(e.message || '移动不了', 'err');
  }
}

async function setFilter(v) {
  if (v.startsWith('kind:')) {
    store.compoundFilters.kind = v.slice(5);
    store.compoundFilters.category = '';
  } else {
    store.compoundFilters.kind = '';
    store.compoundFilters.category = v;
  }
  await loadCompounds();
}

async function newCategory() {
  const name = await prompt({ title: '新建分类', placeholder: '比如：手性配体库、中间体', confirmText: '建' });
  if (!name) return;
  try {
    await addCategory(name, 'compound');
    toast(`建好了「${name}」，在化合物页的「分类」里选它`);
  } catch (e) {
    toast(e.message || '建不了这个分类', 'err');
  }
}

const catName = (c) => c.category_name || '';

/** 没归课题的化合物属于「共用课题」，只在「全部课题」里看得到，这里给个入口 */
const unassigned = () => store.boot?.sharedCounts?.cmp || 0;
const goAllProjects = () => setProject('');

const activeId = () => (route.name === 'compound' ? Number(route.params.id) : null);
</script>

<template>
  <div class="listpane">
    <div class="listpane-head">
      <!-- 分类/类型筛选和搜索并排一行，省掉单独那一行（新建分类在菜单最下面） -->
      <div class="searchrow">
        <div class="searchbox">
          <Icon name="search" :size="13" />
          <input v-model="q" type="search" placeholder="搜编号、名称、分子式、核磁…" autocomplete="off" />
        </div>
        <CatPick
          :value="filterValue"
          :categories="recordCategories('compound')"
          :kinds="COMPOUND_KINDS"
          count-key="cmp_count"
          @change="setFilter"
          @create="newCategory"
        />
      </div>
      <div v-if="store.project && unassigned()" class="hint unassigned-note">
        另有 {{ unassigned() }} 个在「共用课题」，<span class="linkish" @click="goAllProjects">切到全部课题</span>能看到
      </div>
    </div>

    <div class="listpane-body">
      <button
        v-for="(c, i) in store.compounds"
        :key="c.id"
        class="exp-card cmp-card"
        :class="{ 'is-dragging': dragId === c.id, 'is-drop-target': dropId === c.id }"
        :aria-current="c.id === activeId() ? 'true' : 'false'"
        :style="{ '--i': Math.min(i, 12) }"
        draggable="true"
        @dragstart="onDragStart($event, c)"
        @dragend="onDragEnd"
        @dragover="onCardDragOver($event, c)"
        @drop="onDrop($event, c)"
        @click="router.push(`/c/${c.id}`)"
        @contextmenu="compoundMenu($event, c, router)"
      >
        <div class="top">
          <span class="exp-code">{{ c.code || '—' }}</span>
          <span class="tag plain" style="font-size: 9px; padding: 1px 6px">{{ c.kind || '' }}</span>
          <span class="exp-date">{{ c.file_count ? `${c.file_count} 文件` : '' }}</span>
        </div>
        <div class="exp-title">{{ c.name || '（未命名）' }}</div>
        <div class="exp-meta">
          <span v-if="catName(c)" class="cat-tag">{{ catName(c) }}</span>
          <span v-if="c.formula" class="mono">{{ c.formula }}</span>
          <template v-if="c.mw"><span class="sep">·</span><span>MW {{ round(c.mw, 2) }}</span></template>
          <template v-if="c.tlc_rf"><span class="sep">·</span><span>Rf {{ c.tlc_rf }}</span></template>
          <template v-if="c.used_count"><span class="sep">·</span><span>{{ c.used_count }} 处引用</span></template>
        </div>
      </button>

      <div v-if="!store.compounds.length" class="empty-note">
        <template v-if="store.compoundFilters.q || store.compoundFilters.kind">无匹配化合物</template>
        <template v-else>暂无化合物。<br />点右上角「新建化合物」，或在实验中将产物存入化合物库。</template>
      </div>
    </div>
  </div>
</template>
