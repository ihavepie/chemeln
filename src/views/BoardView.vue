<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ExpPick from '../components/ExpPick.vue';
import { api } from '../api.js';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { downloadBlob } from '../lib/print.js';
import {
  PAGE,
  MIN_W,
  BLOCKS,
  MM_PER_PX,
  mm,
  clamp,
  uid,
  itemHtml,
  boardHtml,
  BOARD_CSS,
  PRINT_CSS,
} from '../lib/board.js';

/**
 * 排版板：一张 A4 白纸，把记录里的东西（编号 / 反应式 / 条件 / 投料 / 结果 / 结论 / TLC / 文字）
 * 绝对定位摆上去，导出 PDF。
 *
 * 两件事是这套代码的命根子，改之前先想清楚：
 * ① **坐标用 0.1mm 整数**（见 lib/board.js），屏幕上靠 CSS `zoom` 把整张纸缩进可视区，
 *    纸里字号 / 间距全按 mm / pt 写 —— 屏幕和 PDF 才会一模一样。
 * ② **块的内容由 `itemHtml()` 统一生成**（屏幕用 v-html、PDF 拼进 boardHtml），
 *    别再给屏幕单独写一套渲染，否则两边一定漂。
 */
const route = useRoute();
const router = useRouter();

const board = ref(null);
const items = ref([]);
const sel = ref('');
const saving = ref(false);
const exporting = ref(false);
const exps = ref([]);
const tlcByExp = reactive({});
const expCache = reactive({});
const stageEl = ref(null);
const pageEl = ref(null);
const fitZoom = ref(0.5);
const pinned = ref(false); // 钉住 = 按真实大小看（100%），可以滚

const zoom = computed(() => (pinned.value ? 1 : fitZoom.value));
const pageSize = computed(() => PAGE[board.value?.page || 'a4p'] || PAGE.a4p);
const selItem = computed(() => items.value.find((it) => it.id === sel.value) || null);

/**
 * 屏幕上 1px 等于多少画布单位：1px = MM_PER_PX 毫米，1 单位 = 0.1mm，再除以 zoom。
 * **别写成 1/(MM_PER_PX*0.1*zoom)**——那是 37.8/zoom，比真值大 14 倍，拖一下整块就飞了（踩过）。
 */
const unitsPerPx = () => MM_PER_PX / 0.1 / zoom.value;
const nextZ = () => items.value.reduce((m, it) => Math.max(m, it.z || 0), 0) + 1;

/* ---------------- 读 / 存 ---------------- */

function groupTlc(list) {
  for (const k of Object.keys(tlcByExp)) delete tlcByExp[k];
  for (const t of list || []) (tlcByExp[t.exp_id] ||= []).push(t);
}

async function ensureExp(id) {
  if (!id || expCache[id]) return expCache[id];
  try {
    expCache[id] = await api.experiment(id);
  } catch {
    expCache[id] = null;
  }
  return expCache[id];
}

const expOf = (it) => (it && it.ref && it.type !== 'tlc' && it.type !== 'text' ? expCache[it.ref] : null);

async function load() {
  try {
    const b = (await api.board(route.params.id)).board;
    board.value = b;
    items.value = (b.items || []).map((it) => ({ ...it, z: it.z || 1 }));
    exps.value = (await api.experiments(b.project ? { project: b.project } : {})) || [];
    const t = await api.tlc(b.project || '');
    groupTlc(t.items);
    // 板上已有的块，得把记录读进来才画得出
    const need = [
      ...new Set(
        items.value.flatMap((it) =>
          it.block === 'compare' ? (it.refs || []) : it.type === 'block' || it.type === 'scheme' ? [it.ref] : []
        )
      ),
    ].filter(Boolean);
    await Promise.all(need.map(ensureExp));
  } catch (e) {
    toast(e.message || '读不到这张板', 'err');
    router.replace('/boards');
  }
}

let timer = null;
let dirty = false;
function touch() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(saveNow, 700);
}

