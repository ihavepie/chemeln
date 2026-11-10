<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import AppModal from './AppModal.vue';
import { toast } from '../lib/feedback.js';
import { api } from '../api.js';
import { applyNumeric } from '../lib/numinput.js';
import { ROLES, ROLE_ALIAS, ROLE_EN, amountText, derive, eqNum, mwText as mwFmt, num, parseMwCell, roleTone, round, rowKind, saneDensity, totals, vesselHint } from '../lib/reagent.js';
import { compoundDict, reagentDict, store } from '../store.js';
import { nameInfo } from '../lib/lookup.js';
import { analyzeSmiles } from '../lib/chem.js';

const props = defineProps({
  model: { type: Object, required: true },
  notify: { type: Function, required: true },
  locked: { type: Boolean, default: false },
});
const emit = defineEmits(['recipe']);

const roleMenuFor = ref(-1);

/* 化合物库：输名字时给带结构缩略图的候选，链上了则悬停看结构 */
const cmpInfo = ref(new Map());
const picker = reactive({ open: false, row: null, items: [], index: 0, q: '', updatedAt: 0 });
const preview = reactive({ open: false, row: null, pinned: false });

/* 双击「试剂」格：弹窗里搜化合物库（比长下拉好翻） */
const browse = reactive({ open: false, row: null, q: '', items: [], index: 0, updatedAt: 0 });
let browseTimer = null;

async function openBrowse(r) {
  browse.row = r;
  browse.q = '';
  browse.index = 0;
  browse.open = true;
  try {
    const items = await api.compounds({});
    mergeCompounds(items);
    browse.items = items.slice(0, 30);
    browse.updatedAt = Date.now();
  } catch {
    browse.items = [];
  }
}

function browseClose() {
  browse.open = false;
  browse.row = null;
  browse.items = [];
  browse.q = '';
}

function onBrowseInput() {
  clearTimeout(browseTimer);
  browseTimer = setTimeout(async () => {
    try {
      const items = await api.compounds({ q: browse.q.trim() });
      mergeCompounds(items);
      browse.items = items.slice(0, 30);
      browse.index = 0;
      browse.updatedAt = Date.now();
    } catch {
      browse.items = [];
    }
  }, 160);
}

/** 行内候选里用鼠标点：列表刚刷新过（可能只是手抖点到）就不响应 */
function pickInline(r, c) {
  if (tooSoon(picker.updatedAt)) return;
  if (c._dict) return applyDict(r, c);
  applyCompound(r, c);
}

/** 从「用过的试剂」里选：只填名字和 MW/浓度，不建化合物关联 */
function applyDict(r, d) {
  r.name = d.name || '';
  if (!String(r.mwText || '').trim()) {
    if (num(d.conc)) r.mwText = `${round(d.conc, 2)}M`;
    else if (num(d.mw) !== null) r.mwText = Number(d.mw).toFixed(2);
    if (String(r.mwText || '').trim()) onMw(r);
  }
  // 词库里记着的组分 / 密度也一起带出来（密度只给溶剂，固体带密度会算出 µL）
  if (d.role && (!r.role || r.role === '试剂')) r.role = d.role;
  if (num(r.density) === null && r.role === '溶剂' && saneDensity(d.density)) r.density = saneDensity(d.density);
  pickerClose();
  props.notify();
}

function browsePick(c) {
  if (!browse.row) return;
  if (tooSoon(browse.updatedAt)) return;
  applyCompound(browse.row, c);
  browseClose();
}

function browseKey(ev) {
  if (!browse.items.length) return;
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    browse.index = (browse.index + 1) % browse.items.length;
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    browse.index = (browse.index - 1 + browse.items.length) % browse.items.length;
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    browsePick(browse.items[browse.index]);
  }
}
let pickerTimer = null;

function mergeCompounds(list) {
  const m = new Map(cmpInfo.value);
  for (const c of list || []) if (c && c.id) m.set(Number(c.id), c);
  cmpInfo.value = m;
}

watch(compoundDict, (list) => mergeCompounds(list), { immediate: true });

const cmpById = (id) => cmpInfo.value.get(Number(id)) || null;


function pickerClose() {
  picker.open = false;
  picker.row = null;
  picker.items = [];
  picker.index = 0;
}

/** 列表刚刚刷新过（用户可能只是想点一下）时，短暂忽略点击 */
const tooSoon = (t) => Date.now() - t < 220;

/** 化合物库之外的「用过的试剂」：库里搜不到的临时试剂，靠这份词典下次还能带出 MW */
function dictHits(q) {
  const k = String(q || '').trim().toLowerCase();
  if (!k) return [];
  return reagentDict()
    .filter((d) => d && d.name && d.name.toLowerCase().includes(k))
    .map((d) => ({ _dict: true, name: d.name, mw: d.mw, conc: d.conc, density: d.density, role: d.role }));
}

async function pickerSearch(q) {
  let items = [];
  try {
    items = await api.compounds({ q });
    mergeCompounds(items);
  } catch {
    items = [];
  }
  // 化合物库优先，后面补上词典里那些「只在这本记录里出现过」的试剂
  const names = new Set(items.map((c) => String(c.name || '').trim().toLowerCase()));
  const extra = dictHits(q).filter((d) => !names.has(d.name.trim().toLowerCase()));
  picker.items = items.slice(0, 8).concat(extra).slice(0, 8);
  picker.index = 0;
  picker.updatedAt = Date.now();
  picker.open = true;
}

/** 化合物库里的类型 → 投料表的组分（底物行固定是底物） */
const KIND_TO_ROLE = { 底物: '底物', 催化剂: '催化剂', 配体: '配体', 中间体: '试剂', 产物: '试剂' };

function applyCompound(r, c) {
  r.compound_id = c.id;
  r.name = c.name || c.code || '';
  const role = KIND_TO_ROLE[c.kind];
  if (role && !isBaseRow(r)) r.role = role;
  if (!String(r.mwText || '').trim() && c.mw) {
    r.mwText = Number(c.mw).toFixed(2);
    onMw(r);
  }
  mergeCompounds([c]);
  pickerClose();
  props.notify();
}

