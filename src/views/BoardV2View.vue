<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ExcalidrawHost from '../components/ExcalidrawHost.vue';
import { api } from '../api.js';
import { toast } from '../lib/feedback.js';
import { downloadBlob } from '../lib/print.js';
import { BOARD_CSS, itemHtml } from '../lib/board.js';

/** 截图用的样式：跟纸上一样，但**不带** body 那个 0.7498 缩放 */
const SNAP_CSS = `html, body { margin: 0; padding: 0; background: #fff; }\n${BOARD_CSS}`;

/**
 * 排版板 · 新版画布（试作）：把一张板交给 Excalidraw 显示 / 编辑。
 *
 * 分工：**画布本身的操作**（框选、八点手柄、旋转、撤销、吸附、箭头绑框边）全交给 Excalidraw；
 * 我们只管两件事 ——
 * ① 把 `items`（0.1mm 坐标）**翻译**成 Excalidraw 的元素：文字 / 结论 / 箭头 / 方框 → 原生对象，
 *    TLC 图 / 反应式 → 原生 image（用原文件 / 矢量 SVG，所以放大不糊）；
 * ② 把场景存回 `boards.scene_json`（跟老的 `items_json` 并存，随时能切回旧画布）。
 * 表格类块（投料 / 结果 / TLC 判断 / 对比表）暂时跳过，先在旧画布上摆。
 */
const route = useRoute();
const router = useRouter();

const board = ref(null);
const initial = ref(null);
const loading = ref(true);
const skipped = ref(0);
const hostEl = ref(null);
let exApi = null;
const saving = ref(false);

/** 0.1mm → CSS px（96dpi）：A4 = 794 × 1123 */
const K = 96 / 25.4 / 10;
const px = (u) => Math.round((u || 0) * K * 10) / 10;

const blockCount = computed(() => (board.value ? board.value.items.length : 0));

async function blobToDataURL(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读图失败 ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ dataURL: String(fr.result), mimeType: blob.type || 'image/png' });
    fr.onerror = () => reject(new Error('读图失败'));
    fr.readAsDataURL(blob);
  });
}

let fileSeq = 0;
const files = {}; // 迁移过程中造出来的二进制，跟着场景一起存
async function addFile(url) {
  const id = `f${fileSeq += 1}`;
  const { dataURL, mimeType } = await blobToDataURL(url);
  files[id] = { id, dataURL, mimeType, created: Date.now(), lastRetrieved: Date.now() };
  return { id, size: await imageSize(dataURL) };
}

/** 读一下图片真实宽高，搬过去才不会变形 */
function imageSize(dataURL) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 4, h: img.naturalHeight || 3 });
    img.onerror = () => resolve({ w: 4, h: 3 });
    img.src = dataURL;
  });
}

/** 单块渲图：把这一块按它的真实毫米宽排好，服务端截一张 3 倍像素的图 */
async function rasterBlock(it) {
  const mmW = (it.w || 1200) / 10;
  const cssPx = Math.round(mmW * (96 / 25.4));
  const exp = it.ref ? await ensureExp(it.ref) : null;
  const html = `<div class="bd-body" style="width:${mmW.toFixed(2)}mm">${itemHtml(it, exp, ctxOf())}</div>`;
  const res = await fetch('/api/snapshot/png', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html, css: SNAP_CSS, width: cssPx, snapWidth: cssPx * 3, filename: 'block.png' }),
  });
  if (!res.ok) throw new Error('渲图失败');
  const blob = await res.blob();
  const dataURL = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读图失败'));
    fr.readAsDataURL(blob);
  });
  const id = `b${(fileSeq += 1)}`;
  files[id] = { id, dataURL, mimeType: 'image/png', created: Date.now(), lastRetrieved: Date.now() };
  return { id, size: await imageSize(dataURL) };
}