async function saveNow(keepalive = false) {
  const b = board.value;
  if (!b) return;
  if (saving.value && !keepalive) return;
  if (!keepalive) saving.value = true;
  try {
    await api.saveBoard(
      b.id,
      { title: b.title, project: b.project, page: b.page, items: items.value },
      { keepalive }
    );
    dirty = false;
  } catch (e) {
    toast(e.message || '保存失败', 'err');
  } finally {
    saving.value = false;
  }
}

/**
 * 关窗口 / 切走时补一次：拖动、摆块之后 700ms 才存，页面这会儿被关掉就丢了
 * （`onBeforeUnmount` 只在路由切换时跑，关标签页不会）。keepalive 让请求照发。
 */
function flushNow() {
  if (!dirty || !board.value) return;
  void saveNow(true);
}

watch(items, touch, { deep: true });
watch(() => board.value && board.value.title, touch);

/* ---------------- 画布缩放 ---------------- */

function fit() {
  const el = stageEl.value;
  if (!el) return;
  const pxW = pageSize.value.w * 0.1 * (1 / MM_PER_PX);
  const pxH = pageSize.value.h * 0.1 * (1 / MM_PER_PX);
  const w = el.clientWidth - 16;
  const h = el.clientHeight - 16;
  if (w <= 0 || h <= 0) return;
  fitZoom.value = Math.min(w / pxW, h / pxH, 1);
}

let ro = null;

/* ---------------- 加素材 ---------------- */

/** 视图 px → 画布单位（跟 zoom 无关，按纸张实际渲染宽度算） */
function unitsPerPxView() {
  const r = pageEl.value && pageEl.value.getBoundingClientRect();
  return r && r.width ? pageSize.value.w / r.width : 1;
}

/** 现在所有块里最靠下的底边（单位：画布单位） */
function layoutBottom() {
  const k = unitsPerPxView();
  const els = [...document.querySelectorAll('.board-item')];
  let max = 80;
  els.forEach((el, i) => {
    const it = items.value[i];
    if (!it) return;
    max = Math.max(max, it.y + el.getBoundingClientRect().height * k);
  });
  return Math.round(max);
}

/**
 * 新素材落在「已经排到哪儿」的下面：`cursorY` 是渲染完量出来的最底边，
 * 但连点几下时 DOM 还没更新，所以先按 12mm 估一格往下挪，等渲染完再校准（syncCursor）。
 */
const cursorY = ref(100);
function nextPos(w) {
  const page = pageSize.value;
  let y = cursorY.value + 80;
  if (y > page.h - 200) y = 100;
  cursorY.value = y + 620; // 估一个（连点时来不及量），渲染完由 syncCursor 校准
  return { x: clamp(120, 0, Math.max(0, page.w - w)), y };
}

/** 量一遍真实最底边（单位和 zoom 无关），给下一块当落点 */
function syncCursor() {
  cursorY.value = layoutBottom();
}

function push(it) {
  items.value.push({ caption: '', ...it, z: nextZ() });
  sel.value = items.value[items.value.length - 1].id;
  return nextTick();
}

async function addTlc(e, t) {
  const w = 620;
  const { x, y } = nextPos(w);
  await push({ id: uid(), type: 'tlc', ref: t.id, code: e.code, x, y, w, caption: String(t.note || '').trim() });
  syncCursor();
}

async function addBlock(e, key) {
  const w = (BLOCKS.find((b) => b.key === key) || {}).w || 1300;
  const { x, y } = nextPos(w);
  await push({ id: uid(), type: 'block', block: key, ref: e.id, code: e.code, x, y, w });
  await ensureExp(e.id); // 数据到了再量高度，落点才准
  await nextTick();
  syncCursor();
}

/** 结论块：板上写「结论 / 推理」用，双击改文字 */
function addConcl() {
  const w = 1600;
  const { x, y } = nextPos(w);
  push({ id: uid(), type: 'block', block: 'concl', text: '双击写结论', x, y, w });
}