/** 把这一行引用的化合物解绑：名字、结构、MW 一起清掉，行本身留着。
    只清空输入框的话 compound_id 还在，点一下那格照样弹出原来那张结构卡。 */
function unlinkCompound(r) {
  if (!r.compound_id) return;
  const c = cmpById(r.compound_id);
  const same = (a, b) => {
    const x = String(a || '').trim().toLowerCase();
    return !!x && x === String(b || '').trim().toLowerCase();
  };
  // 名字是跟着化合物带进来的才一起清；自己改过的名字留着
  if (c && (same(r.name, c.name) || same(r.name, c.code))) r.name = '';
  delete r.compound_id;
  // MW 是化合物的，用量是拿 MW 算出来的 —— 都跟着作废；当量、mmol 保留
  r.mwText = '';
  r.mw = null;
  r.conc = null;
  r.mass_mg = null;
  r.volume_ul = null;
  r.amountText = '';
  unpinPreview();
  props.notify();
}

/** 点一下那一格才显示结构：不跟随鼠标，不会扫过就乱弹 */
function pinPreview(r) {
  if (!r.compound_id || !cmpById(r.compound_id)) {
    unpinPreview();          // 点到没挂库的行：把上一张结构卡收掉
    return;
  }
  // 记的是「哪一行」而不是「哪个化合物」——两行挂同一个化合物时只弹一行
  preview.row = r;
  preview.pinned = true;
  preview.open = true;
}

function unpinPreview() {
  preview.pinned = false;
  preview.open = false;
  preview.row = null;
}
const roleMenuUp = ref(false);
const dragOrd = ref(null);
const dropMark = ref(null);
const collapsed = ref(new Set());

const rows = computed(() => props.model.rows);
const steps = computed(() => props.model.steps);
const sum = computed(() => totals(rows.value));
/** 体系总体积 → 建议的瓶 / 磁子 / 转速（只是提示） */
const vessel = computed(() => vesselHint({ liquidUl: sum.value.liquidUl, solventUl: sum.value.solventUl }));

const rowsOf = (i) => rows.value.filter((r) => r.step === i + 1);

/** 组分这一列直接显示英文缩写（数据里存的仍是中文，颜色/统计都按中文走） */
const roleLabel = (r) => ROLE_EN[r.role] || r.role || '';
const ROLE_BY_EN = Object.fromEntries(Object.entries(ROLE_EN).map(([zh, en]) => [en.toLowerCase(), zh]));

/** 手输时中文、英文都认：能对上就存回中文，对不上就按自定义组分存 */
function setRoleText(r, raw) {
  const text = String(raw || '').trim();
  if (!text) {
    r.role = '';
    return;
  }
  const lower = text.toLowerCase();
  r.role = ROLE_EN[text] ? text : ROLE_ALIAS[lower] || ROLE_BY_EN[lower] || text;
}
/** v1 的「底物行」= 第 1 步的第一行（不是整表第一行） */
const baseRow = computed(() => rowsOf(0)[0] || null);
const isBaseRow = (r) => baseRow.value === r;
/** 表里真正显示的第一行（rows 的顺序按 position，可能不是第一步在前） */
const firstRow = computed(() => rowsOf(0)[0] || rows.value[0] || null);

/** 只有一步、而且这一步什么都没填时，整条「第 1 步」标题行都不显示 */
const singleStep = computed(() => steps.value.length <= 1);
const stepHasInfo = (s) =>
  !!(String(s.label || '').trim() || String(s.condition || '').trim() || String(s.workup || '').trim() || s.start || s.end);
const showStepHead = (s) => !singleStep.value || stepHasInfo(s);

function syncAmount(r) {
  const next = derive(r);
  r.mass_mg = next.mass_mg ?? null;
  r.volume_ul = next.volume_ul ?? null;
  r.amountText = amountText(next);
}

function recomputeAll() {
  const b = num(props.model.base) || 0;
  rows.value.forEach((r, i) => {
    if (i === 0) {
      if (!b || num(r.mmol) === b) return;
      r.mmol = b;
      if (!eqNum(r.eq)) r.eq = 1;
      syncAmount(r);
      return;
    }
    if (eqNum(r.eq) === null || !b) return;
    r.mmol = round(b * eqNum(r.eq), 4);
    syncAmount(r);
  });
}

function setBase(raw) {
  props.model.base = num(raw);
  recomputeAll();
  props.notify();
}

function onMw(r) {
  const v = parseMwCell(r.mwText);
  r.mw = v.mw;
  r.conc = v.conc;
  if (v.conc) r.mwText = `${round(v.conc, 3)}M`;
  syncAmount(r);
  props.notify();
}

/** MW 那一格：没在编辑时一律「两位小数」（280.4 → 280.40、168 → 168.00） */
function mwDisplay(r) {
  if (r._mwEditing) return r.mwText;
  return mwFmt(r) || r.mwText || '';
}

/** 当量的写法：**小于 1 的用百分数**（0.1 → 10%），1 以上写数字；正在编辑的那格保留原文 */
function eqDisplay(r) {
  const raw = String(r.eq ?? '').trim();
  if (r._eqEditing || !raw) return raw;
  if (raw.endsWith('%')) return raw;
  const x = num(raw);
  if (x !== null && x > 0 && x < 1) return `${round(x * 100, 2)}%`;
  return raw;
}

function onEq(r) {
  const eq = eqNum(r.eq);
  const b = num(props.model.base) || 0;
  if (eq !== null && b) {
    r.mmol = round(b * eq, 4);
    syncAmount(r);
  }
  props.notify();
}

function onMmol(r) {
  const mmol = num(r.mmol);
  if (mmol === null) return props.notify();
  const b = num(props.model.base) || 0;
  if (isBaseRow(r)) {
    props.model.base = mmol;
    r.eq = 1;
    recomputeAll();
  } else if (b) {
    r.eq = round(mmol / b, 3);
  }
  syncAmount(r);
  props.notify();
}

