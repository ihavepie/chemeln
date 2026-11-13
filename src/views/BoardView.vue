<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { store, loadList } from '../store.js';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { downloadBlob } from '../lib/print.js';
import { PAGE, MIN_W, clamp, nextPos, pct, uid, srcOf, boardHtml, BOARD_CSS } from '../lib/board.js';

/**
 * 排版板：一张 A4 的白纸，素材绝对定位摆上去。
 * 坐标用 0.1mm 的整数（见 lib/board.js），屏幕按百分比显示——换窗口大小、拖内容区宽度，版面都不变。
 * 拖 / 缩放全走 mouse 事件（Safari 里 HTML5 拖放不可靠，项目里一直这么干）。
 */
const route = useRoute();
const router = useRouter();

const board = ref(null);
const items = ref([]);
const sel = ref('');
const saving = ref(false);
const exporting = ref(false);
const tlcList = ref([]);
const pageEl = ref(null);
const scale = ref(1); // 画布单位 → 屏幕像素

const pageSize = computed(() => PAGE[board.value?.page || 'a4p'] || PAGE.a4p);
const selItem = computed(() => items.value.find((it) => it.id === sel.value) || null);
const schemes = computed(() => (store.items || []).filter((e) => e.has_scheme).slice(0, 60));

/* ---------------- 读 / 存 ---------------- */

async function load() {
  try {
    const r = await api.board(route.params.id);
    board.value = r.board;
    items.value = r.board.items || [];
    const t = await api.tlc(r.board.project || '');
    tlcList.value = t.items || [];
    await loadList();
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
  timer = setTimeout(saveNow, 800);
}

async function saveNow() {
  const b = board.value;
  if (!b || saving.value) return;
  saving.value = true;
  try {
    await api.saveBoard(b.id, { title: b.title, project: b.project, page: b.page, items: items.value });
    dirty = false;
  } catch (e) {
    toast(e.message || '保存失败', 'err');
  } finally {
    saving.value = false;
  }
}

watch(items, touch, { deep: true });
watch(() => board.value && board.value.title, touch);

/* ---------------- 画布缩放（百分比坐标 + 一个字号系数） ---------------- */

let ro = null;
function measure() {
  const el = pageEl.value;
  if (!el) return;
  const w = el.getBoundingClientRect().width;
  if (w > 0) scale.value = w / pageSize.value.w;
}

/* ---------------- 素材 ---------------- */

function addTlc(t) {
  const w = 620;
  const { x, y } = nextPos(items.value, w, pageSize.value);
  items.value.push({
    id: uid(),
    type: 'tlc',
    ref: t.id,
    code: t.exp_code,
    x,
    y,
    w,
    caption: String(t.note || '').trim(),
    z: items.value.length + 1,
  });
  sel.value = items.value[items.value.length - 1].id;
  setTimeout(measure, 0);
}

function addScheme(e) {
  const w = 1300;
  const { x, y } = nextPos(items.value, w, pageSize.value);
  items.value.push({ id: uid(), type: 'scheme', ref: e.id, code: e.code, x, y, w, caption: '', z: items.value.length + 1 });
  sel.value = items.value[items.value.length - 1].id;
}

function addText() {
  const w = 1200;
  const { x, y } = nextPos(items.value, w, pageSize.value);
  items.value.push({ id: uid(), type: 'text', text: '写点什么', x, y, w, z: items.value.length + 1 });
  sel.value = items.value[items.value.length - 1].id;
}

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

async function editCaption(it) {
  if (it.type === 'text') {
    const v = await prompt({ title: '改文字', value: it.text, confirmText: '好' });
    if (v != null) it.text = v;
    return;
  }
  const v = await prompt({ title: '图注', value: it.caption || '', placeholder: '图下面那行字，留空就不显示', confirmText: '好', allowEmpty: true });
  if (v != null) it.caption = v;
}

/* ---------------- 拖 / 缩放 ---------------- */

const drag = reactive({ on: false, mode: 'move', id: '', sx: 0, sy: 0, ox: 0, oy: 0, ow: 0 });

function startDrag(ev, it, mode) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  sel.value = it.id;
  Object.assign(drag, { on: true, mode, id: it.id, sx: ev.clientX, sy: ev.clientY, ox: it.x, oy: it.y, ow: it.w });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', endDrag);
}

function onMove(ev) {
  if (!drag.on) return;
  const it = items.value.find((x) => x.id === drag.id);
  if (!it) return;
  const k = scale.value > 0 ? 1 / scale.value : 1; // 屏幕像素 → 画布单位
  const dx = (ev.clientX - drag.sx) * k;
  const dy = (ev.clientY - drag.sy) * k;
  if (drag.mode === 'size') {
    it.w = Math.round(clamp(drag.ow + dx, MIN_W, pageSize.value.w - it.x));
  } else {
    it.x = Math.round(clamp(drag.ox + dx, 0, pageSize.value.w - MIN_W));
    it.y = Math.round(clamp(drag.oy + dy, 0, pageSize.value.h - 200));
  }
}

function endDrag() {
  drag.on = false;
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', endDrag);
}

/* ---------------- 键盘 ---------------- */

function onKey(ev) {
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.target?.isContentEditable) return;
  const it = selItem.value;
  if (ev.key === 'Escape') {
    sel.value = '';
    return;
  }
  if (!it) return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    removeItem(it);
    return;
  }
  const step = ev.shiftKey ? 100 : 10; // 1mm / 10mm
  const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (map[ev.key]) {
    ev.preventDefault();
    it.x = clamp(it.x + map[ev.key][0], 0, pageSize.value.w - MIN_W);
    it.y = clamp(it.y + map[ev.key][1], 0, pageSize.value.h - 200);
  }
}

