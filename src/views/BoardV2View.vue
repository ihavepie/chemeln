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
const failed = ref('');
const skipped = ref(0);
const hostEl = ref(null);
let exApi = null;
const saving = ref(false);
/** 第一次摆好之前先把画布藏起来：不然会看到「默认 100% → 缩到整页」那一下闪 */
const fitted = ref(false);

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
const fresh = []; // 还没交给 Excalidraw 的新图（updateScene 不带 files，得走 addFiles）
/** 同一个块只渲一次：再点一次直接用上次那张图，不再等 0.4 秒 */
const fileCache = {};

async function addFile(url, key) {
  if (key && fileCache[key]) return fileCache[key];
  const id = `f${(fileSeq += 1)}`;
  const { dataURL, mimeType } = await blobToDataURL(url);
  files[id] = { id, dataURL, mimeType, created: Date.now(), lastRetrieved: Date.now() };
  fresh.push(files[id]);
  const got = { id, size: await imageSize(dataURL) };
  if (key) fileCache[key] = got;
  return got;
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
async function rasterBlock(it, key) {
  if (key && fileCache[key]) return fileCache[key];
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
  fresh.push(files[id]);
  const got = { id, size: await imageSize(dataURL) };
  if (key) fileCache[key] = got;
  return got;
}

/** 图注就是一行原生 text（能双击直接改），跟在图下面 */
function captionSk(text, x, y, w) {
  return [{
    type: 'text', x, y, width: Math.round(w), text: String(text),
    fontSize: 13, fontFamily: 2, strokeColor: '#4a463f', textAlign: 'left',
  }];
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
        const hPx = Math.round((w * f.size.h) / f.size.w);
        sk.push({ type: 'image', x, y, width: w, height: hPx, fileId: f.id, status: 'saved' });
        const cap = String(it.caption || '').trim();
        if (cap) sk.push(...captionSk(cap, x, y + hPx + 4, w));
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
          sk.push({ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id, status: 'saved' });
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
          sk.push({ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id, status: 'saved' });
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

/** 场景里被删光的元素（Excalidraw 的删除只是打 isDeleted）——能一键捞回来，不用重新搬 items */
const deletedBox = ref(null);

async function load() {
  try {
    const b = (await api.board(route.params.id)).board;
    board.value = b;
    const els = (b.scene && Array.isArray(b.scene.elements) && b.scene.elements.length) ? b.scene.elements : null;
    const alive = els ? els.filter((e) => !e.isDeleted) : [];
    // 元素全被删了（⌘A + Delete / 清空画布）：东西还在 JSON 里，先给个「恢复」按钮，别自作主张盖回来
    if (els && !alive.length) {
      deletedBox.value = { elements: els, appState: b.scene.appState || {}, files: b.scene.files || {} };
      initial.value = { elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} };
    } else if (els) {
      initial.value = { elements: els, appState: { viewBackgroundColor: '#ffffff' }, files: b.scene.files || {} };
    } else {
      const elements = await migrate(b.items || []);
      initial.value = { elements, appState: { viewBackgroundColor: '#ffffff' }, files: { ...files } };
      fresh.length = 0; // 迁移时造的图已经随 initialData 交过去了
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
const drawerOpen = ref(localStorage.getItem('eln:bdDrawer') !== '0');
/** 专注：连最左导航导轨也收起来，整窗都是画布 */
const focus = ref(localStorage.getItem('eln:bdFocus') === '1');
function toggleFocus() {
  focus.value = !focus.value;
  localStorage.setItem('eln:bdFocus', focus.value ? '1' : '0');
  document.body.classList.toggle('is-board-focus', focus.value);
  setTimeout(() => exApi && fitPaper(exApi), 260);
}
function toggleDrawer() {
  drawerOpen.value = !drawerOpen.value;
  localStorage.setItem('eln:bdDrawer', drawerOpen.value ? '1' : '0');
}
const tlcByExp = ref({});
const q = ref('');
const busyKeys = ref(new Set()); // 同时可以放好几个（各点各的，别把整栏都禁用）

const CHIPS = [
  { key: 'title', label: '编号' },
  { key: 'react', label: '反应式' },
  { key: 'conds', label: '条件' },
  { key: 'reagents', label: '投料' },
  { key: 'result', label: '结果' },
  { key: 'notes', label: '结论' },
];
const CHIP_W = { title: 1200, react: 1200, conds: 1300, reagents: 1500, result: 1300, notes: 1300 };

const hayOf = (e) => `${e.code} ${e.title || ''} ${e.objective || ''} ${e.product_name || ''}`.toLowerCase();
const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  return k ? exps.value.filter((e) => hayOf(e).includes(k)) : exps.value;
});

/** 把删掉的元素原样放回来（位置、图片都还是原来的） */
function restoreDeleted() {
  const box = deletedBox.value;
  if (!box || !exApi) return;
  const els = box.elements.map((e) => ({ ...e, isDeleted: false }));
  exApi.updateScene({ elements: els, captureUpdate: 'IMMEDIATELY' });
  deletedBox.value = null;
  setTimeout(() => fitPaper(exApi), 80);
}

async function loadDrawer() {
  try {
    const project = board.value && board.value.project;
    exps.value = (await api.experiments(project ? { project } : {})) || [];
    // api.tlc 回的是 { items }，不是数组（这里写错会把整个 try 带崩、TLC 缩略图全没有）
    const t = (await api.tlc(project || '')).items || [];
    const map = {};
    for (const x of t) (map[x.exp_id] ||= []).push(x);
    tlcByExp.value = map;
  } catch {
    /* 素材读不到不影响画布 */
  }
}

/** 新块落点：接着纸上已有的内容往下排（别叠在别人身上），排到纸底再从纸顶来 */
function nextPos(wPx, hPx) {
  const x = 60;
  let bottom = 24;
  try {
    for (const el of exApi.getSceneElements()) {
      if (el.locked || el.isDeleted) continue; // A4 白纸不算
      if (el.x + (el.width || 0) < 0) continue;
      bottom = Math.max(bottom, el.y + (el.height || 0));
    }
  } catch {
    /* 还没 ready */
  }
  let y = Math.round(bottom + 24);
  if (y + hPx > 1090) y = 40;
  return { x, y };
}

/** 把 skeleton 加到画布上（走 updateScene，Excalidraw 自己维护版本 / 撤销栈） */
async function insertSkeletons(sk) {
  const EX = await import('@excalidraw/excalidraw');
  const els = EX.convertToExcalidrawElements(sk, { regenerateIds: false });
  // 新图的二进制必须先塞进 Excalidraw 的文件表，否则元素只是张「破图」占位
  if (fresh.length) exApi.addFiles(fresh.splice(0));
  const cur = exApi.getSceneElements();
  exApi.updateScene({ elements: [...cur, ...els], captureUpdate: 'IMMEDIATELY' });
  // 只在落点看不见时才挪视口，而且不做动画（每次插入都飞一下很晃）
  try {
    const st = exApi.getAppState();
    const z = st.zoom && st.zoom.value ? st.zoom.value : 1;
    const el = els[0];
    const sx = (el.x + (el.width || 0) / 2 + st.scrollX) * z;
    const sy = (el.y + (el.height || 0) / 2 + st.scrollY) * z;
    const w = exApi.getAppState().width || window.innerWidth;
    const h = exApi.getAppState().height || window.innerHeight;
    if (sx < 40 || sy < 40 || sx > w - 40 || sy > h - 40) {
      exApi.scrollToContent(els, { fitToContent: false });
    }
  } catch {
    /* 版本差异，忽略 */
  }
}

/* ---------------- 悬停预览：胶囊出那一块的内容，TLC 小图出大图 ----------------
   浮在素材栏右边、不吃鼠标（point-events:none），跟旧画布同一套样式（.bd-peek） */
const peek = ref(null);
let peekTimer = 0;
const PEEK_MAX = 420;

function peekAt(ev) {
  const r = ev.currentTarget.getBoundingClientRect();
  const w = Math.min(PEEK_MAX, Math.round(window.innerWidth * 0.42));
  let x = Math.round(r.right + 12);
  if (x + w > window.innerWidth - 12) x = Math.max(12, Math.round(r.left - w - 12));
  const y = Math.round(Math.min(Math.max(12, r.top - 12), Math.max(12, window.innerHeight - 220)));
  return { x, y, w };
}

function schedulePeek(p) {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    peek.value = p;
  }, 170); // 慢一点才弹，扫过去不闪
}