async function addText() {
  const w = 1200;
  const { x, y } = nextPos(w);
  await push({ id: uid(), type: 'text', text: '写点什么', x, y, w });
  syncCursor();
}

/* 多选：对比表 / 成组摆放都要从记录里挑几条 */
const cmpPick = ref(false);
const groupPick = ref(false);

const ctxOf = () => ({ get: (id) => expCache[id] });
const codeOf = (id) => (expCache[id] && expCache[id].code) || '';

/** 对比表：挑 2–8 条，排成一张「编号 / 改了什么 / TLC 判断 / 产率」的小表 */
async function onComparePicked(ids) {
  cmpPick.value = false;
  const refs = [...new Set((ids || []).map(Number).filter(Boolean))].slice(0, 8);
  if (refs.length < 2) return toast('至少挑两条', 'warn');
  await Promise.all(refs.map(ensureExp));
  const w = 1700;
  const { x, y } = nextPos(w);
  push({ id: uid(), type: 'block', block: 'compare', refs, x, y, w });
  await nextTick();
  syncCursor();
}

/** 成组摆放：一条记录一组「条件 + TLC 判断」，竖着排下来，正好当筛选总结 */
async function onGroupPicked(ids) {
  groupPick.value = false;
  const refs = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!refs.length) return;
  await Promise.all(refs.map(ensureExp));
  const w = 1500;
  const start = nextPos(w);
  let y = start.y;
  for (const id of refs) {
    const base = { x: start.x, w, ref: id, code: codeOf(id), caption: '' };
    push({ id: uid(), type: 'block', block: 'conds', y, ...base });
    push({ id: uid(), type: 'block', block: 'verdict', y: y + 90, ...base });
    y += 250;
  }
  await nextTick();
  syncCursor();
}

function chipsOf(e) {
  const out = [{ key: 'title', label: '编号' }];
  if (e.has_scheme) out.push({ key: 'react', label: '反应式' });
  out.push({ key: 'conds', label: '条件' }, { key: 'reagents', label: '投料' }, { key: 'result', label: '结果' });
  out.push({ key: 'verdict', label: 'TLC 判断' });
  out.push({ key: 'notes', label: '结论' });
  return out;
}

/* ---------------- 选中块的操作 ---------------- */

function removeItem(it) {
  items.value = items.value.filter((x) => x.id !== it.id);
  sel.value = '';
}

function raise(it, where) {
  const zs = items.value.map((x) => x.z || 0);
  it.z = where === 'top' ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
}

function center(it) {
  it.x = Math.round((pageSize.value.w - it.w) / 2);
}

function duplicate(it) {
  const copy = { ...it, id: uid(), x: it.x + 100, y: it.y + 100, z: nextZ() };
  items.value.push(copy);
  sel.value = copy.id;
}

async function editCaption(it) {
  if (it.type === 'text' || (it.block === 'concl')) {
    const v = await prompt({ title: '改文字', value: it.text, confirmText: '好' });
    if (v != null) it.text = v;
    return;
  }
  const v = await prompt({
    title: '图注',
    value: it.caption || '',
    placeholder: '图下面那行字，留空就不显示',
    confirmText: '好',
    allowEmpty: true,
  });
  if (v != null) it.caption = v;
}

/* ---------------- 拖 / 缩放（rAF + 直接改 transform，别每帧走响应式） ---------------- */

const drag = reactive({ on: false, mode: 'move', id: '', sx: 0, sy: 0, ox: 0, oy: 0, ow: 0, moved: false, nx: 0, ny: 0, nw: 0 });
/** 吸附时把那根参考线画出来（单位：画布单位；null = 不画） */
const guideAt = reactive({ x: null, y: null });
const SNAP = 45; // 4.5mm 内吸附到边 / 中线

let dragEl = null;
let raf = 0;
let pend = null;

