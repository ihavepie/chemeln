<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppModal from '../components/AppModal.vue';
import ExperimentMobile from '../components/ExperimentMobile.vue';
import ExpListPane from '../components/ExpListPane.vue';
import PaneGrip from '../components/PaneGrip.vue';
import AttachmentsBlock from '../components/AttachmentsBlock.vue';
import FilePreview from '../components/FilePreview.vue';
import CondRow from '../components/CondRow.vue';
import ReagentTable from '../components/ReagentTable.vue';
import ResultBlock from '../components/ResultBlock.vue';
import SchemeBlock from '../components/SchemeBlock.vue';
import SketcherModal from '../components/SketcherModal.vue';
import TlcStrip from '../components/TlcStrip.vue';
import Icon from '../components/Icon.vue';
import CatPick from '../components/CatPick.vue';
import HistoryModal from '../components/HistoryModal.vue';
import PrintPanel from '../components/PrintPanel.vue';
import ProjPick from '../components/ProjPick.vue';
import { api } from '../api.js';
import { loadBoot, loadList, loadCompounds, store, categoriesOfProject, addCategory, reagentDict } from '../store.js';
import { STATUSES, STATUS_TONE, isImageName, todayISO } from '../lib/ui.js';
import { sheetPrefs } from '../lib/sheetprefs.js';
import { KINDS, RXN_TYPES } from '../lib/kind.js';
import { useAutosave } from '../lib/autosave.js';
import TlcOcr from '../components/TlcOcr.vue';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { amountText, derive, eqNum, mwText, num, round, saneDensity, volText } from '../lib/reagent.js';
import { schemeParts } from '../lib/expScheme.js';
import { preloadSchemeLib } from '../lib/scheme.js';
import { flattenTextareas } from '../lib/autogrow.js';
import { exportSnapshotBundle, exportSnapshotHtml, exportSnapshotPng } from '../lib/snapshot.js';
import { peekPrefs } from '../lib/peek.js';
import { composeSchemeSvg } from '../lib/scheme.js';

const route = useRoute();
const router = useRouter();

const exp = ref(null);
const error = ref('');
const page = ref(1);
const hovered = ref('');
const statusMenu = ref(false);
const rxnMenu = ref(false);   // 抬头「反应类型」那格的候选菜单
const moreMenu = ref(false);
const resBlock = ref(null);   // 结果块（「按投料表生成」缺产物时直接调它的选择器）
const gone = ref(false);   // 删掉了就不再自动保存
const historyOpen = ref(false);
const schemeSketcherOpen = ref(false);   // 画反应式（Ketcher 画板，反应物 → 产物）
const schemePadSeed = ref('');           // 打开画板时先塞进去的东西（按投料表拼出来的反应式）
const recipeModal = ref(false);
/** ⋯ 菜单里「导出」那个二级菜单展不展开；关菜单要一起收 */
const exportSub = ref(false);
function closeMore() {
  moreMenu.value = false;
  exportSub.value = false;
}
const qrModal = ref(false);
const recipeList = ref([]);
const recipePick = ref(null);

const fields = reactive({
  title: '', date: '', status: '进行中', operator: '', ambient_temp: '', ambient_humid: '',
  project: '', rxn_type: '', literature: '', objective: '', solvent: '', concentration: '',
  temperature: '', duration: '', atmosphere: '', apparatus: '', light: '', workup: '', procedure: '', product_name: '',
  appearance: '', yield_pct: '', product_mass: '', product_mw: '', tlc_note: '', dr_ee: '',
  ee_pct: '', sel_method: '', sel_condition: '', sel_rt: '',
  characterization: '', notes: '', conclusion: '', product_compound_id: null, category_id: null,
  no_yield: 0,
  scheme_rxn: '',
  scheme_smiles: '',
  lit_note: '',
  kind: '',
});

const reagent = reactive({ base: null, steps: [], rows: [] });

const FIELD_KEYS = Object.keys(fields);

function toRow(r) {
  // 老数据里溶剂那一行的用量可能还是「30」（没单位、当时解析失败）→ 按 mL 认回来
  const row = {
    step: Math.max(1, Number(r.step) || 1),
    role: r.role || '',
    name: r.name || '',
    mw: r.mw ?? null,
    conc: r.conc ?? null,
    density: r.density ?? null,
    eq: r.eq ?? null,
    mmol: r.mmol ?? null,
    mass_mg: r.mass_mg ?? null,
    volume_ul: r.volume_ul ?? null,
    note: r.note || '',
    compound_id: r.compound_id ?? null,
    mwText: mwText(r),
    amountText: amountText(r),
  };
  if (row.role === '溶剂' && row.volume_ul === null) {
    const m = /^\s*([\d.]+)\s*(ml|l|µl|ul)?\s*$/i.exec(String(r.amountText || '').trim());
    if (m) {
      const v = Number(m[1]);
      const unit = (m[2] || 'ml').toLowerCase();
      const ul = unit === 'l' ? v * 1e6 : unit === 'µl' || unit === 'ul' ? v : v * 1000;
      if (ul > 0) {
        row.volume_ul = ul;
        row.amountText = `${Math.round((ul / 1000) * 100) / 100} mL`;
      }
    }
  }
  return row;
}

function fill(e) {
  exp.value = e;
  for (const k of FIELD_KEYS) if (k in e) fields[k] = e[k] ?? (typeof fields[k] === 'number' ? null : '');
  fields.no_yield = Number(e.no_yield) === 1 ? 1 : 0;   // 0/1 开关，别让它变成 null
  fields.product_compound_id = e.product_compound_id ?? null;

  const raw = Array.isArray(e.steps) ? e.steps : [];
  const list = raw.map((s) => ({
    label: s.label || '',
    condition: s.condition || '',
    workup: s.workup || '',
    start: s.start || '',
    end: s.end || '',
    addition: s.addition || '',
    stir: s.stir || '',
  }));
  const need = (e.reagents || []).reduce((m, r) => Math.max(m, Number(r.step) || 1), 1);
  while (list.length < Math.max(1, need)) list.push({ label: '', condition: '', workup: '', start: '', end: '', addition: '', stir: '' });
  const rows = (e.reagents || []).map(toRow);
  // 一条试剂都还没有时，第一步给一行空行当起点；其余步骤不再自动补空行
  if (!rows.length) rows.push({ step: 1, role: '底物', eq: 1, mwText: '', amountText: '', name: '', note: '' });
  // 有名字/挂了化合物库的行，只有填了当量却没填 mmol 的，按规模补算一份显示值
  // （只补空着的，手写过的数字不动；补完再 markLoaded，所以不会因此触发一次保存）
  const scale = num(e.base_mmol);
  if (scale) {
    for (const r of rows) {
      if (!r.name && !r.compound_id) continue;
      if (r.role === '溶剂') continue;                       // 溶剂按体积量，不走当量
      if (num(r.mmol) !== null || num(r.eq) === null) continue;
      if (num(r.mass_mg) !== null || num(r.volume_ul) !== null) continue;  // 已经称过 / 量过的别动
      r.mmol = round(scale * num(r.eq), 4);
      const d = derive({ ...r });
      r.mass_mg = d.mass_mg ?? null;
      r.volume_ul = d.volume_ul ?? null;
      r.amountText = amountText(d);
    }
  }

  reagent.base = e.base_mmol ?? null;
  reagent.steps = list;
  reagent.rows = rows;
  ensureSolventRow();     // 老记录：溶剂还在字段里 → 补成投料表的一行
  markLoaded();
  if (fixReagentRows(rows)) notify();   // 分子量 / 密度被补上，顺手存一次（导出 / 列表才跟页面对得上）
  // 服务端存着上次画好的那张：数据没变（sig 一样）就直接贴上去，连重画都省了
  const cache = e.scheme_cache;
  if (cache && cache.sig === liveSig.value) {
    liveScheme.value = cache.svg;
    liveSigShown.value = cache.sig;
  } else {
    liveScheme.value = '';
    liveSigShown.value = '';
    scheduleLive(0);
  }
}

/** 打开记录时顺手修两样老数据的毛病（改了就存一次）：
 *  ① 分子量只有一位小数的粗值（P(Cy)3 = 280.4）→ 换成词库里更细的（280.43）；
 *  ② 液体没带密度（HFIP 那种只能显示 g）→ 从词库补上，用量就会折成 µL。 */
