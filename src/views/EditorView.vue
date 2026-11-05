<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppModal from '../components/AppModal.vue';
import ExperimentMobile from '../components/ExperimentMobile.vue';
import ExpListPane from '../components/ExpListPane.vue';
import AttachmentsBlock from '../components/AttachmentsBlock.vue';
import CondRow from '../components/CondRow.vue';
import ReagentTable from '../components/ReagentTable.vue';
import ResultBlock from '../components/ResultBlock.vue';
import SchemeBlock from '../components/SchemeBlock.vue';
import TlcStrip from '../components/TlcStrip.vue';
import Icon from '../components/Icon.vue';
import CatPick from '../components/CatPick.vue';
import HistoryModal from '../components/HistoryModal.vue';
import PrintPanel from '../components/PrintPanel.vue';
import ProjPick from '../components/ProjPick.vue';
import { api } from '../api.js';
import { loadBoot, loadList, store, categoriesOfProject, addCategory } from '../store.js';
import { STATUSES, STATUS_TONE, todayISO } from '../lib/ui.js';
import { useAutosave } from '../lib/autosave.js';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { amountText, derive, mwText, num, round } from '../lib/reagent.js';
import { flattenTextareas } from '../lib/autogrow.js';

const route = useRoute();
const router = useRouter();

const exp = ref(null);
const error = ref('');
const page = ref(1);
const hovered = ref('');
const statusMenu = ref(false);
const moreMenu = ref(false);
const gone = ref(false);   // 删掉了就不再自动保存
const historyOpen = ref(false);
const recipeModal = ref(false);
const qrModal = ref(false);
const recipeList = ref([]);
const recipePick = ref(null);

const fields = reactive({
  title: '', date: '', status: '进行中', operator: '', ambient_temp: '', ambient_humid: '',
  project: '', rxn_type: '', literature: '', objective: '', solvent: '', concentration: '',
  temperature: '', duration: '', atmosphere: '', workup: '', procedure: '', product_name: '',
  appearance: '', yield_pct: '', product_mass: '', product_mw: '', tlc_note: '', dr_ee: '',
  ee_pct: '', sel_method: '', sel_condition: '', sel_rt: '',
  characterization: '', notes: '', conclusion: '', product_compound_id: null, category_id: null,
});

const reagent = reactive({ base: null, steps: [], rows: [] });

const FIELD_KEYS = Object.keys(fields);

function toRow(r) {
  return {
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
}

function fill(e) {
  exp.value = e;
  for (const k of FIELD_KEYS) if (k in e) fields[k] = e[k] ?? (typeof fields[k] === 'number' ? null : '');
  fields.product_compound_id = e.product_compound_id ?? null;

  const raw = Array.isArray(e.steps) ? e.steps : [];
  const list = raw.map((s) => ({
    label: s.label || '',
    condition: s.condition || '',
    workup: s.workup || '',
    start: s.start || '',
    end: s.end || '',
  }));
  const need = (e.reagents || []).reduce((m, r) => Math.max(m, Number(r.step) || 1), 1);
  while (list.length < Math.max(1, need)) list.push({ label: '', condition: '', workup: '', start: '', end: '' });
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
  markLoaded();
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
  }
);

/** 窄屏（手机）走只读精简页，桌面版式完全不渲染 */
const isPhone = ref(typeof window !== 'undefined' && window.innerWidth <= 820);
function onResize() {
  isPhone.value = window.innerWidth <= 820;
}

onMounted(async () => {
  window.addEventListener('resize', onResize);
  window.addEventListener('resize', updateRail);
  page.value = String(route.query.p) === '2' ? 2 : 1;
  if (!isPhone.value) await load();
  document.addEventListener('paste', onPaste);
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', onShortcut);
  // 等这一帧渲染完再量纸面位置
  requestAnimationFrame(updateRail);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  window.removeEventListener('resize', updateRail);
  document.removeEventListener('paste', onPaste);
  document.removeEventListener('click', closeMenus);
  document.removeEventListener('keydown', onShortcut);
});

/** ⌘S / Ctrl+S 立即保存（浏览器默认的「保存网页」挡掉） */
function onShortcut(ev) {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    void doSave();
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
}

