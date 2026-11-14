<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ExpPick from '../components/ExpPick.vue';
import DocGrip from '../components/DocGrip.vue';
import { api } from '../api.js';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { downloadBlob } from '../lib/print.js';
import {
  PAGE,
  MIN_W,
  BLOCKS,
  MM_PER_PX,
  SHAPE_COLORS,
  pxPerUnit,
  snapX as snapXTo,
  unitsPerPx as unitsPerPxOf,
  mm,
  clamp,
  uid,
  itemHtml,
  boardHtml,
  blockHtml,
  BOARD_CSS,
} from '../lib/board.js';

/** 截图 / 截图做 PDF 用的样式：跟纸上一样，但**不带** `body{zoom:0.7498}`（那是给 595px 打印视口缩页用的） */
const SNAP_CSS = `html, body { margin: 0; padding: 0; background: #fff; }\n${BOARD_CSS}`;

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
/* 选中：**一组 id**（框选 / Shift 点选都是多选，单块操作照旧只看 `selItem`） */
const selIds = ref([]);
const selItem = computed(() => (selIds.value.length === 1 ? items.value.find((it) => it.id === selIds.value[0]) || null : null));
const selItems = computed(() => items.value.filter((it) => selIds.value.includes(it.id)));
const isSel = (it) => selIds.value.includes(it.id);
const selectOne = (id) => {
  selIds.value = id ? [id] : [];
};
const clearSel = () => {
  selIds.value = [];
};
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

/** 1px 等于多少画布单位（纯算术在 `lib/board.js`，这里只把 zoom 接进去） */
const unitsPerPx = () => unitsPerPxOf(zoom.value);
const nextZ = () => items.value.reduce((m, it) => Math.max(m, it.z || 0), 0) + 1;

/* ---------------- 读 / 存 ---------------- */

function groupTlc(list) {
  for (const k of Object.keys(tlcByExp)) delete tlcByExp[k];
  for (const t of list || []) (tlcByExp[t.exp_id] ||= []).push(t);
}

const expLoading = new Map();
async function ensureExp(id) {
  if (!id) return null;
  if (expCache[id]) return expCache[id];
  if (expLoading.has(id)) return expLoading.get(id); // 同一个 id 只发一次（搜素材时按字触发）
  const p = api
    .experiment(id)
    .then((d) => {
      expCache[id] = d;
      return d;
    })
    .catch(() => {
      expCache[id] = null;
      return null;
    })
    .finally(() => expLoading.delete(id));
  expLoading.set(id, p);
  return p;
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
watch(items, watchHistory, { deep: true });
watch(() => board.value && board.value.title, touch);

/* ---------------- 撤销 / 重做（快照栈） ----------------
   Excalidraw 也是这么干的：一步 = 一次「有内容变化」的编辑。这里按 400ms 归组，
   所以拖一下 / 连续打几个字算一步。**数据很小（一张板几十个块），整份快照最省事。 */
const undoStack = [];
const redoStack = [];
const canUndo = ref(false);
const canRedo = ref(false);
let histTimer = 0;
let lastSnap = null;
let restoring = false;

const snapNow = () => JSON.stringify(items.value);
function syncHistBtns() {
  canUndo.value = undoStack.length > 0;
  canRedo.value = redoStack.length > 0;
}

/** 内容变了：把「变之前」那份压栈（同一拍里多次改动只压一次） */
function watchHistory() {
  if (restoring) return;
  clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    const now = snapNow();
    if (lastSnap != null && now !== lastSnap) {
      undoStack.push(lastSnap);
      if (undoStack.length > 80) undoStack.shift();
      redoStack.length = 0;
      syncHistBtns();
    }
    lastSnap = now;
  }, 400);
}

function restore(json) {
  restoring = true;
  items.value = JSON.parse(json);
  clearSel();
  draft.value = null;
  lastSnap = json;
  nextTick(() => {
    restoring = false;
    syncCursor();
  });
}

function undo() {
  if (!undoStack.length) return toast('没有可撤销的了', 'warn');
  const cur = snapNow();
  const prev = undoStack.pop();
  redoStack.push(cur);
  if (redoStack.length > 80) redoStack.shift();
  restore(prev);
  syncHistBtns();
  touch();
}

function redo() {
  if (!redoStack.length) return toast('没有可重做的了', 'warn');
  const cur = snapNow();
  const next = redoStack.pop();
  undoStack.push(cur);
  restore(next);
  syncHistBtns();
  touch();
}

/* ---------------- 画布缩放 ---------------- */