/** 把「1.8023 g / 7.5 mL」解析成质量或体积，并反算 mmol / 当量。
 *  rewrite=false 时（边打字边算）不回写输入框里的文字，免得跟输入打架。 */
function applyAmount(r, { rewrite = true } = {}) {
  const m = /^\s*([\d.]+)\s*(mg|g|ml|l|µl|ul)?\s*$/i.exec(r.amountText || '');
  if (!m) return false;
  const v = Number(m[1]);
  // 溶剂按体积量：写「30」或「30 mL」都当 30 mL（以前没单位就被当成克、还判失败）
  if (r.role === '溶剂' && (!m[2] || /^(ml|l|µl|ul)$/i.test(m[2]))) {
    const ul = /^l$/i.test(m[2] || '') ? v * 1e6 : /^(µl|ul)$/i.test(m[2] || '') ? v : v * 1000;
    r.volume_ul = ul;
    r.mass_mg = null;
    r.mmol = null;
    r.eq = '';
    r.amountText = `${round(ul / 1000, 2)} mL`;
    props.notify();
    return true;
  }
  const unit = (m[2] || 'g').toLowerCase();
  let mmol = null;
  if (unit === 'g' && num(r.mw)) {
    r.mass_mg = v * 1000;
    r.volume_ul = null;   // 手填「0.0062 g」= 按质量称的，别再按密度折成 µL
    mmol = (v * 1000) / num(r.mw);
  } else if (unit === 'mg' && num(r.mw)) {
    r.mass_mg = v;
    r.volume_ul = null;
    mmol = v / num(r.mw);
  } else if ((unit === 'ml' || unit === 'l') && num(r.conc)) {
    const ul = unit === 'l' ? v * 1e6 : v * 1000;
    r.volume_ul = ul;
    r.mass_mg = null;
    mmol = (ul / 1000) * num(r.conc);
  } else {
    return false;
  }
  r.mmol = round(mmol, 4);
  const b = num(props.model.base) || 0;
  if (isBaseRow(r)) {
    props.model.base = mmol;
    r.eq = 1;
    recomputeAll();
  } else if (b) {
    r.eq = round(mmol / b, 3);
  }
  if (rewrite) r.amountText = amountText(r);
  return true;
}

function onAmount(r) {
  applyAmount(r);
  props.notify();
}

/* ---- 边打字边算（不用等失焦） ---- */

function onNameInput(ev, r) {
  r.name = ev.target.value;
  onName(r);

  const q = String(r.name || '').trim();
  clearTimeout(pickerTimer);
  if (!q) {
    pickerClose();
    return;
  }
  picker.row = r;
  picker.q = q;
  pickerTimer = setTimeout(() => void pickerSearch(q), 180);
}

function onMwInput(ev, r) {
  applyNumeric(ev.target, 'Mmg/ol');
  r.mwText = ev.target.value;
  r._mwManual = true;          // 手填过的 MW 不再被「换名字→自动带 MW」覆盖
  const v = parseMwCell(r.mwText);
  r.mw = v.mw;
  r.conc = v.conc;
  syncAmount(r);
  props.notify();
}

function onEqInput(ev, r) {
  applyNumeric(ev.target, '%');     // 当量可以写 `10%`（摩尔百分数）
  r.eq = ev.target.value;
  const eq = eqNum(r.eq);
  const b = num(props.model.base) || 0;
  if (eq !== null && b) {
    r.mmol = round(b * eq, 4);
    syncAmount(r);
  }
  props.notify();
}

function onMmolInput(ev, r) {
  applyNumeric(ev.target, '');
  r.mmol = ev.target.value;
  const mmol = num(r.mmol);
  if (mmol !== null) {
    const b = num(props.model.base) || 0;
    if (isBaseRow(r)) {
      props.model.base = mmol;
      r.eq = 1;
      recomputeAll();
    } else if (b) {
      r.eq = round(mmol / b, 3);
    }
    syncAmount(r);
  }
  props.notify();
}

function onAmountInput(ev, r) {
  applyNumeric(ev.target, 'mgLlUµu');
  r.amountText = ev.target.value;
  applyAmount(r, { rewrite: false });
  props.notify();
}

/**
 * 库里、词典里都没有的试剂：拿名字去 PubChem 查一次（服务端代查 + 本地缓存）。
 * 查到了就把 MW / 密度填进空着的格子；查不到什么都不做，绝不能挡住录数据。
 */
async function lookupName(r, key0) {
  const key = String(key0 || r.name || '').trim();
  if (!key || r.compound_id) return;
  if (r._mwManual) return;                         // 手填过就不动
  if (r._looked === key) return;                   // 同一个名字只查一次
  r._looked = key;
  const info = await nameInfo(key);
  if (r._mwManual) return;                         // 查的时候用户自己填了
  if (String(r.name || '').trim().toLowerCase() !== key.toLowerCase()) return;   // 名字又改了，这次结果作废
  if (!info || !info.found) {
    // 查不到（断网 / 自造缩写 / 金属配合物）：不弹 toast，只在放大镜上点一个小点提示
    r._miss = true;
    const d = reagentDict().find((x) => String(x.name || '').toLowerCase() === key.toLowerCase());
    if (d && (num(d.conc) !== null || num(d.mw) !== null)) {
      r.mwText = num(d.conc) ? `${round(d.conc, 2)}M` : Number(d.mw).toFixed(2);
      onMw(r);
      if (d.role && (!r.role || r.role === '试剂')) r.role = d.role;
      props.notify();
    }
    return;
  }
  r._miss = false;
  let mw = num(info.mw);
  // OPSIN 只回 SMILES：拿它在本地算分子式 / MW（openchemlib，不用联网）
  if (mw === null && info.smiles) {
    try {
      const a = await analyzeSmiles(info.smiles);
      if (num(a && a.mw) !== null) mw = a.mw;
    } catch {
      /* 算不出来就算了，手填就行 */
    }
  }
  if (mw !== null) {
    r.mwText = Number(mw).toFixed(2);
    onMw(r);
  }
  // 只有「溶剂」这一行才自动带密度（固体试剂带密度会算出 µL 这种没意义的用量），
  // 而且必须落在合理区间，见 lib/reagent.js 的 saneDensity
  if (num(r.density) === null && r.role === '溶剂' && info.props && saneDensity(String(info.props.density || '').replace(/[^\d.]/g, ''))) {
    r.density = saneDensity(String(info.props.density || '').replace(/[^\d.]/g, ''));
  }
  props.notify();
}

