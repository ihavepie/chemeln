<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { api } from '../api.js';
import { store, loadBoot, loadCompounds, recordCategories, createCompound } from '../store.js';
import { round } from '../lib/reagent.js';
import { toast } from '../lib/feedback.js';
import { compoundMenu } from '../lib/rowmenu.js';

const route = useRoute();
const router = useRouter();

onMounted(() => {
  void loadCompounds();
});

/** 指定分类的空组就地新建（点空分类那一行的小「＋」）；不传就跟当前筛选走 */
async function create(categoryId = undefined) {
  const c = await createCompound(categoryId);
  router.push(`/c/${c.id}`);
}

const activeId = () => (route.name === 'compound' ? Number(route.params.id) : null);

const cats = computed(() => recordCategories('compound'));

/** 分组跟着筛选走：筛了某类就只留那一组 */
const groups = computed(() => {
  const all = store.compounds;
  const filter = store.compoundFilters.category;   // '' 全部 / 'none' 未分类 / id
  const out = [];
  for (const g of cats.value) {
    if (filter && filter !== String(g.id)) continue;
    out.push({
      key: `c${g.id}`,
      id: g.id,
      name: g.name,
      project: g.project || '',
      items: all.filter((c) => Number(c.category_id) === g.id),
    });
  }
  if (!filter || filter === 'none') {
    out.push({ key: 'none', id: null, name: '未分类', project: '', items: all.filter((c) => !c.category_id) });
  }
  return out;
});

const showHeads = computed(() => !store.compoundFilters.category && groups.value.length > 1);

/* ---- 拖卡片换分类 / 换位置 ---- */
const dragId = ref(null);
const dropKey = ref('');
const gapAt = ref(-1);        // 落在该组第几张卡片前面（等于数量 = 放到最后）

function onDragStart(ev, c) {
  if (!cats.value.length) return;
  dragId.value = c.id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(c.id));
}

function onDragEnd() {
  dragId.value = null;
  dropKey.value = '';
  gapAt.value = -1;
}

function onDragOver(ev, key, count) {
  if (!dragId.value) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  dropKey.value = key;
  if (gapAt.value < 0) gapAt.value = count;      // 落在组的空白处：放最后
}

/** 落在某张卡片上：按左右半边决定插在它前面还是后面 */
function onCardDragOver(ev, g, idx) {
  if (!dragId.value) return;
  ev.preventDefault();
  ev.stopPropagation();
  ev.dataTransfer.dropEffect = 'move';
  dropKey.value = g.key;
  const r = ev.currentTarget.getBoundingClientRect();
  gapAt.value = ev.clientX < r.left + r.width / 2 ? idx : idx + 1;
}

async function onDrop(ev, g) {
  ev.preventDefault();
  const id = Number(ev.dataTransfer.getData('text/plain') || dragId.value);
  const at = gapAt.value;
  dragId.value = null;
  dropKey.value = '';
  gapAt.value = -1;
  if (!id) return;
  const c = store.compounds.find((x) => x.id === id);
  if (!c) return;

  // 组内除自己之外的顺序里，这个落点原本是哪一条 → 插到它前面（没有就是最后）
  const rest = g.items.filter((x) => x.id !== id);
  let pos = 0;
  for (let i = 0; i < at && i < g.items.length; i += 1) if (g.items[i].id !== id) pos += 1;
  const before = rest[pos]?.id ?? null;

  const target = g.id;
  if ((c.category_id ?? null) === target && pos === rest.indexOf(c)) return;   // 原地没动

  try {
    await api.moveCompound(id, { category_id: target, before_id: before });
    await loadCompounds();
    await loadBoot();
    toast(target ? `「${c.code || c.name}」已移到「${g.name}」` : `「${c.code || c.name}」已移到未分类`);
  } catch (e) {
    toast(e.message || '移动不了', 'err');
  }
}
</script>