/** 吸到「左 / 水平居中 / 右」里最近的那个；返回 [落点, 参考线要画在哪儿] */
function snapX(x, it) {
  const page = pageSize.value;
  const mid = Math.round(page.w / 2);
  const targets = [
    [0, 0],
    [Math.round((page.w - it.w) / 2), mid],
    [page.w - it.w, page.w],
  ];
  for (const [at, line] of targets) {
    if (Math.abs(x - at) <= SNAP) return { x: at, line };
  }
  return { x, line: null };
}

function startDrag(ev, it, mode) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  sel.value = it.id;
  // grip 的 mousedown 挂在 span 上，要往上找那块
  dragEl = ev.currentTarget?.closest?.('.board-item') || null;
  Object.assign(drag, { on: true, mode, id: it.id, sx: ev.clientX, sy: ev.clientY, ox: it.x, oy: it.y, ow: it.w, moved: false, nx: it.x, ny: it.y, nw: it.w });
  guideAt.x = null;
  guideAt.y = null;
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', endDrag);
}

function onMove(ev) {
  if (!drag.on) return;
  // 3px 死区：只是点一下别把块挪歪
  if (!drag.moved) {
    if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 3) return;
    drag.moved = true;
    if (dragEl) dragEl.style.willChange = drag.mode === 'size' ? 'width' : 'transform';
    document.body.classList.add('is-board-dragging');
  }
  pend = { x: ev.clientX, y: ev.clientY };
  if (!raf) raf = requestAnimationFrame(applyMove);
}

/** 一帧只写一次 DOM：拖的是 transform（合成层，不触发重排），松手才回写坐标 */
function applyMove() {
  raf = 0;
  if (!pend || !drag.on) return;
  const it = items.value.find((x) => x.id === drag.id);
  if (!it || !dragEl) return;
  const k = unitsPerPx();
  const dx = (pend.x - drag.sx) * k;
  const dy = (pend.y - drag.sy) * k;
  if (drag.mode === 'size') {
    drag.nw = Math.round(clamp(drag.ow + dx, MIN_W, pageSize.value.w - it.x));
    dragEl.style.width = mm(drag.nw);
    return;
  }
  const nx = Math.round(clamp(drag.ox + dx, 0, pageSize.value.w - it.w));
  const ny = Math.round(clamp(drag.oy + dy, 0, pageSize.value.h - 100));
  const sx = snapX(nx, it);
  drag.nx = sx.x;
  drag.ny = ny;
  guideAt.x = sx.line;
  dragEl.style.transform = `translate(${(sx.x - drag.ox) / 10}mm, ${(ny - drag.oy) / 10}mm)`;
}

function endDrag() {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  pend = null;
  const it = items.value.find((x) => x.id === drag.id);
  if (it && dragEl && drag.moved) {
    if (drag.mode === 'size') {
      it.w = drag.nw;
      dragEl.style.width = '';
    } else {
      // 先把新位置写进 inline style，再摘 transform：否则会有一帧闪回原位
      dragEl.style.left = mm(drag.nx);
      dragEl.style.top = mm(drag.ny);
      dragEl.style.transform = '';
      it.x = drag.nx;
      it.y = drag.ny;
    }
    dragEl.style.willChange = '';
  }
  drag.on = false;
  drag.moved = false;
  dragEl = null;
  guideAt.x = null;
  guideAt.y = null;
  document.body.classList.remove('is-board-dragging');
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', endDrag);
}

/* ---------------- 键盘 ---------------- */

function onKey(ev) {
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.target?.isContentEditable) return;
  if (ev.key === 'Escape') return (sel.value = '');
  const it = selItem.value;
  if (!it) return;
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'd' || ev.key === 'D')) {
    ev.preventDefault();
    return duplicate(it);
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    return removeItem(it);
  }
  const step = ev.shiftKey ? 100 : 10;
  const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (map[ev.key]) {
    ev.preventDefault();
    it.x = clamp(it.x + map[ev.key][0], 0, pageSize.value.w - it.w);
    it.y = clamp(it.y + map[ev.key][1], 0, pageSize.value.h - 100);
  }
}