function fixReagentRows(rows) {
  const coarse = (v) => v != null && Math.round(Number(v) * 100) % 10 === 0;
  let changed = false;
  for (const r of rows) {
    if (!r.name || r.compound_id) continue;
    const d = reagentDict().find((x) => String(x.name || '').toLowerCase() === String(r.name).toLowerCase());
    if (!d) continue;
    let touched = false;
    if (!r._mwManual && d.mw != null && coarse(r.mw) && Number(d.mw).toFixed(2) !== Number(r.mw).toFixed(2)) {
      r.mw = Number(d.mw);
      r.mwText = Number(d.mw).toFixed(2);
      touched = true;
    }
    if (num(r.density) === null && saneDensity(d.density)) {
      r.density = saneDensity(d.density);
      touched = true;
    }
    if (!touched) continue;
    changed = true;
    if (r.role !== '溶剂' && num(r.mmol) !== null) {
      const next = derive({ ...r });
      r.mass_mg = next.mass_mg ?? null;
      r.volume_ul = next.volume_ul ?? null;
      r.amountText = amountText(next);
    }
  }
  return changed;
}

/** 打开这条记录时的内容快照，用来「重置」 */
const baseline = ref('');

async function load() {
  error.value = '';
  const id = route.params.id;
  try {
    const e = await api.experiment(id);
    // 连点两次列表时先发的可能后回来，这份已经不是当前记录的内容了
    if (route.params.id !== id) return;
    fill(e);
    baseline.value = JSON.stringify(payload());
    // 进到属于某个平行组的记录时，把中栏那一组自动展开：
    // 这样那条「当前」虚线框能落在具体的组员行上（不管是从书签切、从列表点还是直接开链接）
    if (e.group_id) store.openStacks[e.group_id] = true;
  } catch (e) {
    error.value = e.message;
  }
}

/** 左栏里点另一条实验时，路由参数变了但组件不会重建，得自己重新加载 */
watch(
  () => route.params.id,
  async (id, old) => {
    if (!id || id === old) return;
    try {
      if (dirty.value) await flush();
    } catch {
      /* 保存失败已经在状态栏里提示 */
    }
    moreMenu.value = false;
    statusMenu.value = false;
    page.value = String(route.query.p) === '2' ? 2 : 1;
    await load();
    // 切完弹一个气泡通知（只在这条记录是从别处切过来时提示，第一次打开不提示）
    if (exp.value?.code) toast(`已切换到 ${exp.value.code}`, 'info', 1800);
    // 换了记录就当翻到新的一页：滚回顶部，不然停在上一页看到的位置很像「没切换」
    await nextTick();
    editorEl.value?.scrollTo({ top: 0 });
  }
);

/** 窄屏（手机）走只读精简页，桌面版式完全不渲染 */
const isPhone = ref(typeof window !== 'undefined' && window.innerWidth <= 820);
function onResize() {
  isPhone.value = window.innerWidth <= 820;
}

onMounted(async () => {
  void preloadSchemeLib();      // 顺手把 openchemlib 拉下来，别等第一次画反应式才等
  window.addEventListener('resize', onResize);
  window.addEventListener('resize', updateRail);
  page.value = String(route.query.p) === '2' ? 2 : 1;
  if (!isPhone.value) await load();
  document.addEventListener('paste', onPaste);
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', onShortcut);
  document.addEventListener('keydown', onParallelKey);
  // 等这一帧渲染完再量纸面位置
  requestAnimationFrame(updateRail);
});
/** 键盘 ↑/↓ 在这组平行实验里上下切（在输入框 / 文本域里打字时不接管） */
function onParallelKey(ev) {
  if (siblings.value.length < 2 || page.value !== 1) return;
  if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
  const t = ev.target;
  if (t && (t.closest?.('input, textarea, [contenteditable="true"]') || t.isContentEditable)) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const i = siblings.value.findIndex((s) => String(s.id) === String(exp.value?.id));
  if (i < 0) return;
  const next = siblings.value[ev.key === 'ArrowUp' ? i - 1 : i + 1];
  if (!next) return;
  ev.preventDefault();
  router.push(`/e/${next.id}`);
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  window.removeEventListener('resize', updateRail);
  document.removeEventListener('paste', onPaste);
  document.removeEventListener('click', closeMenus);
  document.removeEventListener('keydown', onShortcut);
  document.removeEventListener('keydown', onParallelKey);
});

/** ⌘S / Ctrl+S 立即保存（浏览器默认的「保存网页」挡掉） */
function onShortcut(ev) {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    void doSave();
    return;
  }
  // ⌘Z：撤销上一次保存（只在没聚焦到输入框时接管，不然会把正在打的字撤掉）
  if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && ev.key.toLowerCase() === 'z') {
    const t = ev.target;
    if (t && (t.closest?.('input, textarea, [contenteditable="true"]') || t.isContentEditable)) return;
    ev.preventDefault();
    void undoSave();
  }
}

/** 把这条记录归到某个分类（'' = 未分类） */
function setCategory(v) {
  fields.category_id = v ? Number(v) : null;
  notify();
}

/** 换课题：原来挂的分类属于别的课题就一起清掉，不然保存时会被当悬空引用丢掉 */
function onProjectChange(v) {
  fields.project = v || '';
  const cat = fields.category_id;
  if (cat != null && !categoriesOfProject('experiment', fields.project).some((g) => Number(g.id) === Number(cat))) {
    fields.category_id = null;
  }
  notify();
  // 课题计数 / 中栏列表 / 平行组书签都跟着课题走，换完立刻刷一遍，别等刷新页面
  void refreshSpace();
}

async function refreshSpace() {
  // 必须先把新课题落库，否则拉回来还是旧归属（这是「要刷新页面才变」的根因）
  try {
    await flush();
  } catch {
    /* 存失败由保存状态栏提示 */
  }
  try {
    await loadBoot();
    await loadList();
  } catch {
    /* 刷新失败不影响正在编辑的这条 */
  }
}

async function newCategory() {
  const name = await prompt({ title: '新建分类', placeholder: '比如：方法学 A、手性配体库', confirmText: '建' });
  if (!name) return;
  try {
    await addCategory(name, 'experiment');
    toast(`建好了「${name}」，在分类里选它`);
  } catch (e) {
    toast(e.message || '建不了这个分类', 'err');
  }
}

function closeMenus(e) {
  if (!e.target.closest?.('.menu-wrap')) moreMenu.value = false;
  if (!e.target.closest?.('.status-wrap')) statusMenu.value = false;
  if (!e.target.closest?.('.rxn-wrap')) rxnMenu.value = false;
}

function payload() {
  const body = {};
  for (const k of FIELD_KEYS) body[k] = fields[k];
  body.base_mmol = reagent.base;
  body.steps = reagent.steps.map((s) => ({ ...s }));
  body.reagents = reagent.rows.map(({ mwText, amountText, ...r }) => r);
  return body;
}

/** 撤销上一次保存：把上一版快照写回表单，随后自动保存会把它存回去（等于回滚一次） */
async function undoSave(ev) {
  moreMenu.value = false;
  if (!exp.value || exp.value.locked) return toast('这条记录锁定了，先解锁', 'warn');
  const prev = undoLast();
  if (!prev) return toast('没有可以撤销的上一次保存', 'warn');
  for (const k of FIELD_KEYS) if (k in prev) fields[k] = prev[k];
  reagent.base = prev.base_mmol ?? null;
  if (Array.isArray(prev.steps) && prev.steps.length) reagent.steps = prev.steps.map((x) => ({ ...x }));
  if (Array.isArray(prev.reagents)) reagent.rows = prev.reagents.map((r) => toRow(r));
  notify();
  try {
    await flush();
    toast('已回退到上一次保存之前', 'ok');
  } catch (e) {
    toast(e.message || '回退没存上', 'err');
  }
}

async function saveNow() {
  if (!exp.value || exp.value.locked) return;
  const id = exp.value.id;
  const e = await api.saveExperiment(id, payload());
  // 等响应期间可能已经切到别的记录了：旧记录的内容不能盖到新记录上
  if (!exp.value || exp.value.id !== id) return;
  exp.value = { ...exp.value, ...e };
  await loadList();
}

// 自动保存：payload 里读到的字段一变就排队保存，不用再给每个输入框挂 @input
/** TLC 那块图（附件里 category=tlc 的图片），给「读图」用 */
const tlcShots = computed(() =>
  (exp.value?.attachments || []).filter((f) => f.category === 'tlc' && isImageName(f.original_name || f.filename))
);

