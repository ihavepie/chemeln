<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import CatPick from './CatPick.vue';
import { store, loadList, loadBoot, recordCategories, addCategory } from '../store.js';
import { STATUSES, STATUS_SHORT, STATUS_TONE } from '../lib/ui.js';
import { api } from '../api.js';
import { prompt, toast } from '../lib/feedback.js';

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
const openGroups = ref(new Set());

const rows = computed(() => {
  const out = [];
  const seen = new Set();
  for (const it of store.items) {
    const gid = it.group_id || '';
    if (!gid) {
      out.push({ key: `e${it.id}`, one: it });
      continue;
    }
    if (seen.has(gid)) continue;
    seen.add(gid);
    const members = store.items.filter((x) => (x.group_id || '') === gid);
    // 搜索只命中组里一条时，不装成卡片堆
    if (members.length < 2) {
      out.push({ key: `e${it.id}`, one: it });
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
      members: withVariant,
      kindLabel: allRepeat ? `重复 ×${withVariant.length}` : `${kinds.size + 1} 种条件`,
      face: active || withVariant[0],
      mean: yields.length ? Math.round((yields.reduce((a, b) => a + Number(b), 0) / yields.length) * 10) / 10 : null,
    });
  }
  return out;
});

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

function toggleGroup(gid) {
  const next = new Set(openGroups.value);
  if (next.has(gid)) next.delete(gid);
  else next.add(gid);
  openGroups.value = next;
}
function isGroupOpen(gid) {
  return openGroups.value.has(gid);
}
/** 组里任意一条正在看，就把卡片堆标成选中 */
function isGroupActive(row) {
  return row.members.some((m) => m.id === activeId());
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

    <div class="listpane-body">
      <template v-for="row in rows" :key="row.key">
        <!-- 普通记录 -->
        <button
          v-if="row.one"
          class="exp-card"
          :aria-current="row.one.id === activeId() ? 'true' : 'false'"
          @click="router.push(`/e/${row.one.id}`)"
        >
          <div class="top">
            <span class="exp-code">{{ row.one.code }}</span>
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
            <template v-if="row.one.locked"><span class="sep">·</span><span style="color: var(--accent)">已锁定</span></template>
          </div>
        </button>

        <!-- 平行组：叠成一张卡片，后面露出两层纸边；展开后组员一条一行 -->
        <div v-else class="exp-stack" :class="{ 'is-active': isGroupActive(row) }">
          <!-- 两张垫纸挂在 stack-top 上，只跟着面子那张卡片，不跟着展开出来的组员行 -->
          <div class="stack-top">
            <div
              class="exp-card is-stack"
              :aria-current="isGroupActive(row) ? 'true' : 'false'"
              role="button"
              tabindex="0"
              @click="router.push(`/e/${row.face.id}`)"
              @keydown.enter="router.push(`/e/${row.face.id}`)"
            >
              <div class="top">
                <span class="exp-code">{{ row.face.code }}</span>
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
                >
                  <i class="stack-dot" :class="`tone-${STATUS_TONE[m.status] || 'plain'}`" /><span class="chip-code">{{ m.code }}</span><span class="chip-status">{{ STATUS_SHORT[m.status] || m.status }}</span><span v-if="m.yield_pct != null" class="chip-yield">{{ m.yield_pct }}%</span>
                </button>
              </div>
            </div>
          </div>
          <div v-if="isGroupOpen(row.gid)" class="stack-members">
            <button
              v-for="m in row.members"
              :key="m.id"
              class="exp-card is-member"
              :aria-current="m.id === activeId() ? 'true' : 'false'"
              @click="router.push(`/e/${m.id}`)"
            >
              <div class="top">
                <span class="exp-code">{{ m.code }}</span>
                <span class="tag" :class="STATUS_TONE[m.status]" style="font-size: 9px; padding: 1px 6px">{{ m.status }}</span>
                <span class="stack-variant" :title="m.diffs && m.diffs.length ? m.diffs.join('、') : '与基准条件相同'">{{ m.variant }}</span>
                <span v-if="m.scaleNote" class="stack-scale" :title="`规模 ${m.scaleNote}（不算改条件）`">{{ m.scaleNote }}</span>
                <span class="exp-date">{{ m.date }}</span>
                <span v-if="m.yield_pct != null" class="member-yield">{{ m.yield_pct }}%</span>
              </div>
              <div class="exp-title">{{ m.title || '（未命名实验）' }}</div>
            </button>
          </div>
        </div>
      </template>

      <div v-if="!store.items.length" class="empty-note">
        {{ store.filters.q ? '无匹配记录' : '暂无实验记录。' }}
      </div>
    </div>
  </div>
</template>
