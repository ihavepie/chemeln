<script setup>
import { computed, reactive, ref } from 'vue';
import AppModal from './AppModal.vue';
import Icon from './Icon.vue';
import { api } from '../api.js';
import { toast } from '../lib/feedback.js';
import { labelMarkup, labelMarkupMini } from '../lib/label.js';
import { collectCss, downloadBlob } from '../lib/print.js';

/**
 * 批量打印化合物标签：自己排 A4（不用系统打印，那边没法排版）。
 * 标签沿用单张那套 100×46mm 的版式，靠整体缩放塞进不同大小的格子。
 */
const props = defineProps({
  compounds: { type: Array, default: () => [] },
  owner: { type: String, default: '' },
});
const emit = defineEmits(['close']);

// 小号是面积的 1/4（边长一半）：48×22 → 24×11mm，改用迷你版式（只放二维码/编号/名称）
// 小号 = 原来的 1/4 面积（边长一半）50×23mm，还是完整版式，带结构式；
// 迷你 24×11mm 是精简版（二维码 + 编号 + 名称），放不下结构式但一版能排几百张
const LAYOUTS = [
  { key: 'big', label: '大', cols: 2, rows: 6, scale: 1, w: 100, h: 46, per: 12 },
  { key: 'mid', label: '中', cols: 3, rows: 9, scale: 0.65, w: 65, h: 29.9, per: 27 },
  { key: 'small', label: '小', cols: 4, rows: 12, scale: 0.5, w: 50, h: 23, per: 48 },
  { key: 'mini', label: '迷你', cols: 5, rows: 19, scale: 1, w: 34, h: 14, per: 95, mini: true },
];
const opts = reactive({ layout: 'mid' });
const layout = computed(() => LAYOUTS.find((l) => l.key === opts.layout) || LAYOUTS[1]);

const picked = ref(new Set(props.compounds.map((c) => c.id)));
const allPicked = computed(() => props.compounds.length > 0 && picked.value.size === props.compounds.length);
const chosen = computed(() => props.compounds.filter((c) => picked.value.has(c.id)));
const pageCount = computed(() => Math.max(1, Math.ceil(chosen.value.length / layout.value.per)));

function toggle(id) {
  const s = new Set(picked.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  picked.value = s;
}

function toggleAll() {
  picked.value = allPicked.value ? new Set() : new Set(props.compounds.map((c) => c.id));
}

const making = ref(false);

/** 拼一页：pdf-page 里按列数摆格子，每个格子里一张缩放后的标签 */
function pageHtml(list, l) {
  const cells = list
    .map((c) => {
      const inner = l.mini ? labelMarkupMini(c) : labelMarkup(c, { owner: props.owner });
      return `<div class="label-cell" style="width:${l.w}mm;height:${l.h}mm">
        <div class="label-scale" style="transform:scale(${l.scale})">${inner}</div>
      </div>`;
    })
    .join('');
  return `<div class="pdf-page label-page">${cells}</div>`;
}

function buildPages() {
  const l = layout.value;
  const per = l.cols * l.rows;
  const pages = [];
  for (let i = 0; i < chosen.value.length; i += per) {
    pages.push(pageHtml(chosen.value.slice(i, i + per), l));
  }
  return pages;
}

const labelCss = () =>
  [
    ...collectCss(),
    // 标签页自己的一套：4mm 边距、格子左上对齐、1mm 间隙
    // 整版靠右对齐：满行照常，最后那行不满也贴右
    '.pdf-page.label-page { padding: 3mm; display: flex; flex-wrap: wrap; gap: 1mm; align-content: flex-start; justify-content: flex-end; }',
    '.label-cell { overflow: hidden; flex: none; }',
    '.label-scale { transform-origin: top left; }',
    '.label-scale .label { margin: 0 !important; }',
  ].join('\n');

async function make() {
  if (!chosen.value.length) {
    toast('先选几个化合物', 'err');
    return;
  }
  making.value = true;
  try {
    const pages = buildPages();
    const blob = await api.printPdf({
      pages,
      css: labelCss(),
      filename: `化合物标签-${chosen.value.length}张.pdf`,
    });
    downloadBlob(blob, `化合物标签-${chosen.value.length}张.pdf`);
    toast(`排好了：${chosen.value.length} 张 / ${pageCount.value} 页`);
    emit('close');
  } catch (e) {
    toast(e.message || '生成 PDF 失败', 'err');
  } finally {
    making.value = false;
  }
}
</script>

<template>
  <AppModal
    title="批量打印标签"
    width="560px"
    confirm-text="生成 PDF"
    :show-confirm="false"
    @close="emit('close')"
  >
    <p class="hint">按 A4 排布后下载，可直接用不干胶标签纸整版打印；纵向粘贴时自左上起排。</p>

    <div class="pp-row">
      <span class="pp-label">排版</span>
      <div class="pp-chips">
        <button
          v-for="l in LAYOUTS"
          :key="l.key"
          type="button"
          class="fchip"
          :aria-pressed="opts.layout === l.key ? 'true' : 'false'"
          @click="opts.layout = l.key"
        >
          {{ l.label }} {{ l.w }}×{{ l.h }}mm
        </button>
      </div>
      <span class="hint">{{ layout.per }} 张/页</span>
    </div>

    <div class="lb-head">
      <span>选中 {{ chosen.length }} / {{ compounds.length }} 个</span>
      <span class="spacer" />
      <button class="btn btn-sm btn-ghost" @click="toggleAll">{{ allPicked ? '全不选' : '全选' }}</button>
    </div>

    <div class="lb-list">
      <label v-for="c in compounds" :key="c.id" class="lb-item">
        <input type="checkbox" :checked="picked.has(c.id)" @change="toggle(c.id)" />
        <span class="mono lb-code">{{ c.code || '—' }}</span>
        <span class="lb-name">{{ c.name || '（未命名）' }}</span>
        <span class="hint mono">{{ c.formula || '' }}</span>
      </label>
      <div v-if="!compounds.length" class="hint">当前列表里没有化合物。</div>
    </div>

    <div class="row mt16">
      <button class="btn btn-primary" :disabled="making || !chosen.length" @click="make">
        <Icon name="download" :size="13" /> {{ making ? '正在生成…' : `生成 PDF（${pageCount} 页）` }}
      </button>
      <span class="hint">不弹浏览器对话框</span>
    </div>
  </AppModal>
</template>