/** 名字格失焦：没手填过 MW 就按名字核对一次（缓存命中很快，不会每次都发请求） */
function verifyName(r) {
  const key = String(r.name || '').trim();
  if (!key || r.compound_id || r._mwManual) return;
  void lookupName(r, key);
}

/** 手动重查（名字格右侧的小放大镜）：以 PubChem 为准，覆盖手填值和词典里的旧值 */
async function recheck(r) {
  const key = String(r.name || '').trim();
  if (!key) return toast('先填试剂名', 'warn');
  const info = await nameInfo(key);
  if (!info || !info.found) {
    r._miss = true;
    return toast(`PubChem 里没有「${key}」：直接手填 MW，下次打这个名字就会自动带出来`, 'warn', 3600);
  }
  const changed = [];
  if (num(info.mw) !== null) {
    r.mwText = Number(info.mw).toFixed(2);
    r._mwManual = false;
    onMw(r);
    changed.push(`MW ${round(Number(info.mw), 2)}`);
  }
  if (info.props && info.props.density) {
    const d = Number(String(info.props.density).replace(/[^\d.]/g, ''));
    if (d > 0) {
      r.density = d;
      changed.push(`密度 ${round(d, 3)}`);
    }
  }
  props.notify();
  toast(changed.length ? `已按 PubChem 更新：${changed.join(' · ')}` : '查到了，但没有 MW/密度', changed.length ? 'ok' : 'warn');
}

/** 试剂名填的是化合物库里的编号 / 名称 → 带出 MW 并记下关联 */
function onName(r) {
  const key = String(r.name || '').trim().toLowerCase();
  // 名字都被删空了 → 就把引用的化合物一起解绑，别留一张点得开的结构卡
  if (!key) {
    if (r.compound_id) return unlinkCompound(r);
    return props.notify();
  }
  const hit = compoundDict().find((c) => (c.code || '').toLowerCase() === key || (c.name || '').toLowerCase() === key);
  if (hit) {
    r.compound_id = hit.id;
    if (!r._mwManual && hit.mw) {
      r.mwText = Number(hit.mw).toFixed(2);
      onMw(r);
      return;
    }
  } else if (!r._mwManual) {
    // 化合物库里没有 → 先按「用过的试剂」词库秒填（名字 / 分子量 / 密度 / 组分角色），
    // 再让 PubChem 去核对（查不到也不影响：词库的值已经在了）
    const d = reagentDict().find((x) => String(x.name || '').toLowerCase() === key);
    if (d) {
      if (num(d.conc) !== null) { r.mwText = `${round(d.conc, 2)}M`; onMw(r); }
      else if (num(d.mw) !== null) { r.mwText = Number(d.mw).toFixed(2); onMw(r); }
      if (num(r.density) === null && r.role === '溶剂' && saneDensity(d.density)) r.density = saneDensity(d.density);
      // 角色只在还没挑过的时候才替他填（用户自己选的组分不被覆盖）
      if (d.role && (!r.role || r.role === '试剂')) r.role = d.role;
    }
    void lookupName(r, key);
  }
  props.notify();
}

function setRole(r, role) {
  r.role = role;
  roleMenuFor.value = -1;
  props.notify();
}

/** 投料行：把库里的值摊成一行（跟 EditorView 里那份 toRow 同构，字段少一点） */
function toRow(r) {
  const row = {
    step: Math.max(1, Number(r.step) || 1),
    role: r.role || '',
    name: r.name || '',
    mw: r.mw ?? null,
    conc: r.conc ?? null,
    density: r.density ?? null,
    eq: r.eq ?? null,
    mmol: null,
    mass_mg: null,
    volume_ul: null,
    note: r.note || '',
    compound_id: null,
  };
  row.mwText = mwFmt(row) || '';
  row.amountText = '';
  return row;
}

/** 从「试剂库」挑一个：一次把名字 / 组分 / 分子量 / 浓度·密度 填好，再按当前规模算用量 */
const libOpen = ref(false);
const libItems = ref([]);
const libQ = ref('');
const libLoading = ref(false);

async function openLib() {
  libOpen.value = true;
  libQ.value = '';
  libLoading.value = true;
  try {
    libItems.value = await api.reagents(store.project);
  } catch {
    libItems.value = [];
  } finally {
    libLoading.value = false;
  }
}

const libShown = computed(() => {
  const k = libQ.value.trim().toLowerCase();
  return libItems.value.filter((it) => !k || String(it.name || '').toLowerCase().includes(k) || String(it.role || '').includes(k));
});

function pickFromLib(it) {
  const role = it.role || '试剂';
  const row = toRow({
    step: steps.value.length,
    role,
    name: it.name,
    mw: num(it.mw),
    conc: num(it.conc),
    density: role === '溶剂' ? saneDensity(it.density) : null,
    eq: 1,
    note: '',
  });
  props.model.rows.push(row);
  onEq(row);              // 按当前反应规模算 mmol / 用量
  libOpen.value = false;
  props.notify();
}

function addRow(step) {
  props.model.rows.push({ step: step || steps.value.length, role: '试剂', eq: 1, mwText: '', amountText: '', name: '', note: '' });
  props.notify();
}

/** 溶剂也是投料表的一行（以前单独摆在「条件」里，用户想直接在这里加） */
function addSolvent() {
  props.model.rows.push({ step: steps.value.length, role: '溶剂', eq: '', mwText: '', amountText: '', name: '', note: '' });
  props.notify();
}

function removeRow(r) {
  const i = props.model.rows.indexOf(r);
  if (i < 0) return;
  props.model.rows.splice(i, 1);
  if (preview.row === r) unpinPreview();
  roleMenuFor.value = -1;
  props.notify();
}

