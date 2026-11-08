<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import CatPick from './CatPick.vue';
import { loadBoot, loadCompounds, setProject, store, recordCategories, addCategory } from '../store.js';
import { api } from '../api.js';
import { createPointerSort } from '../lib/pointdrag.js';
import { withFlip } from '../lib/flip.js';
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

/* ---- 中栏列表拖动排序 ----
   用自己实现的 pointer 拖拽（`lib/pointdrag.js`）：卡片是 button，Safari 里原生拖放起不来。 */
const dragId = ref(null);
const dropIdx = ref(-1);
const dragH = ref(74);        // 占位格高度 = 被拖那张卡的真实高度

/* 落到它自己原位（含它后面那一格）时不再画线——没有变化，不需要提示 */
const dragIdx = computed(() => store.compounds.findIndex((c) => c.id === dragId.value));
const slotIdx = computed(() => {
  const at = dropIdx.value;
  if (at < 0) return -1;
  const src = dragIdx.value;
  if (src >= 0 && (at === src || at === src + 1)) return -1;
  return at;
});      // 落点线插在第几张卡片前面（= 长度 = 放最后）

const sorter = createPointerSort({
  name: 'cmp-list',
  onStart: (id) => {
    dragId.value = id;
    const el = document.querySelector(`[data-drag-card="${id}"]`);
    if (el) dragH.value = Math.round(el.getBoundingClientRect().height);
  },
  // 列表是一列：gap 指向「插到第几张前面」，那里画一条强调色的线
  onTarget: (id, groupKey, gap) => {
    const at = Math.min(gap, store.compounds.length);
    if (at === dropIdx.value) return;
    // 占位格一插进去，下面的卡片就要下移：用 FLIP 滑过去，别瞬移
    withFlip([...document.querySelectorAll('.listpane .exp-card')], () => {
      dropIdx.value = at;
    });
  },
  onDrop: (id, groupKey, gap) => dropList(id, gap),
  onCancel: () => { dragId.value = null; dropIdx.value = -1; },
});

function onCardDown(ev, c) {
  sorter.down(ev, c.id);
}

/** 拖完那一下的 click 不要跳页面 */
function openCard(c) {
  if (sorter.clickIsDrag()) return;
  router.push(`/c/${c.id}`);
}

async function dropList(id, at) {
  dragId.value = null;
  dropIdx.value = -1;
  const list = store.compounds;
  const c = list.find((x) => x.id === id);
  if (!c) return;
  const rest = list.filter((x) => x.id !== id);
  let pos = 0;
  for (let i = 0; i < at && i < list.length; i += 1) if (list[i].id !== id) pos += 1;
  const before = rest[pos] || null;
  if (before && (c.category_id ?? null) !== (before.category_id ?? null)) {
    toast('列表里只能在同一分类内排序；换分类请到卡片视图拖', 'warn');
    return;
  }
  if (!before && at === 0) return;             // 放在原地
  if (before && before.id === c.id) return;
  try {
    await api.moveCompound(id, { category_id: c.category_id ?? null, before_id: before ? before.id : null });
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

    <div class="listpane-body" data-drag-group="list" :data-drag-count="store.compounds.length">
      <template v-for="(c, i) in store.compounds" :key="c.id">
      <div v-if="slotIdx === i" class="list-drop-slot" :style="{ height: `${dragH}px` }" />
      <button
        class="exp-card cmp-card"
        :class="{ 'is-dragging': dragId === c.id }"
        :aria-current="c.id === activeId() ? 'true' : 'false'"
        :style="{ '--i': Math.min(i, 12) }"
        :data-drag-card="c.id"
        data-drag-group="list"
        :data-drag-index="i"
        @mousedown="onCardDown($event, c)"
        @click="openCard(c)"
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
      </template>
      <div v-if="slotIdx === store.compounds.length" class="list-drop-slot" :style="{ height: `${dragH}px` }" />

      <div v-if="!store.compounds.length" class="empty-note">
        <template v-if="store.compoundFilters.q || store.compoundFilters.kind">无匹配化合物</template>
        <template v-else>暂无化合物。<br />点右上角「新建化合物」，或在实验中将产物存入化合物库。</template>
      </div>
    </div>
  </div>
</template>