function peekBlock(e, key, ev) {
  void ensureExp(e.id);
  schedulePeek({ kind: 'block', expId: e.id, key, code: e.code, ...peekAt(ev) });
}

function peekTlc(e, t, ev) {
  schedulePeek({ kind: 'tlc', tlc: t, code: e.code, ...peekAt(ev) });
}

function unpeek() {
  clearTimeout(peekTimer);
  peek.value = null;
}

const peekHtml = computed(() => {
  const p = peek.value;
  if (!p || p.kind !== 'block') return '';
  const d = expCache[p.expId];
  if (!d) return '<div class="bd-ph">读取中…</div>';
  const mm = (CHIP_W[p.key] || 1300) / 10;
  const it = { type: 'block', block: p.key, ref: p.expId, w: CHIP_W[p.key] || 1300 };
  return `<div class="bd-body" style="width:${mm}mm">${itemHtml(it, d, ctxOf())}</div>`;
});

/** 预览按「真实毫米宽」排完再缩到浮卡宽度 */
const peekZoom = computed(() => {
  const p = peek.value;
  if (!p || p.kind !== 'block' || p.key === 'react') return 1;
  const natural = ((CHIP_W[p.key] || 1300) / 10) * (96 / 25.4);
  return Math.min(1, (p.w - 22) / natural);
});

