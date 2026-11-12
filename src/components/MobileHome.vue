<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { api } from '../api.js';
import { STATUS_TONE } from '../lib/ui.js';
import { round } from '../lib/reagent.js';
import { listDiff } from '../lib/expDiff.js';
import { store } from '../store.js';

/**
 * 手机端的门：`#/m`。
 * 站在通风橱前手机能做的其实就两件事 —— 找到某条实验（看/拍照）、扫瓶签看化合物。
 * 所以这里只列最近实验，点进去就是那条的移动页（里面有拍照上传）。
 *
 * 实验这边的列表**照着桌面中栏的样子做**（纸卡片 + 投影浮在 bone 底上）：平行组收成一张「卡片堆」，
 * 点「展开 ▾」在下面列出组员行，每行挂「相对基准改了什么」的胶囊（文案来自 `lib/expDiff.js`，
 * 跟桌面同一套）。**没做拖拽排序 / 右键菜单**——手机上手指拖卡片跟滚动会打架，
 * 换分类请回电脑（或者以后长按再说）。
 */
const tab = ref('exp');           // exp | cmp
const list = ref([]);             // 实验
const cmpList = ref([]);          // 化合物
const q = ref('');
const error = ref('');
const loading = ref(true);

async function loadExps() {
  list.value = (await api.experiments({ sort: 'newest' }) || []).slice(0, 40);
}
async function loadCompounds(withQuery = '') {
  cmpList.value = (await api.compounds(withQuery ? { q: withQuery } : {}) || []).slice(0, 60);
}

onMounted(async () => {
  try {
    await Promise.all([loadExps(), loadCompounds()]);
  } catch (e) {
    error.value = e.message || '列表读不出来';
  } finally {
    loading.value = false;
  }
});

/** 搜索：实验按标题/编号，化合物走接口（编号、名称、分子式都能搜） */
let timer = null;
watch(q, (v) => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const k = String(v || '').trim();
    try {
      if (tab.value === 'cmp') await loadCompounds(k);
    } catch {
      /* 搜失败就保持原样 */
    }
  }, 220);
});

const filtered = computed(() => {
  const k = String(q.value || '').trim().toLowerCase();
  if (!k) return list.value;
  return list.value.filter((e) => `${e.code || ''} ${e.title || ''}`.toLowerCase().includes(k));
});

/**
 * 行：同一 `group_id` 且组里 ≥2 条 → 收成一张卡片堆（面子 = 组里最早那条），其余一条一行。
 * 组员的「改了什么」用 `listDiff(基准, 它)` 算，跟桌面中栏同一套文案。
 * 一摞的位置按「基准那条」在列表里的下标排（跟桌面同一条规则，不然排序会跳）。
 */
const expRows = computed(() => {
  const items = filtered.value;
  const out = [];
  const seen = new Set();
  for (const e of items) {
    const gid = e.group_id || '';
    const members = gid ? items.filter((x) => (x.group_id || '') === gid) : [];
    // 搜索只命中组里一条时，别装成卡片堆
    if (!gid || members.length < 2) {
      out.push({ key: `e${e.id}`, one: e, anchor: e.id });
      continue;
    }
    if (seen.has(gid)) continue;
    seen.add(gid);
    const ordered = [...members].sort((a, b) => a.id - b.id);
    const base = ordered[0];
    const withVariant = ordered.map((m) => {
      const diffs = m.id === base.id ? [] : listDiff(base, m);
      // 规模不同不算改条件（重复实验放大 / 缩小很正常），单独记一句
      const scaleNote =
        String(base.base_mmol ?? '') !== String(m.base_mmol ?? '') && m.base_mmol != null
          ? base.base_mmol == null
            ? `${m.base_mmol} mmol`
            : `${base.base_mmol} → ${m.base_mmol} mmol`
          : '';
      const variant = m.id === base.id ? '基准' : diffs.length ? `改：${diffs.join('、')}` : scaleNote ? '改：规模' : '重复';
      return { ...m, diffs, variant, scaleNote };
    });
    const allRepeat = withVariant.every((m) => m.variant === '基准' || m.variant === '重复');
    const kinds = new Set(withVariant.filter((m) => m.variant !== '基准' && m.variant !== '重复').map((m) => m.variant));
    const yields = withVariant.map((m) => m.yield_pct).filter((y) => y != null && y >= 0 && y <= 100);
    out.push({
      key: `g${gid}`,
      gid,
      anchor: base.id,
      members: withVariant,
      face: withVariant[0],
      kindLabel: allRepeat ? `重复 ×${withVariant.length}` : `${kinds.size + 1} 种条件`,
      mean: yields.length ? Math.round((yields.reduce((a, b) => a + Number(b), 0) / yields.length) * 10) / 10 : null,
    });
  }
  const slot = new Map(items.map((x, i) => [x.id, i]));
  return out.sort((a, b) => (slot.get(a.anchor) ?? 1e9) - (slot.get(b.anchor) ?? 1e9));
});

