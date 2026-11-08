<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import CatPick from './CatPick.vue';
import { store, loadList, loadBoot, recordCategories, addCategory } from '../store.js';
import { STATUSES, STATUS_SHORT, STATUS_TONE } from '../lib/ui.js';
import { api } from '../api.js';
import { prompt, toast } from '../lib/feedback.js';
import { createPointerSort } from '../lib/pointdrag.js';
import { experimentMenu, groupMenu } from '../lib/rowmenu.js';

const route = useRoute();
const router = useRouter();
const q = ref(store.filters.q);
let timer = null;

onMounted(() => {
  if (!store.items.length) void loadList();
});

watch(q, (v) => {
  store.filters.q = v;
  clearTimeout(timer);
  timer = setTimeout(() => void loadList(), 220);
});

/** 下拉里的一个值：分类 id / 'none' / 'status:进行中' —— 互斥，选一个清另一个 */
const filterValue = computed(
  () => store.filters.category || (store.filters.status ? `status:${store.filters.status}` : '')
);

async function setFilter(v) {
  if (v.startsWith('status:')) {
    store.filters.status = v.slice(7);
    store.filters.category = '';
  } else {
    store.filters.status = '';
    store.filters.category = v;
  }
  await loadList();
}

async function newCategory() {
  const name = await prompt({ title: '新建分类', placeholder: '比如：方法学 A、手性配体库', confirmText: '建' });
  if (!name) return;
  try {
    await addCategory(name, 'experiment');
    toast(`建好了「${name}」，在实验页的「分类」里选它`);
  } catch (e) {
    toast(e.message || '建不了这个分类', 'err');
  }
}

/** 这一条属于哪个分类（没有就是未分类） */
const catName = (it) => it.category_name || '';

const activeId = () => (route.name === 'editor' ? Number(route.params.id) : null);

/**
 * 中栏列表的行：同一个平行组（重复 / 控制变量实验）收成一张卡片堆，
 * 其余还是一行一条。组里第一条当「面子」，正在看的是组里哪一条就把哪条翻到前面。
 */
/* 展开着哪些组存在 store 里（不是组件内）：/list 和 /e/:id 是两个页面，
   点进记录时这个组件会被重建，存在组件里的状态一重建就没了 → 卡片堆会自己收起 */
/* 动画没走完就不再响应（约一个过渡时长的防抖）：连续快点两下时，Vue 会等上一段
   展开动画收完再开始收起，看着是「先弹到满高再收回去」，像抖了一下。 */
const stackBusy = new Set();
function toggleGroup(gid) {
  if (stackBusy.has(gid)) return;
  stackBusy.add(gid);
  window.setTimeout(() => stackBusy.delete(gid), membersMs() + 40);
  if (store.openStacks[gid]) delete store.openStacks[gid];
  else store.openStacks[gid] = true;
}
function isGroupOpen(gid) {
  return !!store.openStacks[gid];
}

/* 滚动位置也一样跟着走：点开一条记录再回来，别跳回顶部 */
const bodyEl = ref(null);
let scrollRestored = false;
function saveScroll(e) {
  store.listScroll = Math.round(e.currentTarget.scrollTop);
}
function restoreScroll() {
  if (scrollRestored) return;
  const el = bodyEl.value;
  if (!el || !store.items.length) return;      // 还没数据就先等 watch 再来一次
  scrollRestored = true;
  if (store.listScroll > 0) el.scrollTop = store.listScroll;
}
onMounted(() => nextTick(restoreScroll));
watch(() => store.items.length, () => nextTick(restoreScroll));