/* ---------------- 页面 / 导出 / 删除 ---------------- */

function togglePage() {
  board.value.page = board.value.page === 'a4l' ? 'a4p' : 'a4l';
  touch();
  setTimeout(fit, 0);
}

async function exportPdf() {
  if (!items.value.length) return toast('画布还是空的', 'warn');
  exporting.value = true;
  try {
    const name = `${board.value.title || '排版板'}.pdf`;
    const html = boardHtml(items.value, pageSize.value, expOf, ctxOf());
    const blob = await api.printPdf({ pages: [html], css: PRINT_CSS, filename: name });
    downloadBlob(blob, name);
    toast('PDF 好了，一张 A4', 'ok');
  } catch (e) {
    toast(e.message || '导出失败', 'err');
  } finally {
    exporting.value = false;
  }
}

async function removeBoard() {
  const yes = await confirm({ title: '删掉这张排版板？', body: '只删板子，记录和附件都不动。', confirmText: '删掉', danger: true });
  if (!yes) return;
  try {
    await api.deleteBoard(board.value.id);
    toast('已删掉', 'ok');
    router.replace('/boards');
  } catch (e) {
    toast(e.message || '删不了', 'err');
  }
}

/* ---------------- 生命周期 ---------------- */

onMounted(async () => {
  // 画布里的块样式（.bd-*）跟导 PDF 用同一份，注入一次
  const st = document.createElement('style');
  st.id = 'board-page-css';
  st.textContent = BOARD_CSS;
  document.head.appendChild(st);

  await load();
  await new Promise((r) => requestAnimationFrame(r));
  fit();
  if (items.value.length) syncCursor();
  ro = new ResizeObserver(fit);
  if (stageEl.value) ro.observe(stageEl.value);
  window.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('beforeunload', flushNow);
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  if (dirty) void saveNow();
  if (ro) ro.disconnect();
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('pagehide', flushNow);
  window.removeEventListener('beforeunload', flushNow);
  endDrag();
  document.getElementById('board-page-css')?.remove();
});
</script>