/* ---------------- 导出 / 删除 ---------------- */

async function exportPdf() {
  if (!items.value.length) return toast('画布还是空的', 'warn');
  exporting.value = true;
  try {
    const name = `${board.value.title || '排版板'}.pdf`;
    const blob = await api.printPdf({ pages: [boardHtml(items.value, pageSize.value)], css: BOARD_CSS, filename: name });
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
  await load();
  await new Promise((r) => requestAnimationFrame(r));
  measure();
  ro = new ResizeObserver(measure);
  if (pageEl.value) ro.observe(pageEl.value);
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  if (dirty) void saveNow();
  if (ro) ro.disconnect();
  window.removeEventListener('keydown', onKey);
  endDrag();
});
</script>

<template>
  <div class="single board-single">
    <div class="inner board-inner">
      <header class="page-head board-head">
        <div class="board-head-main">
          <input
            v-if="board"
            v-model="board.title"
            class="board-title"
            spellcheck="false"
            title="改板名"
          />
          <p class="page-desc">
            点左边素材加进来 · 拖着摆位 · 拖右下角改大小 · <b>双击改图注</b> · Delete 删掉 · 方向键微调
          </p>
        </div>
        <span class="spacer" />
        <span class="board-saved">{{ saving ? '保存中…' : '已保存' }}</span>
        <button class="btn btn-sm" :disabled="exporting" @click="exportPdf">
          <Icon name="download" :size="12" /> 导出 PDF
        </button>
        <button class="btn btn-sm btn-ghost" @click="removeBoard">删除</button>
      </header>

      <div v-if="!board" class="cmp-empty">读取中…</div>
      <div v-else class="board-wrap">
        <!-- 素材抽屉 -->
        <aside class="board-drawer">
          <div class="board-drawer-h">TLC</div>
          <div v-if="tlcList.length" class="board-thumbs">
            <button
              v-for="t in tlcList"
              :key="t.id"
              class="board-thumb"
              :title="`${t.exp_code} · 点一下加进画布`"
              @click="addTlc(t)"
            >
              <img :src="`/api/files/${t.id}`" alt="" loading="lazy" />
            </button>
          </div>
          <div v-else class="board-drawer-empty">这个课题还没有 TLC 图</div>

          <div class="board-drawer-h">反应式</div>
          <div v-if="schemes.length" class="board-thumbs">
            <button
              v-for="e in schemes"
              :key="e.id"
              class="board-thumb is-wide"
              :title="`${e.code} 的反应式`"
              @click="addScheme(e)"
            >
              <img :src="`/api/experiments/${e.id}/scheme.svg`" alt="" loading="lazy" />
            </button>
          </div>
          <div v-else class="board-drawer-empty">还没有能画的反应式</div>

          <div class="board-drawer-h">文字</div>
          <button class="btn btn-sm btn-ghost board-addtext" @click="addText">
            <Icon name="plus" :size="12" /> 加一段文字
          </button>
        </aside>

        <!-- 画布 -->
        <div class="board-stage">
          <div
            ref="pageEl"
            class="board-page"
            :style="{
              '--bscale': scale,
              // 高度吃满可视区，但也别缩得太小（窄窗口横向还会有 100% 兜底）
              width: `min(100%, clamp(360px, calc((100vh - 210px) * ${pageSize.w / pageSize.h}), 780px))`,
              aspectRatio: `${pageSize.w} / ${pageSize.h}`,
            }"
            @mousedown.self="sel = ''"
          >
            <div
              v-for="it in items"
              :key="it.id"
              class="board-item"
              :class="{ 'is-sel': sel === it.id, 'is-text': it.type === 'text' }"
              :style="{ left: pct(it.x, pageSize.w), top: pct(it.y, pageSize.h), width: pct(it.w, pageSize.w), zIndex: it.z || 1 }"
              @mousedown="startDrag($event, it, 'move')"
              @dblclick="editCaption(it)"
            >
              <div v-if="it.type === 'text'" class="board-text">{{ it.text }}</div>
              <template v-else>
                <img :src="srcOf(it)" alt="" draggable="false" />
                <div v-if="it.caption" class="board-cap">{{ it.caption }}</div>
              </template>
              <span v-if="sel === it.id" class="board-grip" title="拖动改大小" @mousedown.stop="startDrag($event, it, 'size')" />
            </div>
            <div v-if="!items.length" class="board-empty">从左边点一张 TLC 或反应式放上来</div>
          </div>
        </div>
      </div>

      <!-- 选中那一块的小工具条 -->
      <div v-if="selItem" class="board-tools">
        <span class="board-tools-name">
          {{ selItem.type === 'tlc' ? selItem.code || 'TLC' : selItem.type === 'scheme' ? '反应式' : '文字' }}
        </span>
        <button class="board-tool" @click="editCaption(selItem)">{{ selItem.type === 'text' ? '改文字' : '图注' }}</button>
        <button class="board-tool" @click="raise(selItem, 'top')">置顶</button>
        <button class="board-tool" @click="raise(selItem, 'bottom')">置底</button>
        <button class="board-tool" @click="center(selItem)">水平居中</button>
        <button class="board-tool is-danger" @click="removeItem(selItem)">删除</button>
      </div>
    </div>
  </div>
</template>