const chipLabel = (key) => (CHIPS.find((c) => c.key === key) || {}).label || '块';

async function addBlock(e, key) {
  const bk = `${e.code}-${key}`;
  if (!exApi || busyKeys.value.has(bk)) return;
  busyKeys.value.add(bk);
  try {
    const ck = `blk:${e.id}:${key}`;
    if (key === 'react') {
      const f = await addFile(`/api/experiments/${e.id}/scheme.svg`, `${ck}:svg`);
      const w = 520;
      const { x, y } = nextPos(w, 120);
      await insertSkeletons([{ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id, status: 'saved' }]);
    } else {
      const it = { block: key, ref: e.id, code: e.code, w: CHIP_W[key] || 1300 };
      const f = await rasterBlock(it, ck); // 3 倍像素的表格 / 文字块
      const w = it.w * K;
      const { x, y } = nextPos(w, 160);
      await insertSkeletons([{ type: 'image', x, y, width: Math.round(w), height: Math.round((w * f.size.h) / f.size.w), fileId: f.id, status: 'saved' }]);
    }
  } catch (err) {
    toast(err.message || '放不上去', 'err');
  } finally {
    busyKeys.value.delete(bk);
  }
}

async function addTlc(e, t) {
  const bk = `tlc-${t.id}`;
  if (!exApi || busyKeys.value.has(bk)) return;
  busyKeys.value.add(bk);
  try {
    const f = await addFile(`/api/files/${t.id}`, `tlc:${t.id}`);
    const w = 220;
    const hPx = Math.round((w * f.size.h) / f.size.w);
    const { x, y } = nextPos(w, Math.min(hPx, 900));
    const sk = [{ type: 'image', x, y, width: w, height: hPx, fileId: f.id, status: 'saved' }];
    // 图注跟着图一起落：图注是附件里早就写好那句（老画布也是这么干的）
    const cap = String(t.note || '').trim();
    if (cap) sk.push(...captionSk(cap, x, y + hPx + 4, w));
    await insertSkeletons(sk);
  } catch (err) {
    toast(err.message || '放不上去', 'err');
  } finally {
    busyKeys.value.delete(bk);
  }
}

