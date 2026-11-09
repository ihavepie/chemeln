<script setup>
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { store } from '../store.js';
import { downloadBlob } from '../lib/print.js';
import { toast } from '../lib/feedback.js';
import { useColResize } from '../lib/colresize.js';

/**
 * 实验记录的表格视图（卡片墙的另一种看法）：一行 = 一条记录。
 * 数据就是 store.items——中栏列表搜什么、筛什么，这张表就跟着变，不再单独请求。
 *
 * 方法学最常看的是「同一套条件下换底物，产率怎么走」，
 * 所以优先摆 结构 · 底物 → 产物 · 条件 · 产率 · 选择性，并支持按列排序。
 */
const router = useRouter();

const picked = reactive({});
const rows = computed(() => store.items);
const pickedRows = computed(() => rows.value.filter((x) => picked[x.id]));
const pickedCount = computed(() => pickedRows.value.length);

const sortKey = ref('date');
const sortDir = ref('desc');

const COLS = [
  { key: 'code', label: '编号', align: 'left' },
  { key: 'structure', label: '结构', nosort: true },
  { key: 'subject', label: '底物 → 产物' },
  { key: 'condition', label: '条件', nosort: true },
  { key: 'yield_pct', label: '产率', align: 'right' },
  { key: 'ee', label: '选择性', align: 'right' },
  { key: 'date', label: '日期' },
];

/* 表头拖拽改列宽：弹性列是「底物 → 产物」那列；宽度按表存浏览器 */
const COLDEFS = [
  { key: 'pick', w: 30 },
  { key: 'code', w: 86 },
  { key: 'structure', w: 76 },
  { key: 'subject', w: 400 },
  { key: 'condition', w: 320 },
  { key: 'yield_pct', w: 62 },
  { key: 'ee', w: 84 },
  { key: 'date', w: 94 },
];
const { tableEl, start: startResize, colStyle } = useColResize(
  'exp',
  Object.fromEntries(COLDEFS.map((c) => [c.key, c.w]))
);

const numOf = (v) => {
  const m = String(v ?? '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const conditionText = (r) => {
  const parts = [];
  if (r.solvent) parts.push(r.solvent);
  if (r.concentration) parts.push(r.concentration);
  if (r.temperature) parts.push(r.temperature);
  if (r.duration) parts.push(r.duration);
  if (r.atmosphere) parts.push(r.atmosphere);
  return parts.join(' · ');
};

const sorted = computed(() => {
  const key = sortKey.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const val = (r) => {
    if (key === 'yield_pct') return r.yield_pct === null || r.yield_pct === undefined ? null : Number(r.yield_pct);
    if (key === 'ee') return r.ee_pct === null || r.ee_pct === undefined ? numOf(r.dr_ee) : Number(r.ee_pct);
    if (key === 'subject') return `${r.substrates || ''} ${r.product_name || ''}`.trim();
    if (key === 'code') return r.code || '';
    return r[key] ?? '';
  };
  return [...rows.value].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    // 空值永远沉底，不管升序降序
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y), 'zh') * dir;
  });
});

function setSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
    return;
  }
  sortKey.value = key;
  // 产率 / 选择性默认先看大的
  sortDir.value = key === 'yield_pct' || key === 'ee' ? 'desc' : 'asc';
}

const allPicked = computed(() => sorted.value.length > 0 && sorted.value.every((x) => picked[x.id]));

function toggleAll() {
  const on = !allPicked.value;
  for (const r of sorted.value) {
    if (on) picked[r.id] = true;
    else delete picked[r.id];
  }
}

function toggle(id) {
  if (picked[id]) delete picked[id];
  else picked[id] = true;
}

const open = (id) => router.push(`/e/${id}`);

const stat = computed(() => {
  const all = rows.value.filter((x) => x.yield_pct !== null && x.yield_pct !== undefined);
  // 只统 0–100% 的产率：填错成 8321% 那种会把平均拉到离谱，单独报条数让人自己去修
  const good = all.filter((x) => Number(x.yield_pct) >= 0 && Number(x.yield_pct) <= 100);
  const avg = good.length ? good.reduce((s, x) => s + Number(x.yield_pct), 0) / good.length : null;
  return { n: rows.value.length, y: good.length, avg, suspect: all.length - good.length };
});

const thumbUrl = (r) => (r.product_structure_id ? `/api/compound-files/${r.product_structure_id}` : '');

/* ------------------------------------------------------------ 导出 */
const exportRows = computed(() => (pickedCount.value ? pickedRows.value : sorted.value));

