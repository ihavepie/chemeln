<script setup>
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';
import { store } from '../store.js';
import { round } from '../lib/reagent.js';
import { downloadBlob } from '../lib/print.js';
import { toast } from '../lib/feedback.js';
import { useColResize } from '../lib/colresize.js';

/**
 * 化合物库的表格视图（卡片墙的另一种看法）：一行 = 一个化合物。
 * 数据就是 store.compounds——中栏列表搜什么、筛什么，这张表跟着变。
 */
const router = useRouter();

const picked = reactive({});
const rows = computed(() => store.compounds);
const pickedRows = computed(() => rows.value.filter((x) => picked[x.id]));
const pickedCount = computed(() => pickedRows.value.length);

const sortKey = ref('code');
const sortDir = ref('asc');

const COLS = [
  { key: 'structure', label: '结构', nosort: true },
  { key: 'code', label: '编号' },
  { key: 'name', label: '名称' },
  { key: 'kind', label: '类型' },
  { key: 'formula', label: '分子式' },
  { key: 'mw', label: 'MW', align: 'right' },
  { key: 'tlc_rf', label: 'Rf', align: 'right' },
  { key: 'category_name', label: '分类' },
  { key: 'used_count', label: '引用', align: 'right' },
];

/* 表头拖拽改列宽：弹性列是「名称」那列；宽度按表存浏览器 */
const COLDEFS = [
  { key: 'pick', w: 30 },
  { key: 'structure', w: 76 },
  { key: 'code', w: 80 },
  { key: 'name', w: 300 },
  { key: 'kind', w: 62 },
  { key: 'formula', w: 96 },
  { key: 'mw', w: 72 },
  { key: 'tlc_rf', w: 52 },
  { key: 'category_name', w: 90 },
  { key: 'used_count', w: 54 },
];
const { tableEl, start: startResize, colStyle } = useColResize(
  'cmp',
  Object.fromEntries(COLDEFS.map((c) => [c.key, c.w]))
);

const sorted = computed(() => {
  const key = sortKey.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const val = (c) => {
    if (key === 'mw') return c.mw === null || c.mw === undefined ? null : Number(c.mw);
    if (key === 'tlc_rf') return c.tlc_rf === null || c.tlc_rf === undefined || c.tlc_rf === '' ? null : Number(c.tlc_rf);
    if (key === 'used_count') return Number(c.used_count) || 0;
    return c[key] ?? '';
  };
  return [...rows.value].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    // 空值永远沉底；编号/分子式这类字母数字混排按自然顺序
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y), 'zh', { numeric: true }) * dir;
  });
});

function setSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
    return;
  }
  sortKey.value = key;
  sortDir.value = key === 'mw' || key === 'used_count' ? 'desc' : 'asc';
}

const allPicked = computed(() => sorted.value.length > 0 && sorted.value.every((x) => picked[x.id]));

function toggleAll() {
  const on = !allPicked.value;
  for (const c of sorted.value) {
    if (on) picked[c.id] = true;
    else delete picked[c.id];
  }
}

function toggle(id) {
  if (picked[id]) delete picked[id];
  else picked[id] = true;
}

const open = (id) => router.push(`/c/${id}`);
const thumbUrl = (c) => (c.structure_id ? `/api/compound-files/${c.structure_id}` : '');
const mwText = (c) => (c.mw ? round(c.mw, 2) : '—');

/* ------------------------------------------------------------ 导出 */
const exportRows = computed(() => (pickedCount.value ? pickedRows.value : sorted.value));

const csvCell = (v) => {
  const s = String(v ?? '');
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
  const origin = window.location.origin;
  const head = ['编号', '名称', '类型', '分子式', 'MW', 'Rf', '分类', '引用次数', '结构图URL', '记录链接'];
  const body = list.map((c) =>
    [
      c.code,
      c.name,
      c.kind,
      c.formula,
      c.mw ?? '',
      c.tlc_rf ?? '',
      c.category_name,
      c.used_count ?? 0,
      c.structure_id ? `${origin}/api/compound-files/${c.structure_id}` : '',
      `${origin}/#/c/${c.id}`,
    ]
      .map(csvCell)
      .join(',')
  );
  const csv = `\uFEFF${[head.map(csvCell).join(','), ...body].join('\r\n')}\r\n`;
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `化合物库-${store.project || '全部'}-${stamp()}.csv`);
  toast(`导出了 ${list.length} 个`);
}

function exportMd() {
  const list = exportRows.value;
  if (!list.length) return toast('没有可以导出的行', 'err');
  const body = list.map((c) => {
    const cells = [c.code || '', c.name || '', c.kind || '', c.formula || '', mwText(c) === '—' ? '' : mwText(c), c.tlc_rf || '']
      .map((v) => String(v).replace(/\|/g, '\\|'));
    return `| ${cells.join(' | ')} |`;
  });
  const md = ['| 编号 | 名称 | 类型 | 分子式 | MW | Rf |', '|---|---|---|---|---:|---:|', ...body].join('\n');
  const title = `## 化合物库${store.project ? `（${store.project}）` : ''}\n\n`;
  downloadBlob(new Blob([`${title}${md}\n`], { type: 'text/markdown;charset=utf-8' }), `化合物库-${store.project || '全部'}-${stamp()}.md`);
  toast(`导出了 ${list.length} 个`);
}
</script>

<template>
  <div class="table-page">
  <div v-if="!rows.length" class="scope-empty">
    {{
      store.compoundFilters.q || store.compoundFilters.kind || store.compoundFilters.category
        ? '无匹配化合物。'
        : '暂无化合物。点右上角「新建化合物」，或在实验页把产物存入化合物库。'
    }}
  </div>
  <div v-else class="scope-wrap">
    <table ref="tableEl" class="scope-table cmp-table">
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
        <tr v-for="c in sorted" :key="c.id" :class="{ 'is-picked': picked[c.id] }" @click="open(c.id)">
          <td class="c-pick" @click.stop>
            <button type="button" class="pick-one" :aria-pressed="picked[c.id] ? 'true' : 'false'" @click.stop="toggle(c.id)">
              {{ picked[c.id] ? '✓' : '' }}
            </button>
          </td>
          <td class="c-structure">
            <img v-if="thumbUrl(c)" :src="thumbUrl(c)" alt="" loading="lazy" />
            <span v-else class="no-struct">—</span>
          </td>
          <td class="c-code"><button type="button" class="linklike mono">{{ c.code || '—' }}</button></td>
          <td class="c-name">
            <div class="sub-line"><span class="sub-name">{{ c.name || '（未命名）' }}</span></div>
            <div v-if="c.standard_code" class="sub-title">标准实验 {{ c.standard_code }}</div>
          </td>
          <td class="c-kind">{{ c.kind || '—' }}</td>
          <td class="c-formula mono">{{ c.formula || '—' }}</td>
          <td class="c-mw is-right mono">{{ mwText(c) }}</td>
          <td class="c-tlc_rf is-right mono">{{ c.tlc_rf || '—' }}</td>
          <td class="c-category_name">{{ c.category_name || '未分类' }}</td>
          <td class="c-used_count is-right mono">{{ c.used_count || 0 }}</td>
        </tr>
      </tbody>
    </table>

    <div class="scope-foot">
      <span v-if="store.compoundTotal > rows.length">
        显示 {{ rows.length }} / 共 {{ store.compoundTotal }} 个
      </span>
      <span v-else>{{ rows.length }} 个</span>
      <span v-if="pickedCount">· 已勾选 {{ pickedCount }} 个</span>
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