async function addText() {
  if (!exApi) return;
  const { x, y } = nextPos(220, 40);
  await insertSkeletons([{ type: 'text', x, y, text: '写点什么', fontSize: 16, fontFamily: 2 }]);
}

/* ---------------- 存回场景（防抖 800ms） ---------------- */
/**
 * 把 **A4 那张纸**塞进视口（不是「所有元素」）：老 items 里有画到纸外的图，
 * 按内容 fit 会把纸挤到一边、右边还被裁掉。
 * 自己算 zoom / scroll 再一次性 updateScene —— 比 `scrollToContent` 稳：不会先摆一次再补一次，
 * 位置算准了两次也是同一个值，屏幕上看不出跳动。
 */
function fitPaper(a) {
  try {
    const els = a.getSceneElements();
    const paper = els.find((e) => e.type === 'rectangle' && e.locked);
    if (!paper) return;
    const st = a.getAppState();
    const W = st.width || 0;
    const H = st.height || 0;
    if (!W || !H) return;
    const pad = 14;
    const z = Math.min((W - pad * 2) / paper.width, (H - pad * 2) / paper.height);
    const zoom = Math.max(0.1, Math.min(3, Math.round(z * 100) / 100));
    const scrollX = W / 2 / zoom - (paper.x + paper.width / 2);
    const scrollY = H / 2 / zoom - (paper.y + paper.height / 2);
    a.updateScene({ appState: { zoom: { value: zoom }, scrollX, scrollY }, captureUpdate: 'NEVER' });
  } catch {
    /* 版本差异，忽略 */
  }
}

