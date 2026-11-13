<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import CatPick from './CatPick.vue';
import ExpPick from './ExpPick.vue';
import { store, loadList, loadBoot, recordCategories, addCategory, createExperiment } from '../store.js';
import { STATUSES, STATUS_SHORT, STATUS_TONE } from '../lib/ui.js';
import { api } from '../api.js';
import { listDiff } from '../lib/expDiff.js';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { CTX_SEP, openCtxMenu } from '../lib/ctxmenu.js';
import { createPointerSort } from '../lib/pointdrag.js';
import { withFlip } from '../lib/flip.js';
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
      // 规模不同不算改条件（重复实验放大 / 缩小很正常），单独提示
      const scaleNote =
        String(base.base_mmol ?? '') !== String(m.base_mmol ?? '') && m.base_mmol != null
          ? base.base_mmol == null
            ? `${m.base_mmol} mmol`   // 基准那条没记规模，就别写「— → 0.2」
            : `${base.base_mmol} → ${m.base_mmol} mmol`
          : '';
      // 只差规模也算「另一种条件」（不然整摞会被读成「重复 ×2」），但卡片上不再重复写一遍——
      // 规模本来就有自己那行小注
      const variant = m.id === base.id ? '基准' : diffs.length ? `改：${diffs.join('、')}` : scaleNote ? '改：规模' : '重复';
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
const drop = ref(null);       // 落点：{ key: 哪一段, at: 这一段里第几行前面 }
const dragH = ref(74);        // 占位格高度 = 被拖那张卡的真实高度

/* 分类分组：下拉停在「全部分类」时，列表就按分类分段显示（顺序跟设置页 / 卡片墙一致），
   没记录的分类也留一行——那一行就是拖拽换分类的落点。
   在下拉里选了具体分类才平铺，不然看不出自己在看哪一段。 */
const grouping = computed(() => !store.filters.category);

/**
 * 分类段头的右键菜单：左键不再「点一下就筛」（整列跳过去太容易误触），
 * 该做的事都收进这里——只看这一类、在这里新建、改名、删掉（未分类那一段只有前两项）。
 */
