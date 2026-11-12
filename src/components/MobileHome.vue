<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { STATUS_TONE } from '../lib/ui.js';
import { round } from '../lib/reagent.js';
import { listDiff } from '../lib/expDiff.js';

/**
 * 手机端的门：`#/m`。
 * 站在通风橱前手机能做的其实就两件事 —— 找到某条实验（看/拍照）、扫瓶签看化合物。
 * 所以这里只列最近实验，点进去就是那条的移动页（里面有拍照上传）。
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

const rows = computed(() => {
  const k = String(q.value || '').trim().toLowerCase();
  if (!k || tab.value === 'cmp') return list.value;
  return list.value.filter((e) => `${e.code || ''} ${e.title || ''}`.toLowerCase().includes(k));
});

/** 平行组：同 `group_id` 才算。基准 = 组里最早那条（跟桌面中栏一个规则） */
const groupOf = computed(() => {
  const byGid = new Map();
  for (const e of list.value) {
    const gid = e.group_id || '';
    if (!gid) continue;
    if (!byGid.has(gid)) byGid.set(gid, []);
    byGid.get(gid).push(e);
  }
  const out = new Map();          // 实验 id → { base, size, complete }
  for (const arr of byGid.values()) {
    const ordered = [...arr].sort((a, b) => a.id - b.id);
    const base = ordered[0];
    const size = Number(base.group_size) || arr.length;
    for (const e of arr) out.set(e.id, { base, size, complete: arr.length >= size });
  }
  return out;
});

/** 一条记录该挂哪些胶囊：基准 / 重复 / 相对基准改了什么（跟桌面组员行同一套文案） */
function chipsFor(e, g) {
  if (!g || g.size < 2) return [];
  // 手机只取最近 40 条，组没取全时基准可能不在这批里 → 宁可不显示，也别拿错基准比
  if (!g.complete) return [];
  if (e.id === g.base.id) return [{ text: '基准', kind: 'base' }];
  const diffs = listDiff(g.base, e);
  if (diffs.length) return diffs.map((d) => ({ text: d }));
  const scaled = String(g.base.base_mmol ?? '') !== String(e.base_mmol ?? '') && e.base_mmol != null;
  return [{ text: scaled ? '改：规模' : '重复', kind: scaled ? '' : 'repeat' }];
}

/** 实验列表带上「组大小 + 胶囊」，模板里别反复算 */
const expRows = computed(() =>
  rows.value.map((e) => {
    const g = groupOf.value.get(e.id);
    return { ...e, groupSize: g && g.size > 1 ? g.size : 0, chips: chipsFor(e, g) };
  })
);

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

    <ul v-else-if="tab === 'exp'" class="phone-list">
      <li v-for="e in expRows" :key="e.id">
        <a class="phone-item" :href="`#/e/${e.id}`">
          <span class="phone-item-top">
            <b class="mono">{{ e.code }}</b>
            <span class="tag" :class="STATUS_TONE[e.status]">{{ e.status }}</span>
            <span v-if="e.groupSize" class="tag plain">
              平行 ×{{ e.groupSize }}
            </span>
          </span>
          <span class="phone-item-title">{{ e.title || '（未命名实验）' }}</span>
          <span class="phone-item-sub mono">{{ e.date || '' }}<template v-if="e.reagent_count"> · {{ e.reagent_count }} 行投料</template></span>
          <span v-if="e.chips.length" class="phone-chips">
            <span
              v-for="(c, i) in e.chips"
              :key="i"
              class="member-diff-item"
              :class="c.kind ? `is-${c.kind}` : ''"
            >{{ c.text }}</span>
          </span>
        </a>
      </li>
    </ul>
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