const rows = computed(() => {
  const out = [];
  const seen = new Set();
  for (const it of store.items) {
    const gid = it.group_id || '';
    if (!gid) {
      out.push({ key: `e${it.id}`, one: it, anchor: it.id });
      continue;
    }
    if (seen.has(gid)) continue;
    seen.add(gid);
    const members = store.items.filter((x) => (x.group_id || '') === gid);
    // 搜索只命中组里一条时，不装成卡片堆
    if (members.length < 2) {
      out.push({ key: `e${it.id}`, one: it, anchor: it.id });
      continue;
    }
    const ordered = [...members].sort((a, b) => a.id - b.id);   // 最早那条当「面子」
    const base = ordered[0];
    // 列表接口没带 variant（那是编辑页用完整投料表算的），这里用列表里有的条件字段自己比
    const withVariant = ordered.map((m) => {
      const diffs = m.id === base.id ? [] : listDiff(base, m);
      const variant = m.id === base.id ? '基准' : diffs.length === 0 ? '重复' : diffs.length === 1 ? `改：${diffs[0]}` : `改 ${diffs.length} 项`;
      // 规模不同不算改条件（重复实验放大 / 缩小很正常），单独提示
      const scaleNote =
        String(base.base_mmol ?? '') !== String(m.base_mmol ?? '') && m.base_mmol != null
          ? `${base.base_mmol ?? '—'} → ${m.base_mmol} mmol`
          : '';
      return { ...m, diffs, variant, scaleNote };
    });
    const allRepeat = withVariant.every((m) => m.variant === '基准' || m.variant === '重复');
    // 「重复」跟基准是同一套条件，不算多出来的一种；只有真改了变量的才算
    const kinds = new Set(
      withVariant.filter((m) => m.variant !== '基准' && m.variant !== '重复').map((m) => m.variant)
    );
    const active = withVariant.find((m) => m.id === activeId());
    const yields = withVariant.map((m) => m.yield_pct).filter((y) => y != null && y >= 0 && y <= 100);
    out.push({
      key: `g${gid}`,
      gid,
      anchor: ordered[0].id,     // 位置按「最早那条」算，新建平行实验不会让这一堆往上跳
      members: withVariant,
      kindLabel: allRepeat ? `重复 ×${withVariant.length}` : `${kinds.size + 1} 种条件`,
      face: active || withVariant[0],
      mean: yields.length ? Math.round((yields.reduce((a, b) => a + Number(b), 0) / yields.length) * 10) / 10 : null,
    });
  }
  // 卡片堆按基准那条在列表里的位置排：新建平行实验会排在列表最前，
  // 但那一堆仍然待在原来的位置（以前整堆会突然跳到最上面）
  const slot = new Map(store.items.map((x, i) => [x.id, i]));
  return out.sort((a, b) => (slot.get(a.anchor) ?? 1e9) - (slot.get(b.anchor) ?? 1e9));
});

/* ---- 中栏列表拖动排序 ----
   自己实现（`lib/pointdrag.js`）：卡片是 button，Safari 里原生拖放起不了拖。
   一摞（平行组）拖起来是整摞一起动——只挪面子会把同一个组拆到两个分类里。
   行身份用 `anchor`（这一行最早那条的 id）认，一摞的位置本来就按它算。 */
const dragId = ref(null);
const dropIdx = ref(-1);

/* 落到它自己原位（含它后面那一格）时不再画线 */
const dragIdx = computed(() => rows.value.findIndex((r) => r.anchor === dragId.value));
const slotIdx = computed(() => {
  const at = dropIdx.value;
  if (at < 0) return -1;
  const src = dragIdx.value;
  if (src >= 0 && (at === src || at === src + 1)) return -1;
  return at;
});      // 落点线插在第几行前面（= 行数 = 放最后）

const sorter = createPointerSort({
  name: 'exp-list',
  onStart: (id) => { dragId.value = id; },
  // 列表是一列：gap 指向「插到第几行前面」，那里画一条强调色的线
  onTarget: (id, groupKey, gap) => {
    dropIdx.value = Math.min(gap, rows.value.length);
  },
  onDrop: (id, groupKey, gap) => dropRow(id, gap),
  onCancel: () => { dragId.value = null; dropIdx.value = -1; },
});

function onRowDown(ev, row) {
  sorter.down(ev, row.anchor);
}

/** 点卡片：拖完那一下的 click 不要跳页面 */
function goRow(id) {
  if (sorter.clickIsDrag()) return;
  router.push(`/e/${id}`);
}

/** 这一行的分类（一摞就看作面子上那条的分类） */
function rowCategory(row) {
  if (!row) return null;
  return (row.one ? row.one.category_id : row.face.category_id) ?? null;
}

async function dropRow(anchor, at) {
  dragId.value = null;
  dropIdx.value = -1;
  const list = rows.value;
  const row = list.find((r) => r.anchor === anchor);
  if (!row) return;

  const rest = list.filter((r) => r.anchor !== anchor);
  let pos = 0;
  for (let i = 0; i < at && i < list.length; i += 1) if (list[i].anchor !== anchor) pos += 1;
  const nextRow = rest[pos] || null;

  const cat = rowCategory(row);
  if (nextRow && rowCategory(nextRow) !== cat) {
    toast('列表里只能在同一分类内排序；换分类请到卡片视图拖', 'warn');
    return;
  }
  // 原地没动（落点还是它下面那一行）就不发请求
  const curIdx = list.findIndex((r) => r.anchor === anchor);
  if ((list[curIdx + 1] || null) === nextRow) return;

  const ids = row.one ? [row.one.id] : row.members.map((m) => m.id);
  const before = nextRow ? nextRow.anchor : null;
  try {
    // 整摞按顺序插到同一个 before 前面：先面子、再组员，顺序就不会被打乱
    for (const one of ids) await api.moveExperiment(one, { category_id: cat, before_id: before });
    await loadList();
    await loadBoot();
  } catch (e) {
    toast(e.message || '移动不了', 'err');
  }
}