let sizeWatch = null;
function onReady(a) {
  exApi = a;
  if (import.meta.env.DEV) window.__exApi = a; // 只在开发预览里挂个把手，方便量几何
  setTimeout(() => {
    fitPaper(a);
    requestAnimationFrame(() => {
      fitted.value = true;
    });
  }, 120);
  // 舞台尺寸变了（收素材栏 / 专注 / 拖窗口）跟着重新摆；尺寸没变就不动，免得打断正在看的位置
  const box = st => `${st.width}x${st.height}`;
  let last = box(a.getAppState());
  sizeWatch = setInterval(() => {
    const cur = box(a.getAppState());
    if (cur !== last) {
      last = cur;
      fitPaper(a);
    }
  }, 200);
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
          viewBackgroundColor: '#ffffff',
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

window.addEventListener('blur', unpeek);

if (focus.value) document.body.classList.add('is-board-focus');

onBeforeUnmount(() => {
  if (sizeWatch) clearInterval(sizeWatch);
  document.body.classList.remove('is-board-focus');
  window.removeEventListener('blur', unpeek);
  unpeek();
  clearTimeout(timer);
  if (pending) void saveNow();
});

load();
</script>

<template>
  <div class="single bv2">
    <!-- 素材：点一个块 / 一张板就放到纸上（表格类是 3 倍像素的图，其它是原生对象） -->
    <aside class="board-drawer bv2-drawer" :class="{ 'is-closed': !drawerOpen }" @mouseleave="unpeek">
      <div class="board-drawer-top">
        <div class="board-drawer-t">
          素材<span class="board-drawer-n">{{ busyKeys.size ? '放上去中…' : exps.length + ' 条记录' }}</span>
          <button class="bv2-dtoggle" title="收起素材栏（画布更宽）" @click="toggleDrawer">‹</button>
        </div>
        <div class="searchbox bd-q">
          <Icon name="search" :size="12" />
          <input v-model="q" type="text" spellcheck="false" placeholder="搜编号 / 题目 / 产物" />
        </div>
      </div>
      <div class="board-drawer-body" @scroll="unpeek">
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
              :class="{ 'is-busy': busyKeys.has(`${e.code}-${c.key}`) }"
              @click="addBlock(e, c.key)"
              @mouseenter="peekBlock(e, c.key, $event)"
              @mouseleave="unpeek"
            >
              {{ c.label }}
            </button>
          </div>
          <div v-if="(tlcByExp[e.id] || []).length" class="bd-rec-tlc">
            <button
              v-for="t in tlcByExp[e.id]"
              :key="t.id"
              class="bd-thumb"
              @click="addTlc(e, t)"
              @mouseenter="peekTlc(e, t, $event)"
              @mouseleave="unpeek"
            >
              <img :src="`/api/files/${t.id}`" alt="" loading="lazy" />
            </button>
          </div>
        </div>
        <div v-if="!exps.length" class="board-drawer-empty">这个课题还没有实验记录</div>
        <div class="bd-rec-chips" style="margin-top: 10px">
          <button class="btn btn-sm btn-ghost" @click="addText">
            <Icon name="plus" :size="12" /> 文字
          </button>
        </div>
      </div>
    </aside>

    <!-- 悬停预览：胶囊出那一块、TLC 小图出大图；不吃鼠标，扫过去就走 -->
    <Teleport to="body">
      <div
        v-if="peek"
        class="bd-peek"
        :style="{ left: peek.x + 'px', top: peek.y + 'px', ...(peek.kind === 'block' ? { width: peek.w + 'px' } : {}) }"
      >
        <div class="bd-peek-h">
          <span class="mono">{{ peek.code }}</span>
          <span>{{ peek.kind === 'tlc' ? 'TLC' : chipLabel(peek.key) }}</span>
        </div>
        <img v-if="peek.kind === 'tlc'" class="bd-peek-img" :src="`/api/files/${peek.tlc.id}`" alt="" />
        <div v-else class="bd-peek-body" :style="{ zoom: peekZoom }" v-html="peekHtml" />
      </div>
    </Teleport>

    <div class="bv2-stage">
      <!-- 顶部那一条只放 Excalidraw 的工具（它靠 CSS 从画布里浮上来），右边浮一排板级操作 -->
      <div class="bv2-tools" />
      <div class="bv2-fbar">
        <span class="bv2-title" :title="board ? board.title : ''">{{ board ? board.title : '排版板' }}</span>
        <span class="bv2-saved">{{ saving ? '保存中…' : '已保存' }}</span>
        <button v-if="deletedBox" class="btn btn-sm btn-ghost" @click="restoreDeleted">恢复上次内容</button>
        <button class="btn btn-sm btn-ghost" :disabled="!!downloading" @click="exportPng">存图</button>
        <button class="btn btn-sm" :disabled="!!downloading" @click="exportPdf">
          <Icon name="download" :size="12" /> 导出 PDF
        </button>
        <button class="btn btn-sm btn-ghost" title="打开旧画布（HTML 版）" @click="router.push(`/b-old/${route.params.id}`)">
          <Icon name="arrow-left" :size="12" /> 旧画布
        </button>
      </div>
      <button v-if="!drawerOpen" class="bv2-dopen" title="展开素材栏" @click="toggleDrawer">›</button>
      <button class="bv2-focus" :class="{ 'is-on': focus }" :title="focus ? '退出专注' : '专注：整个窗口都当画布'" @click="toggleFocus">⤢</button>
      <div v-if="loading" class="cmp-empty">读取中…</div>
      <div v-else class="bv2-canvas" :class="{ 'is-fitted': fitted }">
        <div v-if="failed" class="bv2-fail">
          <p>这个画布起不来：{{ failed }}</p>
          <p class="bv2-fail-hint">先回旧画布也能用，把上面的报错截图发我就能定位。</p>
          <button class="btn btn-sm" @click="router.push(`/b-old/${route.params.id}`)">回旧画布</button>
        </div>
        <ExcalidrawHost v-else ref="hostEl" :initial="initial" @ready="onReady" @fail="failed = $event" @change="onChange" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.bv2 { display: flex; align-items: stretch; height: 100%; padding: 0; overflow: hidden; }
.bv2-drawer { flex: 0 0 250px; flex-shrink: 0; }
.bv2 .bd-chip.is-busy { background: var(--accent-soft); color: var(--accent-ink); }
.bv2 .bd-thumb:disabled, .bv2 .bd-chip:disabled { opacity: 0.55; cursor: default; }
/* 整个内容区就是画布：只有顶上一条 46px 给工具用，其余全给纸 */
.bv2-stage { position: relative; flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
/* 素材栏收起：画布拿满整条宽度，左边留一个小小的展开把手 */
.bv2-drawer { position: relative; transition: flex-basis 0.16s ease; }
.bv2-drawer.is-closed { flex-basis: 0; width: 0; border-right: 0; padding: 0; overflow: hidden; }
.bv2-dtoggle {
  margin-left: auto; border: 0; background: none; color: var(--ink-4); cursor: pointer;
  font-size: 14px; line-height: 1; padding: 0 2px;
}
.bv2-dtoggle:hover { color: var(--ink-2); }
.bv2-focus {
  position: absolute; left: 6px; bottom: 8px; z-index: 7;
  width: 22px; height: 22px; border: 0; border-radius: 4px;
  background: #fff; box-shadow: 0 1px 3px rgba(20, 18, 14, 0.12);
  color: var(--ink-3); cursor: pointer; font-size: 12px; line-height: 1;
}
.bv2-focus.is-on { color: var(--accent-ink); }
.bv2-dopen {
  position: absolute; left: 6px; top: 14px; z-index: 7;
  width: 20px; height: 20px; border: 0; border-radius: 4px;
  background: #fff; box-shadow: 0 1px 3px rgba(20, 18, 14, 0.12);
  color: var(--ink-3); cursor: pointer; font-size: 13px; line-height: 1;
}
.bv2-tools { flex: 0 0 auto; height: 46px; }
.bv2-fbar {
  position: absolute; top: 0; right: 10px; z-index: 6;
  display: flex; align-items: center; gap: 6px; height: 46px;
}
.bv2-title {
  max-width: 26vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--serif); font-size: 14px; color: var(--ink-2); margin-right: 4px;
}
.bv2-fail {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px; padding: 24px;
  background: var(--canvas); text-align: center; font-size: 12.5px; color: var(--ink-2);
}
.bv2-fail-hint { color: var(--ink-4); font-size: 11.5px; }
.bv2-saved { font-size: 10.5px; color: var(--ink-4); margin-right: 2px; }
.bv2-canvas { flex: 1 1 auto; min-height: 0; overflow: visible; opacity: 0; }
.bv2-canvas.is-fitted { opacity: 1; transition: opacity 140ms ease; }
/* 窗口窄的时候：板名让位、工具按钮缩一圈，别跟右边那排操作叠在一起 */
@media (max-width: 1460px) {
  .bv2-title { display: none; }
  .bv2-canvas :deep(.excalidraw) { --lg-button-size: 30px; --default-button-size: 30px; }
}
@media (max-width: 1240px) {
  .bv2-canvas :deep(.excalidraw) { --lg-button-size: 26px; --default-button-size: 26px; }
  .bv2-saved { display: none; }
}

/* ---- 画布上只留一排工具：汉堡菜单、素材库、缩放/撤销/帮助、下面那行提示全藏掉 ---- */
.bv2-canvas :deep(.App-menu_top__left),
.bv2-canvas :deep(.layer-ui__wrapper__top-right),
.bv2-canvas :deep(.layer-ui__wrapper__footer),
.bv2-canvas :deep(.HintViewer),
.bv2-canvas :deep(.disable-zen-mode) { display: none !important; }

/* 工具条从纸面上挪到画布上方那一条（.bv2-tools 46px，正好放它）。
   根节点默认 overflow:hidden，会把这排工具裁掉 —— 放开才能浮出去 */
.bv2-canvas :deep(.excalidraw) { overflow: visible; }
.bv2-canvas :deep(.FixedSideContainer_side_top) { top: -46px; left: 0; right: 0; bottom: auto; height: auto; }
.bv2-canvas :deep(.App-menu_top) { display: flex; justify-content: flex-start; gap: 0; }
.bv2-canvas :deep(.shapes-section) { justify-content: flex-start; }
</style>
