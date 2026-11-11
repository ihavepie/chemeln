<script setup>
import { computed, reactive, ref } from 'vue';
import AppModal from './AppModal.vue';
import Icon from './Icon.vue';
import { api } from '../api.js';
import { confirm, toast } from '../lib/feedback.js';
import { A4_CSS, collectCss, downloadBlob } from '../lib/print.js';
import { flattenTextareas } from '../lib/autogrow.js';

/**
 * 打印面板：打印前先看一眼真样子的两页 A4，并决定这次打什么。
 *
 * 预览不是"屏幕版式的缩小版"，而是直接用 iframe 渲染**打印版式**——
 * 和生成 PDF 用的是同一份 HTML/CSS、同一个引擎，所以所见即所得
 * （纸面字号比编辑时小一档、按 A4 边距排，这是本来就有的版式差异）。
 */
const props = defineProps({
  title: { type: String, default: '打印' },
  /** 存成 PDF 时的文件名，比如 EXP-0046.pdf */
  filename: { type: String, default: '记录.pdf' },
  /** 第 3 页（文献）有没有内容：没有就不出现在预览和 PDF 里 */
  lit: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'print']);

const opts = reactive({ pages: 'both', attachments: true, header: true, mono: false });

const PAGE_CHOICES = computed(() => [
  { key: 'both', label: props.lit ? '全部页' : '两页' },
  { key: 'p1', label: '只第 1 页' },
  { key: 'p2', label: '只第 2 页' },
  ...(props.lit ? [{ key: 'lit', label: '只文献页' }] : []),
]);

/** 输入框/文本域 clone 只带 attribute，得把当前值搬过去（Vue 改的是 property） */
function syncFields(from, to) {
  const a = from.querySelectorAll('input, textarea, select');
  const b = to.querySelectorAll('input, textarea, select');
  a.forEach((el, i) => {
    const c = b[i];
    if (!c) return;
    if (c.tagName === 'SELECT') c.value = el.value;
    else if (c.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) c.checked = el.checked;
    else if (c.tagName === 'INPUT') {
      c.value = el.value;
      c.setAttribute('value', el.value);
    } else {
      c.value = el.value;
      c.textContent = el.value;
    }
  });
}

function exportCss() {
  return [...collectCss(), ...A4_CSS, opts.mono ? '.pdf-page img { filter: grayscale(1); }' : ''].filter(Boolean).join('\n');
}

/** 要打哪几页（'p1' / 'p2' / 两页），预览、计量、导出共用一处判断 */
const pickIdx = computed(() => {
  if (opts.pages === 'p1') return [0];
  if (opts.pages === 'p2') return [1];
  if (opts.pages === 'lit') return [2];
  return props.lit ? [0, 1, 2] : [0, 1];
});

/** 按选项挑出要打的那几页，克隆成独立 HTML 片段（克隆里没有 .editor 祖先，print 规则照常命中） */
function buildPages() {
  const sheets = [...document.querySelectorAll('.editor .sheet:not(.sheet-att)')];
  const out = [];
  for (const i of pickIdx.value) {
    const sheet = sheets[i];
    if (!sheet) continue;
    const clone = sheet.cloneNode(true);
    clone.classList.remove('is-hidden');
    clone.removeAttribute('style');
    syncFields(sheet, clone);
    if (!opts.attachments) clone.querySelectorAll('.sec-att, .tlc-strip').forEach((el) => el.remove());
    if (!opts.header) clone.querySelectorAll('.sheet-runner').forEach((el) => el.remove());
    // 文本域换成 div：否则长表征只印得出文本域自己那几行高
    flattenTextareas(clone);
    out.push(`<div class="pdf-page">${clone.outerHTML}</div>`);
  }
  return out;
}

/** 这一页有没有比 A4 还长（PDF 是按 A4 一页页出的，超出 = 被裁掉） */
const overflow = ref([false, false, false]);
const overflowing = computed(() => pickIdx.value.some((i) => overflow.value[i]));

/** 预览 iframe 和 PDF 是同一份 HTML/CSS，所以在 iframe 里量出来的就是最终结果 */
function measurePage(i, ev) {
  const doc = ev?.target?.contentDocument;
  const read = () => {
    const page = doc?.querySelector?.('.pdf-page');
    overflow.value[i] = !!page && page.scrollHeight > page.clientHeight + 2;
  };
  read();
  // 谱图 / 结构图是稍后才加载的，图一进来页面就更高了，过一会儿再量一次
  setTimeout(read, 700);
}