/** 列表里能拿到的条件字段：跟基准比一下，看这条是重复还是改了变量 */
const LIST_VARS = [
  ['solvent', '溶剂'],
  ['concentration', '浓度'],
  ['temperature', '温度'],
  ['duration', '时长'],
  ['atmosphere', '气氛'],
  ['rxn_type', '类型'],
];
/** 当量差在 2%（且 ≤0.005）以内算同一个条件——放大/取整常让当量差一点点 */
function eqSame(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a ?? '') === String(b ?? '');
  return Math.abs(x - y) <= Math.max(0.005, 0.02 * Math.max(Math.abs(x), Math.abs(y)));
}

function listDiff(base, m) {
  const diffs = [];
  // 规模变了，浓度多半是被动跟着变的（放大时溶剂不一定等比加）——不算改条件
  const scaleChanged = String(base.base_mmol ?? '') !== String(m.base_mmol ?? '');
  for (const [k, label] of LIST_VARS) {
    if (k === 'concentration' && scaleChanged) continue;
    if (String(base[k] ?? '') !== String(m[k] ?? '')) diffs.push(label);
  }
  if (String(base.substrates || '') !== String(m.substrates || '')) diffs.push('底物');
  // 投料表：签名一样就跳过；不一样就点出「加 / 去 / 当量」哪种变化
  if (String(base.reagent_sig || '') !== String(m.reagent_sig || '')) {
    const parse = (sig) =>
      Object.fromEntries(
        String(sig || '')
          .split('|')
          .filter(Boolean)
          .map((one) => {
            const [role, name, eq] = one.split(':');
            return [`${role}:${name}`, { role, name, eq }];
          })
      );
    const a = parse(base.reagent_sig);
    const b = parse(m.reagent_sig);
    const notes = [];
    for (const [k, r] of Object.entries(b)) if (!a[k]) notes.push(`加 ${r.name || '（未命名）'}`);
    for (const [k, r] of Object.entries(a)) if (!b[k]) notes.push(`去 ${r.name || '（未命名）'}`);
    for (const [k, rb] of Object.entries(b)) {
      const ra = a[k];
      if (ra && !eqSame(ra.eq, rb.eq)) notes.push(`${rb.name || '（未命名）'} 当量`);
    }
    if (notes.length) diffs.push(`投料（${notes.slice(0, 3).join('，')}${notes.length > 3 ? ' 等' : ''}）`);
  }
  return diffs;
}

/* 组员段展开 / 收起：高度 + 上边距一起过渡，下面那些卡片跟着被推下去，
   不是「啪」地多出一块。每堆内容高度不一样，所以现场量 scrollHeight；
   动画收尾把内联样式清掉、高度交回内容自己算（内容变了也不会卡在某个定值）。 */
const MEMBERS_MS = 220;
const membersMs = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : MEMBERS_MS;

function membersEnter(el, done) {
  const ms = membersMs();
  const gap = getComputedStyle(el).marginTop;   // 常态上距（CSS 里的那个值），过渡到它而不是写死
  el.style.overflow = 'hidden';
  el.style.height = '0px';
  el.style.marginTop = '0px';
  void el.offsetHeight;                         // 先让「0 高」落进布局，才有得过渡
  const h = el.scrollHeight;
  el.style.transition = `height ${ms}ms var(--ease), margin-top ${ms}ms var(--ease)`;
  el.style.height = `${h}px`;
  el.style.marginTop = gap;
  window.setTimeout(() => { membersSettled(el); done(); }, ms + 20);
}

function membersLeave(el, done) {
  const ms = membersMs();
  const gap = getComputedStyle(el).marginTop;
  // 连点两下（展开还没完就收起）时从「当前高度」接着收，别先弹回满高
  const cur = el.getBoundingClientRect().height || el.scrollHeight;
  el.style.overflow = 'hidden';
  el.style.height = `${cur}px`;
  el.style.marginTop = gap;
  void el.offsetHeight;
  el.style.transition = `height ${ms}ms var(--ease), margin-top ${ms}ms var(--ease)`;
  el.style.height = '0px';
  el.style.marginTop = '0px';
  window.setTimeout(() => { membersSettled(el); done(); }, ms + 20);
}