<template>
  <div class="grid-page" :class="{ 'is-dragging': !!dragId }">
      <section
        v-for="g in groups"
        :key="g.key"
        class="grid-group"
        :class="{ 'is-drop': dropKey === g.key }"
        @dragover="onDragOver($event, g.key, g.items.length)"
        @dragleave="(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget) && dropKey === g.key) { dropKey = ''; gapAt = -1; } }"
        @drop="onDrop($event, g)"
      >
        <div v-if="showHeads" class="grid-group-head">
          <span class="grid-group-name">{{ g.name }}</span>
          <span class="grid-group-n">{{ g.items.length }}</span>
          <span v-if="!store.project && g.project" class="grid-group-proj">{{ g.project }}</span>
          <!-- 0 条的分类只占这一行：一个小「＋」就地新建，不再撑一整格虚线 -->
          <button v-if="!g.items.length" class="grid-group-add" @click="create(g.id)">
            <Icon name="plus" :size="11" /><span>新建化合物</span>
          </button>
        </div>

        <!-- 空分类：只留拖拽落点 -->
        <div v-if="showHeads && !g.items.length" class="grid-drop-line" :class="{ 'is-live': dropKey === g.key }">
          <template v-if="dragId">{{ dropKey === g.key ? `松手放到「${g.name}」` : '' }}</template>
        </div>

        <div v-else class="card-grid is-even">
          <button v-if="g.key === 'none' || !g.items.length" class="grid-new" @click="create(g.id)">
            <Icon name="plus" :size="16" />
            <span>{{ dragId && dropKey === g.key ? '松手就放到这里' : '新建化合物' }}</span>
          </button>

          <template v-for="(c, ci) in g.items" :key="c.id">
            <div v-if="dropKey === g.key && gapAt === ci" class="drop-gap" />
            <button
              class="grid-card"
              :class="{ 'is-dragging': dragId === c.id }"
              :aria-current="c.id === activeId() ? 'true' : 'false'"
              :draggable="cats.length > 0"
              @dragover="onCardDragOver($event, g, ci)"
              @dragstart="onDragStart($event, c)"
              @dragend="onDragEnd"
              @click="router.push(`/c/${c.id}`)"
              @contextmenu="compoundMenu($event, c, router)"
            >
              <div class="grid-thumb is-structure">
                <img v-if="c.structure_id" :src="`/api/compound-files/${c.structure_id}`" alt="" loading="lazy" draggable="false" />
                <Icon v-else name="molecule" :size="20" class="i-empty" />
              </div>
              <div class="grid-body">
                <div class="top">
                  <span class="exp-code">{{ c.code || '—' }}</span>
                  <span class="tag plain" style="font-size: 9px; padding: 1px 6px">{{ c.kind || '' }}</span>
                  <span class="exp-date">{{ c.file_count ? `${c.file_count} 文件` : '' }}</span>
                </div>
                <div class="exp-title">{{ c.name || '（未命名）' }}</div>
                <div class="exp-meta">
                  <span v-if="c.category_name" class="cat-tag">{{ c.category_name }}</span>
                  <span v-if="c.formula" class="mono">{{ c.formula }}</span>
                  <template v-if="c.mw"><span v-if="c.formula" class="sep">·</span><span>MW {{ round(c.mw, 2) }}</span></template>
                  <template v-if="c.tlc_rf"><span class="sep">·</span><span>Rf {{ c.tlc_rf }}</span></template>
                </div>
              </div>
            </button>
          </template>

          <div v-if="dropKey === g.key && gapAt === g.items.length" class="drop-gap" />
        </div>
      </section>

    <div v-if="store.compoundTotal > store.compounds.length" class="grid-note">
      只显示了前 {{ store.compounds.length }} 个（共 {{ store.compoundTotal }} 个），用上面的搜索或筛选缩小范围。
    </div>
    <div v-else-if="!store.compounds.length" class="grid-note">
      <template v-if="store.compoundFilters.q || store.compoundFilters.kind || store.compoundFilters.category">无匹配化合物。</template>
      <template v-else>暂无化合物。点上方卡片新建，或在实验中将产物存入化合物库。</template>
    </div>
  </div>
</template>