const ctxOf = () => ({ get: (id) => expCache[id] });
const expCache = {};
const expLoading = new Set();
async function ensureExp(id) {
  if (!id) return null;
  if (expCache[id]) return expCache[id];
  if (expLoading.has(id)) {
    // 同一批里已经在取，等它
    for (let i = 0; i < 40 && expLoading.has(id); i += 1) await new Promise((r) => setTimeout(r, 50));
    return expCache[id] || null;
  }
  expLoading.add(id);
  try {
    expCache[id] = await api.experiment(id);
  } catch {
    expCache[id] = null;
  } finally {
    expLoading.delete(id);
  }
  return expCache[id];
}

/** 把老画布的 items 翻成 Excalidraw 的 skeleton（再交给 convertToExcalidrawElements） */
async function migrate(items) {
  const sk = [
    // A4 白纸：794 × 1123 px（= 210×297mm @96dpi），锁住不让拖
    {
      type: 'rectangle', x: 0, y: 0, width: 794, height: 1123,
      backgroundColor: '#ffffff', strokeColor: 'transparent', fillStyle: 'solid',
      roughness: 0, locked: true,
    },
  ];
  skipped.value = 0;
  for (const it of items) {
    const x = px(it.x);
    const y = px(it.y);
    const w = px(it.w);
    const ink = it.color || '#1c1b19';

    if (it.type === 'text') {
      sk.push({ type: 'text', x, y, text: String(it.text || ''), fontSize: 16, fontFamily: 2, strokeColor: ink });
      continue;
    }
    if (it.type === 'shape') {
      const h = px(it.h || (it.shape === 'arrow' ? 200 : 600));
      if (it.shape === 'box') {
        sk.push({
          type: 'rectangle', x, y, width: w, height: h, strokeColor: ink,
          backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: it.thick ? 2 : 1, roughness: 0,
        });
      } else {
        // 尾 → 头（老数据没有 up = 中线水平）
        const right = it.dir !== 'left';
        const legacy = it.up === undefined || it.up === null;
        const tail = legacy ? [right ? 0 : w, h / 2] : [right ? 0 : w, it.up ? h : 0];
        const head = legacy ? [right ? w : 0, h / 2] : [right ? w : 0, it.up ? 0 : h];
        sk.push({
          type: 'arrow', x, y, width: w, height: h,
          points: [tail, head],
          strokeColor: ink, strokeWidth: it.thick ? 2 : 1, roughness: 0,
          endArrowhead: 'arrow', startArrowhead: null,
        });
      }
      continue;
    }
    if (it.type === 'tlc' && it.ref) {
      try {
        const f = await addFile(`/api/files/${it.ref}`);
        sk.push({ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id });
      } catch {
        skipped.value += 1;
      }
      continue;
    }
    if (it.type === 'block') {
      // 反应式：喂矢量 SVG（放大不糊）；其它块是 HTML 表格，先不搬
      if (it.block === 'react' && it.ref) {
        try {
          const f = await addFile(`/api/experiments/${it.ref}/scheme.svg`);
          sk.push({ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id });
        } catch {
          skipped.value += 1;
        }
        continue;
      }
      // 表格类（投料 / 结果 / TLC 判断 / 结论文字 / 对比表 / 编号 / 条件）：HTML 表格没法变成原生对象，
      // 按 3 倍像素渲成图贴上去 —— 跟记录页的排版一模一样，A4 上放大到约 300% 以内都清楚
      if (['title', 'conds', 'reagents', 'result', 'verdict', 'notes', 'compare'].includes(it.block) || it.block === 'concl') {
        try {
          const f = await rasterBlock(it);
          sk.push({ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id });
        } catch {
          skipped.value += 1;
        }
        continue;
      }
      if (it.block === 'concl') {
        sk.push({ type: 'text', x, y, text: '结论', fontSize: 10, fontFamily: 2, strokeColor: '#a09c93' });
        sk.push({ type: 'text', x, y: y + 18, text: String(it.text || '双击写结论'), fontSize: 16, fontFamily: 2, strokeColor: ink });
        continue;
      }
      skipped.value += 1;
      continue;
    }
    skipped.value += 1;
  }
  const EX = await import('@excalidraw/excalidraw');
  return EX.convertToExcalidrawElements(sk, { regenerateIds: false });
}