/* 展开着哪些组跟桌面共用 `store.openStacks`（点进记录回来还在），不一堆一套自己的状态 */
const isOpen = (gid) => !!store.openStacks[gid];
function toggleGroup(gid) {
  if (store.openStacks[gid]) delete store.openStacks[gid];
  else store.openStacks[gid] = true;
}

const colors = computed(() => cmpList.value.filter((c) => String(c.name || c.code || '').trim()));
</script>

<template>
  <div class="phone-cmp">
    <div class="phone-head">
      <div class="phone-code mono">EXP · ELN</div>
      <h1 class="phone-name">{{ tab === 'exp' ? '最近实验' : '化合物' }}</h1>
      <p class="phone-hint">
        {{ tab === 'exp' ? '点一条进去看内容、拍 TLC / 照片 / 谱图；画结构式请回电脑。' : '点一个看结构式、MW、谱图和性状；也可以直接搜编号或名字。' }}
      </p>
      <div class="phone-seg">
        <button type="button" :class="{ on: tab === 'exp' }" @click="tab = 'exp'">实验</button>
        <button type="button" :class="{ on: tab === 'cmp' }" @click="tab = 'cmp'">化合物</button>
      </div>
      <input class="phone-search" v-model="q" :placeholder="tab === 'exp' ? '搜编号 / 标题' : '搜编号 / 名称 / 分子式'" />
    </div>

    <div v-if="error" class="phone-note">{{ error }}</div>
    <div v-else-if="loading" class="phone-note">读取中…</div>

    <!-- 实验：纸卡片列表，平行组收成卡片堆 / 可展开（跟桌面中栏同构，只是不带拖拽） -->
    <div v-else-if="tab === 'exp'" class="phone-cards">
      <div v-for="row in expRows" :key="row.key" class="phone-stack">
        <template v-if="row.one">
          <a class="exp-card" :href="`#/e/${row.one.id}`">
            <div class="top">
              <span class="exp-code">{{ row.one.code }}</span>
              <span v-if="row.one.locked" class="exp-lock" title="已锁定，只能查看"><Icon name="lock" :size="11" /></span>
              <span class="tag" :class="STATUS_TONE[row.one.status]" style="font-size: 9px; padding: 1px 6px">{{ row.one.status }}</span>
              <span v-if="row.one.rxn_type" class="tag is-rxn">{{ row.one.rxn_type }}</span>
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
              <template v-if="row.one.project"><span>{{ row.one.project }}</span><span class="sep">·</span></template>
              <span v-if="row.one.reagent_count">{{ row.one.reagent_count }} 行投料</span>
              <template v-if="row.one.yield_pct != null"><span class="sep">·</span><span>{{ row.one.yield_pct }}%</span></template>
            </div>
          </a>
        </template>

        <template v-else>
          <div class="stack-top">
            <div
              class="exp-card is-stack"
              :class="{ 'is-open': isOpen(row.gid) }"
              role="button"
              tabindex="0"
              @click="toggleGroup(row.gid)"
              @keydown.enter="toggleGroup(row.gid)"
            >
              <div class="top">
                <span class="exp-code">{{ row.face.code }}</span>
                <span class="stack-badge">平行 ×{{ row.members.length }}</span>
                <span class="tag" :class="STATUS_TONE[row.face.status]" style="font-size: 9px; padding: 1px 6px">{{ row.face.status }}</span>
                <span v-if="row.face.rxn_type" class="tag is-rxn">{{ row.face.rxn_type }}</span>
                <span class="exp-date">{{ row.face.date }}</span>
                <button
                  type="button"
                  class="stack-more"
                  :aria-expanded="isOpen(row.gid) ? 'true' : 'false'"
                  :title="isOpen(row.gid) ? '收起组员' : '展开组员'"
                  @click.stop="toggleGroup(row.gid)"
                >
                  {{ isOpen(row.gid) ? '收起 ▴' : '展开 ▾' }}
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
                <template v-if="row.face.project"><span>{{ row.face.project }}</span><span class="sep">·</span></template>
                <span class="stack-kind">{{ row.kindLabel }}</span>
                <template v-if="row.mean != null"><span class="sep">·</span><span style="color: var(--ok)">均值 {{ row.mean }}%</span></template>
              </div>
            </div>
          </div>

          <div v-if="isOpen(row.gid)" class="stack-members">
            <a v-for="m in row.members" :key="m.id" class="exp-card is-member" :href="`#/e/${m.id}`">
              <div class="top">
                <span class="exp-code">{{ m.code }}</span>
                <span class="tag" :class="STATUS_TONE[m.status]" style="font-size: 9px; padding: 1px 6px">{{ m.status }}</span>
                <span v-if="(!m.diffs || !m.diffs.length) && m.variant !== '改：规模'" class="stack-variant">{{ m.variant }}</span>
                <span v-if="m.scaleNote" class="stack-scale" :title="`规模 ${m.scaleNote}（不算改条件）`">{{ m.scaleNote }}</span>
                <span class="exp-date">{{ m.date }}</span>
                <span v-if="m.yield_pct != null" class="member-yield">{{ m.yield_pct }}%</span>
              </div>
              <div class="exp-title">
                <span class="exp-name">{{ m.title || m.objective || '（未命名实验）' }}</span>
              </div>
              <div v-if="m.diffs && m.diffs.length" class="member-diff">
                <span v-for="d in m.diffs" :key="d" class="member-diff-item">{{ d }}</span>
              </div>
            </a>
          </div>
        </template>
      </div>
      <p v-if="!expRows.length" class="phone-hint" style="padding: 8px 2px">没有匹配的实验</p>
    </div>

    <ul v-else class="phone-list">
      <li v-for="c in colors" :key="c.id">
        <a class="phone-item phone-item-cmp" :href="`#/c/${c.id}`">
          <img v-if="c.structure_id" class="phone-cmp-fig" :src="`/api/compound-files/${c.structure_id}`" alt="" loading="lazy" />
          <span v-else class="phone-cmp-fig is-empty" />
          <span class="phone-item-body">
            <span class="phone-item-top">
              <b class="mono">{{ c.code || '—' }}</b>
              <span v-if="c.kind" class="tag plain">{{ c.kind }}</span>
            </span>
            <span class="phone-item-title">{{ c.name || '（未命名）' }}</span>
            <span class="phone-item-sub mono">{{ c.formula || '' }}<template v-if="c.mw"> · {{ round(c.mw, 2) }}</template></span>
          </span>
        </a>
      </li>
      <li v-if="!colors.length" class="phone-hint" style="padding: 16px 2px">没有匹配的化合物</li>
    </ul>

    <p class="phone-foot">瓶签二维码可直接打开化合物档案</p>
  </div>
</template>
