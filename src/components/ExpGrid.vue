<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { api } from '../api.js';
import { store, loadBoot, loadList, recordCategories, createExperiment } from '../store.js';
import { createPointerSort } from '../lib/pointdrag.js';
import { STATUS_TONE } from '../lib/ui.js';
import { toast } from '../lib/feedback.js';
import { experimentMenu } from '../lib/rowmenu.js';

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

/** 同一 group_id 的实验在墙上收成一摞：面子是正在看的那条（没有就看最早那条），
 *  后面露两层纸边，垫一个「平行 ×N」。点开的是面子那条，其余的在左栏卡片堆 / 书签里切。 */
function stackOf(items) {
  const out = [];
  const byGid = new Map();
  for (const it of items) {
    const gid = it.group_id || '';
    if (!gid || !(it.group_size > 1)) {
      out.push({ key: `i${it.id}`, it, members: [it], anchor: it.id });
      continue;
    }
    const found = byGid.get(gid);
    if (found) {
      found.members.push(it);
      continue;
    }
    const card = { key: `g${gid}`, it, members: [it], anchor: it.id };
    byGid.set(gid, card);
    out.push(card);
  }
  for (const c of out) {
    if (c.members.length < 2) continue;
    c.members.sort((a, b) => a.id - b.id);
    c.it = c.members.find((m) => m.id === activeId()) || c.members[0];
    c.anchor = c.members[0].id;      // 位置永远按最早那条算
  }
  // 按「基准那条」在列表里的位置排：新建一条平行实验会排到最前面，
  // 但那一摞不该跟着跳到最上面去
  const slot = new Map(items.map((x, i) => [x.id, i]));
  return out.sort((a, b) => (slot.get(a.anchor) ?? 1e9) - (slot.get(b.anchor) ?? 1e9));
}

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
      cards: stackOf(all.filter((it) => Number(it.category_id) === g.id)),
    });
  }
  if (!filter || filter === 'none') {
    const rest = all.filter((it) => !it.category_id);
    out.push({ key: 'none', id: null, name: '未分类', project: '', items: rest, cards: stackOf(rest) });
  }
  return out;
});

/** 只在「看全部」且确实分了组的时候显示分组标题 */
const showHeads = computed(() => !store.filters.category && groups.value.length > 1);

/* ---- 拖卡片换分类 / 换位置 ----
   自己实现（`lib/pointdrag.js`）：卡片是 <button>，Safari 里原生 draggable 经常起不了拖。 */
const dragId = ref(null);      // 用「面子那条」的 id 认卡片；一摞就整摞一起挪
const dropKey = ref('');
const gapAt = ref(-1);         // 落在该组第几张卡片前面（等于数量 = 放到最后）

/** 拖起来的那张卡片在哪一组（卡片身份按 card.it.id 认） */
function cardOf(id) {
  for (const g of groups.value) {
    const card = g.cards.find((c) => c.it.id === id);
    if (card) return { g, card };
  }
  return null;
}

const sorter = createPointerSort({
  name: 'exp-grid',
  onStart: (id) => { dragId.value = id; },
  onTarget: (id, groupKey, gap) => {
    dropKey.value = groupKey;
    gapAt.value = gap;
  },
  onDrop: (id, groupKey, gap) => dropCard(id, groupKey, gap),
  onCancel: () => {
    dragId.value = null;
    dropKey.value = '';
    gapAt.value = -1;
  },
});

function onCardDown(ev, card) {
  // 不设「有分类才能拖」的门槛：未分类里也要能排顺序
  sorter.down(ev, card.it.id);
}

/** 拖完松手那一下会再冒一个 click，别让它跳进那条记录 */
function openCard(card) {
  if (sorter.clickIsDrag()) return;
  router.push(`/e/${card.it.id}`);
}