async function load() {
  try {
    const b = (await api.board(route.params.id)).board;
    board.value = b;
    if (b.scene && Array.isArray(b.scene.elements) && b.scene.elements.length) {
      initial.value = { elements: b.scene.elements, appState: b.scene.appState || {}, files: b.scene.files || {} };
    } else {
      const elements = await migrate(b.items || []);
      initial.value = { elements, appState: {}, files: { ...files } };
    }
  } catch (e) {
    toast(e.message || '读不到这张板', 'err');
    router.replace('/boards');
  } finally {
    loading.value = false;
    void loadDrawer();
  }
}

/* ---------------- 左侧素材栏：点一下就把那块放到纸上 ----------------
   老画布那套（搜索 / 悬停预览）先留在 /b-old，这里是最直接的「点一个块」+「点一张板」。 */
const exps = ref([]);
const tlcByExp = ref({});
const q = ref('');
const busy = ref('');

const CHIPS = [
  { key: 'title', label: '编号' },
  { key: 'react', label: '反应式' },
  { key: 'conds', label: '条件' },
  { key: 'reagents', label: '投料' },
  { key: 'result', label: '结果' },
  { key: 'verdict', label: 'TLC 判断' },
  { key: 'notes', label: '结论' },
];

const hayOf = (e) => `${e.code} ${e.title || ''} ${e.objective || ''} ${e.product_name || ''}`.toLowerCase();
const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  return k ? exps.value.filter((e) => hayOf(e).includes(k)) : exps.value;
});

async function loadDrawer() {
  try {
    const project = board.value && board.value.project;
    exps.value = (await api.experiments(project ? { project } : {})) || [];
    const t = (await api.tlc(project || '')) || [];
    const map = {};
    for (const x of t) (map[x.exp_id] ||= []).push(x);
    tlcByExp.value = map;
  } catch {
    /* 素材读不到不影响画布 */
  }
}

/** 新块落点：纸的左边往下排（跟旧画布的落点规则一致） */
let cursorY = 40;
function nextPos(wPx, hPx) {
  const x = 60;
  let y = cursorY;
  if (y + hPx > 1080) y = 40;
  cursorY = y + hPx + 18;
  return { x, y };
}

/** 把 skeleton 加到画布上（走 updateScene，Excalidraw 自己维护版本 / 撤销栈） */
async function insertSkeletons(sk) {
  const EX = await import('@excalidraw/excalidraw');
  const els = EX.convertToExcalidrawElements(sk, { regenerateIds: false });
  const cur = exApi.getSceneElements();
  exApi.updateScene({ elements: [...cur, ...els], captureUpdate: 'IMMEDIATELY' });
  exApi.scrollToContent(els, { fitToContent: false, animate: true });
}

async function addBlock(e, key) {
  if (!exApi || busy.value) return;
  busy.value = `${e.code}-${key}`;
  try {
    if (key === 'react') {
      const f = await addFile(`/api/experiments/${e.id}/scheme.svg`);
      const w = 520;
      const { x, y } = nextPos(w, 120);
      await insertSkeletons([{ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id }]);
    } else {
      const it = { block: key, ref: e.id, code: e.code, w: key === 'reagents' ? 1500 : 1300 };
      const f = await rasterBlock(it); // 3 倍像素的表格 / 文字块
      const w = it.w * K;
      const { x, y } = nextPos(w, 160);
      await insertSkeletons([{ type: 'image', x, y, width: Math.round(w), height: Math.round((w * f.size.h) / f.size.w), fileId: f.id }]);
    }
  } catch (err) {
    toast(err.message || '放不上去', 'err');
  } finally {
    busy.value = '';
  }
}