function catMenu(ev, sec) {
  const items = [
    { key: 'only', label: `只看「${sec.name}」`, icon: 'search' },
    { key: 'add', label: '在这里新建实验', icon: 'plus' },
  ];
  if (sec.catId != null) {
    items.push(
      CTX_SEP,
      { key: 'rename', label: '重命名分类', icon: 'edit' },
      { key: 'delete', label: '删除分类', icon: 'trash', danger: true }
    );
  }
  openCtxMenu(ev, items, async (key) => {
    if (key === 'only') return setFilter(sec.catId == null ? 'none' : String(sec.catId));
    if (key === 'add') return createIn(sec);
    if (key === 'rename') {
      const name = await prompt({ title: '重命名分类', value: sec.name, confirmText: '改名' });
      if (!name || name === sec.name) return;
      try {
        await api.saveCategory(sec.catId, { name });
        await Promise.all([loadBoot(), loadList()]);
      } catch (e) {
        toast(e.message || '改不了', 'err');
      }
      return;
    }
    if (key === 'delete') {
      const ok = await confirm({
        title: `删除「${sec.name}」这个分类？`,
        body: '分类里的记录会变成「未分类」，记录本身不会被删掉。',
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteCategory(sec.catId);
        if (String(store.filters.category) === String(sec.catId)) store.filters.category = '';
        await Promise.all([loadBoot(), loadList()]);
      } catch (e) {
        toast(e.message || '删不掉', 'err');
      }
    }
  });
}

/** 「与另一条对照」：卡片右键里挑，选完并排打开 /compare */
const compareFrom = ref(null);
function askCompare(it) {
  compareFrom.value = it || null;
}
function onComparePicked(list) {
  const id = Number((list || [])[0]);
  const from = compareFrom.value;
  compareFrom.value = null;
  if (!id || !from) return;
  router.push(`/compare?a=${from.id}&b=${id}`);
}

/** 在某个分类段里新建一条实验（`catId == null` = 未分类那一段，明确落未分类） */
async function createIn(sec) {
  const exp = await createExperiment(sec.catId == null ? null : sec.catId);
  router.push(`/e/${exp.id}`);
}

const sections = computed(() => {
  const all = rows.value;
  if (!grouping.value) return [{ key: 'list', name: '', catId: undefined, rows: all }];
  const byCat = new Map();
  for (const r of all) {
    const cid = rowCategory(r);
    const k = cid == null || cid === '' ? 'none' : String(cid);
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(r);
  }
  const out = [];
  for (const c of recordCategories('experiment')) {
    const k = String(c.id);
    out.push({ key: `cat:${k}`, name: c.name, catId: Number(c.id), rows: byCat.get(k) || [] });
    byCat.delete(k);
  }
  // 列表里有、分类表里没有的（老记录挂在已删的分类上）也得有落处，别让它们消失
  for (const [k, rs] of [...byCat]) {
    if (k === 'none' || !rs.length) continue;
    out.push({ key: `cat:${k}`, name: rs[0].category_name || '其他分类', catId: Number(k), rows: rs });
    byCat.delete(k);
  }
  out.push({ key: 'cat:none', name: '未分类', catId: null, rows: byCat.get('none') || [] });
  return out;
});

/* 拖它自己那一格、或者紧后头那一格，都不用再画落点格（原地没动） */
function showSlot(sec, at) {
  const d = drop.value;
  if (!d || d.key !== sec.key || d.at !== at) return false;
  const s = sec.rows.findIndex((r) => r.anchor === dragId.value);
  return !(s >= 0 && (at === s || at === s + 1));
}

const sorter = createPointerSort({
  name: 'exp-list',
  onStart: (id) => {
    dragId.value = id;
    const el = document.querySelector(`[data-drag-card="${id}"]`);
    if (el) dragH.value = Math.round(el.getBoundingClientRect().height);
  },
  // 每一段（一个分类）自己是一个落区：gap = 插到这一段的第几行前面
  onTarget: (id, groupKey, gap) => {
    const sec = sections.value.find((s) => s.key === groupKey);
    if (!sec) return;
    const at = Math.min(gap, sec.rows.length);
    if (drop.value && drop.value.key === sec.key && drop.value.at === at) return;
    // 占位格一插进去，下面的卡片就要下移：用 FLIP 滑过去，别瞬移
    withFlip([...document.querySelectorAll('.listpane .exp-card')], () => {
      drop.value = { key: sec.key, at };
    });
  },
  onDrop: (id, groupKey, gap) => dropRow(id, groupKey, gap),
  onCancel: () => { dragId.value = null; drop.value = null; },
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

async function dropRow(anchor, groupKey, gap) {
  dragId.value = null;
  drop.value = null;
  const sec = sections.value.find((s) => s.key === groupKey);
  const row = rows.value.find((r) => r.anchor === anchor);
  if (!row || !sec) return;

  const at = Math.min(gap, sec.rows.length);
  const rest = sec.rows.filter((r) => r.anchor !== anchor);
  let pos = 0;
  for (let i = 0; i < at && i < sec.rows.length; i += 1) if (sec.rows[i].anchor !== anchor) pos += 1;
  const nextRow = rest[pos] || null;

  const curCat = rowCategory(row);
  // 平铺（正在按分类 / 状态筛）时 sec.catId 是 undefined，按「不换分类」处理
  const nextCat = sec.catId === undefined ? curCat : sec.catId;
  const changing = (curCat ?? null) !== (nextCat ?? null);

  // 原地没动（落点还是它自己后面那一行）就不发请求
  const curIdx = sec.rows.findIndex((r) => r.anchor === anchor);
  if (!changing && (sec.rows[curIdx + 1] || null) === nextRow) return;

  const ids = row.one ? [row.one.id] : row.members.map((m) => m.id);
  const before = nextRow ? nextRow.anchor : null;
  try {
    // 整摞按顺序插到同一个 before 前面：先面子、再组员，顺序就不会被打乱
    for (const one of ids) await api.moveExperiment(one, { category_id: nextCat, before_id: before });
    await loadList();
    await loadBoot();
    if (changing) toast(`已移到「${sec.name || '未分类'}」`, 'info', 1600);
  } catch (e) {
    toast(e.message || '移动不了', 'err');
  }
}

/** 记录类型（试反应 / 条件筛选…）。反应类型单独做成一颗胶囊（`.tag.is-rxn`），不挤进那段文字里 */
const rxnDesc = (m) => String(m.kind || '').trim();
/* 两步反应那条链：`第 2 步`（单独一条记录、没接就不显示） */
const chainTag = (it) => (Number(it && it.chain_len) > 1 ? `第 ${Number(it.chain_step) || 1} 步` : '');
const rxnType = (m) => String(m.rxn_type || '').trim();

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

    <div class="listpane-body" ref="bodyEl" @scroll="saveScroll">
      <!-- 「全部分类」时按分类分段：每段自己就是一个拖放落区（拖进去 = 换分类） -->
      <section
        v-for="sec in sections"
        :key="sec.key"
        class="list-cat"
        :class="{ 'is-drop-target': drop && drop.key === sec.key }"
        :data-drag-group="sec.key"
        :data-drag-count="sec.rows.length"
        @contextmenu="catMenu($event, sec)"
      >
        <!-- 分类这一行不在左键上做事（点一下就整列跳过去，太容易误触）：
             **右键**出菜单（只看这一类 / 在这里新建 / 改名 / 删掉），右边那颗＋是新建 -->
        <div v-if="grouping" class="list-cat-row">
          <span class="list-cat-head">
            <span class="list-cat-name">{{ sec.name }}</span>
            <span class="list-cat-count">{{ sec.rows.length }}</span>
          </span>
          <button
            type="button"
            class="list-cat-add"
            :title="`在「${sec.name}」里新建实验`"
            @click.stop="createIn(sec)"
          >
            <Icon name="plus" :size="11" />
          </button>
        </div>
        <template v-for="(row, ri) in sec.rows" :key="row.key">
          <div v-if="showSlot(sec, ri)" class="list-drop-slot" :style="{ height: `${dragH}px` }" />
        <!-- 普通记录 -->
        <button
          v-if="row.one"
          class="exp-card can-drag"
          :class="{ 'is-dragging': dragId === row.anchor }"
          :aria-current="row.one.id === activeId() ? 'true' : 'false'"
          :data-drag-card="row.anchor"
          :data-drag-group="sec.key"
          :data-drag-index="ri"
          @mousedown="onRowDown($event, row)"
          @click="goRow(row.one.id)"
          @contextmenu="experimentMenu($event, row.one, router, { category: sec.catId == null ? null : { id: sec.catId, name: sec.name }, onCompare: askCompare })"
        >
          <div class="top">
            <span class="exp-code">{{ row.one.code }}</span>
            <span v-if="row.one.locked" class="exp-lock" title="已锁定，只能查看"><Icon name="lock" :size="11" /></span>
            <span class="tag" :class="STATUS_TONE[row.one.status]" style="font-size: 9px; padding: 1px 6px">{{ row.one.status }}</span>
            <span v-if="chainTag(row.one)" class="tag is-step">{{ chainTag(row.one) }}</span>
            <span v-if="rxnType(row.one)" class="tag is-rxn">{{ rxnType(row.one) }}</span>
            <span class="exp-date">{{ row.one.date }}</span>
          </div>
          <div class="exp-title">
            <span class="exp-name">{{ row.one.title || row.one.objective || '（未命名实验）' }}</span>
            <template v-if="row.one.objective && row.one.objective !== row.one.title">
              <span class="exp-rule" aria-hidden="true" />
              <span class="exp-desc-inline">{{ row.one.objective }}</span>
            </template>
          </div>
          <div class="exp-meta">
            <span v-if="!grouping && catName(row.one)" class="cat-tag">{{ catName(row.one) }}</span>
            <span v-if="row.one.project">{{ row.one.project }}</span>
            <template v-if="rxnDesc(row.one)"><span class="sep">·</span><span>{{ rxnDesc(row.one) }}</span></template>
            <template v-if="row.one.yield_pct != null"><span class="sep">·</span><span style="color: var(--ok)">{{ row.one.yield_pct }}%</span></template>
            <template v-if="row.one.attach_count"><span class="sep">·</span><span>{{ row.one.attach_count }} 附件</span></template>
          </div>
        </button>

        <!-- 平行组：叠成一张卡片，后面露出两层纸边；展开后组员一条一行 -->
        <div
          v-else
          class="exp-stack"
          :class="{ 'is-active': isGroupActive(row) }"
          :data-drag-group="sec.key"
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
              :data-drag-group="sec.key"
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
                <span v-if="chainTag(row.face)" class="tag is-step">{{ chainTag(row.face) }}</span>
                <span class="tag" :class="STATUS_TONE[row.face.status]" style="font-size: 9px; padding: 1px 6px">{{ row.face.status }}</span>
                <span v-if="rxnType(row.face)" class="tag is-rxn">{{ rxnType(row.face) }}</span>
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
              <div class="exp-title">
                <span class="exp-name">{{ row.face.title || row.face.objective || '（未命名实验）' }}</span>
                <template v-if="row.face.objective && row.face.objective !== row.face.title">
                  <span class="exp-rule" aria-hidden="true" />
                  <span class="exp-desc-inline">{{ row.face.objective }}</span>
                </template>
              </div>
              <div class="exp-meta">
                <span v-if="!grouping && catName(row.face)" class="cat-tag">{{ catName(row.face) }}</span>
                <span v-if="row.face.project">{{ row.face.project }}</span>
                <span class="sep">·</span><span class="stack-kind">{{ row.kindLabel }}</span>
                <template v-if="row.face.rxn_type"><span class="sep">·</span><span class="stack-kind">{{ row.face.rxn_type }}</span></template>
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
                  <span v-if="rxnDesc(m)" class="stack-rxn">{{ rxnDesc(m) }}</span>
                  <span v-if="rxnType(m)" class="tag is-rxn">{{ rxnType(m) }}</span>
                  <span v-if="(!m.diffs || !m.diffs.length) && m.variant !== '改：规模'" class="stack-variant">{{ m.variant }}</span>
                  <span v-if="m.scaleNote" class="stack-scale" :title="`规模 ${m.scaleNote}（不算改条件）`">{{ m.scaleNote }}</span>
                  <span class="exp-date">{{ m.date }}</span>
                  <span v-if="m.yield_pct != null" class="member-yield">{{ m.yield_pct }}%</span>
                </div>
                <div class="exp-title">
                  <span class="exp-name">{{ m.title || m.objective || '（未命名实验）' }}</span>
                  <template v-if="m.objective && m.objective !== m.title">
                    <span class="exp-rule" aria-hidden="true" />
                    <span class="exp-desc-inline">{{ m.objective }}</span>
                  </template>
                </div>
                <!-- 改了什么：一条一项，各自一颗小标签，不折成「投料（… 等）」也不让它断行 -->
                <div v-if="m.diffs && m.diffs.length" class="member-diff">
                  <span v-for="d in m.diffs" :key="d" class="member-diff-item">{{ d }}</span>
                </div>
              </button>
            </div>
          </Transition>
        </div>
      </template>

        <div v-if="showSlot(sec, sec.rows.length)" class="list-drop-slot" :style="{ height: `${dragH}px` }" />
        <div v-if="grouping && !sec.rows.length" class="list-cat-blank">拖一条记录到这里</div>
      </section>

      <ExpPick
        :model-value="!!compareFrom"
        title="跟哪条记录对照？"
        confirm-text="并排看"
        :exclude="compareFrom ? [compareFrom.id] : []"
        @close="compareFrom = null"
        @confirm="onComparePicked"
      />

      <div v-if="!store.items.length" class="empty-note">
        {{ store.filters.q ? '无匹配记录' : '暂无实验记录。' }}
      </div>
    </div>
  </div>
</template>