function payload() {
  const body = {};
  for (const k of FIELD_KEYS) body[k] = fields[k];
  body.base_mmol = reagent.base;
  body.steps = reagent.steps.map((s) => ({ ...s }));
  body.reagents = reagent.rows.map(({ mwText, amountText, ...r }) => r);
  return body;
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
const { state: saveState, dirty, markLoaded, touch: notify, flush } = useAutosave(payload, saveNow, {
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
      <div class="exp-qr-name">${(exp.value.title || '').replace(/[<>&]/g, '')}</div>
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
  const list = (full.steps || []).map((s) => ({ label: s.label || '', condition: s.condition || '', workup: s.workup || '' }));
  while (!list.length) list.push({ label: '', condition: '', workup: '' });
  reagent.steps = list;
  // 套用配方 = 把这套投料方案按「当前反应规模」重新算一遍（弹窗上就是这么写的）。
  // 以前只把 mmol/用量清空，表里剩下一个个空格，得逐行重填。
  const scale = num(reagent.base);
  reagent.rows = (full.reagents || []).map((r) => {
    const row = { ...toRow(r), mmol: null, mass_mg: null, volume_ul: null, amountText: '' };
    if (scale && row.role !== '溶剂' && num(row.eq) !== null) {
      row.mmol = round(scale * num(row.eq), 4);
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
const railStyle = ref({});
function updateRail() {
  const el = sheetEl.value;
  if (!el || page.value !== 1) return;
  const r = el.getBoundingClientRect();
  railStyle.value = { left: `${Math.round(r.left)}px`, top: `${Math.round(r.top + 42)}px` };
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
    const e = await api.parallel(exp.value.id);
    await loadList();
    router.push(`/e/${e.id}`);
    toast('已按这条实验新建一条平行实验；结果留空，改掉要变的那个变量就行');
  } catch (err) {
    toast(err.message || '建不了平行实验', 'err');
  }
}

/** 悬停预览卡：跟着鼠标所在的那枚书签定位，永远放在书签**左边**（不压纸张） */
const peek = ref(null);
const peekPos = ref({});
function showPeek(s, ev) {
  const r = ev.currentTarget.getBoundingClientRect();
  const width = 232;
  // 卡片右边贴在书签左边；左边不够就尽量靠左，别出屏幕
  const left = Math.max(8, r.left - width - 10);
  const top = Math.max(8, Math.min(window.innerHeight - 152, r.top - 6));
  peekPos.value = { left: `${left}px`, top: `${top}px`, width: `${width}px` };
  peek.value = s;
}
function hidePeek() {
  peek.value = null;
}

/** 书签上那一行小字：产率有就写产率，没有就写状态 */
function sibMeta(s) {
  const y = num(s.yield_pct);
  return y !== null ? `${round(y, 1)}%` : s.status || '';
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
watch([solventFromTable, concFromTable], ([s, c]) => {
  if (s && fields.solvent !== s) fields.solvent = s;
  if (c && fields.concentration !== c) fields.concentration = c;
});

// 投料表里算得出来才锁成只读文字；算不出来（比如没标「溶剂」行）就保留手填
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
const openAttachment = (id) => window.open(`/api/files/${id}`, '_blank');
</script>

<template>
  <ExperimentMobile v-if="isPhone" :id="route.params.id" />

  <div v-else-if="error" class="single"><div class="empty-note" style="padding: 80px">{{ error }}</div></div>

  <div v-else-if="!exp" class="single"><div class="empty-note" style="padding: 80px">读取中…</div></div>

  <div v-else class="panes">
    <!-- 左：实验列表 -->
    <ExpListPane />
    <div class="editor" ref="editorEl" @scroll="updateRail">
      <div class="editor-bar">
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
            <button @click="doPrint(); moreMenu = false"><Icon name="print" :size="13" /> 打印这条记录</button>
            <button @click="toggleLock(); moreMenu = false">
              <Icon :name="exp.locked ? 'unlock' : 'lock'" :size="13" /> {{ exp.locked ? '解锁（恢复可编辑）' : '锁定（此后只读）' }}
            </button>
            <button @click="historyOpen = true; moreMenu = false"><Icon name="file" :size="13" /> 修改历史</button>
            <div class="menu-sep" />
            <button @click="qrModal = true; moreMenu = false"><Icon name="qr" :size="13" /> 二维码（手机端查看）</button>
            <button @click="exportOne(); moreMenu = false"><Icon name="download" :size="13" /> 导出本条实验</button>
            <button @click="exportAll(); moreMenu = false"><Icon name="download" :size="13" /> 导出整本记录</button>
            <button @click="duplicate(); moreMenu = false"><Icon name="copy" :size="13" /> 复制这条实验</button>
            <button @click="newParallel()"><Icon name="plus" :size="13" /> 新建平行实验（重复 / 改一个变量）</button>
            <button @click="saveToCompound()"><Icon name="molecule" :size="13" /> 产物存入化合物库</button>
            <div class="menu-sep" />
            <button class="menu-danger" @click="removeExperiment(); moreMenu = false">
              <Icon name="trash" :size="13" /> 移入回收站
            </button>
          </div>
        </div>
      </div>

      <div class="editor-inner">
        <!-- ============ 第 1 页 ============ -->
        <article class="sheet sheet-p1" ref="sheetEl" :class="{ 'is-hidden': page !== 1 }">
          <div class="sheet-runner">
            <span>{{ store.boot?.settings?.lab_heading || '方法学实验记录' }}</span>
            <span>{{ exp.code }}</span>
          </div>

          <input class="sheet-title" v-model="fields.title" placeholder="实验名称" :disabled="exp.locked" />

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
                <th>温度</th>
                <td><input v-model="fields.ambient_temp" placeholder="18.8 ℃" :disabled="exp.locked" /></td>
                <th>湿度</th>
                <td><input v-model="fields.ambient_humid" placeholder="34 %" :disabled="exp.locked" /></td>
              </tr>
              <tr>
                <th>实验人</th>
                <td><input v-model="fields.operator" placeholder="记录人" :disabled="exp.locked" /></td>
                <th>课题</th>
                <td class="proj-cell"><ProjPick :model-value="fields.project" :projects="projectList" :disabled="exp.locked" @update:model-value="onProjectChange" /></td>
                <th>类型</th>
                <td><input v-model="fields.rxn_type" placeholder="C–H 活化" :disabled="exp.locked" /></td>
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
              <tr>
                <th>文献</th>
                <td colspan="7"><input v-model="fields.literature" placeholder="DOI / 参考文献" :disabled="exp.locked" /></td>
              </tr>
            </tbody>
          </table>

          <SchemeBlock
            :attachments="exp.attachments || []"
            :locked="exp.locked"
            :hovered="hovered"
            :on-hover="onHover"
            :on-pick="pickFile"
          />

          <ReagentTable :model="reagent" :notify="notify" :locked="exp.locked" @recipe="openRecipe">
            <template #cond>
              <CondRow :model="fields" :notify="notify" :locked="exp.locked" :fixed="condFixed" />
            </template>
          </ReagentTable>

          <ResultBlock :model="fields" :base="reagent.base" :notify="notify" :locked="exp.locked" @open-compound="(id) => router.push(`/compounds/${id}`)" />

          <section class="sec sec-tight sec-tlc">
            <div class="block-head">
              <span class="lbl">TLC</span>
              <input class="tlc-note" v-model="fields.tlc_note" placeholder="展开剂 / 显色方式，如 PE:EA = 10:1，UV + 磷钼酸" :disabled="exp.locked" />
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
        </article>

        <!-- 平行书签是浮层：挂在 body 上、按纸面位置钉住，滚动容器裁不到它 -->
        <Teleport to="body">
          <!-- 平行组书签：从纸面左边凸出去的一排纸签（重复实验 / 控制变量实验）。
               悬停先看一眼，点下去才切记录。 -->
          <nav v-if="siblings.length > 1 && page === 1" class="pgroup pgroup--float noprint" :style="railStyle" aria-label="平行实验">
            <span class="pgroup-cap">平行</span>
            <button
              v-for="s in siblings"
              :key="s.id"
              type="button"
              class="pgroup-tab"
              :class="{ 'is-on': String(s.id) === String(exp.id) }"
              :title="`${s.code}${s.variant ? ` · ${s.variant}` : ''}`"
              @mouseenter="showPeek(s, $event)"
              @mouseleave="hidePeek()"
              @click="String(s.id) === String(exp.id) ? null : router.push(`/e/${s.id}`)"
            >
              <span class="pgroup-row">
                <span class="pgroup-code">{{ s.code }}</span>
                <span class="pgroup-meta">{{ sibMeta(s) }}</span>
              </span>
            </button>
            <button type="button" class="pgroup-add" title="从这条实验新建平行实验" @click="newParallel">＋</button>
          </nav>
          <!-- 悬停预览卡：挂到 body 上、放在书签外侧（左边），绝不压在纸面上 -->
          <Teleport to="body">
            <div v-if="peek" class="pgroup-peek-float" :style="peekPos">
              <div class="pgroup-peek-title">{{ peek.title || '（未命名实验）' }}</div>
              <div class="pgroup-peek-line">{{ peek.date }} · {{ peek.status }}<template v-if="peek.yield_pct != null"> · 产率 {{ peek.yield_pct }}%</template></div>
              <div v-if="peek.substrates" class="pgroup-peek-line">底物：{{ peek.substrates }}</div>
              <div v-if="[peek.solvent, peek.temperature, peek.duration].filter(Boolean).length" class="pgroup-peek-line">
                {{ [peek.solvent, peek.temperature, peek.duration].filter(Boolean).join(' · ') }}<template v-if="peek.base_mmol"> ｜ {{ peek.base_mmol }} mmol</template>
              </div>
              <div v-if="peek.variant === '重复'" class="pgroup-peek-line">与基准完全相同（重复实验）</div>
              <div v-else-if="peek.diffs && peek.diffs.length" class="pgroup-peek-line">与基准相比：{{ peek.diffs.join('、') }}</div>
              <div class="pgroup-peek-line">{{ peek.code }} · 点一下切到这条</div>
            </div>
          </Teleport>
        </Teleport>

        <!-- ============ 第 2 页 ============ -->
        <article class="sheet sheet-p2" :class="{ 'is-hidden': page !== 2 }">
          <div class="sheet-runner">
            <span>{{ store.boot?.settings?.lab_heading || '方法学实验记录' }} · 续页</span>
            <span>{{ exp.code }}</span>
          </div>

          <section class="sec">
            <h2 class="sec-title"><span class="num">一</span>实验目的</h2>
            <textarea class="sheet-text" rows="2" v-autogrow v-model="fields.objective" :disabled="exp.locked" placeholder="实验目的与预期结果" />
          </section>
          <section class="sec">
            <h2 class="sec-title"><span class="num">二</span>实验操作</h2>
            <textarea class="sheet-text mono" rows="3" v-autogrow v-model="fields.procedure" :disabled="exp.locked" placeholder="按时间顺序记录加料、换气、升温、取样等操作节点" />
          </section>
          <section class="sec">
            <h2 class="sec-title"><span class="num">三</span>实验现象</h2>
            <textarea class="sheet-text" rows="2" v-autogrow v-model="fields.notes" :disabled="exp.locked" placeholder="颜色、溶解性、放热、气体、析出、TLC 变化" />
          </section>
          <section class="sec">
            <h2 class="sec-title"><span class="num">四</span>后处理</h2>
            <textarea class="sheet-text" rows="2" v-autogrow v-model="fields.workup" :disabled="exp.locked" placeholder="淬灭、萃取、干燥、柱层析（洗脱剂配比、Rf）" />
          </section>
          <section class="sec">
            <h2 class="sec-title"><span class="num">五</span>表征数据</h2>
            <textarea class="sheet-text mono" rows="4" v-autogrow v-model="fields.characterization" :disabled="exp.locked" />
            <div class="chips noprint">
              <button v-for="c in chips" :key="c" class="chip" type="button" @click="insertChip(c)">{{ c }}</button>
            </div>
          </section>
          <section class="sec">
            <h2 class="sec-title"><span class="num">六</span>讨论与结论</h2>
            <textarea class="sheet-text" rows="2" v-autogrow v-model="fields.conclusion" :disabled="exp.locked" placeholder="本组条件的结论与下一轮拟考察的变量" />
          </section>

          <AttachmentsBlock
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

    <PrintPanel
      v-if="printPanel"
      :title="`打印 · ${exp?.code || ''}`"
      :filename="`${exp?.code || '记录'}.pdf`"
      @close="printPanel = false"
      @print="runPrint"
    />

  </div>
</template>