async function addTlc(e, t) {
  if (!exApi || busy.value) return;
  busy.value = `tlc-${t.id}`;
  try {
    const f = await addFile(`/api/files/${t.id}`);
    const w = 220;
    const { x, y } = nextPos(w, 240);
    await insertSkeletons([{ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id }]);
  } catch (err) {
    toast(err.message || '放不上去', 'err');
  } finally {
    busy.value = '';
  }
}

async function addText() {
  if (!exApi) return;
  const { x, y } = nextPos(220, 40);
  await insertSkeletons([{ type: 'text', x, y, text: '写点什么', fontSize: 16, fontFamily: 2 }]);
}

/* ---------------- 存回场景（防抖 800ms） ---------------- */
function onReady(a) {
  exApi = a;
  // 把整张纸放进视口（initialData.scrollToContent 在异步 import 下不一定生效）
  setTimeout(() => {
    try {
      a.scrollToContent(a.getSceneElements(), { fitToContent: true });
    } catch {
      /* 版本差异，忽略 */
    }
  }, 120);
}

let timer = 0;
let pending = null;
function onChange(payload) {
  pending = payload;
  clearTimeout(timer);
  timer = setTimeout(saveNow, 800);
}

async function saveNow() {
  if (!pending || !board.value) return;
  const p = pending;
  pending = null;
  saving.value = true;
  try {
    const appState = p.appState || {};
    await api.saveBoard(board.value.id, {
      scene: {
        elements: p.elements || [],
        files: { ...files, ...((exApi && exApi.getFiles && exApi.getFiles()) || {}) },
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor || '#f5f4f1',
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom,
        },
      },
    });
  } catch (e) {
    toast(e.message || '保存失败', 'err');
  } finally {
    saving.value = false;
  }
}

/* ---------------- 导出：先用 Excalidraw 自己渲成图，再走「截图 PDF」那条路 ---------------- */
const downloading = ref('');

async function renderImage() {
  const EX = await import('@excalidraw/excalidraw');
  const a = exApi;
  const appState = {
    ...a.getAppState(),
    exportBackground: true,
    viewBackgroundColor: '#ffffff',
    exportWithDarkMode: false,
    exportScale: 2,
  };
  return EX.exportToBlob({ elements: a.getSceneElements(), appState, files: a.getFiles(), mimeType: 'image/png' });
}

const blobDataURL = (blob) =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读图失败'));
    fr.readAsDataURL(blob);
  });

async function exportPng() {
  if (!exApi || downloading.value) return;
  downloading.value = 'png';
  try {
    const blob = await renderImage();
    downloadBlob(blob, `${board.value.title || '排版板'}.png`);
    toast('图片好了', 'ok');
  } catch (e) {
    toast(e.message || '导图失败', 'err');
  } finally {
    downloading.value = '';
  }
}

async function exportPdf() {
  if (!exApi || downloading.value) return;
  downloading.value = 'pdf';
  try {
    const blob = await renderImage();
    const dataURL = await blobDataURL(blob);
    // 这张图铺满一页 A4，再交给我们那套「截图 PDF」出真 PDF
    const html = `<div class="pdf-page" style="padding:0"><img src="${dataURL}" style="display:block;width:100%;height:auto"></div>`;
    const pdf = await api.snapshotPdf({
      pages: [html],
      css: 'html,body{margin:0;padding:0;background:#fff}.pdf-page{width:210mm;height:297mm;overflow:hidden;background:#fff}',
      width: 794,
      snapWidth: 1588,
      filename: `${board.value.title || '排版板'}.pdf`,
    });
    downloadBlob(pdf, `${board.value.title || '排版板'}.pdf`);
    toast('PDF 好了', 'ok');
  } catch (e) {
    toast(e.message || '导出失败', 'err');
  } finally {
    downloading.value = '';
  }
}

onBeforeUnmount(() => {
  clearTimeout(timer);
  if (pending) void saveNow();
});

load();
</script>