function addStep() {
  props.model.steps.push({ label: '', condition: '', workup: '', start: '', end: '', addition: '', stir: '' });
  props.model.rows.push({ step: props.model.steps.length, role: '试剂', eq: 1, mwText: '', amountText: '', name: '', note: '' });
  props.notify();
}

function removeStep(i) {
  if (props.model.steps.length <= 1) return;
  props.model.steps.splice(i, 1);
  props.model.rows = props.model.rows
    .map((r) => (r.step === i + 1 ? { ...r, step: Math.max(1, i) } : r.step > i + 1 ? { ...r, step: r.step - 1 } : r))
    .filter((r) => r.step <= props.model.steps.length);
  props.notify();
}

function toggleCollapse(i) {
  const s = new Set(collapsed.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  collapsed.value = s;
}

function onStepField(i, key, value) {
  props.model.steps[i][key] = value;
  props.notify();
}

/** 起止时间：只收数字和冒号（9:15 / 09:15:20） */
function onStepTime(ev, i, key) {
  applyNumeric(ev.target, ':');
  onStepField(i, key, ev.target.value);
}

/** 「1a」「THF」这种短名字，用来起头说明这是哪一行 */
const rowLabel = (r) => (r.name || '').trim() || (r.role || '这一行');

/** 一行实际的换算：mmol + (MW 或 浓度) → 克 / 毫升 */
function amountMath(mmol, mw, conc) {
  if (conc && mmol !== null) return `${round(mmol, 3)} mmol ÷ ${round(conc, 3)} M = ${round(mmol / conc, 3)} mL`;
  if (mw && mmol !== null) return `${round(mmol, 3)} mmol × ${round(mw, 2)} = ${round((mmol * mw) / 1000, 4)} g`;
  return '';
}

function toggleRoleMenu(r, ev) {
  const idx = rows.value.indexOf(r);
  if (roleMenuFor.value === idx) {
    roleMenuFor.value = -1;
    return;
  }
  const rect = ev.currentTarget.getBoundingClientRect();
  // 下面放不下就往上开（菜单 11 个胶囊，约 110–150px）
  roleMenuUp.value = rect.bottom + 150 > window.innerHeight;
  roleMenuFor.value = idx;
}

function closeRoleMenu() {
  if (roleMenuFor.value !== -1) roleMenuFor.value = -1;
}

function onDocClick(ev) {
  if (preview.pinned && !ev.target.closest?.('.cmp-pop') && !ev.target.closest?.('.name-cell')) unpinPreview();
  if (picker.open && !ev.target.closest?.('.cmp-pick') && !ev.target.closest?.('[data-f="name"]')) pickerClose();
  if (roleMenuFor.value === -1) return;
  if (ev.target.closest?.('.role-menu') || ev.target.closest?.('.role-caret')) return;
  closeRoleMenu();
}

function onDocKey(ev) {
  if (ev.key !== 'Escape') return;
  closeRoleMenu();
  if (preview.open) unpinPreview();
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onDocKey);
});

function hintFor(r, field) {
  const mmol = num(r.mmol);
  const mw = num(r.mw);
  const conc = num(r.conc);
  const eq = eqNum(r.eq);
  const base = num(props.model.base);
  const name = rowLabel(r);

  if (field === 'mwcell') {
    if (conc && mmol !== null) return `${name}：${amountMath(mmol, null, conc)}`;
    if (mw && mmol !== null) return `${name}：${amountMath(mmol, mw, null)}`;
    return `${name}：填分子量（如 120.15）或浓度（如 2 M）`;
  }

  if (field === 'eq') {
    if (isBaseRow(r)) return `${name}：基准行，${round(mmol ?? base ?? 0, 3)} mmol 就是反应规模`;
    if (eq !== null && base) {
      const mmolOut = base * eq;
      const extra = amountMath(mmolOut, mw, conc);
      return `${name}：${round(base, 3)} mmol × ${round(eq, 3)} eq = ${round(mmolOut, 4)} mmol${extra ? ` → ${extra.split(' = ')[1]}` : ''}`;
    }
    return `${name}：${eq === null ? '未填当量' : `${round(eq, 3)} eq`}，规模 ${base ? `${round(base, 3)} mmol` : '未填'}`;
  }

  if (field === 'mmol') {
    const math = amountMath(mmol, mw, conc);
    if (math) return `${name}：${math}`;
    return `${name}：${mmol === null ? '未填 mmol' : `${round(mmol, 3)} mmol`}${mw || conc ? '' : '（需填分子量或浓度方可计算用量）'}`;
  }

  if (field === 'amount') {
    if (mmol === null) return `${name}：先填当量或 mmol，用量将自动计算`;
    const math = amountMath(mmol, mw, conc);
    return math ? `${name}：${math}` : `${name}：${round(mmol, 3)} mmol`;
  }

  return '';
}

/** 没聚焦时显示基准行（底物）的算式，而不是一句空话 */
const defaultHint = computed(() => {
  const b = baseRow.value;
  if (!b) return '';
  const name = rowLabel(b);
  const mmol = num(b.mmol) ?? num(props.model.base);
  const mw = num(b.mw);
  const conc = num(b.conc);
  const math = amountMath(mmol, mw, conc);
  if (math) return `${name}：${math}`;
  if (mmol !== null) return `${name}：规模 ${round(mmol, 3)} mmol（填写分子量后自动计算用量）`;
  return '';
});

const focus = ref(null);
const focusHint = (r, field) => {
  focus.value = { r, field };
};
const blurHint = () => {
  focus.value = null;
};
const footInfo = computed(() => (focus.value ? hintFor(focus.value.r, focus.value.field) : defaultHint.value));