function fit() {
  const el = stageEl.value;
  if (!el) return;
  // 画布单位（0.1mm）→ 屏幕 px（不乘 zoom：这里算的是 100% 时纸张多大）
  const pxW = pageSize.value.w * pxPerUnit(1);
  const pxH = pageSize.value.h * pxPerUnit(1);
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
  selectOne(items.value[items.value.length - 1].id);
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

/* ---------------- 工具：先点工具，再在纸上点 / 拖（像 ChemDraw 的画布） ----------------
   以前点「箭头」就直接在页尾落一根、位置还得再挪；现在工具是「拿在手上」的：
   点一下工具进入落笔状态（按钮高亮 + 顶部提示），然后在纸上点 / 拖才真的加 —— 箭头和方框
   是**按下拖到松手**决定位置、长度、方向，点一下不动就给默认大小；Esc 或右键收笔。 */
const TOOLS = [
  { key: 'text', label: '文字', hint: '在纸上点一下放文字' },
  { key: 'concl', label: '结论', hint: '在纸上点一下放结论块' },
  { key: 'arrow', label: '箭头', hint: '在纸上拖一根箭头（点一下 = 默认长度）' },
  { key: 'box', label: '方框', hint: '在纸上拖一个框（点一下 = 默认大小）' },
];
const tool = ref('');
const toolHint = computed(() => (TOOLS.find((t) => t.key === tool.value) || {}).hint || '');
const draft = ref(null); // 拖着的那块先按 itemHtml 画出来，松手前就看得到粗细 / 方向
const draw = reactive({ on: false, kind: '', x0: 0, y0: 0, x1: 0, y1: 0, moved: false });

function armTool(kind) {
  tool.value = tool.value === kind ? '' : kind;
  draft.value = null;
  clearSel();
}

/** 屏幕坐标 → 画布单位。
    坑：Safari 里 `zoom` 元素的 `getBoundingClientRect()` **位置要再乘一次 zoom，尺寸却是没缩的**
    （实测 zoom .619 时 rect.left 1170 / 真实可视 724 = 1170×.619，而 rect.width 794 / 可视 491 = 794×.619）。
    所以左边 / 上边都得 `× zoom` 才是眼睛看到的那条边，不乘的话落笔点整块偏掉。 */
function pointAt(ev) {
  const r = pageEl.value.getBoundingClientRect();
  const z = zoom.value || 1;
  const k = unitsPerPx();
  return { x: Math.round((ev.clientX - r.left * z) * k), y: Math.round((ev.clientY - r.top * z) * k) };
}

function onDrawDown(ev) {
  if (!tool.value || ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  const p = pointAt(ev);
  Object.assign(draw, { on: true, kind: tool.value, x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false });
  // 草稿等到真的动了才画：按下就画会先闪一个「默认大小」的箭头，看着像不跟手
  draft.value = null;
  window.addEventListener('mousemove', onDrawMove);
  window.addEventListener('mouseup', endDraw);
}

function onDrawMove(ev) {
  if (!draw.on) return;
  const p = pointAt(ev);
  draw.x1 = p.x;
  draw.y1 = p.y;
  if (!draw.moved && Math.hypot(draw.x1 - draw.x0, draw.y1 - draw.y0) > 12) draw.moved = true;
  if (draw.kind === 'arrow' || draw.kind === 'box') draft.value = shapeFrom(draw);
}

/** 「按下 → 现在」折算成一块：拖了就按拖出来的范围，点一下（位移 < 1.2mm）给默认大小 */
function shapeFrom(d) {
  const W = pageSize.value.w;
  const H = pageSize.value.h;
  const color = SHAPE_COLORS[0].v;
  const dx = d.x1 - d.x0;
  const dy = d.y1 - d.y0;
  if (d.kind === 'arrow') {
    if (!d.moved || (Math.abs(dx) < 60 && Math.abs(dy) < 60)) {
      const w = 1500;
      return { type: 'shape', shape: 'arrow', x: clamp(d.x0, 0, W - w), y: d.y0, w, h: 200, dir: 'right', color };
    }
    const dir = dx < 0 ? 'left' : 'right';
    // 横向拖（上下差不到 6mm）就当水平箭头：高度给 20mm、不存 up（老数据的画法）；
    // 斜着拖就是真实的「尾 → 头」对角，任意角度
    if (Math.abs(dy) < 60) {
      const len = clamp(Math.abs(dx), 300, W);
      return { type: 'shape', shape: 'arrow', x: dir === 'left' ? clamp(d.x0 - len, 0, W - len) : clamp(d.x0, 0, W - len), y: d.y0, w: len, h: 200, dir, color };
    }
    const w = clamp(Math.abs(dx), 80, W);
    const h = clamp(Math.abs(dy), 80, H);
    return {
      type: 'shape',
      shape: 'arrow',
      x: clamp(dx < 0 ? d.x0 - w : d.x0, 0, W - w),
      y: clamp(dy < 0 ? d.y0 - h : d.y0, 0, H - h),
      w,
      h,
      dir,
      up: dy < 0, // 往上拖 → 头在上
      color,
    };
  }
  if (!d.moved || (Math.abs(dx) < 60 && Math.abs(dy) < 60)) {
    const w = 1400;
    const h = 600;
    return { type: 'shape', shape: 'box', x: clamp(d.x0, 0, W - w), y: clamp(d.y0, 0, H - h), w, h, color };
  }
  const w = clamp(Math.abs(dx), 120, W);
  const h = clamp(Math.abs(dy), 120, H);
  return { type: 'shape', shape: 'box', x: clamp(dx < 0 ? d.x0 - w : d.x0, 0, W - w), y: clamp(dy < 0 ? d.y0 - h : d.y0, 0, H - h), w, h, color };
}

async function endDraw() {
  window.removeEventListener('mousemove', onDrawMove);
  window.removeEventListener('mouseup', endDraw);
  if (!draw.on) return;
  const kind = draw.kind;
  const at = { x: draw.x0, y: draw.y0 };
  const built = draft.value;
  draw.on = false;
  draft.value = null;
  const W = pageSize.value.w;
  const H = pageSize.value.h;
  if (kind === 'text' || kind === 'concl') {
    const w = kind === 'text' ? 1200 : 1600;
    await push({
      id: uid(),
      ...(kind === 'text' ? { type: 'text', text: '写点什么' } : { type: 'block', block: 'concl', text: '双击写结论' }),
      x: clamp(at.x, 0, W - w),
      y: clamp(at.y, 0, H - 100),
      w,
    });
  } else if (built) {
    await push({ id: uid(), ...built });
  }
  syncCursor();
}

/** 右键 = 收笔（工具还拿在手上时会先被这里吃掉，不弹页面菜单） */
function cancelDraw() {
  if (!tool.value && !draw.on) return false;
  tool.value = '';
  draft.value = null;
  window.removeEventListener('mousemove', onDrawMove);
  window.removeEventListener('mouseup', endDraw);
  draw.on = false;
  return true;
}

/** 改颜色 / 粗细 / 箭头方向（就地改，靠防抖自动存） */
function setShapeColor(it, v) {
  it.color = v;
  touch();
}
function toggleThick(it) {
  it.thick = it.thick ? 0 : 1;
  touch();
}
function flipShape(it) {
  it.dir = it.dir === 'left' ? 'right' : 'left';
  touch();
}

/** 上下翻转：老箭头（up 未设 = 水平）先转成对角，再翻 */
function flipVertical(it) {
  it.up = it.up === undefined ? false : !it.up;
  touch();
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

/* ---------------- 素材栏：搜记录里的字 + 悬停预览 ---------------- */

const bdQ = ref('');
const q = computed(() => bdQ.value.trim().toLowerCase());

/** 投料表里的试剂名：列表接口只给了 `reagent_sig`（`role:名字:当量:…|…`），拆出来当搜索词 */
const reagentNames = (e) =>
  String(e.reagent_sig || '')
    .split('|')
    .map((seg) => String(seg.split(':')[1] || '').trim())
    .filter(Boolean)
    .join(' ');

const tlcNoteOf = (e) =>
  (tlcByExp[e.id] || [])
    .map((t) => [t.note, t.solvent, t.verdict].filter(Boolean).join(' '))
    .join(' ');

/** 详情里那段正文（没读到就当没有，读到之后 computed 会自己重算） */
function detailText(e) {
  const d = expCache[e.id];
  if (!d) return '';
  const steps = typeof d.steps_json === 'string' ? d.steps_json : JSON.stringify(d.steps || '');
  return [d.procedure, d.workup, d.characterization, d.conclusion, d.notes, d.tlc_note, d.addition, steps]
    .filter(Boolean)
    .join(' ');
}

const hayOf = (e) =>
  [
    e.code,
    e.title,
    e.objective,
    e.substrates,
    e.product_name,
    e.category_name,
    e.kind,
    e.solvent,
    e.temperature,
    reagentNames(e),
    tlcNoteOf(e),
    detailText(e),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

const filExps = computed(() => (q.value ? exps.value.filter((e) => hayOf(e).includes(q.value)) : exps.value));

/** 不是编号 / 题目命中时，指出是**哪一行字**命中的，顺手带几个字上下文 */
const HINT_FIELDS = [
  ['题目', (e) => e.title],
  ['描述', (e) => e.objective],
  ['底物', (e) => e.substrates],
  ['产物', (e) => e.product_name],
  ['试剂', (e) => reagentNames(e)],
  ['溶剂', (e) => e.solvent],
  ['分类', (e) => e.category_name],
  ['条件', (e) => [e.temperature, e.duration, e.atmosphere].filter(Boolean).join(' ')],
  ['TLC', (e) => tlcNoteOf(e)],
  ['操作', (e, d) => d.procedure],
  ['后处理', (e, d) => d.workup],
  ['表征', (e, d) => d.characterization],
  ['结论', (e, d) => [d.conclusion, d.notes].filter(Boolean).join(' ')],
];

function hintOf(e) {
  if (!q.value) return '';
  if (String(e.code || '').toLowerCase().includes(q.value)) return '';
  if (String(e.title || '').toLowerCase().includes(q.value)) return '';
  const d = expCache[e.id] || {};
  for (const [label, fn] of HINT_FIELDS) {
    const v = String(fn(e, d) || '');
    const at = v.toLowerCase().indexOf(q.value);
    if (at < 0) continue;
    const from = Math.max(0, at - 6);
    const to = Math.min(v.length, at + q.value.length + 12);
    return `${label} · ${from > 0 ? '…' : ''}${v.slice(from, to).replace(/\s+/g, ' ').trim()}`;
  }
  return '';
}

// 打字后把还没读过的详情补上（正文里的字也能搜到）；延迟一拍，别边敲边轰请求
let searchTimer = 0;
watch(q, (v) => {
  clearTimeout(searchTimer);
  if (!v) return;
  searchTimer = setTimeout(() => {
    for (const e of exps.value) if (!expCache[e.id]) void ensureExp(e.id);
  }, 220);
});

/* 悬停预览：胶囊出那一块的内容，TLC 小图出大图。浮在素材栏右边、不吃鼠标（point-events:none） */
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
  const at = peekAt(ev);
  void ensureExp(e.id); // 内容要详情；没到之前先显示占位
  schedulePeek({ kind: 'block', expId: e.id, key, ...at });
}

function peekTlc(e, t, ev) {
  schedulePeek({ kind: 'tlc', tlc: t, code: e.code, ...peekAt(ev) });
}

function unpeek() {
  clearTimeout(peekTimer);
  peek.value = null;
}

const peekCode = computed(() => {
  const p = peek.value;
  if (!p) return '';
  if (p.kind === 'tlc') return p.code || '';
  const d = expCache[p.expId];
  if (d) return d.code || '';
  const e = exps.value.find((x) => x.id === p.expId);
  return (e && e.code) || '';
});

/** 预览内容：详情没到之前先给占位（别拿列表那份去画「投料表是空的」） */
const peekHtml = computed(() => {
  const p = peek.value;
  if (!p || p.kind !== 'block') return '';
  const d = expCache[p.expId];
  if (!d) return '<div class="bd-ph">读取中…</div>';
  return blockHtml(p.key, d);
});

/** 预览按「真实毫米宽」排完再缩到卡片宽度（反应式是 img width:100%，不用缩） */
const peekZoom = computed(() => {
  const p = peek.value;
  if (!p || p.kind !== 'block' || p.key === 'react' || p.key === 'compare') return 1;
  const w = (BLOCKS.find((b) => b.key === p.key) || {}).w || 1300;
  const natural = (w / 10) * (96 / 25.4);
  return Math.min(1, (p.w - 22) / natural);
});

const blockLabel = (key) => (BLOCKS.find((b) => b.key === key) || {}).label || '块';

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
  clearSel();
}

/* ---- 多选（框选 / Shift 点选）：整组挪、整组删、整组复制 ---- */

function removeMany() {
  const ids = new Set(selIds.value);
  if (!ids.size) return;
  items.value = items.value.filter((x) => !ids.has(x.id));
  clearSel();
}

/** 一组块允许的位移：整组一起夹边界，别把组拉变形 */
function clampDelta(list, dx, dy) {
  const W = pageSize.value.w;
  const H = pageSize.value.h;
  const minX = Math.min(...list.map((i) => i.x));
  const maxX = Math.max(...list.map((i) => i.x + i.w));
  const minY = Math.min(...list.map((i) => i.y));
  const maxY = Math.max(...list.map((i) => i.y + (i.h || 0)));
  return { dx: clamp(dx, -minX, W - maxX), dy: clamp(dy, -minY, H - 60 - (maxY - minY)) };
}

function moveSelection(dx, dy) {
  const list = selItems.value;
  if (!list.length) return;
  const d = clampDelta(list, dx, dy);
  for (const it of list) {
    it.x = Math.round(it.x + d.dx);
    it.y = Math.round(it.y + d.dy);
  }
  touch();
}

function raiseMany(where) {
  const list = selItems.value;
  if (!list.length) return;
  const zs = items.value.map((x) => x.z || 0);
  let z = where === 'top' ? Math.max(...zs) + 1 : Math.min(...zs) - list.length;
  for (const it of list) it.z = z++;
  touch();
}

function duplicateMany() {
  const made = selItems.value.map((it) => ({ ...it, id: uid(), x: it.x + 100, y: it.y + 100, z: nextZ() }));
  items.value.push(...made);
  selIds.value = made.map((m) => m.id);
  touch();
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
  selectOne(copy.id);
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

const drag = reactive({ on: false, mode: 'move', corner: 'r', id: '', sx: 0, sy: 0, ox: 0, oy: 0, ow: 0, oh: 0, moved: false, nx: 0, ny: 0, nw: 0, nh: 0, gdx: 0, gdy: 0 });
/** 吸附时把那根参考线画出来（单位：画布单位；null = 不画） */
const guideAt = reactive({ x: null, y: null });
/* 吸附半径 / 落点算法在 `lib/board.js`（`SNAP` / `snapX`），这里只管画参考线 */

let dragEl = null;
let dragGroup = []; // 多选一起拖时，每块的原坐标 + DOM
let raf = 0;
let pend = null;

function snapX(x, it) {
  const page = snapXTo(x, it.w, pageSize.value.w);
  // 纸边 / 纸中线优先；没吸上再看别的块
  if (page.line !== null) return page;
  const cands = [];
  for (const o of items.value) {
    if (o.id === it.id) continue;
    cands.push([o.x, o.x], [o.x + Math.round((o.w - it.w) / 2), o.x + Math.round(o.w / 2)], [o.x + o.w - it.w, o.x + o.w]);
  }
  const r = snapTo(cands, x);
  return { x: r.v, line: r.line };
}

/** 吸附：`cands` 是 [落点, 参考线] 成对（居中时落点≠线），4.5mm 内取最近的那个 */
function snapTo(cands, cur) {
  let best = cur;
  let line = null;
  let dist = 1e9;
  for (const [pos, ln] of cands) {
    const d = Math.abs(pos - cur);
    if (d <= 45 && d < dist) {
      dist = d;
      best = pos;
      line = ln;
    }
  }
  return { v: best, line };
}

function snapY(y, it) {
  const H = pageSize.value.h;
  const h = it.h || 400;
  const cands = [
    [0, 0],
    [Math.round((H - h) / 2), Math.round(H / 2)],
    [H - h, H],
  ];
  for (const o of items.value) {
    if (o.id === it.id) continue;
    const oh = o.h || 0;
    cands.push([o.y, o.y], [o.y + Math.round((oh - h) / 2), o.y + Math.round(oh / 2)], [o.y + oh - h, o.y + oh]);
  }
  return snapTo(cands, y);
}

function startDrag(ev, it, mode, corner = 'r') {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  // 点没选中的块 = 只选它；Shift = 加选 / 减选；多选里拖其中一块 = 整组挪
  if (ev.shiftKey && mode === 'move') {
    selIds.value = isSel(it) ? selIds.value.filter((x) => x !== it.id) : [...selIds.value, it.id];
  } else if (!isSel(it) || selIds.value.length === 1) {
    selectOne(it.id);
  }
  // grip 的 mousedown 挂在 span 上，要往上找那块
  dragEl = ev.currentTarget?.closest?.('.board-item') || null;
  dragGroup =
    mode === 'move' && selIds.value.length > 1
      ? selIds.value
          .map((id) => {
            const g = items.value.find((x) => x.id === id);
            const el = pageEl.value && pageEl.value.querySelector(`.board-item[data-id="${id}"]`);
            return g && el ? { it: g, el, ox: g.x, oy: g.y } : null;
          })
          .filter(Boolean)
      : [];
  Object.assign(drag, { on: true, mode, corner, id: it.id, sx: ev.clientX, sy: ev.clientY, ox: it.x, oy: it.y, ow: it.w, oh: it.h || 0, moved: false, nx: it.x, ny: it.y, nw: it.w, nh: it.h || 0 });
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
    for (const g of dragGroup) g.el.style.willChange = 'transform';
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
    const W = pageSize.value.w;
    const H = pageSize.value.h;
    const c = drag.corner || 'r';
    // 手柄名是方位：块给 'l' / 'r'，形状给 nw / ne / sw / se
    const east = c === 'r' || c.endsWith('e');
    const west = c === 'l' || c.endsWith('w');
    const north = c.startsWith('n');
    const south = c.startsWith('s');
    let nw = drag.ow;
    let nx = it.x;
    if (east) nw = clamp(drag.ow + dx, MIN_W, W - it.x);
    if (west) {
      nw = clamp(drag.ow - dx, MIN_W, it.x + drag.ow);
      nx = it.x + (drag.ow - nw);
    }
    drag.nw = Math.round(nw);
    drag.nx = Math.round(nx);
    dragEl.style.left = mm(drag.nx);
    dragEl.style.width = mm(drag.nw);
    // 形状（箭头 / 方框）四角都能拉：宽 + 高一起改，拉左上/右上时 x/y 跟着走
    if (it.type === 'shape') {
      const oh = drag.oh || it.h || 400;
      let nh = oh;
      let ny = it.y;
      if (south) nh = clamp(oh + dy, 120, Math.max(140, H - it.y - 40));
      if (north) {
        nh = clamp(oh - dy, 120, it.y + oh);
        ny = it.y + (oh - nh);
      }
      drag.nh = Math.round(nh);
      drag.ny = Math.round(ny);
      dragEl.style.top = mm(drag.ny);
      dragEl.style.height = mm(drag.nh);
      // 老箭头（没有 up）一旦被拉高，改成「对角」画法
      if (it.shape === 'arrow' && it.up === undefined && drag.nh !== oh) it.up = false;
    }
    return;
  }
  if (dragGroup.length) {
    const d = clampDelta(dragGroup.map((g) => g.it), Math.round(dx), Math.round(dy));
    drag.gdx = d.dx;
    drag.gdy = d.dy;
    for (const g of dragGroup) g.el.style.transform = `translate(${d.dx / 10}mm, ${d.dy / 10}mm)`;
    return;
  }
  const nx = Math.round(clamp(drag.ox + dx, 0, pageSize.value.w - it.w));
  const ny = Math.round(clamp(drag.oy + dy, 0, pageSize.value.h - 100));
  const sx = snapX(nx, it);
  const sy = snapY(ny, it);
  drag.nx = sx.x;
  drag.ny = sy.y;
  guideAt.x = sx.line;
  guideAt.y = sy.line;
  dragEl.style.transform = `translate(${(sx.x - drag.ox) / 10}mm, ${(sy.y - drag.oy) / 10}mm)`;
}

function endDrag() {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  pend = null;
  const it = items.value.find((x) => x.id === drag.id);
  if (it && dragEl && drag.moved && dragGroup.length) {
    for (const g of dragGroup) {
      g.el.style.left = mm(g.ox + drag.gdx);
      g.el.style.top = mm(g.oy + drag.gdy);
      g.el.style.transform = '';
      g.el.style.willChange = '';
      g.it.x = Math.round(g.ox + drag.gdx);
      g.it.y = Math.round(g.oy + drag.gdy);
    }
  } else if (it && dragEl && drag.moved) {
    if (drag.mode === 'size') {
      it.w = drag.nw;
      it.x = drag.nx;
      it.y = drag.ny;
      if (it.type === 'shape' && drag.nh) it.h = drag.nh;
      dragEl.style.width = '';
      dragEl.style.height = '';
      dragEl.style.left = '';
      dragEl.style.top = '';
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
  dragGroup = [];
  guideAt.x = null;
  guideAt.y = null;
  document.body.classList.remove('is-board-dragging');
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', endDrag);
}

/* ---------------- 框选（PPT / ChemDraw 那种橡皮筋） ----------------
   空白处按下拖 → 虚线框；框到谁选谁（按每块的真实矩形比，块的高度是内容撑的，只有 DOM 量得准）。
   点一下空白 = 取消选择；Shift 框选 = 加选。 */
const marq = reactive({ on: false, x0: 0, y0: 0, x1: 0, y1: 0, add: false });
const marqStyle = computed(() => {
  if (!marq.on) return null;
  return {
    left: Math.min(marq.x0, marq.x1) + 'px',
    top: Math.min(marq.y0, marq.y1) + 'px',
    width: Math.abs(marq.x1 - marq.x0) + 'px',
    height: Math.abs(marq.y1 - marq.y0) + 'px',
  };
});

function onPageDown(ev) {
  if (ev.button !== 0 || tool.value) return;
  if (!ev.shiftKey) clearSel();
  Object.assign(marq, { on: true, x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY, add: ev.shiftKey });
  window.addEventListener('mousemove', onMarqMove);
  window.addEventListener('mouseup', endMarq);
}

function onMarqMove(ev) {
  if (!marq.on) return;
  marq.x1 = ev.clientX;
  marq.y1 = ev.clientY;
  const x = Math.min(marq.x0, marq.x1);
  const y = Math.min(marq.y0, marq.y1);
  const w = Math.abs(marq.x1 - marq.x0);
  const h = Math.abs(marq.y1 - marq.y0);
  if (w < 3 && h < 3) return;
  const hit = [];
  for (const el of pageEl.value.querySelectorAll('.board-item')) {
    const b = el.getBoundingClientRect();
    if (b.right < x || b.left > x + w || b.bottom < y || b.top > y + h) continue;
    if (el.dataset.id) hit.push(el.dataset.id);
  }
  selIds.value = marq.add ? [...new Set([...selIds.value, ...hit])] : hit;
}

function endMarq() {
  window.removeEventListener('mousemove', onMarqMove);
  window.removeEventListener('mouseup', endMarq);
  const dragged = marq.on && (Math.abs(marq.x1 - marq.x0) > 3 || Math.abs(marq.y1 - marq.y0) > 3);
  marq.on = false;
  if (!dragged) clearSel(); // 点一下空白 = 取消选择
}

/** 右键：工具还拿在手上就收笔（不然会跟页面右键菜单打架） */
function onPageCtx(ev) {
  if (cancelDraw()) ev.preventDefault();
}

/* ---------------- 键盘 ---------------- */

function onKey(ev) {
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.target?.isContentEditable) return;
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault();
    return ev.shiftKey ? redo() : undo();
  }
  if (ev.key === 'Escape') {
    if (cancelDraw()) return;
    return clearSel();
  }
  const list = selItems.value;
  if (!list.length) return;
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'd' || ev.key === 'D')) {
    ev.preventDefault();
    return list.length > 1 ? duplicateMany() : duplicate(list[0]);
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    return list.length > 1 ? removeMany() : removeItem(list[0]);
  }
  const step = ev.shiftKey ? 100 : 10;
  const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (map[ev.key]) {
    ev.preventDefault();
    moveSelection(map[ev.key][0], map[ev.key][1]);
  }
}