<template>
  <div class="single bv2">
    <!-- 素材：点一个块 / 一张板就放到纸上（表格类是 3 倍像素的图，其它是原生对象） -->
    <aside class="board-drawer bv2-drawer">
      <div class="board-drawer-top">
        <div class="board-drawer-t">
          素材<span class="board-drawer-n">{{ busy ? '放上去中…' : exps.length + ' 条记录' }}</span>
        </div>
        <div class="searchbox bd-q">
          <Icon name="search" :size="12" />
          <input v-model="q" type="text" spellcheck="false" placeholder="搜编号 / 题目 / 产物" />
        </div>
      </div>
      <div class="board-drawer-body">
        <div v-for="e in shown" :key="e.id" class="bd-rec">
          <div class="bd-rec-head">
            <span class="mono">{{ e.code }}</span>
            <span class="bd-rec-title">{{ e.title || e.objective || '' }}</span>
          </div>
          <div class="bd-rec-chips">
            <button
              v-for="c in CHIPS"
              :key="c.key"
              class="bd-chip"
              :class="{ 'is-busy': busy === `${e.code}-${c.key}` }"
              :disabled="!!busy"
              @click="addBlock(e, c.key)"
            >
              {{ c.label }}
            </button>
          </div>
          <div v-if="(tlcByExp[e.id] || []).length" class="bd-rec-tlc">
            <button v-for="t in tlcByExp[e.id]" :key="t.id" class="bd-thumb" :disabled="!!busy" @click="addTlc(e, t)">
              <img :src="`/api/files/${t.id}`" alt="" loading="lazy" />
            </button>
          </div>
        </div>
        <div v-if="!exps.length" class="board-drawer-empty">这个课题还没有实验记录</div>
        <div class="bd-rec-chips" style="margin-top: 10px">
          <button class="btn btn-sm btn-ghost" :disabled="!!busy" @click="addText">
            <Icon name="plus" :size="12" /> 文字
          </button>
        </div>
      </div>
    </aside>

    <div class="inner bv2-inner">
      <header class="page-head bv2-head">
        <div class="bv2-head-main">
          <h1 class="page-title">{{ board ? board.title : '排版板' }}</h1>
          <p class="page-desc">
            新版画布（Excalidraw）· 框选 / 八点手柄 / 旋转 / ⌘Z 撤销 / 吸附 / 箭头绑框边都是它自带的
            <span v-if="skipped"> · 还有 {{ skipped }} 个表格类块没搬过来（先在旧画布上摆）</span>
          </p>
        </div>
        <span class="spacer" />
        <span class="bv2-saved">{{ saving ? '保存中…' : '已保存' }}</span>
        <button class="btn btn-sm" :disabled="!!downloading" @click="exportPdf">
          <Icon name="download" :size="12" /> 导出 PDF
        </button>
        <button class="btn btn-sm btn-ghost" :disabled="!!downloading" @click="exportPng">存图</button>
        <button class="btn btn-sm btn-ghost" title="打开旧画布（HTML 版）" @click="router.push(`/b-old/${route.params.id}`)">
          <Icon name="arrow-left" :size="12" /> 旧画布
        </button>
      </header>
      <div v-if="loading" class="cmp-empty">读取中…</div>
      <div v-else class="bv2-canvas">
        <ExcalidrawHost ref="hostEl" :initial="initial" @ready="onReady" @change="onChange" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.bv2 { display: flex; align-items: stretch; height: 100%; padding: 0; overflow: hidden; }
.bv2-drawer { flex: 0 0 250px; }
.bv2 .bd-chip.is-busy { background: var(--accent-soft); color: var(--accent-ink); }
.bv2 .bd-thumb:disabled, .bv2 .bd-chip:disabled { opacity: 0.55; cursor: default; }
.bv2-inner { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; padding: 26px 28px 16px; max-width: none; }
.bv2-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 14px; flex: 0 0 auto; }
.bv2-head-main { min-width: 0; }
.bv2-saved { font-size: 10.5px; color: var(--ink-4); margin-right: 8px; }
.bv2-canvas { flex: 1 1 auto; min-height: 0; border-radius: 8px; overflow: hidden; box-shadow: 0 0 0 1px var(--line); }
</style>