/** 动画结束：清掉内联样式，高度交回内容 */
function membersSettled(el) {
  el.style.height = '';
  el.style.marginTop = '';
  el.style.overflow = '';
  el.style.transition = '';
}

/** 组里任意一条正在看，就把卡片堆标成选中 */
function isGroupActive(row) {
  return row.members.some((m) => m.id === activeId());
}

/**
 * 点卡片堆的面子：**正在看这一组**时不再重复跳同一条记录（页面没变化，看着像没反应），
 * 改成展开 / 收起组员；别的组还是照旧跳过去（跳过去会由 EditorView 自动展开）。
 */
/** 卡片堆上右键：整组的动作 + 「单独处理」里每条子实验一个子菜单 */
function onStackMenu(ev, row) {
  groupMenu(ev, row, router);
}

function onStackFace(row) {
  if (sorter.clickIsDrag()) return;
  if (isGroupActive(row)) return toggleGroup(row.gid);
  router.push(`/e/${row.face.id}`);
}
</script>

<template>
  <div class="listpane">
    <div class="listpane-head">
      <!-- 分类 + 状态都收进右边这个下拉，跟搜索框并排一行 -->
      <div class="searchrow">
        <div class="searchbox">
          <Icon name="search" :size="13" />
          <input v-model="q" type="search" placeholder="搜试剂、条件、表征…" autocomplete="off" />
        </div>
        <CatPick
          :value="filterValue"
          :categories="recordCategories('experiment')"
          :statuses="STATUSES"
          count-key="exp_count"
          @change="setFilter"
          @create="newCategory"
        />
      </div>
    </div>

    <div
      class="listpane-body"
      ref="bodyEl"
      data-drag-group="list"
      :data-drag-count="rows.length"
      @scroll="saveScroll"
    >
      <template v-for="(row, ri) in rows" :key="row.key">
        <div v-if="slotIdx === ri" class="list-drop-line" />
        <!-- 普通记录 -->
        <button
          v-if="row.one"
          class="exp-card can-drag"
          :class="{ 'is-dragging': dragId === row.anchor }"
          :aria-current="row.one.id === activeId() ? 'true' : 'false'"
          :data-drag-card="row.anchor"
          data-drag-group="list"
          :data-drag-index="ri"
          @mousedown="onRowDown($event, row)"
          @click="goRow(row.one.id)"
          @contextmenu="experimentMenu($event, row.one, router)"
        >
          <div class="top">
            <span class="exp-code">{{ row.one.code }}</span>
            <span v-if="row.one.locked" class="exp-lock" title="已锁定，只能查看"><Icon name="lock" :size="11" /></span>
            <span class="tag" :class="STATUS_TONE[row.one.status]" style="font-size: 9px; padding: 1px 6px">{{ row.one.status }}</span>
            <span class="exp-date">{{ row.one.date }}</span>
          </div>
          <div class="exp-title">{{ row.one.title || '（未命名实验）' }}</div>
          <div class="exp-meta">
            <span v-if="catName(row.one)" class="cat-tag">{{ catName(row.one) }}</span>
            <span v-if="row.one.project">{{ row.one.project }}</span>
            <template v-if="row.one.rxn_type"><span class="sep">·</span><span>{{ row.one.rxn_type }}</span></template>
            <template v-if="row.one.yield_pct != null"><span class="sep">·</span><span style="color: var(--ok)">{{ row.one.yield_pct }}%</span></template>
            <template v-if="row.one.attach_count"><span class="sep">·</span><span>{{ row.one.attach_count }} 附件</span></template>
          </div>
        </button>

        <!-- 平行组：叠成一张卡片，后面露出两层纸边；展开后组员一条一行 -->
        <div
          v-else
          class="exp-stack"
          :class="{ 'is-active': isGroupActive(row) }"
          data-drag-group="list"
          :data-drag-count="ri + 1"
        >
          <!-- 两张垫纸挂在 stack-top 上，只跟着面子那张卡片，不跟着展开出来的组员行 -->
          <div class="stack-top">
            <div
              class="exp-card is-stack can-drag"
              :class="{ 'is-dragging': dragId === row.anchor }"
              :aria-current="isGroupActive(row) && !isGroupOpen(row.gid) ? 'true' : 'false'"
              role="button"
              tabindex="0"
              :data-drag-card="row.anchor"
              data-drag-group="list"
              :data-drag-index="ri"
              @mousedown="onRowDown($event, row)"
              @click="onStackFace(row)"
              @keydown.enter="onStackFace(row)"
              @contextmenu="onStackMenu($event, row)"
            >
              <div class="top">
                <span class="exp-code">{{ row.face.code }}</span>
                <span v-if="row.face.locked" class="exp-lock" title="已锁定，只能查看"><Icon name="lock" :size="11" /></span>
                <span class="stack-badge">平行 ×{{ row.members.length }}</span>
                <span class="tag" :class="STATUS_TONE[row.face.status]" style="font-size: 9px; padding: 1px 6px">{{ row.face.status }}</span>
                <span class="exp-date">{{ row.face.date }}</span>
                <button
                  type="button"
                  class="stack-more"
                  :title="isGroupOpen(row.gid) ? '收起组员' : '展开组员'"
                  :aria-expanded="isGroupOpen(row.gid) ? 'true' : 'false'"
                  @click.stop="toggleGroup(row.gid)"
                >
                  {{ isGroupOpen(row.gid) ? '收起 ▴' : '展开 ▾' }}
                </button>
              </div>
              <div class="exp-title">{{ row.face.title || '（未命名实验）' }}</div>
              <div class="exp-meta">
                <span v-if="catName(row.face)" class="cat-tag">{{ catName(row.face) }}</span>
                <span v-if="row.face.project">{{ row.face.project }}</span>
                <span class="sep">·</span><span class="stack-kind">{{ row.kindLabel }}</span>
                <template v-if="row.mean != null"><span class="sep">·</span><span style="color: var(--ok)">均值 {{ row.mean }}%</span></template>
              </div>
              <div class="stack-codes">
                <button
                  v-for="m in row.members"
                  :key="m.id"
                  type="button"
                  class="stack-chip"
                  :class="{ 'is-on': m.id === activeId() }"
                  :title="`${m.code} · ${m.status}${m.yield_pct != null ? ` · ${m.yield_pct}%` : ''}`"
                  @click.stop="router.push(`/e/${m.id}`)"
                  @contextmenu.stop="experimentMenu($event, m, router, { groupSize: row.members.length })"
                >
                  <i class="stack-dot" :class="`tone-${STATUS_TONE[m.status] || 'plain'}`" /><span class="chip-code">{{ m.code }}</span><span class="chip-status">{{ STATUS_SHORT[m.status] || m.status }}</span><span v-if="m.yield_pct != null" class="chip-yield">{{ m.yield_pct }}%</span>
                </button>
              </div>
            </div>
          </div>
          <Transition @enter="membersEnter" @leave="membersLeave" @after-enter="membersSettled" @after-leave="membersSettled">
            <div v-if="isGroupOpen(row.gid)" class="stack-members">
              <button
                v-for="m in row.members"
                :key="m.id"
                class="exp-card is-member"
                :aria-current="m.id === activeId() ? 'true' : 'false'"
                @click="router.push(`/e/${m.id}`)"
                @contextmenu.stop="experimentMenu($event, m, router, { groupSize: row.members.length })"
              >
                <div class="top">
                  <span class="exp-code">{{ m.code }}</span>
                  <span v-if="m.locked" class="exp-lock" title="已锁定，只能查看"><Icon name="lock" :size="11" /></span>
                  <span class="tag" :class="STATUS_TONE[m.status]" style="font-size: 9px; padding: 1px 6px">{{ m.status }}</span>
                  <span class="stack-variant" :title="m.diffs && m.diffs.length ? m.diffs.join('、') : '与基准条件相同'">{{ m.variant }}</span>
                  <span v-if="m.scaleNote" class="stack-scale" :title="`规模 ${m.scaleNote}（不算改条件）`">{{ m.scaleNote }}</span>
                  <span class="exp-date">{{ m.date }}</span>
                  <span v-if="m.yield_pct != null" class="member-yield">{{ m.yield_pct }}%</span>
                </div>
                <div class="exp-title">{{ m.title || '（未命名实验）' }}</div>
              </button>
            </div>
          </Transition>
        </div>
      </template>

      <div v-if="slotIdx === rows.length" class="list-drop-line" />

      <div v-if="!store.items.length" class="empty-note">
        {{ store.filters.q ? '无匹配记录' : '暂无实验记录。' }}
      </div>
    </div>
  </div>
</template>