/** 从 TLC 图里读到展开剂 / Rf：只补空格子（实验的 TLC 备注里记展开剂） */
function applyTlcOcr({ solvent, rf, auto, raw }) {
  const filled = [];
  if (solvent && !String(fields.tlc_note || '').trim()) {
    fields.tlc_note = rf ? `${solvent}，Rf ${rf}` : solvent;
    filled.push(`展开剂 ${solvent}`);
  } else if (solvent && !auto) {
    fields.tlc_note = `${solvent}${rf ? `，Rf ${rf}` : ''}`;
    filled.push(`展开剂 ${solvent}`);
  } else if (!solvent && !auto && raw && !String(fields.tlc_note || '').trim()) {
    fields.tlc_note = raw;
    filled.push('原文');
  }
  if (filled.length) toast(`从图上读到 ${filled.join(' · ')}`, 'ok');
}

const { state: saveState, dirty, markLoaded, touch: notify, flush, undoLast } = useAutosave(payload, saveNow, {
  delay: 900,
  enabled: () => !gone.value && !!exp.value && !exp.value.locked,
  onError: (e) => {
    toast(e.message, 'err');
  },
});

/** 手动保存：把排队中的自动保存立刻执行 */
async function doSave() {
  if (!exp.value || exp.value.locked) return;
  try {
    await flush();
    baseline.value = JSON.stringify(payload());   // 手动保存过，就把这里当成新的「打开时」
    toast('已保存');
  } catch {
    /* flush 里已经把错误写到 saveState */
  }
}

/** 重置：回到打开这条记录时的样子（会顺手把服务端也改回去） */
async function doReset() {
  if (!exp.value || exp.value.locked || !baseline.value) return;
  const snap = baseline.value;
  if (JSON.stringify(payload()) === snap) {
    toast('没有要撤销的改动');
    return;
  }
  const ok = await confirm({
    title: '重置到打开时的状态？',
    body: '将撤销打开本记录之后的全部修改，内容恢复到打开时的状态。',
    confirmText: '重置',
    danger: true,
  });
  if (!ok) return;
  const base = JSON.parse(snap);
  fill({ ...exp.value, ...base });
  baseline.value = snap;
  try {
    await flush();
    toast('已重置');
  } catch {
    /* 错误已显示在保存状态里 */
  }
}

async function toggleLock() {
  if (dirty.value) await flush();
  const e = await api.lock(exp.value.id, !exp.value.locked);
  fill(e);
  await loadBoot();
  toast(e.locked ? '已锁定，之后只能查看' : '已解锁，可以继续修改');
}

const printPanel = ref(false);

