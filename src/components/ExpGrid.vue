<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { api } from '../api.js';
import { store, loadBoot, loadList, recordCategories, createExperiment } from '../store.js';
import { STATUS_TONE } from '../lib/ui.js';
import { toast } from '../lib/feedback.js';

const route = useRoute();
const router = useRouter();

onMounted(() => {
  void loadList();
});

/* 正筛着某个分类时，新建的记录直接放进那个分类 */
/** 指定分类的空组就地新建（点空分类那一行的小「＋」）；不传就跟当前筛选走 */
async function create(categoryId = undefined) {
  const exp = await createExperiment(categoryId);
  router.push(`/e/${exp.id}`);
}

const activeId = () => (route.name === 'editor' ? Number(route.params.id) : null);

/** 缩略图：先看反应式附件，没有再退回到记录里产物/底物的结构式 */
const thumbOf = (it) =>
  it.preview_id ? `/api/files/${it.preview_id}` : it.preview_cmp_file ? `/api/compound-files/${it.preview_cmp_file}` : '';

const cats = computed(() => recordCategories('experiment'));

/** 每个分类都占一格（空的也显示），筛了某类就只留那一组；未分类放最后 */
const groups = computed(() => {
  const all = store.items;
  const filter = store.filters.category;          // '' 全部 / 'none' 未分类 / id
  const out = [];
  for (const g of cats.value) {
    if (filter && filter !== String(g.id)) continue;
    out.push({
      key: `c${g.id}`,
      id: g.id,
      name: g.name,
      project: g.project || '',
      items: all.filter((it) => Number(it.category_id) === g.id),
    });
  }
  if (!filter || filter === 'none') {
    out.push({ key: 'none', id: null, name: '未分类', project: '', items: all.filter((it) => !it.category_id) });
  }
  return out;
});

/** 只在「看全部」且确实分了组的时候显示分组标题 */
const showHeads = computed(() => !store.filters.category && groups.value.length > 1);

/* ---- 拖卡片换分类 / 换位置 ---- */
const dragId = ref(null);
const dropKey = ref('');
const gapAt = ref(-1);        // 落在该组第几张卡片前面（等于数量 = 放到最后）

function onDragStart(ev, it) {
  if (!cats.value.length) return;         // 一个分类都没有就不用拖
  dragId.value = it.id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(it.id));
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
  const it = store.items.find((x) => x.id === id);
  if (!it) return;

  // 组内除自己之外的顺序里，这个落点原本是哪一条 → 插到它前面（没有就是最后）
  const rest = g.items.filter((x) => x.id !== id);
  let pos = 0;
  for (let i = 0; i < at && i < g.items.length; i += 1) if (g.items[i].id !== id) pos += 1;
  const before = rest[pos]?.id ?? null;

  const target = g.id;
  if ((it.category_id ?? null) === target && pos === rest.indexOf(it)) return;   // 原地没动

  try {
    await api.moveExperiment(id, { category_id: target, before_id: before });
    await loadList();
    await loadBoot();
    toast(target ? `「${it.code}」已移到「${g.name}」` : `「${it.code}」已移到未分类`);
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
            <Icon name="plus" :size="11" /><span>新建实验</span>
          </button>
        </div>

        <!-- 空分类：只留拖拽落点 -->
        <div v-if="showHeads && !g.items.length" class="grid-drop-line" :class="{ 'is-live': dropKey === g.key }">
          <template v-if="dragId">{{ dropKey === g.key ? `松手放到「${g.name}」` : '' }}</template>
        </div>

        <div v-else class="card-grid is-even">
          <button v-if="g.key === 'none' || !g.items.length" class="grid-new" @click="create(g.id)">
            <Icon name="plus" :size="16" />
            <span>{{ dragId && dropKey === g.key ? '松手就放到这里' : '新建实验' }}</span>
          </button>

          <template v-for="(it, ci) in g.items" :key="it.id">
            <div v-if="dropKey === g.key && gapAt === ci" class="drop-gap" />
            <button
              class="grid-card"
              :class="{ 'is-dragging': dragId === it.id }"
              :aria-current="it.id === activeId() ? 'true' : 'false'"
              :draggable="cats.length > 0"
              @dragover="onCardDragOver($event, g, ci)"
              @dragstart="onDragStart($event, it)"
              @dragend="onDragEnd"
              @click="router.push(`/e/${it.id}`)"
            >
              <div class="grid-thumb">
                <img v-if="thumbOf(it)" :src="thumbOf(it)" alt="" loading="lazy" draggable="false" />
                <Icon v-else name="flask" :size="20" class="i-empty" />
              </div>
              <div class="grid-body">
                <div class="top">
                  <span class="exp-code">{{ it.code }}</span>
                  <span v-if="it.group_size > 1" class="stack-badge" title="属于一个平行组（重复 / 控制变量实验）">平行 ×{{ it.group_size }}</span>
                  <span class="tag" :class="STATUS_TONE[it.status]" style="font-size: 9px; padding: 1px 6px">{{ it.status }}</span>
                  <span class="exp-date">{{ it.date }}</span>
                </div>
                <div class="exp-title">{{ it.title || '（未命名实验）' }}</div>
                <div class="exp-meta">
                  <span v-if="it.category_name" class="cat-tag">{{ it.category_name }}</span>
                  <span v-if="it.project">{{ it.project }}</span>
                  <template v-if="it.rxn_type"><span v-if="it.project" class="sep">·</span><span>{{ it.rxn_type }}</span></template>
                  <template v-if="it.yield_pct != null"><span class="sep">·</span><span style="color: var(--ok)">{{ it.yield_pct }}%</span></template>
                  <template v-if="it.reagent_count"><span class="sep">·</span><span>{{ it.reagent_count }} 投料</span></template>
                </div>
              </div>
            </button>
          </template>

          <div v-if="dropKey === g.key && gapAt === g.items.length" class="drop-gap" />
        </div>
      </section>

    <div v-if="store.listTotal > store.items.length" class="grid-note">
      只显示了前 {{ store.items.length }} 条（共 {{ store.listTotal }} 条），用上面的搜索或筛选缩小范围。
    </div>
    <div v-else-if="!store.items.length" class="grid-note">
      {{ store.filters.q || store.filters.status || store.filters.category ? '无匹配记录。' : '暂无实验记录。点上方卡片新建一条。' }}
    </div>
  </div>
</template>