/** 完整文档：预览 iframe 和 PDF 共用这一份 */
const pageDocs = computed(() => {
  const css = exportCss();
  return buildPages().map(
    (frag) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${frag}</body></html>`
  );
});

const making = ref(false);

async function makePdf() {
  if (making.value) return;
  if (overflowing.value) {
    // 宁可多问一句，也别让人以为存下来的 PDF 是完整的
    const go = await confirm({
      title: '本页超出 A4',
      body: 'PDF 按 A4 逐页输出，超出部分将被截断。若需完整内容，请用「打印」（系统打印，自动分页）。仍要生成 PDF 吗？',
      confirmText: '仍然出 PDF',
      cancelText: '改用打印',
      danger: true,
    });
    if (!go) return;
  }
  const pages = buildPages();
  if (!pages.length) {
    toast('没有可取的内容', 'err');
    return;
  }
  making.value = true;
  try {
    const blob = await api.printPdf({ pages, css: exportCss(), filename: props.filename });
    downloadBlob(blob, props.filename);
    toast('PDF 生成好了，已经下载');
    emit('close');
  } catch (e) {
    toast(e.message || '生成 PDF 失败', 'err');
  } finally {
    making.value = false;
  }
}

const print = () => emit('print', { ...opts });
</script>

<template>
  <AppModal :title="props.title" width="680px" confirm-text="打印" @close="emit('close')" @confirm="print">
    <div class="pp-previews">
      <div
        class="pp-thumb"
        :class="{ 'is-off': pageDocs[0] && opts.pages === 'p2' }"
        @click="opts.pages = opts.pages === 'p1' ? 'both' : 'p1'"
      >
        <div class="pp-thumb-inner">
          <iframe
            v-if="pageDocs[0]"
            class="pp-frame"
            :srcdoc="pageDocs[0]"
            tabindex="-1"
            title="第 1 页预览"
            @load="measurePage(0, $event)"
          />
        </div>
        <div class="pp-cap">第 1 页 · 主记录</div>
      </div>
      <div
        class="pp-thumb"
        :class="{ 'is-off': pageDocs[1] && opts.pages === 'p1' }"
        @click="opts.pages = opts.pages === 'p2' ? 'both' : 'p2'"
      >
        <div class="pp-thumb-inner">
          <iframe
            v-if="pageDocs[1]"
            class="pp-frame"
            :srcdoc="pageDocs[1]"
            tabindex="-1"
            title="第 2 页预览"
            @load="measurePage(1, $event)"
          />
        </div>
        <div class="pp-cap">第 2 页 · 续页</div>
      </div>
      <div
        v-if="props.lit"
        class="pp-thumb"
        :class="{ 'is-off': pageDocs[2] && (opts.pages === 'p1' || opts.pages === 'p2') }"
        @click="opts.pages = opts.pages === 'lit' ? 'both' : 'lit'"
      >
        <div class="pp-thumb-inner">
          <iframe
            v-if="pageDocs[2]"
            class="pp-frame"
            :srcdoc="pageDocs[2]"
            tabindex="-1"
            title="第 3 页预览"
            @load="measurePage(2, $event)"
          />
        </div>
        <div class="pp-cap">第 3 页 · 文献</div>
      </div>
    </div>

    <div class="pp-row">
      <span class="pp-label">打印范围</span>
      <div class="pp-chips">
        <button
          v-for="c in PAGE_CHOICES"
          :key="c.key"
          type="button"
          class="fchip"
          :aria-pressed="opts.pages === c.key ? 'true' : 'false'"
          @click="opts.pages = c.key"
        >
          {{ c.label }}
        </button>
      </div>
    </div>

    <div class="switch-row mt12">
      <button type="button" class="switch" :aria-checked="opts.attachments" @click="opts.attachments = !opts.attachments">
        <span class="switch-knob" />
      </button>
      <div class="switch-text"><div class="switch-label">带谱图与附件</div></div>
    </div>
    <div class="switch-row mt8">
      <button type="button" class="switch" :aria-checked="opts.header" @click="opts.header = !opts.header">
        <span class="switch-knob" />
      </button>
      <div class="switch-text"><div class="switch-label">带页眉（标题 · 编号）</div></div>
    </div>
    <div class="switch-row mt8">
      <button type="button" class="switch" :aria-checked="opts.mono" @click="opts.mono = !opts.mono">
        <span class="switch-knob" />
      </button>
      <div class="switch-text">
        <div class="switch-label">图片按黑白打印</div>
        <p class="hint">谱图本身为黑白，此项仅作用于彩色反应式与 TLC 照片</p>
      </div>
    </div>

    <p v-if="overflowing" class="hint pp-warn">
      本页内容超出 A4，存成 PDF 时将被截断；请用「打印」（系统打印，可自动分页）。
    </p>

    <div class="row mt16">
      <button class="btn" :disabled="making" @click="makePdf">
        <Icon name="download" :size="13" /> {{ making ? '正在生成…' : overflowing ? '存成 PDF（会缺内容）' : '存成 PDF' }}
      </button>
      <span class="hint">在本地渲染为 A4 PDF 并直接下载，不经过系统打印对话框</span>
    </div>

    <p class="hint mt12">
      <Icon name="print" :size="12" /> 预览即打印与 PDF 的实际版式（字号小于编辑界面，按 A4 边距排版）。
      点右下角「打印」进入系统对话框，纸张、份数与双面在此设置。
    </p>
  </AppModal>
</template>