/** 打印一张实验二维码小贴纸（独立的纸片，不动记录本身的版式） */
function printQr() {
  qrModal.value = false;
  const el = document.createElement('div');
  el.className = 'exp-qr-sheet';
  el.id = 'exp-qr-sheet';
  el.innerHTML = `
    <img src="/api/experiments/${exp.value.id}/qr.svg?unit=6" alt="">
    <div class="exp-qr-text">
      <div class="exp-qr-code">${exp.value.code}</div>
      <div class="exp-qr-name">${(exp.value.title || exp.value.objective || '').replace(/[<>&]/g, '')}</div>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('printing-expqr');
  const done = () => {
    document.body.classList.remove('printing-expqr');
    document.getElementById('exp-qr-sheet')?.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 80);
}

function doPrint() {
  if (dirty.value) void flush();
  printPanel.value = true;
}

/** 面板点了「打印」：把选项挂到 body 上，交给打印样式，打完再摘掉 */
function runPrint(opts) {
  printPanel.value = false;
  const b = document.body;
  const marks = {
    'print-page-1': opts.pages === 'p1',
    'print-page-2': opts.pages === 'p2',
    'print-no-attach': !opts.attachments,
    'print-no-header': !opts.header,
    'print-mono': opts.mono,
  };
  for (const [k, on] of Object.entries(marks)) b.classList.toggle(k, on);
  let restore = () => {};
  let finished = false;
  const done = () => {
    finished = true;
    for (const k of Object.keys(marks)) b.classList.remove(k);
    restore();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  // 浏览器没发 afterprint 时兜底还回来，别让记录页一直是 div
  setTimeout(done, 60000);
  setTimeout(() => {
    if (finished) return;
    // 文本域换成 div 再打：纸面比屏幕窄、textarea 又只印得出自己那几行高，长表征会被截断。
    // 放在 print() 前一瞬换，免得这段时间里 Vue 再渲染一次
    restore = flattenTextareas(document.querySelector('.editor-inner') || document.body);
    window.print();
  }, 150);
}

async function refreshAttachments() {
  const id = exp.value.id;
  const e = await api.experiment(id);
  // 上传/粘贴要等接口回来，这期间可能已经切了记录：旧记录的附件绝不能并到新记录上
  // （并过去之后点 × 删的就是别人记录的文件）
  if (!exp.value || exp.value.id !== id) return;
  exp.value = { ...exp.value, attachments: e.attachments };
}

async function updateStatus(s) {
  fields.status = s;
  statusMenu.value = false;
  notify();
}

function onHover(v) {
  hovered.value = v;
}

function pickFile(category) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    fd.append('category', category || 'photo');
    await api.upload(exp.value.id, fd);
    await refreshAttachments();
  };
  input.click();
}

/** 图片下面那行说明：存到附件的 note，刷新后还在 */
async function saveCaption(id, note) {
  const hit = (exp.value.attachments || []).find((a) => Number(a.id) === Number(id));
  if (hit) hit.note = note;                 // 先就地更新，别等刷新闪一下
  try {
    await api.updateAttachment(id, { note });
  } catch (e) {
    toast(e.message || '图注没存上', 'err');
  }
}

async function onPaste(ev) {
  if (route.name !== 'editor' || !exp.value || exp.value.locked) return;
  const items = Array.from(ev.clipboardData?.items || []).filter((i) => i.kind === 'file' && String(i.type).startsWith('image/'));
  if (!items.length) return;
  ev.preventDefault();
  // 没有悬停在某个格子时：还没有反应式就贴成反应式，否则进附件
  const hasScheme = (exp.value.attachments || []).some((a) => a.category === 'scheme');
  const cat = hovered.value || (hasScheme ? 'photo' : 'scheme');
  const files = items.map((it, i) => {
    const f = it.getAsFile();
    return f ? new File([f], `粘贴-${Date.now()}-${i + 1}.png`, { type: f.type }) : null;
  }).filter(Boolean);
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name);
  fd.append('category', cat);
  await api.upload(exp.value.id, fd);
  await refreshAttachments();
}

/**
 * 画板里画完的反应式：RXN 存进这条记录（下次点「画反应式」能接着改），
 * 图交给 Ketcher 自己的 Indigo 渲染成 SVG，当方案反应式那张附件存（替换旧的那张）。
 */
async function applySketchScheme({ rxn, smiles, svg }) {
  if (!exp.value || exp.value.locked || !rxn || !svg) return;
  const old = (exp.value.attachments || []).find((a) => a.category === 'scheme');
  try {
    if (old) await api.deleteAttachment(old.id).catch(() => {});
    const fd = new FormData();
    fd.append('file', new File([svg], '反应式.svg', { type: 'image/svg+xml' }), '反应式.svg');
    fd.append('category', 'scheme');
    await api.upload(exp.value.id, fd);
    fields.scheme_rxn = rxn;
    if (smiles) fields.scheme_smiles = smiles;
    await refreshAttachments();
  } catch (e) {
    toast(e.message || '反应式没存上', 'err');
  }
}

/**
 * 反应式 → 投料表：把画板里那条反应式的反应物按 SMILES 跟化合物库对上，
 * 对上就按库里的名字 / 分子量 / 类型填行（类型是底物的当底物，其余当试剂）；
 * 产物那一侧对上的话，结果块的产物名 / MW / 挂库也一起填。
 */
/**
 * 按投料表 + 条件拼一张反应式图（不经过画板）。
 * 底物（可以两个）画成反应物，试剂 / 催化剂 / 碱……和溶剂、温度、时间写在箭头上方一格，
 * 产物取结果块里挂库的那个。尺度和字号在 lib/scheme.js 里统一控制。
 */
/** 反应式：一直跟着投料表画（没有开关了，用户说「都用这张」）。
 *  画好的那张按记录存到服务端（`scheme_cache`），数据没变就直接贴出来，省掉重画那一下空白；
 *  数据变了（sig 不同）才重画，画完再存回去。 */
const liveScheme = ref('');
/* 屏幕上这张图对应的是哪个 sig：一样就不用再画（缓存命中时首帧直接贴上，不再重画一次——
   以前化合物库晚一步读进来会触发一次多余的重画，看着就是「闪一下」） */
const liveSigShown = ref('');
/* sig 只看「会进这张图的字段」，别把密度 / 用量那些也塞进来——它们一变就白重画一次，
   页面一打开就能对得上缓存（化合物库还没读进来也不影响）。版本号用来让旧缓存失效。 */
const SCHEME_SIG_VERSION = 'v8';   // 改了出图规则就加一，让旧缓存失效
const liveSig = computed(() =>
  SCHEME_SIG_VERSION +
  JSON.stringify({
    r: (reagent.rows || []).map((r) => [r.role || '', r.name || '', String(r.eq ?? ''), r.compound_id ?? '']),
    s: fields.solvent || '',
    t: fields.temperature || '',
    d: fields.duration || '',
    pn: fields.product_name || '',
    pc: fields.product_compound_id ?? '',
  })
);
let liveTimer = null;
function scheduleLive(ms = 700) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => void renderLive(), ms);
}
async function renderLive() {
  const id = exp.value?.id;
  if (!id || exp.value.locked) {
    liveScheme.value = '';
    liveSigShown.value = '';
    return;
  }
  const sig = liveSig.value;
  if (liveScheme.value && liveSigShown.value === sig) return;   // 已经是这张了，别白画一遍
  try {
    // 化合物库还没读进来时（刚打开页面）先读一次，否则底物挂不上结构、反应式是空的
    if (!(store.compounds && store.compounds.length)) await loadCompounds();
    const parts = schemeParts({ ...fields, reagents: reagent.rows }, store.compounds || []);
    if (!parts.reactants.length) {
      liveScheme.value = '';
      liveSigShown.value = '';
      return;
    }
    const svg = await composeSchemeSvg({
      reactants: parts.reactants,
      reactantIds: parts.reactantIds,
      product: parts.product,
      productId: parts.productId,
      productLabel: parts.product ? '' : parts.prodName,
      above: parts.above,
      below: parts.below,
      background: false,     // 直接贴在纸面上，别垫一块白方块
    });
    if (exp.value?.id !== id) return;   // 等的时候切到别的记录了：这份丢掉
    liveScheme.value = svg;
    liveSigShown.value = sig;
    api.saveSchemeCache(id, { sig, svg }).catch(() => {});   // 存不下也不影响显示
  } catch {
    if (exp.value?.id === id) {
      liveScheme.value = '';
      liveSigShown.value = '';
    }
  }
}
watch(liveSig, () => scheduleLive());
watch(() => (store.compounds || []).length, () => scheduleLive(50));

async function schemeFromTable() {
  if (!exp.value || exp.value.locked) return;
  try {
    await loadCompounds();
  } catch (e) {
    return toast(e.message || '化合物库没读出来', 'err');
  }
  // 构件（反应物 / 产物 / 箭头上下的字）跟筛选表共用一份，见 lib/expScheme.js
  const parts = schemeParts({ ...fields, reagents: reagent.rows }, store.compounds || []);
  if (!parts.reactants.length) {
    return toast(
      reactantHint() || '投料表里还没有挂化合物库的底物——双击试剂名选一个',
      'warn'
    );
  }
  // 产物没挂结构也要能画：试反应常常还不知道准确产物，那就只在箭头右边写产物名（或留空）
  const hasProduct = !!parts.product;

  let svg;
  try {
    svg = await composeSchemeSvg({
      reactants: parts.reactants,
      reactantIds: parts.reactantIds,
      product: parts.product,
      productId: parts.productId,
      productLabel: hasProduct ? '' : parts.prodName,
      above: parts.above,
      below: parts.below,
    });
  } catch (e) {
    return toast(e.message || '反应式没拼出来', 'err');
  }

  const ok = await confirm({
    title: '按投料表重画反应式？',
    body: hasProduct
      ? '会用投料表里的底物画反应物、试剂和条件写在箭头上，产物用结果块里挂的那个；现在这张反应式图会被替换。'
      : `产物还没挂化合物库，所以箭头右边${parts.prodName ? `只写名字「${parts.prodName}」` : '留空'}（试反应不知道产物也没关系）；现在这张反应式图会被替换。`,
  });
  if (!ok) return;

  const old = (exp.value.attachments || []).find((a) => a.category === 'scheme');
  try {
    if (old) await api.deleteAttachment(old.id).catch(() => {});
    const fd = new FormData();
    fd.append('file', new File([svg], '反应式.svg', { type: 'image/svg+xml' }), '反应式.svg');
    fd.append('category', 'scheme');
    await api.upload(exp.value.id, fd);
    // 顺手记一份反应式文本，这样还能用「从反应式填表」跟投料表对一遍
    fields.scheme_smiles = `${parts.reactants.join('.')}>>${parts.product}`;
    await refreshAttachments();
    toast(
      parts.loose
        ? `反应式重画好了；${parts.loose} 个底物没挂结构，名字放在箭头上方（要画成结构就双击试剂名挂个化合物）`
        : '反应式图按投料表重画好了'
    );
  } catch (e) {
    toast(e.message || '反应式没存上', 'err');
  }
}

/** 底物行了但没挂化合物库时，给一句说得更具体的话 */
function reactantHint() {
  const subs = reagent.rows.filter((r) => r.role === '底物');
  if (!subs.length) return '投料表里还没有「底物」行';
  const bound = subs.filter((r) => r.compound_id);
  if (!bound.length) return '底物还没挂化合物库（双击试剂名选一个）';
  if (bound.some((r) => !(store.compounds || []).find((c) => Number(c.id) === Number(r.compound_id))?.smiles)) {
    return '底物挂的那个化合物没有 SMILES，先给它粘个结构';
  }
  return '';
}

/** 点「画反应式」：不预填别的，用上次存的那条 RXN */
function openSchemePad() {
  schemePadSeed.value = '';
  schemeSketcherOpen.value = true;
}

async function openRecipe() {
  recipeList.value = await api.experiments({ sort: 'newest' });
  recipePick.value = recipeList.value.find((x) => x.id !== exp.value.id && x.reagent_count)?.id ?? null;
  recipeModal.value = true;
}

async function applyRecipe() {
  const src = recipeList.value.find((x) => x.id === recipePick.value);
  recipeModal.value = false;
  if (!src) return;
  const full = await api.experiment(src.id);
  const list = (full.steps || []).map((s) => ({
    label: s.label || '',
    condition: s.condition || '',
    workup: s.workup || '',
    addition: s.addition || '',
    stir: s.stir || '',
  }));
  while (!list.length) list.push({ label: '', condition: '', workup: '' });
  reagent.steps = list;
  // 套用配方 = 把这套投料方案按「当前反应规模」重新算一遍（弹窗上就是这么写的）。
  // 以前只把 mmol/用量清空，表里剩下一个个空格，得逐行重填。
  const scale = num(reagent.base);
  const srcScale = num(full.base_mmol);   // 源记录的规模：溶剂量按比例搬
  reagent.rows = (full.reagents || []).map((r) => {
    const row = { ...toRow(r), mmol: null, mass_mg: null, volume_ul: null, amountText: '' };
    // 溶剂：用量不按当量算，直接照源记录等比缩放（以前一律清空，套完配方溶剂量是空的）
    if (row.role === '溶剂') {
      const ul = num(r.volume_ul);
      if (ul !== null && ul > 0) {
        const k = scale && srcScale ? scale / srcScale : 1;
        row.volume_ul = round(ul * k, 1);
        row.amountText = volText(row.volume_ul);
      }
      return row;
    }
    // 当量要认 `10%` 这种摩尔百分数（eqNum：10% → 0.1）；以前用 num() 得到 null，
    // 于是催化剂那行 mmol / 质量 / 用量 全空——「套用配方」出来一个空格子
    const e = eqNum(row.eq);
    if (scale && e !== null) {
      row.mmol = round(scale * e, 4);
      const d = derive({ ...row });
      row.mass_mg = d.mass_mg ?? null;
      row.volume_ul = d.volume_ul ?? null;
      row.amountText = amountText(d);
    }
    return row;
  });
  notify();
}

async function saveToCompound() {
  moreMenu.value = false;
  const ok = await confirm({
    title: '将本实验产物存入化合物库？',
    body: '将新建化合物档案，并带入名称、分子量、表征、TLC 与操作步骤；谱图与结构图一并复制。',
    confirmText: '存入',
  });
  if (!ok) return;
  try {
    const c = await api.compoundFromExperiment(exp.value.id);
    fields.product_compound_id = c.id;
    await loadBoot();
    toast(`已存入化合物库：${c.code || c.name || '新化合物'}`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function duplicate() {
  api
    .duplicate(exp.value.id)
    .then(async (e) => {
      await loadBoot();
      await loadList();
      router.push(`/e/${e.id}`);
      toast('已复制为新记录；产率与表征未带入');
    })
    .catch((err) => toast(err.message, 'err'));
}

/** 平行组：同一轮实验的重复 / 控制变量实验，纸面左侧那排书签 */
const siblings = computed(() => exp.value?.siblings || []);

/**
 * 书签是浮层（挂在 body 上）：位置按第 1 张纸的左上角算，
 * 因为 .editor 是滚动容器，书签留在里面会被裁掉伸出去的那一半。
 */
const sheetEl = ref(null);
const editorEl = ref(null);
/** 这排书签收起来没有（点「平行 ×N」那行切换，只在这次会话里记） */
const railOpen = ref(true);
/** 短杠长度按产率来：14–22px（没填产率就是 14） */
function tickW(s) {
  const y = Number(s.yield_pct);
  return Number.isFinite(y) ? Math.round(14 + Math.min(Math.max(y, 0), 100) / 100 * 8) : 14;
}
const railStyle = ref({});
function updateRail() {
  const el = sheetEl.value;
  if (!el || page.value !== 1) return;
  const r = el.getBoundingClientRect();
  // 固定站在纸面**左边**那条缝里，短杠离纸 6px。
  // 缝里挤（窗口窄）时短杠会顶到编辑区左边界，但绝不越过它——不能压中栏列表；
  // 编号那一行不占缝：够宽写在缝里，不够就画进纸面自己的左边距（A4 有 44px）。
  const ed = editorEl.value ? editorEl.value.getBoundingClientRect() : { left: 0, right: window.innerWidth };
  const railW = 22;
  railStyle.value = {
    left: `${Math.round(Math.max(r.left - 6 - railW, ed.left + 4))}px`,
    top: `${Math.round(r.top + 72)}px`,   // 让开纸面顶栏那行小字（记录本名 / 课题名）
    width: `${railW}px`,
  };
}
watch([() => exp.value?.id, () => page.value, () => siblings.value.length], () => {
  nextTick(updateRail);
});

/**
 * 从当前记录再生成一条平行实验（带条件、投料表、反应式；结果清空），
 * 然后切过去。先把当前的改动存掉，不然带过去的是旧内容。
 */
async function newParallel() {
  moreMenu.value = false;
  try {
    if (dirty.value) await flush();
    // 带过去什么，先说清楚（服务端是「整份条件 + 投料表 + 反应式」照搬，只清结果）
    const carried = [];
    const head = String(fields.title || fields.objective || '').trim();
    if (head) carried.push(`题目「${head}」`);
    const nRows = reagent.rows.filter((r) => String(r.name || '').trim()).length;
    if (nRows) carried.push(`${nRows} 行投料`);
    const cond = [fields.temperature, fields.duration, fields.atmosphere].filter(Boolean);
    if (cond.length) carried.push('条件');
    if ((exp.value.attachments || []).some((a) => a.category === 'scheme')) carried.push('反应式');
    const e = await api.parallel(exp.value.id);
    await loadList();
    router.push(`/e/${e.id}`);
    toast(
      `已新建平行实验${carried.length ? `：带过来 ${carried.join(' · ')}` : ''}；产率 / 表征 / TLC 留空，改掉要变的那个变量就行`,
      'ok',
      3600
    );
  } catch (err) {
    toast(err.message || '建不了平行实验', 'err');
  }
}

/** 悬停预览卡：跟着鼠标所在的那枚书签定位，永远放在书签**左边**（不压纸张）。
 *  形态照 DSH 的 turn 预览卡——不带箭头，跟书签留 12px。 */
const peek = ref(null);
const peekPos = ref({});
const peekEl = ref(null);
/** 悬停 220ms 才弹卡片：先让书签上的编号逐字浮出来（那一瞬间就够认了），
 *  卡片再出来；不然卡片一出现就把编号盖住，等于白做。 */
let peekTimer = 0;
function showPeek(s, ev) {
  const r = ev.currentTarget.getBoundingClientRect();
  clearTimeout(peekTimer);
  peekTimer = window.setTimeout(() => revealPeek(s, r), 220);
}
function revealPeek(s, r) {
  const width = 300;
  const left = Math.max(8, r.left - width - 12);
  peekPos.value = {
    left: `${left}px`,
    top: `${Math.max(8, r.top - 6)}px`,
    width: `${width}px`,
  };
  peek.value = s;
  // 卡片高度要等渲染出来才知道：竖直居中在短杠上，箭头对准短杠中线
  nextTick(() => {
    const h = peekEl.value ? peekEl.value.offsetHeight : 100;
    const cy = r.top + r.height / 2;
    const top = Math.max(10, Math.min(window.innerHeight - h - 10, cy - h / 2));
    peekPos.value = {
      left: `${left}px`,
      top: `${Math.round(top)}px`,
      width: `${width}px`,
      '--arrow-y': `${Math.round(Math.max(12, Math.min(h - 12, cy - top)))}px`,
    };
  });
}
function hidePeek() {
  clearTimeout(peekTimer);
  peek.value = null;
}

/** 预览卡的「条件」：溶剂（带浓度）· 温度 · 时长 · 气氛 */
const peekConds = computed(() => {
  const p = peek.value;
  if (!p) return '';
  // 溶剂没填但浓度填了，就别画出「（）」这种空括号
  const sol = p.solvent ? (p.concentration ? `${p.solvent}（${p.concentration}）` : p.solvent) : p.concentration || '';
  return [sol, p.temperature, p.duration, p.atmosphere].filter(Boolean).join(' · ');
});

/** 关键数字那一排：规模 / 溶剂用量 / 产率 / ee（没有 ee 就显示 dr） */
/** 预览卡第一行（粗体一行，照 DSH 那个 turn 预览的样子）：编号 + 相对基准改了什么 */
const peekLine = computed(() => {
  const p = peek.value;
  if (!p) return '';
  let diff = '';
  if (p.variant === '基准') diff = '基准';
  else if (p.variant === '重复') diff = p.scaleNote ? `重复 · 规模 ${p.scaleNote}` : '重复';
  else if (Array.isArray(p.diffs) && p.diffs.length) diff = `改 ${p.diffs.join('、')}`;
  return [p.code, p.title, diff].filter(Boolean).join(' · ');
});

/** 预览卡下面那几行灰字：状态 · 条件 · 底物→产物 · 结果 · 结论 · 备注（按 05 的开关），
 *  拼成一句话、最多三行，超出截断——别再回到一格格带标签的小行。 */
const peekBody = computed(() => {
  const p = peek.value;
  if (!p) return '';
  const seg = [];
  if (p.status) seg.push(p.status);
  if (peekPrefs.conditions && peekConds.value) seg.push(peekConds.value);
  if (peekPrefs.substrates && (p.substrates || p.product_name)) {
    seg.push(`${p.substrates || '—'}${p.product_name ? ` → ${p.product_name}` : ''}`);
  }
  if (peekPrefs.result) {
    const r = [];
    if (p.yield_pct != null) r.push(`产率 ${p.yield_pct}%`);
    if (p.ee_pct != null) r.push(`ee ${p.ee_pct}%`);
    else if (p.dr_ee) r.push(`dr/ee ${p.dr_ee}`);
    if (p.base_mmol) r.push(`${p.base_mmol} mmol`);
    if (r.length) seg.push(r.join(' · '));
  }
  if (peekPrefs.conclusion && p.conclusion) seg.push(p.conclusion);
  if (peekPrefs.notes && p.notes) seg.push(p.notes);
  return seg.join(' · ');
});

/** 书签上那一行小字：产率有就写产率，没有就写状态 */
function sibMeta(s) {
  const y = num(s.yield_pct);
  return y !== null ? `${round(y, 1)}%` : s.status || '';
}

/** 书签第二行：基准 / 改了哪一项（筛条件时最要紧）；没有差异就看产率或状态 */
function sibLine(s) {
  if (s.variant === '基准') return '基准';
  const d = Array.isArray(s.diffs) ? s.diffs.filter(Boolean) : [];
  if (s.variant === '重复' || !d.length) return s.variant === '重复' ? '重复' : sibMeta(s);
  // 「投料（LDA 当量）」括号里那截才是真变量，书签只有 84px，只留它
  const first = String(d[0]).replace(/^[^（]*（(.+)）$/, '$1');
  return d.length > 1 ? `改 ${first} +${d.length - 1}` : `改 ${first}`;
}

async function removeExperiment() {
  const ok = await confirm({
    title: `将 ${exp.value.code} 移入回收站？`,
    body: '记录将移入回收站，附件文件保留在磁盘上；可在「设置 → 回收站」恢复或彻底删除。',
    confirmText: '移入回收站',
    danger: true,
  });
  if (!ok) return;
  gone.value = true;   // 先停自动保存
  await api.deleteExperiment(exp.value.id);
  await loadBoot();
  await loadList();
  router.push('/list');
  toast('已移入回收站');
}

/** 溶剂的名称和浓度都从投料表里「溶剂」那几行来 */
const solventRows = computed(() =>
  reagent.rows.filter((r) => r.role === '溶剂' && String(r.name || '').trim())
);

const solventFromTable = computed(() =>
  [...new Set(solventRows.value.map((r) => String(r.name).trim()))].join(' / ')
);

const concFromTable = computed(() => {
  const r = solventRows.value[0];
  if (!r) return '';
  if (num(r.conc)) return `${round(r.conc, 3)} M`;
  const mmol = num(r.mmol);
  const ml = (num(r.volume_ul) ?? 0) / 1000;
  if (mmol && ml) return `${round(mmol / ml, 3)} M`;
  return '';
});

// 算出来就写回字段，导出 / 打印 / 搜索都跟得上；算不出来时保留原来填的内容
// 溶剂行被删干净时，把条件里的溶剂一起清掉（否则下次打开又会被补回来）
watch(solventFromTable, (s, old) => {
  if (s) {
    if (fields.solvent !== s) fields.solvent = s;
  } else if (old) {
    fields.solvent = '';
  }
});
watch(concFromTable, (c) => {
  if (c && fields.concentration !== c) fields.concentration = c;
});

// 投料表里算得出来才锁成只读文字；算不出来（比如没标「溶剂」行）就保留手填
/** 老记录把溶剂存在字段里：打开时补成投料表的一行（保存后就是表里的溶剂行了） */
function ensureSolventRow() {
  const s = String(fields.solvent || '').trim();
  if (!s) return;
  if (reagent.rows.some((r) => r.role === '溶剂' && String(r.name || '').trim())) return;
  reagent.rows.push({ step: Math.max(1, reagent.steps.length), role: '溶剂', eq: '', mwText: '', amountText: '', name: s, note: '' });
}

const condFixed = computed(() => {
  const fixed = {};
  if (solventFromTable.value) fixed.solvent = solventFromTable.value;
  if (concFromTable.value) fixed.concentration = concFromTable.value;
  return fixed;
});

const chips = ['¹H NMR', '¹³C NMR', '¹⁹F NMR', 'δ ', 's', 'd', 'dd', 't', 'q', 'm', 'br s', 'J = ', 'Hz', 'CDCl₃', 'DMSO-d₆', 'HRMS (ESI)', 'IR (neat)', 'Rf', '[α]D'];
function insertChip(text) {
  fields.characterization = `${fields.characterization || ''}${text}`;
  notify();
}

const meta = computed(() => exp.value || {});
/** 已有课题：课题格子的小下拉用 */
const projectList = computed(() => store.boot?.projects || []);
const exportOne = () => {
  moreMenu.value = false;
  window.open(`/api/experiments/${exp.value.id}/export.md`, '_blank');
};
const exportAll = () => {
  moreMenu.value = false;
  // 在某个课题里就只导这个课题，「全部」才导整本
  const p = store.project ? `?project=${encodeURIComponent(store.project)}` : '';
  window.open(`/api/export/notebook.md${p}`, '_blank');
};
/** 「像截屏一样」的两种导出：整页长图 / 自包含网页（都不按 A4 分页，不会被裁） */
async function snapshotPng() {
  if (dirty.value) await flush();
  try {
    await exportSnapshotPng(exp.value.code || '记录');
  } catch (e) {
    toast(e.message || '长图导出失败', 'err');
  }
}

async function snapshotBundle() {
  if (dirty.value) await flush();
  try {
    await exportSnapshotBundle(exp.value.code || '记录', exp.value.id);
  } catch (e) {
    toast(e.message || '打包失败', 'err');
  }
}

async function snapshotHtml() {
  if (dirty.value) await flush();
  try {
    await exportSnapshotHtml(exp.value.code || '记录');
  } catch (e) {
    toast(e.message || '导出失败', 'err');
  }
}

/** 点 TLC 图 / 反应式看大图：走弹窗预览（要下载再在弹窗里下） */
const preview = ref(null);
const openAttachment = (id) => {
  const a = (exp.value?.attachments || []).find((x) => x.id === id);
  if (!a) return;
  preview.value = { src: `/api/files/${id}`, name: a.original_name || a.filename || '附件' };
};
</script>

<template>
  <ExperimentMobile v-if="isPhone" :id="route.params.id" />

  <div v-else-if="error" class="single"><div class="empty-note" style="padding: 80px">{{ error }}</div></div>

  <div v-else class="panes">
    <!-- 左：实验列表。读取中就一直挂着——从列表/卡片墙点进来时，这栏以前会跟着
         整棵 v-if 分支一起卸载重建，看着就是闪一下 -->
    <ExpListPane />
    <PaneGrip />
    <div class="editor" ref="editorEl" @scroll="updateRail">
      <!-- 读取中：左边列表原地不动，只把右边这张纸换成空白骨架，
           不然点开记录是一整片白闪一下再长出内容 -->
      <template v-if="!exp">
        <div class="editor-bar">
          <span class="mono" style="font-size: 10.5px; color: var(--ink-4); letter-spacing: 0.08em">读取中…</span>
        </div>
        <div class="editor-inner">
          <article class="sheet sheet-loading" aria-hidden="true">
            <div class="sheet-runner">
              <span class="sk-line" style="width: 132px" /><span class="sk-line" style="width: 64px" />
            </div>
            <div class="sk-line sk-h" style="width: 46%" />
            <div class="sk-line" style="width: 88%; margin-top: 20px" />
            <div class="sk-line" style="width: 71%" />
            <div class="sk-line" style="width: 79%" />
            <div class="sk-line" style="width: 52%" />
          </article>
        </div>
      </template>

      <div v-if="exp" class="editor-bar">
        <span class="mono" style="font-size: 10.5px; color: var(--ink-4); letter-spacing: 0.08em">{{ exp.code }}</span>
        <div class="page-tabs noprint" role="tablist">
          <button class="ptab" :aria-selected="page === 1 ? 'true' : 'false'" @click="page = 1">第 1 页 · 主记录</button>
          <button class="ptab" :aria-selected="page === 2 ? 'true' : 'false'" @click="page = 2">第 2 页 · 续页</button>
        </div>
        <CatPick
          class="toolbar-cat"
          :value="fields.category_id == null || fields.category_id === '' ? '' : String(fields.category_id)"
          :categories="categoriesOfProject('experiment', fields.project)"
          count-key="exp_count"
          :show-all="false"
          @change="setCategory"
          @create="newCategory"
        />
        <span class="spacer" />
        <span class="save-state" :class="{ 'is-dirty': dirty }">{{ exp.locked ? '只读' : saveState }}</span>
        <button class="btn btn-sm" :disabled="exp.locked" title="立即保存（⌘S）" @click="doSave">保存</button>
        <button class="btn btn-sm btn-ghost" :disabled="exp.locked" title="放弃本次修改，恢复到打开时的内容" @click="doReset">重置</button>
        <div class="menu-wrap">
          <button class="btn btn-sm btn-ghost" title="更多" @click.stop="moreMenu = !moreMenu">
            <Icon name="dots" :size="15" />
          </button>
          <div v-if="moreMenu" class="menu">
            <button @click="doPrint(); moreMenu = false"><Icon name="print" :size="13" /> 打印</button>
            <button @click="toggleLock(); moreMenu = false">
              <Icon :name="exp.locked ? 'unlock' : 'lock'" :size="13" /> {{ exp.locked ? '解锁' : '锁定' }}
            </button>
            <button @click="historyOpen = true; moreMenu = false"><Icon name="file" :size="13" /> 历史</button>
            <div class="menu-sep" />
            <button @click="qrModal = true; moreMenu = false"><Icon name="qr" :size="13" /> 二维码</button>
            <!-- 导出类收进二级菜单（点一下展开，比一排「导出…（…）」干净） -->
            <div class="menu-group">
              <button :class="{ 'is-open': exportSub }" @click.stop="exportSub = !exportSub">
                <Icon name="download" :size="13" /> 导出 <span class="menu-caret">›</span>
              </button>
              <div v-if="exportSub" class="menu menu-sub">
                <button @click="exportOne(); closeMore()"><Icon name="file" :size="13" /> 本条记录</button>
                <button @click="exportAll(); closeMore()"><Icon name="book" :size="13" /> 整本记录</button>
                <button @click="snapshotPng(); closeMore()"><Icon name="image" :size="13" /> 长图 PNG</button>
                <button @click="snapshotHtml(); closeMore()"><Icon name="file" :size="13" /> 单文件网页</button>
                <button @click="snapshotBundle(); closeMore()"><Icon name="folder" :size="13" /> 打包 ZIP</button>
              </div>
            </div>
            <button @click="duplicate(); moreMenu = false"><Icon name="copy" :size="13" /> 复制</button>
            <button @click="undoSave()"><Icon name="undo" :size="13" /> 撤销上次保存</button>
            <button @click="newParallel()"><Icon name="plus" :size="13" /> 新建平行实验</button>
            <button @click="saveToCompound()"><Icon name="molecule" :size="13" /> 产物存库</button>
            <div class="menu-sep" />
            <button class="menu-danger" @click="removeExperiment(); moreMenu = false">
              <Icon name="trash" :size="13" /> 移入回收站
            </button>
          </div>
        </div>
      </div>

      <div v-if="exp" class="editor-inner">
        <!-- ============ 第 1 页 ============ -->
        <article class="sheet sheet-p1" ref="sheetEl" :class="{ 'is-hidden': page !== 1 }">
          <div class="sheet-runner">
            <span>{{ store.boot?.settings?.lab_heading || '方法学实验记录' }}</span>
            <span>{{ exp.code }}</span>
          </div>

          <!-- 大标题 = 实验名；右边那颗小格写「描述」（实验目的） -->
          <div class="sheet-headline">
            <input class="sheet-title" v-model="fields.title" placeholder="实验名称" :disabled="exp.locked" />
            <input class="sheet-desc" v-model="fields.objective" placeholder="描述 / 目的" :disabled="exp.locked" title="这一步想解决什么（一句话）" />
          </div>

          <table class="sheet-meta">
            <colgroup>
              <col style="width: 62px" /><col style="width: 92px" /><col style="width: 52px" /><col style="width: 136px" />
              <col style="width: 52px" /><col style="width: 150px" /><col style="width: 50px" /><col />
            </colgroup>
            <tbody>
              <tr>
                <th>NO.</th>
                <td><input class="mono" :value="exp.code" readonly /></td>
                <th>日期</th>
                <td class="date-cell">
                  <input type="date" v-model="fields.date" :disabled="exp.locked" />
                  <button type="button" class="mini noprint" title="设为今天" @click="fields.date = todayISO(); notify()">今</button>
                </td>
                <template v-if="sheetPrefs.env">
                  <th>温度</th>
                  <td><input v-model="fields.ambient_temp" placeholder="18.8 ℃" :disabled="exp.locked" /></td>
                  <th>湿度</th>
                  <td><input v-model="fields.ambient_humid" placeholder="34 %" :disabled="exp.locked" /></td>
                </template>
                <td v-else colspan="4" class="meta-fill" />
              </tr>
              <tr>
                <th>实验人</th>
                <td><input v-model="fields.operator" placeholder="记录人" :disabled="exp.locked" /></td>
                <th>课题</th>
                <td class="proj-cell"><ProjPick :model-value="fields.project" :projects="projectList" :disabled="exp.locked" @update:model-value="onProjectChange" /></td>
                <th>类型</th>
                <td class="kind-cell">
                  <div class="kind-inline">
                    <select class="kind-pick" v-model="fields.kind" :disabled="exp.locked" title="记录类型（原料/试反应/条件筛选/底物扩展，并行存在）">
                      <option value="">通用</option>
                      <option v-for="k in KINDS" :key="k.key" :value="k.key">{{ k.key }}</option>
                    </select>
                    <div class="rxn-wrap">
                      <input
                        class="kind-rxn"
                        v-model="fields.rxn_type"
                        placeholder="反应类型"
                        :disabled="exp.locked"
                        title="反应类型：改当量 / 放大实验 / 转化…（也可以自己写）"
                        @click.stop="rxnMenu = true"
                        @focus="rxnMenu = true"
                        @keydown.esc="rxnMenu = false"
                      />
                      <div v-if="rxnMenu && !exp.locked" class="rxn-menu">
                        <button
                          v-for="t in RXN_TYPES"
                          :key="t"
                          type="button"
                          class="rxn-opt"
                          :class="{ 'is-on': fields.rxn_type === t }"
                          @click="fields.rxn_type = t; rxnMenu = false; notify()"
                        >
                          {{ t }}
                        </button>
                        <button
                          v-if="fields.rxn_type"
                          type="button"
                          class="rxn-opt is-clear"
                          @click="fields.rxn_type = ''; rxnMenu = false; notify()"
                        >
                          清掉
                        </button>
                      </div>
                    </div>
                  </div>
                </td>
                <th>状态</th>
                <td class="tight status-cell">
                  <div class="status-wrap">
                    <button type="button" class="status-chip" :class="`tone-${STATUS_TONE[fields.status] || 'plain'}`" @click.stop="statusMenu = !statusMenu">
                      {{ fields.status }}
                    </button>
                    <div v-if="statusMenu" class="status-menu">
                      <button
                        v-for="s in STATUSES"
                        :key="s"
                        type="button"
                        class="status-opt"
                        :class="`tone-${STATUS_TONE[s]}`"
                        @click="updateStatus(s)"
                      >
                        <span class="dot" />{{ s }}
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
              <tr v-if="sheetPrefs.literature">
                <th>文献</th>
                <td colspan="7"><input v-model="fields.literature" placeholder="DOI / 参考文献" :disabled="exp.locked" /></td>
              </tr>
            </tbody>
          </table>

          <SchemeBlock
            v-if="sheetPrefs.scheme"
            :attachments="exp.attachments || []"
            :locked="exp.locked"
            :hovered="hovered"
            :on-hover="onHover"
            :on-pick="pickFile"
            :on-open="openAttachment"
            :on-sketch="openSchemePad"
            :on-from-table="schemeFromTable"
            :live-svg="liveScheme"
          />

          <ReagentTable v-if="sheetPrefs.reagents" :model="reagent" :notify="notify" :locked="exp.locked" @recipe="openRecipe">
            <template #cond>
              <CondRow :model="fields" :notify="notify" :locked="exp.locked" :fixed="condFixed" />
            </template>
          </ReagentTable>

          <ResultBlock
            v-if="sheetPrefs.result"
            ref="resBlock"
            :model="fields"
            :base="reagent.base" :notify="notify" :locked="exp.locked" @open-compound="(id) => router.push(`/compounds/${id}`)" />


        </article>

        <!-- 平行书签是浮层：挂在 body 上、按纸面位置钉住，滚动容器裁不到它 -->
        <Teleport to="body">
          <!-- 平行组书签：从纸面左边凸出去的一排纸签（重复实验 / 控制变量实验）。
               悬停先看一眼，点下去才切记录。 -->
          <nav
            v-if="siblings.length > 1 && page === 1"
            class="pgroup pgroup--float noprint"
            :class="{ 'is-dense': siblings.length > 6 }"
            :style="railStyle"
            aria-label="平行实验"
          >
            <button type="button" class="pgroup-cap" @click="railOpen = !railOpen">
              {{ railOpen ? `平行 ×${siblings.length}` : '平行 ▸' }}
            </button>
            <template v-if="railOpen">
            <button
              v-for="s in siblings"
              :key="s.id"
              type="button"
              class="pgroup-tab"
              :class="{ 'is-on': String(s.id) === String(exp.id) }"
              :data-tone="STATUS_TONE[s.status] || 'plain'"
              :style="{ '--tick-w': `${tickW(s)}px` }"
              :data-code="s.code"
              :aria-label="`${s.code}${s.variant ? ` · ${s.variant}` : ''}`"
              @mouseenter="showPeek(s, $event)"
              @mouseleave="hidePeek()"
              @click="String(s.id) === String(exp.id) ? null : router.push(`/e/${s.id}`)"
            >
              <!-- 编号写在纸面自己的左边距里（短杠右侧）：写在外侧那条缝里会被悬停预览卡盖住。
                   详细的条件 / 结果还是靠悬停预览卡。 -->
              <span class="pgroup-lbl" aria-hidden="true">{{ s.code }}</span>
            </button>
            <button type="button" class="pgroup-add" title="从这条实验新建平行实验" @click="newParallel">＋</button>
            </template>
          </nav>
          <!-- 悬停预览卡：挂到 body 上、放在书签外侧（左边），绝不压在纸面上 -->
          <Teleport to="body">
            <div v-if="peek" ref="peekEl" class="pgroup-peek-float" :style="peekPos">
              <p class="peek-line">{{ peekLine }}</p>
              <p v-if="peekBody" class="peek-body">{{ peekBody }}</p>
            </div>
          </Teleport>
        </Teleport>

        <!-- ============ 第 2 页 ============ -->
        <article class="sheet sheet-p2" :class="{ 'is-hidden': page !== 2 }">
          <div class="sheet-runner">
            <span>{{ store.boot?.settings?.lab_heading || '方法学实验记录' }} · 续页</span>
            <span>{{ exp.code }}</span>
          </div>

          <section v-if="sheetPrefs.procedure" class="sec">
            <h2 class="sec-title"><span class="num">一</span>实验操作与现象</h2>
            <div class="op-grid">
              <div class="op-cell">
                <span class="op-cap">操作</span>
                <textarea class="sheet-text mono" rows="3" v-autogrow v-model="fields.procedure" :disabled="exp.locked" placeholder="加料、换气、升温、取样…" />
              </div>
              <label class="op-cell">
                <span class="op-cap">现象</span>
                <textarea class="sheet-text" rows="3" v-autogrow v-model="fields.notes" :disabled="exp.locked" placeholder="颜色、放热、气体、析出…" />
              </label>
            </div>
            <!-- 照片单独一整行：以前是右边一窄栏竖着堆，图一高「操作 / 现象」下面就是一大片空白（用户提的） -->
            <div class="op-shots">
              <span class="op-cap">照片</span>
              <div class="sec-shots" @mouseenter="onHover('photo')" @mouseleave="onHover('')">
                <TlcStrip
                  category="photo"
                  captions
                  :attachments="exp.attachments || []"
                  :locked="exp.locked"
                  :hovered="hovered"
                  :on-hover="onHover"
                  :on-pick="pickFile"
                  :on-open="openAttachment"
                  :on-caption="saveCaption"
                  :on-delete="async (id) => { await api.deleteAttachment(id); await refreshAttachments(); }"
                />
              </div>
            </div>
          </section>
          <section v-if="sheetPrefs.workup" class="sec">
            <h2 class="sec-title"><span class="num">二</span>后处理</h2>
            <textarea class="sheet-text" rows="2" v-autogrow v-model="fields.workup" :disabled="exp.locked" placeholder="淬灭、萃取、干燥、柱层析（洗脱剂配比、Rf）" />
          </section>
          <section v-if="sheetPrefs.tlc" class="sec sec-tight sec-tlc">
            <div class="block-head">
              <span class="lbl">TLC</span>
              <input class="tlc-note" v-model="fields.tlc_note" placeholder="展开剂 / 显色方式，如 PE:EA = 10:1，UV + 磷钼酸" :disabled="exp.locked" />
              <TlcOcr :shots="tlcShots" scope="attachment" @pick="applyTlcOcr" />
            </div>
            <TlcStrip
              :attachments="exp.attachments || []"
              :locked="exp.locked"
              :hovered="hovered"
              :on-hover="onHover"
              :on-pick="pickFile"
              :on-open="openAttachment"
              :on-delete="async (id) => { await api.deleteAttachment(id); await refreshAttachments(); }"
            />
          </section>
          <section v-if="sheetPrefs.characterization" class="sec">
            <h2 class="sec-title"><span class="num">三</span>表征数据</h2>
            <textarea class="sheet-text mono" rows="4" v-autogrow v-model="fields.characterization" :disabled="exp.locked" />
            <div class="chips noprint">
              <button v-for="c in chips" :key="c" class="chip" type="button" @click="insertChip(c)">{{ c }}</button>
            </div>
          </section>
          <section v-if="sheetPrefs.conclusion" class="sec">
            <h2 class="sec-title"><span class="num">四</span>讨论与结论</h2>
            <textarea class="sheet-text" rows="2" v-autogrow v-model="fields.conclusion" :disabled="exp.locked" placeholder="本组条件的结论与下一轮拟考察的变量" />
          </section>

          <!-- 文献：文献里的反应式 / 条件表截图（可多张、带图注）+ 一段要点。出处仍是第 1 页抬头那格「文献」 -->
          <section v-if="sheetPrefs.lit" class="sec">
            <h2 class="sec-title"><span class="num">五</span>文献</h2>
            <textarea
              class="sheet-text"
              rows="2"
              v-autogrow
              v-model="fields.lit_note"
              :disabled="exp.locked"
              placeholder="文献里的标准条件 / 产率 / 跟我们做法的差别"
            />
            <div class="op-shots">
              <span class="op-cap">文献图</span>
              <div class="sec-shots is-lit" @mouseenter="onHover('lit')" @mouseleave="onHover('')">
                <TlcStrip
                  category="literature"
                  captions
                  cap-placeholder="图注，如：文献 Table 2 / Scheme 1"
                  :attachments="exp.attachments || []"
                  :locked="exp.locked"
                  :hovered="hovered"
                  :on-hover="onHover"
                  :on-pick="pickFile"
                  :on-open="openAttachment"
                  :on-caption="saveCaption"
                  :on-delete="async (id) => { await api.deleteAttachment(id); await refreshAttachments(); }"
                />
              </div>
            </div>
          </section>

          <AttachmentsBlock
            v-if="sheetPrefs.attachments"
            :exp-id="exp.id"
            :attachments="exp.attachments || []"
            :locked="exp.locked"
            @refresh="refreshAttachments"
          />

          <div class="sheet-foot noprint">
            <button class="btn btn-sm btn-danger" :disabled="exp.locked" @click="removeExperiment"><Icon name="trash" :size="13" /> 移入回收站</button>
            <span class="hint">数据目录 <span class="mono">{{ store.boot?.dataDir }}</span></span>
          </div>
        </article>
      </div>
    </div>

    <AppModal v-if="recipeModal" title="套用已有投料表" confirm-text="套用" @close="recipeModal = false" @confirm="applyRecipe">
      <div class="recipe-list">
        <button
          v-for="it in recipeList.filter((x) => x.id !== exp.id && x.reagent_count)"
          :key="it.id"
          type="button"
          class="recipe-opt"
          :class="{ 'is-on': recipePick === it.id }"
          @click="recipePick = it.id"
        >
          <span class="recipe-code mono">{{ it.code }}</span>
          <span class="recipe-title">{{ it.title || '（未命名实验）' }}</span>
          <span class="recipe-meta">{{ it.reagent_count }} 行 · {{ it.date }}</span>
        </button>
      </div>
      <div class="hint" style="margin-top: 10px">仅复制试剂名、组分、分子量与当量；mmol 与用量按当前规模重新计算。</div>
    </AppModal>

    <HistoryModal v-if="historyOpen" entity="experiment" :id="exp.id" @close="historyOpen = false" />

    <AppModal v-if="qrModal" title="手机扫码查看" confirm-text="打印二维码" @close="qrModal = false" @confirm="printQr">
      <div class="qr-modal">
        <img :src="`/api/experiments/${exp.id}/qr.svg?unit=8`" alt="二维码" />
        <div class="mono qr-modal-code">{{ exp.code }}</div>
        <p class="hint">手机端为只读精简版：反应式、投料、条件与结果。</p>
      </div>
    </AppModal>

    <FilePreview v-if="preview" :src="preview.src" :name="preview.name" @close="preview = null" />

    <SketcherModal
      :open="schemeSketcherOpen"
      mode="reaction"
      :initial="schemePadSeed || fields.scheme_rxn || ''"
      @close="schemeSketcherOpen = false"
      @pick="applySketchScheme"
    />

    <PrintPanel
      v-if="printPanel"
      :title="`打印 · ${exp?.code || ''}`"
      :filename="`${exp?.code || '记录'}.pdf`"
      @close="printPanel = false"
      @print="runPrint"
    />

  </div>
</template>