function onKeydown(ev, r, field) {
  if (props.locked) return;

  // 化合物候选列表打开时，方向键 / 回车先给它
  if (field === 'name' && picker.open && picker.row === r && picker.items.length) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      picker.index = (picker.index + 1) % picker.items.length;
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      picker.index = (picker.index - 1 + picker.items.length) % picker.items.length;
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      applyCompound(r, picker.items[picker.index]);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      pickerClose();
      return;
    }
  }

  // 回车 = 「这一格填完了」：提交并退出，不再自己跳下一行 / 新建一行。
  // 想往下走用 Tab；确实要再加一行就用 ⌘↩。
  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (ev.metaKey || ev.ctrlKey) {
      addRow(r.step);
      return;
    }
    ev.target.blur();
    props.notify();
    return;
  }

  if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'Backspace' || ev.key === 'Delete')) {
    ev.preventDefault();
    removeRow(r);
  }
}

function onDragStart(ev, r) {
  if (props.locked) return;
  dragOrd.value = rows.value.indexOf(r);
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(dragOrd.value));
}

function onDragOver(ev, r) {
  if (dragOrd.value === null) return;
  ev.preventDefault();
  const rect = ev.currentTarget.getBoundingClientRect();
  dropMark.value = { ord: rows.value.indexOf(r), before: ev.clientY < rect.top + rect.height / 2, step: r.step };
}

function onDrop(ev) {
  if (dragOrd.value === null || !dropMark.value) return;
  ev.preventDefault();
  const from = dragOrd.value;
  const mark = dropMark.value;
  const list = props.model.rows;
  const [moved] = list.splice(from, 1);
  let ins = mark.ord;
  if (from < mark.ord) ins -= 1;
  if (!mark.before) ins += 1;
  moved.step = mark.step;
  list.splice(Math.max(0, Math.min(list.length, ins)), 0, moved);
  dragOrd.value = null;
  dropMark.value = null;
  props.notify();
}
</script>

