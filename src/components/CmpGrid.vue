<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { api } from '../api.js';
import { store, loadBoot, loadCompounds, recordCategories, createCompound, groupOf } from '../store.js';
import { round } from '../lib/reagent.js';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { openCtxMenu } from '../lib/ctxmenu.js';
import { compoundMenu } from '../lib/rowmenu.js';
import { COMPOUND_KINDS } from '../lib/ui.js';
import { createPointerSort } from '../lib/pointdrag.js';
import { withFlip } from '../lib/flip.js';

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

/** 按类型分组：底物 / 中间体 / 产物 / 配体…本身就是「库」，不用用户再建一遍分类 */
const kindMode = computed(() => groupOf('cmp') === 'kind');

/** 分组跟着筛选走：筛了某类就只留那一组 */
const groups = computed(() => {
  const all = store.compounds;
  const filter = store.compoundFilters.category;   // '' 全部 / 'none' 未分类 / id
  const out = [];

  if (kindMode.value) {
    // 类型的先后照 COMPOUND_KINDS 那条路线的顺序来；老数据里表外的值（「试剂」之类）排最后
    const rank = (k) => {
      const i = COMPOUND_KINDS.indexOf(k);
      return i < 0 ? 99 : i;
    };
    const buckets = new Map();
    for (const c of all) {
      const k = String(c.kind || '').trim() || '未分类';
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(c);
    }
    return [...buckets.keys()]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'zh'))
      .map((k) => ({ key: `k:${k}`, id: null, kind: k, name: k, project: '', items: buckets.get(k) }));
  }
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

const showHeads = computed(() =>
  kindMode.value ? groups.value.length > 0 : !store.compoundFilters.category && groups.value.length > 1
);

/* ---- 拖卡片换分类 / 换位置 ----
   自己实现（`lib/pointdrag.js`）：卡片是 <button>，Safari 里原生 `draggable` 经常起不了拖。 */
const dragId = ref(null);
const dropKey = ref('');
const gapAt = ref(-1);        // 落在该组第几张卡片前面（等于数量 = 放到最后）

const sorter = createPointerSort({
  name: 'cmp-grid',
  onStart: (id) => { dragId.value = id; },
  onTarget: (id, groupKey, gap) => {
    if (groupKey === dropKey.value && gap === gapAt.value) return;   // 同一个落点就不折腾
    // 占位格一插进去整面墙就重排：用 FLIP 让它「滑」过去，而不是瞬移一格
    withFlip([...document.querySelectorAll('.grid-card, .grid-stack')], () => {
      dropKey.value = groupKey;
      gapAt.value = gap;
    });
  },
  onDrop: (id, groupKey, gap) => dropCard(id, groupKey, gap),
  onCancel: () => {
    dragId.value = null;
    dropKey.value = '';
    gapAt.value = -1;
  },
});

function onCardDown(ev, c) {
  // 按类型看着的时候不给拖：拖进另一组其实是「改类型」，那是另一种语义，先不开
  if (kindMode.value) return;
  // 不设「有分类才能拖」的门槛：未分类里也要能排顺序（下拉里还有「未分类」这一格）
  sorter.down(ev, c.id);
}

/** 拖完松手那一下会再冒一个 click，别让它跳进那张卡片 */
function openCard(c) {
  if (sorter.clickIsDrag()) return;
  router.push(`/c/${c.id}`);
}

async function dropCard(id, groupKey, at) {
  dragId.value = null;
  dropKey.value = '';
  gapAt.value = -1;
  if (!id) return;
  const c = store.compounds.find((x) => x.id === id);
  const g = groups.value.find((x) => x.key === groupKey);
  if (!c || !g) return;

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

/** 分类组头右键：就地改名 / 删除。分类管理就挂在这个分类自己身上，不往一级侧栏塞东西 */
function groupMenu(ev, g) {
  if (g.id == null) return; // 「未分类」是固定桶，没有动作
  openCtxMenu(
    ev,
    [
      { key: 'rename', label: '重命名分类', icon: 'edit' },
      { key: 'delete', label: '删除分类', icon: 'trash', danger: true },
    ],
    async (key) => {
      if (key === 'rename') {
        const name = await prompt({ title: '重命名分类', value: g.name, confirmText: '改名' });
        if (!name || name === g.name) return;
        try {
          await api.saveCategory(g.id, { name });
          await loadBoot();
          await loadCompounds();
        } catch (e) {
          toast(e.message || '改不了', 'err');
        }
        return;
      }
      const ok2 = await confirm({
        title: `删除「${g.name}」这个分类？`,
        body: '分类里的记录会变成「未分类」，记录本身不会被删掉。',
        confirmText: '删除',
        danger: true,
      });
      if (!ok2) return;
      try {
        await api.deleteCategory(g.id);
        if (String(store.compoundFilters.category) === String(g.id)) store.compoundFilters.category = '';
        await loadBoot();
        await loadCompounds();
        toast('分类已删除');
      } catch (e) {
        toast(e.message || '删不掉', 'err');
      }
    }
  );
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
        :data-drag-count="g.items.length"
      >
        <div v-if="showHeads" class="grid-group-head" @contextmenu="kindMode ? null : groupMenu($event, g)">
          <span class="grid-group-name">{{ g.name }}</span>
          <span class="grid-group-n">{{ g.items.length }}</span>
          <span v-if="!store.project && g.project" class="grid-group-proj">{{ g.project }}</span>
          <!-- 0 条的分类只占这一行：一个小「＋」就地新建，不再撑一整格虚线 -->
          <button v-if="!g.items.length" class="grid-group-add" @click="create(g.id)">
            <Icon name="plus" :size="11" /><span>新建化合物</span>
          </button>
        </div>

        <!-- 空分类：只留拖拽落点 -->
        <!-- 空分类：平时只占组头那一行；拖起来时这一行长成一个够大的落点，不然只有 20 多像素高，很难拖进去 -->
        <div
          v-if="showHeads && !g.items.length"
          class="grid-drop-line"
          :class="{ 'is-live': dropKey === g.key, 'is-armed': !!dragId }"
        >
          <template v-if="dragId">{{ dropKey === g.key ? `松手放到「${g.name}」` : `拖到这里放进「${g.name}」` }}</template>
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
              :class="{
                'is-dragging': dragId === c.id,
                'can-drag': !kindMode }"
              :aria-current="c.id === activeId() ? 'true' : 'false'"
              :data-drag-card="c.id"
              :data-drag-group="g.key"
              :data-drag-index="ci"
              @mousedown="onCardDown($event, c)"
              @click="openCard(c)"
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