async function dropCard(id, groupKey, at) {
  const src = cardOf(id);
  dragId.value = null;
  dropKey.value = '';
  gapAt.value = -1;
  if (!src) return;
  const g = groups.value.find((x) => x.key === groupKey);
  if (!g) return;

  const ids = src.card.members.map((m) => m.id);   // 一摞就整组按顺序挪，别把平行实验拆到两个分类
  const it = src.card.it;

  // 组内除自己这一摞之外的顺序里，这个落点原本是哪一张 → 插到它前面（没有就是最后）
  const rest = g.cards.filter((c) => !c.members.some((m) => ids.includes(m.id)));
  let pos = 0;
  for (let i = 0; i < at && i < g.cards.length; i += 1) {
    if (!g.cards[i].members.some((m) => ids.includes(m.id))) pos += 1;
  }
  const before = rest[pos]?.it.id ?? null;

  const target = g.id;
  const sameCat = (it.category_id ?? null) === target;
  const curIdx = g.cards.findIndex((c) => c.members.some((m) => ids.includes(m.id)));
  // 原地没动（本来就在这个分类里，落点还是它现在那一格）就不发请求
  if (sameCat && curIdx >= 0 && (at === curIdx || at === curIdx + 1)) return;

  try {
    for (const one of ids) await api.moveExperiment(one, { category_id: target, before_id: before });
    await loadList();
    await loadBoot();
    const what = ids.length > 1 ? `${ids.length} 条平行实验` : `「${it.code}」`;
    toast(target ? `已把${what}移到「${g.name}」` : `已把${what}移到未分类`);
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
        :data-drag-group="g.key"
        :data-drag-count="g.cards.length"
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

          <template v-for="(card, ci) in g.cards" :key="card.key">
            <div v-if="dropKey === g.key && gapAt === ci" class="drop-gap" />
            <!-- 平行组：一摞纸（后面两层纸边），点开是面子那条 -->
            <div v-if="card.members.length > 1" class="grid-stack" :class="{ 'is-dragging': card.members.some((m) => m.id === dragId) }">
              <button
                class="grid-card"
                :aria-current="card.members.some((m) => m.id === activeId()) ? 'true' : 'false'"
                :data-drag-card="card.it.id"
                :data-drag-group="g.key"
                :data-drag-index="ci"
                @mousedown="onCardDown($event, card)"
                @click="openCard(card)"
                @contextmenu="experimentMenu($event, card.it, router, { groupSize: card.members.length })"
              >
                <div class="grid-thumb">
                  <img v-if="thumbOf(card.it)" :src="thumbOf(card.it)" alt="" loading="lazy" draggable="false" />
                  <Icon v-else name="flask" :size="20" class="i-empty" />
                  <span class="stack-badge is-corner" :title="card.members.map((m) => `${m.code} ${m.status}`).join(' / ')">平行 ×{{ card.members.length }}</span>
                </div>
                <div class="grid-body">
                  <div class="top">
                    <span class="exp-code">{{ card.it.code }}</span>
                    <span class="tag" :class="STATUS_TONE[card.it.status]" style="font-size: 9px; padding: 1px 6px">{{ card.it.status }}</span>
                    <span class="exp-date">{{ card.it.date }}</span>
                  </div>
                  <div class="exp-title">{{ card.it.title || '（未命名实验）' }}</div>
                  <div class="exp-meta">
                    <span v-if="card.it.category_name" class="cat-tag">{{ card.it.category_name }}</span>
                    <span v-if="card.it.project">{{ card.it.project }}</span>
                    <template v-if="card.it.rxn_type"><span v-if="card.it.project" class="sep">·</span><span>{{ card.it.rxn_type }}</span></template>
                    <template v-if="card.it.yield_pct != null"><span class="sep">·</span><span style="color: var(--ok)">{{ card.it.yield_pct }}%</span></template>
                    <template v-if="card.it.reagent_count"><span class="sep">·</span><span>{{ card.it.reagent_count }} 投料</span></template>
                  </div>
                </div>
              </button>
            </div>
            <button
              v-else
              class="grid-card"
              :class="{ 'is-dragging': dragId === card.it.id }"
              :aria-current="card.it.id === activeId() ? 'true' : 'false'"
              :data-drag-card="card.it.id"
              :data-drag-group="g.key"
              :data-drag-index="ci"
              @mousedown="onCardDown($event, card)"
              @click="openCard(card)"
              @contextmenu="experimentMenu($event, card.it, router)"
            >
              <div class="grid-thumb">
                <img v-if="thumbOf(card.it)" :src="thumbOf(card.it)" alt="" loading="lazy" draggable="false" />
                <Icon v-else name="flask" :size="20" class="i-empty" />
                <!-- 平行组标记钉在缩略图角上：塞进下面那行会把编号/日期挤出去 -->
                <span v-if="card.it.group_size > 1" class="stack-badge is-corner" :title="`属于一个平行组（共 ${card.it.group_size} 条，筛出来的只有这一条）`">平行 ×{{ card.it.group_size }}</span>
              </div>
              <div class="grid-body">
                <div class="top">
                  <span class="exp-code">{{ card.it.code }}</span>
                  <span class="tag" :class="STATUS_TONE[card.it.status]" style="font-size: 9px; padding: 1px 6px">{{ card.it.status }}</span>
                  <span class="exp-date">{{ card.it.date }}</span>
                </div>
                <div class="exp-title">{{ card.it.title || '（未命名实验）' }}</div>
                <div class="exp-meta">
                  <span v-if="card.it.category_name" class="cat-tag">{{ card.it.category_name }}</span>
                  <span v-if="card.it.project">{{ card.it.project }}</span>
                  <template v-if="card.it.rxn_type"><span v-if="card.it.project" class="sep">·</span><span>{{ card.it.rxn_type }}</span></template>
                  <template v-if="card.it.yield_pct != null"><span class="sep">·</span><span style="color: var(--ok)">{{ card.it.yield_pct }}%</span></template>
                  <template v-if="card.it.reagent_count"><span class="sep">·</span><span>{{ card.it.reagent_count }} 投料</span></template>
                </div>
              </div>
            </button>
          </template>

          <div v-if="dropKey === g.key && gapAt === g.cards.length" class="drop-gap" />
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