const cell = (v) => String(v ?? '');
const csvCell = (v) => {
  const s = cell(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function exportCsv() {
  const list = exportRows.value;
  if (!list.length) return toast('没有可以导出的行', 'err');
  const head = ['编号', '日期', '状态', '底物', '产物', '溶剂', '浓度', '温度', '时间', '气氛', '产率(%)', 'ee/dr', '结构图URL', '记录链接', '标题'];
  const origin = window.location.origin;
  const body = list.map((r) =>
    [
      r.code,
      r.date,
      r.status,
      r.substrates,
      r.product_name,
      r.solvent,
      r.concentration,
      r.temperature,
      r.duration,
      r.atmosphere,
      r.yield_pct ?? '',
      r.dr_ee,
      r.product_structure_id ? `${origin}/api/compound-files/${r.product_structure_id}` : '',
      `${origin}/#/e/${r.id}`,
      r.title,
    ]
      .map(csvCell)
      .join(',')
  );
  const csv = `\uFEFF${[head.map(csvCell).join(','), ...body].join('\r\n')}\r\n`;
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `底物拓展-${store.project || '全部'}-${stamp()}.csv`);
  toast(`导出了 ${list.length} 行`);
}

function exportMd() {
  const list = exportRows.value;
  if (!list.length) return toast('没有可以导出的行', 'err');
  const sep = '|---|---|---|---|---:|---:|';
  const body = list.map((r) => {
    const cells = [
      r.code || '',
      r.substrates || '',
      r.product_name || '',
      conditionText(r),
      r.yield_pct === null || r.yield_pct === undefined ? '' : `${r.yield_pct}%`,
      r.dr_ee || '',
    ].map((c) => cell(c).replace(/\|/g, '\\|'));
    return `| ${cells.join(' | ')} |`;
  });
  const md = ['| 编号 | 底物 | 产物 | 条件 | 产率 | 选择性 |', sep, ...body].join('\n');
  const title = `## 底物拓展${store.project ? `（${store.project}）` : ''}\n\n`;
  downloadBlob(new Blob([`${title}${md}\n`], { type: 'text/markdown;charset=utf-8' }), `底物拓展-${store.project || '全部'}-${stamp()}.md`);
  toast(`导出了 ${list.length} 行`);
}
</script>

<template>
  <div class="table-page">
  <div v-if="!rows.length" class="scope-empty">
    {{ store.filters.q || store.filters.status || store.filters.category ? '无匹配记录。' : '暂无实验记录。点右上角「新建实验」。' }}
  </div>
  <div v-else class="scope-wrap">
    <table ref="tableEl" class="scope-table">
      <colgroup>
        <col v-for="c in COLDEFS" :key="c.key" :style="colStyle(c.key)" />
      </colgroup>
      <thead>
        <tr>
          <th class="c-pick">
            <button type="button" class="pick-all" :aria-pressed="allPicked ? 'true' : 'false'" @click="toggleAll">
              {{ allPicked ? '✓' : '' }}
            </button>
          </th>
          <th
            v-for="c in COLS"
            :key="c.key"
            :data-col="c.key"
            :class="[`c-${c.key}`, c.align === 'right' ? 'is-right' : '', c.nosort ? '' : 'is-sortable']"
            @click="c.nosort ? null : setSort(c.key)"
          >
            {{ c.label }}
            <span v-if="!c.nosort && sortKey === c.key" class="sort-mark">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
            <!-- 右边界那一条：按住横拖改列宽（跟旁边那列换空间） -->
            <span
              class="col-grip"
              :title="'拖动改「' + c.label + '」的列宽'"
              @mousedown="startResize($event, c.key)"
              @click.stop
            />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in sorted" :key="r.id" :class="{ 'is-picked': picked[r.id] }" @click="open(r.id)">
          <td class="c-pick" @click.stop>
            <button type="button" class="pick-one" :aria-pressed="picked[r.id] ? 'true' : 'false'" @click.stop="toggle(r.id)">
              {{ picked[r.id] ? '✓' : '' }}
            </button>
          </td>
          <td class="c-code"><button type="button" class="linklike mono">{{ r.code }}</button></td>
          <td class="c-structure">
            <img v-if="thumbUrl(r)" :src="thumbUrl(r)" alt="" loading="lazy" />
            <span v-else class="no-struct">—</span>
          </td>
          <td class="c-subject">
            <div class="sub-line">
              <span class="sub-name">{{ r.substrates || '—' }}</span>
              <span class="sub-arrow">→</span>
              <span class="prod-name">{{ r.product_name || '（未填产物）' }}</span>
            </div>
            <div v-if="r.title" class="sub-title">{{ r.title }}</div>
          </td>
          <td class="c-condition">{{ conditionText(r) || '—' }}</td>
          <td class="c-yield_pct is-right mono">
            <span v-if="r.yield_pct === null || r.yield_pct === undefined" class="muted">—</span>
            <span v-else>{{ r.yield_pct }}%</span>
          </td>
          <td class="c-ee is-right mono">
            <span :class="{ muted: !r.dr_ee && r.ee_pct == null }">{{ r.dr_ee || (r.ee_pct == null ? '—' : `${r.ee_pct}% ee`) }}</span>
          </td>
          <td class="c-date mono">{{ r.date }}</td>
        </tr>
      </tbody>
    </table>

    <div class="scope-foot">
      <span v-if="store.listTotal > rows.length">
        显示 {{ rows.length }} / 共 {{ store.listTotal }} 条
      </span>
      <span v-else>{{ stat.n }} 条</span>
      <span v-if="stat.y">· {{ stat.y }} 条有产率，平均 {{ Math.round(stat.avg * 10) / 10 }}%</span>
      <span v-if="stat.suspect" class="muted">· {{ stat.suspect }} 条产率不在 0–100% 内，没算进去</span>
      <span v-if="pickedCount">· 已勾选 {{ pickedCount }} 条</span>
      <span class="spacer" />
      <button class="btn btn-sm btn-ghost" :disabled="!sorted.length" @click="exportMd">
        <Icon name="download" :size="12" /> 导出表格
      </button>
      <button class="btn btn-sm btn-ghost" :disabled="!sorted.length" @click="exportCsv">
        <Icon name="download" :size="12" /> 导出 CSV
      </button>
    </div>
  </div>
  </div>
</template>