/* ---------------- 页面 / 导出 / 删除 ---------------- */

function togglePage() {
  board.value.page = board.value.page === 'a4l' ? 'a4p' : 'a4l';
  touch();
  setTimeout(fit, 0);
}

/** 导出 = **把整张纸截成一张图**：PDF 就是这张图铺满一页，另给一份 PNG。
    矢量 PDF（print.swift 那套）在字体 / 裁切上出过问题，这里不再用它。 */
function snapDoc() {
  const html = boardHtml(items.value, pageSize.value, expOf, ctxOf());
  const wpx = Math.round((pageSize.value.w / 10 / 25.4) * 96); // A4 竖 794 / 横 1123
  return { html, css: SNAP_CSS, width: wpx };
}

async function exportPdf() {
  if (!items.value.length) return toast('画布还是空的', 'warn');
  exporting.value = true;
  try {
    const name = `${board.value.title || '排版板'}.pdf`;
    const d = snapDoc();
    const blob = await api.snapshotPdf({ ...d, snapWidth: d.width * 2, filename: name });
    downloadBlob(blob, name);
    toast('PDF 好了（截图铺满一页）', 'ok');
  } catch (e) {
    toast(e.message || '导出失败', 'err');
  } finally {
    exporting.value = false;
  }
}

async function exportPng() {
  if (!items.value.length) return toast('画布还是空的', 'warn');
  exporting.value = true;
  try {
    const name = `${board.value.title || '排版板'}.png`;
    const d = snapDoc();
    const blob = await api.snapshotPng({ ...d, snapWidth: d.width * 3, filename: name });
    downloadBlob(blob, name);
    toast('截图好了', 'ok');
  } catch (e) {
    toast(e.message || '截图失败', 'err');
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
  lastSnap = snapNow();
  await new Promise((r) => requestAnimationFrame(r));
  fit();
  if (items.value.length) syncCursor();
  ro = new ResizeObserver(fit);
  if (stageEl.value) ro.observe(stageEl.value);
  syncHistBtns();
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
    <!-- 素材：页面级左栏（以前塞在内容区里 196px，纸被挤扁；现在通高、整列滚动） -->
    <aside class="board-drawer">
      <div class="board-drawer-top">
        <div class="board-drawer-t">
          素材<span class="board-drawer-n">{{ q ? '命中 ' + filExps.length + ' / ' + exps.length : exps.length + ' 条记录' }}</span>
        </div>
        <!-- 搜记录里的字：编号 / 题目 / 底物 / 产物 / 试剂 / 结论正文都算 -->
        <div class="searchbox bd-q">
          <Icon name="search" :size="12" />
          <input v-model="bdQ" type="text" spellcheck="false" placeholder="搜编号 / 试剂 / 产物 / 结论…" />
        </div>
        <div class="bd-rec-chips">
          <button class="bd-chip" title="挑几条记录排成一张对比表" @click="cmpPick = true">对比表…</button>
          <button class="bd-chip" title="挑几条记录，各生成「条件 + TLC 判断」并竖排" @click="groupPick = true">成组摆放…</button>
        </div>
      </div>
      <div class="board-drawer-body" @scroll="unpeek">
        <div v-for="e in filExps" :key="e.id" class="bd-rec">
          <div class="bd-rec-head">
            <span class="mono">{{ e.code }}</span>
            <span class="bd-rec-title">{{ e.title || e.objective || '' }}</span>
          </div>
          <div v-if="hintOf(e)" class="bd-rec-hint">{{ hintOf(e) }}</div>
          <div class="bd-rec-chips">
            <button
              v-for="c in chipsOf(e)"
              :key="c.key"
              class="bd-chip"
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
              :title="`${e.code} · TLC`"
              @click="addTlc(e, t)"
              @mouseenter="peekTlc(e, t, $event)"
              @mouseleave="unpeek"
            >
              <img :src="`/api/files/${t.id}`" alt="" loading="lazy" />
            </button>
          </div>
        </div>
        <div v-if="!exps.length" class="board-drawer-empty">这个课题还没有实验记录</div>
        <div v-else-if="!filExps.length" class="board-drawer-empty">没有匹配「{{ bdQ.trim() }}」的记录</div>
      </div>
    </aside>

    <div class="inner board-inner">
      <!-- 内容区宽度可拖（跟工作台 / 筛选表一个抓手） -->
      <DocGrip />
      <header class="page-head board-head">
        <div class="board-head-main">
          <input v-if="board" v-model="board.title" class="board-title" spellcheck="false" title="改板名" />
          <p class="page-desc">
            点素材摆上来 · 拖动摆位 · 空白处框选 · <b>双击改图注</b> · ⌘D 复制 · Delete 删
          </p>
        </div>
        <div class="board-head-acts">
          <div class="board-acts-row">
            <span class="board-saved">{{ saving ? '保存中…' : '已保存' }}</span>
            <button class="board-tool is-icon" :disabled="!canUndo" title="撤销（⌘Z）" @click="undo">↶</button>
            <button class="board-tool is-icon" :disabled="!canRedo" title="重做（⇧⌘Z）" @click="redo">↷</button>
            <button class="btn btn-sm btn-ghost" @click="togglePage">{{ pageSize.label }}</button>
            <button class="btn btn-sm btn-ghost" @click="pinned = !pinned">{{ pinned ? '适应窗口' : '100%' }}</button>
            <button class="btn btn-sm" :disabled="exporting" @click="exportPdf" title="把整张纸截成图，铺满一页 A4">
              <Icon name="download" :size="12" /> 导出 PDF
            </button>
            <button class="btn btn-sm btn-ghost" :disabled="exporting" @click="exportPng" title="整张纸存成 PNG">存图</button>
            <button class="btn btn-sm btn-ghost" title="回到新画布（Excalidraw）" @click="router.push(`/b/${route.params.id}`)">
              新画布
            </button>
            <button class="btn btn-sm btn-ghost" @click="removeBoard">删除</button>
          </div>
          <!-- 收集工具：都先「拿在手上」，再在纸上点 / 拖（像 ChemDraw 的画布） -->
          <div class="board-acts-row board-palette">
            <span v-if="tool" class="board-armed-hint">{{ toolHint }} · Esc 收笔</span>
            <button
              v-for="t in TOOLS"
              :key="t.key"
              class="btn btn-sm btn-ghost"
              :class="{ 'is-on': tool === t.key }"
              :title="t.hint"
              @click="armTool(t.key)"
            >
              <Icon name="plus" :size="12" /> {{ t.label }}
            </button>
          </div>
        </div>
      </header>

      <div v-if="!board" class="cmp-empty">读取中…</div>
      <div v-else class="board-wrap">
        <!-- 画布：一张 A4，靠 zoom 缩进可视区，纸里全是 mm 单位 -->
        <div
          ref="stageEl"
          class="board-stage"
          :class="{ 'is-pinned': pinned }"
          @mousedown.self="clearSel"
          @dragstart.prevent
          @drop.prevent
        >
          <div
            ref="pageEl"
            class="bd-page board-page"
            :class="{ 'is-armed': !!tool }"
            :style="{ width: mm(pageSize.w), height: mm(pageSize.h), zoom }"
            @mousedown.self="onPageDown"
            @mousedown.capture="onDrawDown"
            @contextmenu="onPageCtx"
          >
            <!-- 拖着的那块：先按 itemHtml 画出来，松手前就看得到粗细 / 方向 -->
            <div
              v-if="draft"
              class="bd-item board-item is-draft"
              :style="{ left: mm(draft.x), top: mm(draft.y), width: mm(draft.w), height: mm(draft.h) }"
            >
              <div class="bd-body" v-html="itemHtml(draft, null, ctxOf())" />
            </div>
            <div
              v-for="it in items"
              :key="it.id"
              class="bd-item board-item"
              :data-id="it.id"
              :class="{ 'is-sel': isSel(it) }"
              :style="{ left: mm(it.x), top: mm(it.y), width: mm(it.w), ...(it.type === 'shape' ? { height: mm(it.h || 400) } : {}), zIndex: it.z || 1 }"
              @mousedown="startDrag($event, it, 'move')"
              @dblclick="editCaption(it)"
            >
              <div class="bd-body" v-html="itemHtml(it, expOf(it), ctxOf())" />
              <template v-if="selIds.length === 1 && isSel(it)">
                <template v-if="it.type === 'shape'">
                  <span
                    v-for="c in ['nw', 'ne', 'sw', 'se']"
                    :key="c"
                    class="board-grip"
                    :class="'is-' + c"
                    :title="`拖${c === 'se' ? '右下' : c === 'nw' ? '左上' : c === 'ne' ? '右上' : '左下'}角改形状 / 角度`"
                    @mousedown.stop="startDrag($event, it, 'size', c)"
                  />
                </template>
                <template v-else>
                  <span class="board-grip is-l" title="拖左边改宽度" @mousedown.stop="startDrag($event, it, 'size', 'l')" />
                  <span class="board-grip is-r" title="拖右边改宽度" @mousedown.stop="startDrag($event, it, 'size', 'r')" />
                </template>
              </template>
            </div>
            <div v-if="guideAt.x != null" class="board-guide is-v" :style="{ left: mm(guideAt.x) }" />
            <div v-if="guideAt.y != null" class="board-guide is-h" :style="{ top: mm(guideAt.y) }" />
            <div v-if="!items.length" class="board-empty">从左边点一个块放上来</div>
          </div>
        </div>
      </div>

    <Teleport to="body">
      <div v-if="marqStyle" class="bd-marquee" :style="marqStyle" />
    </Teleport>

      <!-- 工具条占位固定：选中/取消时版面不动，纸张不会因为多出一行而重新缩放 -->
      <div class="board-tools-bar">
        <!-- 多选：整组置顶 / 置底 / 复制 / 删除 -->
        <div v-if="selItems.length > 1" class="board-tools">
          <span class="board-tools-name">{{ selItems.length }} 块</span>
          <button class="board-tool" @click="raiseMany('top')">置顶</button>
          <button class="board-tool" @click="raiseMany('bottom')">置底</button>
          <button class="board-tool" @click="duplicateMany">复制</button>
          <button class="board-tool is-danger" @click="removeMany">删除</button>
        </div>
        <div v-else-if="selItem" class="board-tools">
          <span class="board-tools-name">
            {{ selItem.type === 'tlc' ? selItem.code || 'TLC'
              : selItem.type === 'text' ? '文字'
              : selItem.type === 'shape' ? (selItem.shape === 'box' ? '方框' : '箭头')
              : (BLOCKS.find((b) => b.key === (selItem.block || 'react')) || {}).label || '块' }}
          </span>
          <!-- 形状：颜色 / 粗细 / 箭头方向 -->
          <template v-if="selItem.type === 'shape'">
            <span class="board-swatches">
              <button
                v-for="c in SHAPE_COLORS"
                :key="c.key"
                type="button"
                class="board-swatch"
                :class="{ 'is-on': (selItem.color || SHAPE_COLORS[0].v) === c.v }"
                :style="{ '--c': c.v }"
                :title="c.label"
                @click="setShapeColor(selItem, c.v)"
              />
            </span>
            <button class="board-tool" @click="toggleThick(selItem)">{{ selItem.thick ? '细一点' : '粗一点' }}</button>
            <template v-if="selItem.shape !== 'box'">
              <button class="board-tool" title="左右翻转箭头" @click="flipShape(selItem)">⇄</button>
              <button class="board-tool" title="上下翻转箭头" @click="flipVertical(selItem)">⇅</button>
            </template>
          </template>
          <button class="board-tool" @click="editCaption(selItem)">{{ selItem.type === 'text' ? '改文字' : '图注' }}</button>
          <button class="board-tool" @click="raise(selItem, 'top')">置顶</button>
          <button class="board-tool" @click="raise(selItem, 'bottom')">置底</button>
          <button class="board-tool" @click="center(selItem)">居中</button>
          <button class="board-tool" @click="duplicate(selItem)">复制</button>
          <button class="board-tool is-danger" @click="removeItem(selItem)">删除</button>
        </div>
      </div>
    </div>

    <!-- 悬停预览：胶囊出那一块、TLC 小图出大图；不吃鼠标，扫过去就走 -->
    <Teleport to="body">
      <div
        v-if="peek"
        class="bd-peek"
        :style="{ left: peek.x + 'px', top: peek.y + 'px', ...(peek.kind === 'block' ? { width: peek.w + 'px' } : {}) }"
      >
        <div class="bd-peek-h">
          <span class="mono">{{ peekCode }}</span>
          <span>{{ peek.kind === 'tlc' ? 'TLC' : blockLabel(peek.key) }}</span>
        </div>
        <img v-if="peek.kind === 'tlc'" class="bd-peek-img" :src="`/api/files/${peek.tlc.id}`" alt="" />
        <div
          v-else
          class="bd-peek-body"
          :style="{ zoom: peekZoom }"
          v-html="peekHtml"
        />
      </div>
    </Teleport>

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