<template>
  <div class="single board-single">
    <div class="inner board-inner">
      <header class="page-head board-head">
        <div class="board-head-main">
          <input v-if="board" v-model="board.title" class="board-title" spellcheck="false" title="改板名" />
          <p class="page-desc">
            左边点素材放上来 · 拖着摆位（靠边 / 居中有吸附） · 拖右下角改宽 · <b>双击改图注</b> · ⌘D 复制 · Delete 删
          </p>
        </div>
        <span class="spacer" />
        <span class="board-saved">{{ saving ? '保存中…' : '已保存' }}</span>
        <button class="btn btn-sm btn-ghost" @click="togglePage">{{ pageSize.label }}</button>
        <button class="btn btn-sm btn-ghost" @click="pinned = !pinned">{{ pinned ? '适应窗口' : '100%' }}</button>
        <button class="btn btn-sm" :disabled="exporting" @click="exportPdf">
          <Icon name="download" :size="12" /> 导出 PDF
        </button>
        <button class="btn btn-sm btn-ghost" @click="removeBoard">删除</button>
      </header>

      <div v-if="!board" class="cmp-empty">读取中…</div>
      <div v-else class="board-wrap">
        <!-- 素材抽屉：按记录分组，一条记录能放的块都在这儿 -->
        <aside class="board-drawer">
          <div class="board-drawer-h">整组</div>
          <div class="bd-rec-chips">
            <button class="bd-chip" title="挑几条记录排成一张对比表" @click="cmpPick = true">对比表…</button>
            <button class="bd-chip" title="挑几条记录，各生成「条件 + TLC 判断」并竖排" @click="groupPick = true">成组摆放…</button>
          </div>

          <div class="board-drawer-h">素材 · {{ exps.length }} 条记录</div>
          <div v-for="e in exps" :key="e.id" class="bd-rec">
            <div class="bd-rec-head">
              <span class="mono">{{ e.code }}</span>
              <span class="bd-rec-title">{{ e.title || e.objective || '' }}</span>
            </div>
            <div class="bd-rec-chips">
              <button v-for="c in chipsOf(e)" :key="c.key" class="bd-chip" @click="addBlock(e, c.key)">{{ c.label }}</button>
            </div>
            <div v-if="(tlcByExp[e.id] || []).length" class="bd-rec-tlc">
              <button
                v-for="t in tlcByExp[e.id]"
                :key="t.id"
                class="bd-thumb"
                :title="`${e.code} · TLC`"
                @click="addTlc(e, t)"
              >
                <img :src="`/api/files/${t.id}`" alt="" loading="lazy" />
              </button>
            </div>
          </div>
          <div v-if="!exps.length" class="board-drawer-empty">这个课题还没有实验记录</div>
          <div class="bd-rec-chips board-addrow">
            <button class="btn btn-sm btn-ghost" @click="addText"><Icon name="plus" :size="12" /> 文字</button>
            <button class="btn btn-sm btn-ghost" @click="addConcl"><Icon name="plus" :size="12" /> 结论</button>
          </div>
        </aside>

        <!-- 画布：一张 A4，靠 zoom 缩进可视区，纸里全是 mm 单位 -->
        <div ref="stageEl" class="board-stage" :class="{ 'is-pinned': pinned }" @mousedown.self="sel = ''">
          <div ref="pageEl" class="bd-page board-page" :style="{ width: mm(pageSize.w), height: mm(pageSize.h), zoom }" @mousedown.self="sel = ''">
            <div
              v-for="it in items"
              :key="it.id"
              class="bd-item board-item"
              :data-id="it.id"
              :class="{ 'is-sel': sel === it.id }"
              :style="{ left: mm(it.x), top: mm(it.y), width: mm(it.w), zIndex: it.z || 1 }"
              @mousedown="startDrag($event, it, 'move')"
              @dblclick="editCaption(it)"
            >
              <div class="bd-body" v-html="itemHtml(it, expOf(it), ctxOf())" />
              <span v-if="sel === it.id" class="board-grip" title="拖动改宽度" @mousedown.stop="startDrag($event, it, 'size')" />
            </div>
            <div v-if="guideAt.x != null" class="board-guide is-v" :style="{ left: mm(guideAt.x) }" />
            <div v-if="!items.length" class="board-empty">从左边点一个块放上来</div>
          </div>
        </div>
      </div>

      <!-- 工具条占位固定：选中/取消时版面不动，纸张不会因为多出一行而重新缩放 -->
      <div class="board-tools-bar">
        <div v-if="selItem" class="board-tools">
        <span class="board-tools-name">
          {{ selItem.type === 'tlc' ? selItem.code || 'TLC'
            : selItem.type === 'text' ? '文字'
            : (BLOCKS.find((b) => b.key === (selItem.block || 'react')) || {}).label || '块' }}
        </span>
        <button class="board-tool" @click="editCaption(selItem)">{{ selItem.type === 'text' ? '改文字' : '图注' }}</button>
        <button class="board-tool" @click="raise(selItem, 'top')">置顶</button>
        <button class="board-tool" @click="raise(selItem, 'bottom')">置底</button>
        <button class="board-tool" @click="center(selItem)">居中</button>
        <button class="board-tool" @click="duplicate(selItem)">复制</button>
          <button class="board-tool is-danger" @click="removeItem(selItem)">删除</button>
        </div>
      </div>
    </div>

    <ExpPick
      :model-value="cmpPick"
      title="哪几条排进对比表？"
      confirm-text="生成对比表"
      @close="cmpPick = false"
      @confirm="onComparePicked"
    />
    <ExpPick
      :model-value="groupPick"
      title="哪几条各生成「条件 + TLC 判断」？"
      confirm-text="竖排摆好"
      @close="groupPick = false"
      @confirm="onGroupPicked"
    />
  </div>
</template>