<template>
  <section class="sec sec-tight">
    <div class="block-head">
      <span class="lbl">投料表</span>
      <span class="spacer" />
      <label class="scale-inline">
        <span>反应规模</span>
        <input type="number" step="any" :value="model.base ?? ''" placeholder="0.00" :disabled="locked" @input="setBase($event.target.value)" />
        <span class="unit">mmol</span>
      </label>
    </div>

    <table class="rtable" id="rtable">
      <colgroup>
        <col class="c-grip" /><col class="c-role" /><col class="c-name" /><col class="c-mw" />
        <col class="c-eq" /><col class="c-mmol" /><col class="c-amt" /><col class="c-note" /><col class="c-del" />
      </colgroup>
      <thead>
        <tr>
          <th class="grip-cell" />
          <th>组分</th><th>试剂</th><th class="n">MW / 浓度</th>
          <th class="n">当量</th><th class="n">mmol</th><th class="n">用量</th><th>说明</th><th class="noprint" />
        </tr>
      </thead>
      <tbody @drop="onDrop" @dragover.prevent>
        <template v-for="(s, si) in steps" :key="si">
          <tr
            v-if="showStepHead(s)"
            class="step-head"
            :class="{ 'step-bare': singleStep }"
            :data-step="si + 1"
          >
            <td colspan="9" class="step-cell">
              <div class="step-line step-line-head">
                <button type="button" class="step-caret noprint" @click="toggleCollapse(si)"><Icon name="chevron" :size="11" /></button>
                <span class="step-no">第 {{ si + 1 }} 步</span>
                <input class="step-label" :value="s.label" placeholder="本步内容" :disabled="locked" @change="onStepField(si, 'label', $event.target.value)" />
                <template v-if="steps.length > 1 || s.condition">
                  <span class="step-tag">条件</span>
                  <input class="step-cond" :value="s.condition" :disabled="locked" @change="onStepField(si, 'condition', $event.target.value)" />
                </template>
                <template v-if="steps.length > 1 || s.workup">
                  <span class="step-tag">之后</span>
                  <input class="step-after" :value="s.workup" :disabled="locked" @change="onStepField(si, 'workup', $event.target.value)" />
                </template>
                <span class="step-spacer" />
                <button type="button" class="step-add noprint" title="在这一步加一行投料" @click="addRow(si + 1)"><Icon name="plus" :size="11" /></button>
                <button type="button" class="step-del noprint" title="删除这一步" @click="removeStep(si)"><Icon name="x" :size="11" /></button>
              </div>
              <div class="step-line step-line-sub noprint-wrap">
                <template v-if="steps.length > 1 || s.addition">
                  <span class="step-tag">加料</span>
                  <input class="step-addmode" :value="s.addition" placeholder="滴加 / 分批" :disabled="locked" @change="onStepField(si, 'addition', $event.target.value)" />
                </template>
                <template v-if="steps.length > 1 || s.stir">
                  <span class="step-tag">搅拌</span>
                  <input class="step-stir" :value="s.stir" placeholder="500 rpm" :disabled="locked" @change="onStepField(si, 'stir', $event.target.value)" />
                </template>
                <span class="step-spacer" />
                <span class="step-time">
                  <input
                    class="step-time-in"
                    :value="s.start"
                    placeholder="起"
                    :disabled="locked"
                    @input="onStepTime($event, si, 'start')"
                  />
                  <span class="step-time-sep">→</span>
                  <input
                    class="step-time-in"
                    :value="s.end"
                    placeholder="止"
                    :disabled="locked"
                    @input="onStepTime($event, si, 'end')"
                  />
                </span>
              </div>
            </td>
          </tr>

          <template v-if="!collapsed.has(si)">
            <tr
              v-for="r in rowsOf(si)"
              :key="rows.indexOf(r)"
              class="reag-row"
              :class="{
                base: isBaseRow(r),
                'has-cmp': r.compound_id,
                'step-multi': rowsOf(si).length > 1,
                'menu-open': roleMenuFor === rows.indexOf(r),
              }"
              :data-step="si + 1"
              :data-tone="roleTone(r.role)"
              @dragover="onDragOver($event, r)"
            >
              <td class="grip-cell">
                <span class="grip" draggable="true" title="拖动调整加料顺序" @dragstart="onDragStart($event, r)">⠿</span>
              </td>
              <td class="role-cell">
                <div class="role-wrap">
                  <input
                    class="role-input"
                    data-f="role"
                    :value="roleLabel(r)"
                    placeholder="Rgt"
                    :disabled="locked"
                    spellcheck="false"
                    @change="setRoleText(r, $event.target.value); notify()"
                  />
                  <button v-if="!locked" type="button" class="role-caret noprint" title="从固定组分里选" @click.stop="toggleRoleMenu(r, $event)">
                    <Icon name="down" :size="11" />
                  </button>
                </div>
                <!-- 点菜单空白处也算「有反应」：直接关掉，别让那一下像是没点到 -->
                <div v-if="roleMenuFor === rows.indexOf(r)" class="qmenu role-menu" :class="{ up: roleMenuUp }" @click.stop="closeRoleMenu">
                  <button
                    v-for="role in ROLES"
                    :key="role"
                    type="button"
                    class="qchip"
                    :data-tone="roleTone(role)"
                    :aria-selected="role === r.role"
                    @click="setRole(r, role)"
                  >
                    {{ role }}<span class="role-en">{{ ROLE_EN[role] }}</span>
                  </button>
                </div>
              </td>
              <td class="name-cell" @click="pinPreview(r)">
                <input
                  data-f="name"
                  :value="r.name"
                  :title="r.name || ''"
                  :placeholder="isBaseRow(r) ? '起始原料' : '试剂名称'"
                  :disabled="locked"
                  @input="onNameInput($event, r)"
                  @change="onName(r)"
                  @keydown="onKeydown($event, r, 'name')"
                  @blur="verifyName(r)"
                  @dblclick.prevent="openBrowse(r)"
                />
                <button
                  v-if="!locked && String(r.name || '').trim() && !r.compound_id"
                  type="button"
                  class="name-lookup noprint"
                  :class="{ 'is-miss': r._miss }"
                  title="按名字去 PubChem 查 MW / 密度"
                  @click.stop="recheck(r)"
                >
                  <Icon name="search" :size="10" />
                </button>

                <!-- 结构式预览：这一行链了库里的化合物，鼠标移上来就显示 -->
                <div
                  v-if="preview.open && preview.row === r && cmpById(r.compound_id)"
                  class="cmp-pop"
                  :class="{ 'is-pinned': preview.pinned }"
                >
                  <button v-if="preview.pinned" type="button" class="cmp-pop-x" title="关闭" @click.stop="unpinPreview">
                    <Icon name="x" :size="11" />
                  </button>
                  <div class="cmp-pop-fig">
                    <img
                      v-if="cmpById(r.compound_id).structure_id"
                      :src="`/api/compound-files/${cmpById(r.compound_id).structure_id}`"
                      alt=""
                    />
                    <span v-else class="hint">（没有结构图）</span>
                  </div>
                  <div class="cmp-pop-meta">
                    <b>{{ cmpById(r.compound_id).code || '—' }}</b>
                    <span>{{ cmpById(r.compound_id).name || '（未命名）' }}</span>
                    <!-- 分子式那一行右边顺手放「移除」：引错了化合物就摘掉关联，行留着 -->
                    <div class="cmp-pop-line">
                      <span class="mono">
                        {{ cmpById(r.compound_id).formula || '' }}
                        <template v-if="cmpById(r.compound_id).mw">· MW {{ round(cmpById(r.compound_id).mw, 2) }}</template>
                      </span>
                      <button v-if="!locked" type="button" class="cmp-pop-unlink" title="解绑这个化合物，行留着" @click.stop="unlinkCompound(r)">
                        移除
                      </button>
                    </div>
                  </div>
                </div>

                <!-- 输名字时的候选（带结构缩略图，最多 8 条） -->
                <div v-if="picker.open && picker.row === r" class="cmp-pick" @mousedown.prevent>
                  <button
                    v-for="(c, ci) in picker.items"
                    :key="c._dict ? `d:${c.name}` : c.id"
                    type="button"
                    :class="{ on: ci === picker.index }"
                    @click.stop="pickInline(r, c)"
                    @mouseenter="picker.index = ci"
                  >
                    <img v-if="c.structure_id" class="cmp-pick-fig" :src="`/api/compound-files/${c.structure_id}`" alt="" />
                    <span v-else class="cmp-pick-fig cmp-pick-fig-empty" />
                    <span class="cmp-pick-code mono">{{ c._dict ? '用过' : (c.code || '—') }}</span>
                    <span class="cmp-pick-name">{{ c.name || '（未命名）' }}</span>
                    <span class="cmp-pick-meta mono"><template v-if="c._dict"><template v-if="c.mw">MW {{ Number(c.mw).toFixed(2) }}</template><template v-else-if="c.conc">{{ round(c.conc, 2) }}M</template><template v-if="saneDensity(c.density)"> · ρ {{ round(c.density, 2) }}</template><template v-if="c.role"> · {{ c.role }}</template></template><template v-else>{{ c.formula || '' }}<template v-if="c.mw"> · {{ round(c.mw, 2) }}</template><template v-else-if="c.conc"> · {{ round(c.conc, 2) }}M</template></template></span>
                  </button>
                  <div v-if="!picker.items.length" class="cmp-pick-empty">化合物库和「用过的试剂」里都没有「{{ picker.q }}」</div>
                </div>
              </td>
              <td>
                <input class="n mw-cell" data-f="mwcell" :value="mwDisplay(r)" :disabled="locked" @input="onMwInput($event, r)" @change="onMw(r)" @focus="r._mwEditing = true; focusHint(r, 'mwcell')" @blur="r._mwEditing = false; onMw(r); blurHint()" @keydown="onKeydown($event, r, 'mwcell')" />
              </td>
              <td>
                <input class="n" data-f="eq" inputmode="decimal" :value="eqDisplay(r)" :disabled="locked" @input="onEqInput($event, r)" @change="onEq(r)" @focus="r._eqEditing = true; focusHint(r, 'eq')" @blur="r._eqEditing = false; onEq(r); blurHint()" @keydown="onKeydown($event, r, 'eq')" />
              </td>
              <td>
                <input class="n calc" data-f="mmol" inputmode="decimal" :value="r.mmol ?? ''" :disabled="locked" @input="onMmolInput($event, r)" @change="onMmol(r)" @focus="focusHint(r, 'mmol')" @blur="blurHint" @keydown="onKeydown($event, r, 'mmol')" />
              </td>
              <td class="amount-td" :data-kind="rowKind(r)">
                <input class="n calc amount-cell" data-f="amount" :value="r.amountText" :disabled="locked" @input="onAmountInput($event, r)" @change="onAmount(r)" @focus="focusHint(r, 'amount')" @blur="blurHint" @keydown="onKeydown($event, r, 'amount')" />
              </td>
              <td class="note-td">
                <input class="note-cell" data-f="note" :value="r.note" :placeholder="firstRow === r ? '说明' : ''" :disabled="locked" @input="r.note = $event.target.value" @change="notify()" />
              </td>
              <td class="rowend">
                <button v-if="!locked" class="del noprint" title="删除该行" @click="removeRow(r)"><Icon name="x" :size="12" /></button>
              </td>
            </tr>
          </template>
        </template>
      </tbody>
      <tfoot>
        <tr class="rtable-total">
          <td class="grip-cell" />
          <td colspan="8">
            <div class="foot-line">
              <div class="totals">
                <span class="tot-lbl">合计</span>
                <span v-if="model.base" class="tot">规模 {{ round(model.base, 3) }} mmol</span>
                <template v-if="sum.solidMg"><span class="tot-sep">·</span><span class="tot">固体 {{ round(sum.solidMg / 1000, 4) }} g</span></template>
                <template v-if="sum.liquidUl"><span class="tot-sep">·</span><span class="tot">液体 / 溶液 {{ round(sum.liquidUl / 1000, 2) }} mL</span></template>
                <template v-if="sum.solventUl"><span class="tot-sep">·</span><span class="tot">溶剂 {{ round(sum.solventUl / 1000, 2) }} mL</span></template>
                <template v-if="vessel">
                  <span class="tot-sep">·</span>
                  <span class="tot tot-vessel" :title="`体系约 ${vessel.ml} mL；按「装量不超过瓶子六成」选瓶，磁子按瓶内径的 0.6–0.7 估`">
                    {{ vessel.tight ? '超过 3 L，分釜做' : `${vessel.flask} mL 瓶 · ${vessel.bar} 磁子` }}
                  </span>
                </template>
              </div>
              <div class="calc-hint">{{ footInfo }}</div>
            </div>
          </td>
        </tr>
        <tr v-if="!locked" class="rtable-add noprint">
          <td colspan="9">
            <div class="add-cell">
              <button class="add-row" @click="addRow(steps.length)"><Icon name="plus" :size="12" /> 添加试剂</button>
              <button class="add-row" @click="addSolvent"><Icon name="plus" :size="12" /> 加溶剂</button>
              <button class="add-row" @click="openLib"><Icon name="flask" :size="12" /> 从试剂库选</button>
              <button class="add-row" @click="addStep"><Icon name="plus" :size="12" /> 加一步</button>
              <span class="spacer" />
              <button class="add-row" @click="emit('recipe')"><Icon name="copy" :size="12" /> 套用配方</button>
            </div>
          </td>
        </tr>
      </tfoot>
    </table>

    <AppModal v-if="libOpen" :model-value="libOpen" title="从试剂库选一个" :show-footer="false" width="520px" @close="libOpen = false">
      <input v-model="libQ" class="lib-search" placeholder="搜试剂名 / 组分…" spellcheck="false" />
      <div v-if="libLoading" class="lib-empty">读取中…</div>
      <div v-else-if="!libShown.length" class="lib-empty">试剂库里没有匹配的条目。</div>
      <div v-else class="lib-list">
        <button v-for="it in libShown" :key="it.name" type="button" class="lib-row" @click="pickFromLib(it)">
          <span class="lib-name">{{ it.name }}</span>
          <span class="lib-role">{{ it.role || '试剂' }}</span>
          <span class="lib-meta mono"><template v-if="it.conc">= {{ Number(it.conc).toFixed(2) }} M</template><template v-else-if="it.mw != null">{{ Number(it.mw).toFixed(2) }}<template v-if="it.per_mmol_g"> · 1 mmol {{ it.per_mmol_g }} g</template><template v-if="it.per_mmol_ul"> / {{ it.per_mmol_ul }} µL</template></template></span>
        </button>
      </div>
    </AppModal>

    <AppModal
      v-if="browse.open"
      title="从化合物库选一个"
      :show-footer="false"
      width="600px"
      @close="browseClose"
    >
      <input
        class="input mono"
        v-model="browse.q"
        placeholder="搜编号 / 名称 / 分子式（如 1a、苯甲醛、C8H8O）"
        style="width: 100%; margin-bottom: 10px"
        @input="onBrowseInput"
        @keydown="browseKey"
        v-focus
      />
      <div class="cmp-browse" @mouseleave="browse.index = -1">
        <button
          v-for="(c, ci) in browse.items"
          :key="c.id"
          type="button"
          :class="{ on: ci === browse.index }"
          @click="browsePick(c)"
          @mouseenter="browse.index = ci"
        >
          <span class="cmp-browse-fig">
            <img v-if="c.structure_id" :src="`/api/compound-files/${c.structure_id}`" alt="" />
          </span>
          <span class="cmp-browse-code mono">{{ c.code || '—' }}</span>
          <span class="cmp-browse-name">{{ c.name || '（未命名）' }}</span>
          <span class="cmp-browse-meta mono">{{ c.formula || '' }}<template v-if="c.mw"> · {{ round(c.mw, 2) }}</template></span>
        </button>
        <div v-if="!browse.items.length" class="hint" style="padding: 12px 2px">无匹配化合物</div>
      </div>
      <div class="hint" style="margin-top: 8px">点击即选用该化合物；<kbd>Esc</kbd> 或点击对话框外侧关闭。</div>
    </AppModal>

    <slot name="cond" />
  </section>
</template>
