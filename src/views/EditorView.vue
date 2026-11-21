<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { markPopupOpen, ignoreOutsideClick } from '../lib/popguard.js';
import { useRoute, useRouter } from 'vue-router';
import AppModal from '../components/AppModal.vue';
import ExperimentMobile from '../components/ExperimentMobile.vue';
import ExpListPane from '../components/ExpListPane.vue';
import AttachmentsBlock from '../components/AttachmentsBlock.vue';
import FilePreview from '../components/FilePreview.vue';
import CondCand from '../components/CondCand.vue';
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
import ExpPick from '../components/ExpPick.vue';
import ProductBind from '../components/ProductBind.vue';
import SyncConflicts from '../components/SyncConflicts.vue';
import { api } from '../api.js';
import { loadBoot, loadList, loadCompounds, store, categoriesOfProject, addCategory, compoundDict, quickList, reagentDict } from '../store.js';
import { STATUSES, STATUS_TONE, isImageName, todayISO } from '../lib/ui.js';
import { sheetFx, sheetPrefs, sheetTlcMax, sheetSchemeFmt, useSheetBlocks } from '../lib/sheetprefs.js';
import { KINDS } from '../lib/kind.js';
import { useAutosave } from '../lib/autosave.js';
import TlcOcr from '../components/TlcOcr.vue';
import { confirm, confirmLines, prompt, toast } from '../lib/feedback.js';
import { amountText, derive, eqLabel, eqNum, mwText, num, round, saneDensity, volText } from '../lib/reagent.js';
import { buildReportCard, reportCardCss } from '../lib/reportcard.js';
import { downloadBlob } from '../lib/print.js';
import { schemeParts, productSmilesOf } from '../lib/expScheme.js';
import { preloadSchemeLib } from '../lib/scheme.js';
import { flattenTextareas } from '../lib/autogrow.js';
import { exportSnapshotBundle, exportSnapshotHtml, exportSnapshotPng } from '../lib/snapshot.js';
import { peekPrefs } from '../lib/peek.js';
import { onUiMerged, uiGet } from '../lib/uiprefs.js';
import { composeChainSvg } from '../lib/scheme.js';
import { analyzeSmiles, svgToFile } from '../lib/chem.js';

const route = useRoute();
const router = useRouter();

const exp = ref(null);
const error = ref('');
const page = ref(1);
/**
 * 「切记录时停在同一页」（设置页 04 界面里那个开关，存 `uiprefs` 的 `pageKeep`，默认开）。
 * 用户：「假设你在第二页，切换实验的话就也到对应的第二页，然后如果没有第 X 页的话就默认第一页。」
 * 哪几页存在是**看设置**的：文献（3）要 `sheetPrefs.lit`，附件（4）要 `sheetPrefs.attachments`，
 * 第 1 / 2 页永远有。
 */
const keepPage = ref(uiGet('pageKeep', true) !== false);
onUiMerged(() => {
  keepPage.value = uiGet('pageKeep', true) !== false;
});
/** 这一页现在存不存在（不存在的就退回第 1 页）。`pageTabs` 在下面定义，这里只声明不执行 */
function pageExists(p) {
  return pageTabs.value.includes(Number(p));
}
/* 第 3 页（文献）有没有内容：没内容时打印 / 存 PDF 不带这一页，不留一张白纸 */
const litHasContent = computed(
  () =>
    String(fields.lit_note || '').trim() !== '' ||
    (exp.value?.attachments || []).some((a) => a.category === 'literature')
);
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
  appearance: '', yield_pct: '', product_mass: '', product_mw: '', tlc_note: '', tlc_verdict: '', tlc_shot_id: null, dr_ee: '',
  ee_pct: '', sel_method: '', sel_condition: '', sel_rt: '',
  characterization: '', notes: '', conclusion: '', product_compound_id: null, category_id: null,
  no_yield: 0,
  scheme_rxn: '',
  scheme_smiles: '',
  lit_note: '',
  kind: '',
  // 两步反应：接在上一步哪条记录后面 + 反应式要不要连上一步一起画
  prev_exp_id: null,
  chain_draw: 0,
});

const reagent = reactive({ base: null, steps: [], rows: [] });

/**
 * 条件组：一次筛选批次里的 N 个条件（本记录内的「小筛选表」）。
 * 投料表 / 操作 / TLC 都是整条记录共享的，这里每行只写「改了什么」+ 产率 / 选择性 / 备注。
 * 条件筛选页（`#/screenings`）会从这里拆行，不用为每个条件再建一条实验记录。
 */
const conds = ref([]);

/**
 * 记录类型 = 版式：打开记录 / 切类型时，把「这张纸显示哪几块」换成**那一类自己记的那一套**
 * （`lib/sheetprefs.js`：按类型分开存，设置页 06 里能逐类改；没改过的类用 `KIND_BLOCKS` 的默认）。
 * 这里只「选」不「写」——以前每次打开都按类型重写，把用户在 06 里手勾的盖掉了。
 */
const KIND_OPTIONS = [{ value: '', label: '通用' }, ...KINDS.map((k) => ({ value: k.key, label: k.key }))];
const kindMenu = ref(false);
/** 反应类型候选：设置 › 记录页 › 常用选项 里能自己加 / 删 / 挪（`quick:rxn_type`），
 *  没改过就是 lib/kind.js 的 RXN_TYPES；这一格照样可以随手敲别的，敲完能一键记进候选。 */
/** TLC 那格的展开剂候选（设置 › 记录页 › 常用选项 里能自己加 / 删 / 挪） */
const tlcNotes = computed(() => quickList('tlc_note'));
const tlcMenu = ref(false);
const tlcTyped = computed(() => String(fields.tlc_note || '').trim());
/**
 * 这一格不再横向铺满：宽度按「当前文字（空的时候按占位字）」量出来，
 * 小箭头就贴在字后面 —— 以前输入框吃满整行，箭头被推到最右，鼠标要横着跑很远。
 * 量宽度用一个看不见的镜像我（`.tlc-mirror`，同字体同字号），WebKit 没有 `field-sizing`。
 */
const TLC_PH = '展开剂 / 显色方式';
const tlcMirrorEl = ref(null);
const tlcBoxW = ref('');
const tlcMirrorText = computed(() => tlcTyped.value || TLC_PH);
function sizeTlcBox() {
  const m = tlcMirrorEl.value;
  if (!m) return;
  tlcBoxW.value = `${Math.ceil(m.getBoundingClientRect().width) + 3}px`;
}
function setTlcInput(el) {
  if (el) nextTick(sizeTlcBox);
}
watch(
  [() => fields.tlc_note, () => page.value, () => exp.value?.id, () => sheetPrefs.tlc],
  () => nextTick(sizeTlcBox)
);
function openTlcMenu() {
  tlcMenu.value = !tlcMenu.value;
  if (tlcMenu.value) markPopupOpen();
}
/**
 * **单击整格 = 出候选，双击 = 直接改字**（跟条件行那几格一个手感）：
 * 以前只有右边那个小箭头能点，鼠标要横着跑到格子另一头，箭头又小按不准。
 * 现在输入框平时 `pointer-events: none`，落点算整个 `.tlc-note-wrap`；
 * 双击才程序化 `focus()` 放光标进去（聚焦后 CSS 再把 pointer-events 放开）。
 */
const tlcEditing = ref(false);
let tlcDownTimer = 0;
let tlcLastDownAt = 0;
function onTlcDown(ev) {
  if (exp.value?.locked) return;
  // 小箭头 / 已经弹出来的菜单：各有自己的点击，别抢（菜单里的 mousedown 会冒到这里）
  if (ev.target.closest?.('.tlc-caret, .tlc-menu')) return;
  const el = ev.currentTarget?.querySelector?.('input');
  if (!el) return;
  if (document.activeElement === el) return;   // 已经在打字：正常放光标、选字
  const now = Date.now();
  const isDouble = now - tlcLastDownAt < 340;
  tlcLastDownAt = now;
  if (isDouble) {
    clearTimeout(tlcDownTimer);
    // preventDefault 得在 focus 之前：不然浏览器把这下 mousedown 的默认行为做完
    // （焦点被挪走）→ 输入框立刻 blur → `.is-editing` 刚加上就被撤掉，光标进不去
    ev.preventDefault();
    tlcMenu.value = false;
    tlcEditing.value = true;
    el.focus?.();
    el.select?.();
    return;
  }
  ev.preventDefault();
  clearTimeout(tlcDownTimer);
  tlcDownTimer = setTimeout(() => {
    tlcMenu.value = !tlcMenu.value;
    if (tlcMenu.value) markPopupOpen();
  }, 130);
}
function pickTlc(v) {
  fields.tlc_note = v;
  tlcMenu.value = false;
  notify();
}
/** 「＋ 自定义」：格子里已经有字就直接拿它当默认值，省得再敲一遍 */
async function addTlc() {
  const v = await prompt({
    title: '加一条 TLC 展开剂',
    placeholder: '比如 PE:EA = 4:1，UV + 磷钼酸',
    value: tlcTyped.value,
  });
  const val = String(v || '').trim();
  if (!val) return;
  try {
    await api.saveQuick('tlc_note', [...new Set([...tlcNotes.value, val])], true);
    await loadBoot();
    fields.tlc_note = val;
    notify();
    tlcMenu.value = false;
    toast(`「${val}」加好了，以后点这格就能选`);
  } catch (e) {
    toast(e.message || '没存上', 'err');
  }
}
/** 从常用选项里去掉一条（内置的也能删：存的是整份列表） */
async function delTlc(v) {
  try {
    await api.saveQuick('tlc_note', tlcNotes.value.filter((x) => x !== v), true);
    await loadBoot();
    toast(`已经从常用选项里去掉「${v}」`);
  } catch (e) {
    toast(e.message || '没删掉', 'err');
  }
}
const rxnTypes = computed(() => quickList('rxn_type'));
const rxnTyped = computed(() => String(fields.rxn_type || '').trim());
const rxnCanRemember = computed(() => !!rxnTyped.value && !rxnTypes.value.includes(rxnTyped.value));
async function rememberRxnType() {
  const v = rxnTyped.value;
  if (!v) return;
  const next = rxnTypes.value.includes(v) ? rxnTypes.value : [...rxnTypes.value, v];
  rxnMenu.value = false;
  try {
    await api.saveQuick('rxn_type', next, true);
    await loadBoot();
    toast(`「${v}」加进反应类型候选了`);
  } catch (e) {
    toast(e.message || '没存上', 'err');
  }
}
function applyKindBlocks(kind) {
  useSheetBlocks(kind);
}
function pickKind(v) {
  kindMenu.value = false;
  if (fields.kind === v) return;
  fields.kind = v;
  applyKindBlocks(v);
  notify();
}

/**
 * 本次筛选的「变量集合」= 投料表里标成变量的行（`reagents.variable`）+ 记录级字段变量（温度 / 时间…）。
 * 条件组的列、反应式箭头上的占位符（`[L]` / `[T]`）都从这一个来源来。
 */
const fieldVars = ref([]);   // [{key:'temperature', label:'T'}]
/** 每个变量槽在条件组里有几个候选（投料表那行显示「N 个候选」用） */
const varCounts = computed(() => {
  const m = {};
  for (const c of conds.value) {
    for (const [k, v] of Object.entries(c.vars || {})) {
      if (String(v || '').trim()) m[k] = (m[k] || 0) + 1;
    }
  }
  return m;
});
/** 每个变量槽的候选名单（按条件组顺序，给投料表那行显示摘要用） */
const varCandidates = computed(() => {
  const m = {};
  for (const c of conds.value) {
    for (const [k, v] of Object.entries(c.vars || {})) {
      const val = String(v || '').trim();
      if (!val) continue;
      (m[k] = m[k] || []).push(val);
    }
  }
  return m;
});
const condsEl = ref(null);
function scrollToConds() {
  condsEl.value?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** 变量行的占位提示（跟以前条件表一样，按槽猜一个例句） */
function varPlaceholder(v) {
  if (v.ph === 'T') return '−40 °C';
  if (v.ph === 't') return '6 h';
  if (v.ph === 'atm') return 'N2 / 空气';
  // 试剂类槽：拿投料表里那个标准试剂当提示（以前这里回落到占位符本身，
  // 空着的时候格子里就只剩一个「Cat」，看着像填了什么）
  if (v.role) return v.src || '试剂名';
  return v.ph;
}

/**
 * 一行「变量」的分子量 / 当量 / mmol / 用量。
 * 只有「一个变量槽」时才算得出来（多个槽一行里混着几样东西，数字没意义，就写 —）。
 */
/** 本地（化合物库 → 试剂库）按名字找分子量；都没有就 null（交给联网查） */
function mwOfName(name0) {
  const name = String(name0 || '').trim().toLowerCase();
  if (!name) return null;
  const cmp = compoundDict().find((x) => String(x.name || '').trim().toLowerCase() === name || String(x.code || '').trim().toLowerCase() === name);
  if (cmp && cmp.mw != null) return Number(cmp.mw);
  const d = reagentDict().find((x) => String(x.name || '').trim().toLowerCase() === name);
  return d && d.mw != null ? Number(d.mw) : null;
}

function varInfo(c) {
  const empty = { mw: null, mmol: null, amount: '—' };
  const slot = condVars.value[0] || null;
  // 温度 / 时间 / 气氛这类字段变量没有分子量、当量、用量可言（用户点名要分开）
  if (!slot || !slot.role) return empty;
  const name = String(c.vars?.[slot.ph] || '').trim();
  if (!name) return empty;
  const mw = mwOfName(name);
  const eq = eqNum(c.varEq?.[slot.ph]);
  const base = num(reagent.base) || 0;
  const mmol = eq != null && base ? round(base * eq, 4) : null;
  let amount = '—';
  if (mw != null && mmol != null) amount = amountText(derive({ role: '试剂', mw, mmol, density: null, conc: null })) || '—';
  return { mw, mmol, amount };
}
/**
 * 变量行里的试剂名（RuPhos / Dcpf 这种）**不在投料表里**，所以保存时不会进试剂库，
 * 本地也就查不到分子量。这里拿名字去问一次（PubChem → OPSIN → Wikidata，服务端带缓存），
 * 查到的**落一条进试剂库**（`/api/reagents/verify` 里没这条就插入），下次打这个名字直接带出 MW。
 * 状态按名字记：busy / ok / miss（查不到还可以点一下强制重查）。
 */
const varLook = reactive({});
const varLookBusy = (name) => varLook[String(name || '').trim().toLowerCase()] === 'busy';
function varLookState(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return '';
  if (varLook[key]) return varLook[key];
  return mwOfName(key) != null ? 'ok' : '';
}
/** 变量行「说明」那格里那颗小按钮上写什么 */
function varLookLabel(name) {
  const st = varLook[String(name || '').trim().toLowerCase()];
  if (!name) return '';
  if (st === 'busy') return '查中…';
  if (st === 'miss') return '查不到';
  if (st === 'err') return '重查';
  return '查 MW';
}
function varLookTitle(name) {
  const st = varLook[String(name || '').trim().toLowerCase()];
  if (st === 'miss') return 'PubChem / OPSIN / Wikidata 都没这一条：点一下重查，或者照文献手填分子量';
  if (st === 'err') return '刚才没连上（或服务没开），点一下重查';
  return '按名字去库里查分子量；查到会记进试剂库，下次打这个名字就自动带出来';
}

async function lookupVarName(name0, { force = false, role = '' } = {}) {
  const name = String(name0 || '').trim();
  if (!name) return;
  const key = name.toLowerCase();
  if (varLook[key] === 'busy') return;
  if (!force && mwOfName(name) != null) {
    varLook[key] = 'ok';
    return;
  }
  varLook[key] = 'busy';
  try {
    const r = await api.reagentsVerify(name, force, role);
    varLook[key] = r && r.ok ? 'ok' : r && r.state === 'error' ? 'err' : 'miss';
    if (r && r.ok) {
      await loadBoot();          // 试剂库多了这一条，bootstrap 里那份字典要重读
      notify();
    }
  } catch (e) {
    varLook[key] = 'err';
  }
}

/** 变量行（连下标 / 算好的数一起给模板）；`isMol` = 这一槽是「试剂类」，才显示 MW / 当量 / mmol / 用量 */
const varRows = computed(() => {
  const slot = condVars.value[0] || null;
  const isMol = !!slot && !!slot.role;
  return conds.value.map((c, i) => ({
    c,
    i,
    ph: slot ? slot.ph : '',
    isMol,
    fieldName: slot && slot.name ? slot.name : '',
    info: isMol ? varInfo(c) : { mw: null, mmol: null, amount: '—' },
  }));
});


/** 结果块里那一行「这个条件改了什么」（带当量：`[L] RuPhos · 20%`，光看名字分不清两个 20% 还是 5%） */
function condWhat(c) {
  const parts = [];
  for (const v of condVars.value) {
    const val = String(c.vars?.[v.ph] || '').trim();
    if (!val) continue;
    const eq = String(c.varEq?.[v.ph] ?? '').trim();
    parts.push(eq ? `[${v.ph}] ${val} · ${eq}` : `[${v.ph}] ${val}`);
  }
  if (parts.length) return parts.join(' · ');
  return String(c.label || '').trim() || '（还没填变量）';
}
function setVarEq(c, ph, v) {
  if (!c.varEq) c.varEq = {};
  c.varEq[ph] = v;
  notify();
}

/**
 * 一次筛选只筛**一样**（用户定的：不会出现「配体 × 温度」这种交叉变量，最多换试剂种类 + 它的当量）。
 * 所以这里只取第一个变量槽——试剂行优先，其次是字段（温度 / 时间 / 气氛）。
 * 真正保证「互斥」的是 toggleVariable / toggleFieldVar 里的收尾，这里只是渲染口径。
 */
const condVars = computed(() => {
  const r = reagent.rows.find((x) => x.variable);
  if (r) return [{ key: `r:${r.variable}`, ph: r.variable, label: r.variable, src: r.name || r.role || '', role: r.role || '' }];
  const f = fieldVars.value[0];
  if (f) return [{ key: `f:${f.key}`, ph: f.label, label: f.label, src: f.key, role: '', name: FIELD_VAR_NAME[f.key] || f.key }];
  return [];
});
const FIELD_VAR_LABEL = { temperature: 'T', duration: 't', atmosphere: 'atm', concentration: 'c' };
/** 字段变量那一行合并成一格时要写的字（写「变的是哪样」） */
const FIELD_VAR_NAME = { temperature: '反应温度', duration: '时间节点', atmosphere: '气氛 / 容器', concentration: '浓度' };

/** 输入停下来就自己查一次（只在本地确实没有 MW 时发请求） */
let varLookTimer = 0;
watch(
  () => varRows.value.filter((r) => r.isMol).map((r) => `${r.ph}\u0000${r.c.vars?.[r.ph] || ''}`),
  (list) => {
    clearTimeout(varLookTimer);
    varLookTimer = setTimeout(() => {
      for (const one of list) {
        const [ph, val] = String(one).split('\u0000');
        if (String(val || '').trim().length < 2) continue;
        if (mwOfName(val) != null) continue;
        const slot = condVars.value.find((v) => v.ph === ph);
        void lookupVarName(val, { role: slot ? slot.role : '' });
      }
    }, 900);
  }
);

/** 试剂行被标成变量（组分菜单里点的）：把字段变量和别的试剂行的变量收掉 */
/**
 * 变量取消了：条件里那几行如果**只是候选**（没填产率 / 选择性 / 备注）就跟着收掉；
 * 填过结果的留着（它们会退回「自由写法」那几行），别把数据吃掉。
 */
function pruneOrphanConds() {
  if (condVars.value.length) return;
  const before = conds.value.length;
  conds.value = conds.value.filter(
    (c) => c.yield_pct != null || String(c.sel || '').trim() || String(c.note || '').trim()
  );
  if (before !== conds.value.length) toast('变量取消了，下面没填结果的候选一起收掉了', 'info', 2600);
}

function onReagentVarToggled(slot) {
  if (!slot) return pruneOrphanConds();
  const dropped = [];
  if (fieldVars.value.length) dropped.push(...fieldVars.value.map((v) => v.label));
  fieldVars.value = [];
  for (const r of reagent.rows) {
    if (r.variable && r.variable !== slot) {
      dropped.push(r.variable);
      r.variable = '';
    }
  }
  // 「这一行挪下去」：投料表里原来那行就是标准条件，先在下面变量里补上它自己
  const row = reagent.rows.find((x) => x.variable === slot);
  const name = String(row?.name || '').trim();
  if (name && !conds.value.some((c) => String(c.vars?.[slot] || '').trim() === name)) {
    const eq = String(row?.eq ?? '').trim();
    conds.value.unshift({ label: '', yield_pct: null, mass: '', sel: '', note: '', vars: { [slot]: name }, varEq: eq ? { [slot]: eq } : {} });
  }
  if (dropped.length) toast(`一次只筛一样：变量换成 [${slot}]，已经收掉 ${dropped.map((x) => `[${x}]`).join(' ')}`, 'info', 2800);
  notify();
}

/** 取消当前这个变量：投料表里那一行「回来」，下面只是候选的条件行一起收掉 */
function dropVariable() {
  const slot = condVars.value[0];
  if (!slot) return;
  if (slot.role) {
    const r = reagent.rows.find((x) => x.variable === slot.ph);
    if (r) r.variable = '';
  }
  fieldVars.value = fieldVars.value.filter((v) => v.label !== slot.ph);
  pruneOrphanConds();
  for (const r of reagent.rows) if (r.variable === slot.ph) r.variable = '';
  notify();
}

function toggleFieldVar(f) {
  const i = fieldVars.value.findIndex((v) => v.key === f.key);
  if (i >= 0) {
    fieldVars.value.splice(i, 1);
    pruneOrphanConds();
    return notify();
  }
  // 反过来：字段变量开起来，投料表那边的变量（以及别的字段变量）一起收掉
  const dropped = fieldVars.value.map((v) => v.label);
  for (const r of reagent.rows) {
    if (r.variable) {
      dropped.push(r.variable);
      r.variable = '';
    }
  }
  const label = FIELD_VAR_LABEL[f.key] || f.key;
  fieldVars.value = [{ key: f.key, label }];
  if (dropped.length) toast(`一次只筛一样：变量换成 [${label}]，已经收掉 ${dropped.map((x) => `[${x}]`).join(' ')}`, 'info', 2800);
  notify();
}

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
    variable: r.variable || '',
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
  fields.prev_exp_id = e.prev_exp_id ?? null;
  fields.chain_draw = Number(e.chain_draw) === 1 ? 1 : 0;
  prevExp.value = e.prev || null;
  nextExps.value = Array.isArray(e.next) ? e.next : [];
  chainStep.value = Number(e.chain_step) || 1;

  applyKindBlocks(String(e.kind || ''));

  fieldVars.value = (Array.isArray(e.field_vars) ? e.field_vars : []).map((v) => ({ key: v.key, label: v.label || v.key }));
  conds.value = (Array.isArray(e.conds) ? e.conds : []).map((c) => ({
    label: c.label || '',
    mass: c.mass ?? '',            // 质量 / g：一行一个候选之后，产率由它算（跟投料表一个式子）
    yield_pct: c.yield_pct ?? null,
    sel: c.sel || '',
    note: c.note || '',
    vars: { ...(c.vars || {}) },
    varEq: { ...(c.varEq || {}) },
  }));

  const raw = Array.isArray(e.steps) ? e.steps : [];
  const list = raw.map((s) => ({
    label: s.label || '',
    condition: s.condition || '',
    workup: s.workup || '',
    start: s.start || '',
    end: s.end || '',
    addition: s.addition || '',
    stir: s.stir || '',
    product_name: s.product_name || '',   // 这一步的产物（中间体）
    // 这一步自己的条件行（多步记录里一步一条）
    temperature: s.temperature || '',
    duration: s.duration || '',
    atmosphere: s.atmosphere || '',
    apparatus: s.apparatus || '',
    light: s.light || '',
    // 这一步的结果（「结果」一张表里一步一行）：只对中间几步有意义，
    // 最后一步的数字就是记录本身那几格（product_name / mass / yield…）
    product_compound_id: s.product_compound_id ?? null,
    product_mw: s.product_mw ?? '',
    product_mass: s.product_mass ?? '',
    yield_pct: s.yield_pct ?? '',
    appearance: s.appearance || '',
    dr_ee: s.dr_ee || '',
  }));
  const need = (e.reagents || []).reduce((m, r) => Math.max(m, Number(r.step) || 1), 1);
  while (list.length < Math.max(1, need)) {
    list.push({
      label: '', condition: '', workup: '', start: '', end: '', addition: '', stir: '', product_name: '',
      temperature: '', duration: '', atmosphere: '', apparatus: '', light: '',
      product_compound_id: null, product_mw: '', product_mass: '', yield_pct: '', appearance: '', dr_ee: '',
    });
  }
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
  // **必须在 rows / conds 都装好之后**再收编（早一步是上一条记录的数据，会白忙一场）
  collapseVarRows();
  markLoaded();
  if (fixReagentRows(rows)) notify();   // 分子量 / 密度被补上，顺手存一次（导出 / 列表才跟页面对得上）
  // 服务端存着上次画好的那张：数据没变（sig 一样）就直接贴上去，连重画都省了
  const cache = e.scheme_cache;
  // 只认「这张就是现在这份数据画的」缓存：新鲜的话照贴、一次都不用重画（切换记录 0ms 到位）。
  // 旧图不贴（用户：「不要旧的那个占位，从旧的闪到新的还是闪」）——真过期了就清空重画，
  // 这一小段空窗由 `.is-busy` 把「点击上传」那行提示也藏起来。
  if (cache && cache.svg && !cache.stale && cache.sig === liveSig.value) {
    liveScheme.value = cache.svg;
    liveSigShown.value = cache.sig;
    liveFpShown.value = cache.fp || '';
  } else {
    liveScheme.value = '';
    liveSigShown.value = '';
    liveFpShown.value = '';
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
    // 词库里标成「固体」的（TsCl 这类）：标上行，密度就不参与折体积了
    if (d.solid && !r.solid) {
      r.solid = 1;
      touched = true;
    }
    if (!d.solid && num(r.density) === null && saneDensity(d.density)) {
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
    paperOut();                     // 先把旧的一页推走（数据还在路上，正好盖住等待）
    try {
      if (dirty.value) await flush();
    } catch {
      /* 保存失败已经在状态栏里提示 */
    }
    closeMore();
    statusMenu.value = false;
    rxnMenu.value = false;
    kindMenu.value = false;
    tlcMenu.value = false;
    // 停在同一页切过去（设置里可以关）；那条记录没有这一页（文献 / 附件被关掉）就回第 1 页
    const want = keepPage.value ? Number(page.value) || 1 : 0;
    page.value = want && pageExists(want) ? want : String(route.query.p) === '2' ? 2 : 1;
    await load();
    // 切完弹一个气泡通知（只在这条记录是从别处切过来时提示，第一次打开不提示）
    if (exp.value?.code) toast(`已切换到 ${exp.value.code}`, 'info', 1800);
    // 换了记录就当翻到新的一页：滚回顶部，不然停在上一页看到的位置很像「没切换」
    await nextTick();
    editorEl.value?.scrollTo({ top: 0 });
    paperIn();
  }
);

/**
 * 「纸放得下就别让它滚」：`.editor` 底部那 120px 是给长内容留的呼吸位，
 * 纸本身没超出一屏的时候它会让页面白滚一段（用户报过「现在会上下动」）。
 * 所以量一下「内容 + 顶距」够不够放，够就把这个容器的 overflow 关掉。
 */
const editorFits = ref(false);
/**
 * 量「内容真实底边」而不是 `scrollHeight - padding`：`.editor` 底部那 120px 是给长内容垫底的，
 * 用 scrollHeight 算会把它当成内容，于是「纸明明没超出一屏」也判成放不下（用户报过
 * 「这边没超出页面但还是会滚动」——实测 1435 高的窗口里内容底 1286，is-fit 却是 false，
 * 因为量到了落盘前的那一版，之后就没人再量了）。
 */
function updateEditorFit() {
  const el = editorEl.value;
  if (!el) return;
  const inner = el.querySelector('.editor-inner');
  if (!inner) return;
  const top = el.getBoundingClientRect().top;
  const bottom = inner.getBoundingClientRect().bottom - top + el.scrollTop;
  editorFits.value = bottom + 24 <= el.clientHeight;
}
let fitRO = null;
let fitTimers = [];
/** 内容会异步长（反应式画完、谱图载入、字体回来），量一次不够——补几拍再量 */
function scheduleFit() {
  updateEditorFit();
  updateEdgeBox();
  requestAnimationFrame(() => {
    updateEditorFit();
    updateEdgeBox();
  });
  for (const t of fitTimers) clearTimeout(t);
  fitTimers = [
    setTimeout(() => {
      updateEditorFit();
      updateEdgeBox();
    }, 250),
    setTimeout(() => {
      updateEditorFit();
      updateEdgeBox();
    }, 900),
  ];
}

/** 窄屏（手机）走只读精简页，桌面版式完全不渲染 */
const isPhone = ref(typeof window !== 'undefined' && window.innerWidth <= 820);
function onResize() {
  isPhone.value = window.innerWidth <= 820;
  scheduleFit();
}

onMounted(async () => {
  void preloadSchemeLib();      // 顺手把 openchemlib 拉下来，别等第一次画反应式才等
  window.addEventListener('resize', onResize);
  window.addEventListener('resize', updateRail);
  page.value = String(route.query.p) === '2' ? 2 : 1;
  if (!isPhone.value) await load();
  document.addEventListener('paste', onPaste);
  document.addEventListener('click', closeMenus, true);
  document.addEventListener('keydown', onShortcut);
  document.addEventListener('keydown', onPageKey);
  document.addEventListener('keydown', onParallelKey);
  // 等这一帧渲染完再量纸面位置
  requestAnimationFrame(updateRail);
  requestAnimationFrame(scheduleFit);
  // 纸的高度随内容变（画反应式、加附件、翻页、切块）→ 用 ResizeObserver 跟着重量，
  // 别在每处都手动调一次
  if (typeof ResizeObserver !== 'undefined') {
    fitRO = new ResizeObserver(() => scheduleFit());
    const watchInner = () => {
      const inner = editorEl.value && editorEl.value.querySelector('.editor-inner');
      fitRO.disconnect();
      if (inner) {
        fitRO.observe(inner);
        const sheet = inner.querySelector('.sheet');
        if (sheet) fitRO.observe(sheet);
      }
      scheduleFit();
    };
    watchInner();
    watch([() => !!exp.value, page, () => liveScheme.value], () => nextTick(watchInner), { flush: 'post' });
    // 谱图 / 反应式图是异步载入的：图一到位就重量一次（`load` 不冒泡，得用捕获）
    const onImgLoad = () => scheduleFit();
    if (editorEl.value) editorEl.value.addEventListener('load', onImgLoad, true);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleFit).catch(() => {});
  }
});
/** 现在能翻的几页（文献 / 附件两页在设置里关掉后就不参与左右翻页） */
const pageTabs = computed(() => {
  const tabs = [1, 2];
  if (sheetPrefs.lit) tabs.push(3);
  if (sheetPrefs.attachments) tabs.push(4);
  return tabs;
});

/**
 * 方向键什么时候让给别人：正在打字、有弹窗 / 菜单开着、带修饰键、手机版、记录已删除。
 * 输入框里左右是移光标、上下是移行，绝不能被接管。
 */
function arrowBusy(ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return true;
  if (isPhone.value || gone.value) return true;
  const t = ev.target;
  if (t && (t.closest?.('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)) return true;
  // 弹层 / 菜单开着时方向键归它们（自绘菜单那几个类名 + Element Plus 的遮罩与 popper）
  const overlays = document.querySelectorAll('.el-overlay, .el-popper, .cat-menu, .kind-menu, .kind-opt-menu, .proj-menu, .role-menu');
  for (const el of overlays) if (el.getClientRects().length) return true;
  return false;
}

/** 键盘 ←/→ 翻页（第 1 页 / 第 2 页 / 文献 / 附件，到头就停、不绕回去） */
function onPageKey(ev) {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  if (arrowBusy(ev)) return;
  const tabs = pageTabs.value;
  if (tabs.length < 2) return;
  const i = tabs.indexOf(page.value);
  const next = i < 0 ? tabs[0] : tabs[i + (ev.key === 'ArrowRight' ? 1 : -1)];
  if (next == null || next === page.value) return;
  ev.preventDefault();
  page.value = next;
  // 翻页跟翻纸一样回到顶部，不然停在上一页滚到的位置很像「没翻」
  void nextTick(() => editorEl.value?.scrollTo({ top: 0 }));
}

/** 滚到头再滚 = 切记录（设置页 04 的 `scrollSwitch`，默认开）。
    用户：「滚动切换记录」「鼠标加键盘有点麻烦，但键盘快捷还是留着」。
    纸面本来就放得下（不需要滚）时，竖向滚轮没有别的用处，就直接算切换；
    放不下的时候要先自己滚到底，再往下**多滚 140px** 才切，免得看着看着被弹走。 */
const scrollSwitch = ref(uiGet('scrollSwitch', true) !== false);
/** 「点纸左右两侧的空白翻页」（设置页 04，`edgeFlip`，默认开）：只用鼠标也能翻。
    两条透明的热点带贴在编辑区左右那两条空白里，中间是纸，互不遮挡。 */
const edgeFlip = ref(uiGet('edgeFlip', true) !== false);
/** 热区长相：`soft` 悬停才浮一颗淡圆按钮（默认）/ `quiet` 什么都不画 / `always` 一直淡淡地显示 */
const edgeLook = ref(String(uiGet('edgeFlipLook', 'soft') || 'soft'));
const edgeBox = reactive({ left: {}, right: {} });
/** 量一下纸东西两侧的空白有多大、纸在哪（写进 fixed 的热点带） */
function updateEdgeBox() {
  const ed = editorEl.value;
  const sheet = document.querySelector('.sheet:not(.is-hidden)');
  if (!ed || !sheet || !edgeFlip.value) {
    edgeBox.left = {};
    edgeBox.right = {};
    return;
  }
  const e = ed.getBoundingClientRect();
  const r = sheet.getBoundingClientRect();
  const top = Math.max(e.top, 0);
  const height = Math.max(0, Math.min(e.bottom, window.innerHeight) - top);
  const gap = 6;
  const lw = Math.max(0, Math.round(r.left - e.left - gap));
  const rw = Math.max(0, Math.round(e.right - r.right - gap));
  // 缝太窄就别放热区（点了也容易点歪）：16px 起算
  edgeBox.left = lw >= 16 ? { left: `${Math.round(e.left)}px`, top: `${Math.round(top)}px`, height: `${Math.round(height)}px`, width: `${lw}px` } : {};
  edgeBox.right = rw >= 16 ? { right: `${Math.round(window.innerWidth - e.right)}px`, top: `${Math.round(top)}px`, height: `${Math.round(height)}px`, width: `${rw}px` } : {};
}

/** 「换记录时播「推」的动画」（设置页 04，`pageAnim`，默认开） */
const pageAnim = ref(uiGet('pageAnim', true) !== false);
/** 滚轮力度：轻一点 44 / 正好 90 / 要滚多一点 160（`scrollWheel`，默认「轻一点」） */
const WHEEL_PX = { light: 44, normal: 90, heavy: 160 };
const wheelPreset = ref(String(uiGet('scrollWheel', 'light') || 'light'));
onUiMerged(() => {
  scrollSwitch.value = uiGet('scrollSwitch', true) !== false;
  pageAnim.value = uiGet('pageAnim', true) !== false;
  edgeFlip.value = uiGet('edgeFlip', true) !== false;
  edgeLook.value = String(uiGet('edgeFlipLook', 'soft') || 'soft');
  nextTick(updateEdgeBox);
  wheelPreset.value = String(uiGet('scrollWheel', 'light') || 'light');
});
let wheelAcc = 0;
let wheelLast = 0;
let wheelLock = 0;
// 累计多少像素算一次「故意再滚」：跟设置页那个「滚轮力度」走（用户：滚太多了，默认收到 44）
const WHEEL_IDLE = 320;      // 手停这么久就重新累计
const WHEEL_COOLDOWN = 460;  // 切完这么长时间内不再切（刚好接住一次「推」的动画）
/**
 * 换记录时纸面「平缓进来」：方向跟手势走（往下滚 / ↓ / 点下面那条 = 从下往上浮，反之亦然）。
 * 直接给 `.editor-inner` 挂一个 300ms 的 keyframes，`offsetWidth` 强制重排让动画重放；
 * 动画完把 class 摘掉、重新量一次平行书签的位置（书签是 Teleport 到 body、按纸面位置钉住的）。
 * 系统开了「减少动态效果」就只换内容、不做动画。
 */
let paperTimer = 0;
let navDir = 1;
const reducedMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const PAPER_CLASSES = ['paper-in-down', 'paper-in-up', 'paper-out-down', 'paper-out-up'];
function paperRoot() {
  if (reducedMotion || !pageAnim.value) return null;
  return editorEl.value?.querySelector('.editor-inner') || null;
}
/** 推走旧的那一页（切记录一开始就播，趁数据还在路上，所以看得见「被推走」） */
let paperSafety = 0;
function paperOut(dir = navDir) {
  const root = paperRoot();
  if (!root) return;
  root.classList.remove(...PAPER_CLASSES);
  void root.offsetWidth;
  root.classList.add(dir < 0 ? 'paper-out-up' : 'paper-out-down');
  // 数据回来得慢就把旧的先放回去（别让纸一直半透明），新的一页到了再推
  clearTimeout(paperSafety);
  paperSafety = window.setTimeout(() => root.classList.remove('paper-out-down', 'paper-out-up'), 420);
}
/** 把新的那一页推进来（从推走的方向接手，接成一整段「推」的感觉） */
function paperIn(dir = navDir) {
  const root = paperRoot();
  if (!root) return;
  root.classList.remove(...PAPER_CLASSES);
  void root.offsetWidth;
  root.classList.add(dir < 0 ? 'paper-in-up' : 'paper-in-down');
  clearTimeout(paperSafety);
  clearTimeout(paperTimer);
  paperTimer = window.setTimeout(() => {
    root.classList.remove(...PAPER_CLASSES);
    updateRail();
  }, 320);
}

/** 上下一条：**按左栏显示顺序**（`store.listOrder`，分类分组 + 卡片堆展开后的序列）走，
    所以能跨平行组、跨分类一路翻；左栏还没算出来时退回列表接口顺序，再退平行组。
    用户：「就还是可以切换到非平行实验」。 */
function neighborExp(step) {
  const id = Number(exp.value?.id);
  const order = Array.isArray(store.listOrder) && store.listOrder.length ? store.listOrder : null;
  const pools = [
    order,
    (Array.isArray(store.items) ? store.items : []).map((x) => Number(x.id)),
    siblings.value.map((x) => Number(x.id)),
  ];
  for (const pool of pools) {
    if (!pool) continue;
    const i = pool.indexOf(id);
    if (i >= 0) {
      const next = pool[i + step];
      if (next != null) return { id: next };
      return null;   // 到头就停，不绕回
    }
  }
  return null;
}
function onWheel(ev) {
  if (!scrollSwitch.value) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;   // 缩放 / 系统手势不接管
  if (arrowBusy(ev)) return;
  const el = editorEl.value;
  if (!el || !exp.value) return;
  const down = ev.deltaY > 0;
  if (!ev.deltaY) return;
  const stuck = down ? el.scrollTop + el.clientHeight >= el.scrollHeight - 2 : el.scrollTop <= 1;
  if (!stuck) {
    wheelAcc = 0;
    return;
  }
  const now = Date.now();
  if (now - wheelLast > WHEEL_IDLE) wheelAcc = 0;
  wheelLast = now;
  if (now < wheelLock) {
    wheelAcc = 0;
    return;
  }
  wheelAcc += ev.deltaY;
  if (Math.abs(wheelAcc) < (WHEEL_PX[wheelPreset.value] || WHEEL_PX.light)) return;
  wheelAcc = 0;
  navDir = down ? 1 : -1;
  const next = neighborExp(down ? 1 : -1);
  if (!next) return;                       // 到头就停，不绕回
  wheelLock = now + WHEEL_COOLDOWN;
  router.push(`/e/${next.id}`);
}
onMounted(() => {
  // 滚轮要 passive 才不挡纸面正常滚动；这里只读 scrollTop、不改布局
  editorEl.value?.addEventListener('wheel', onWheel, { passive: true });
});
onBeforeUnmount(() => {
  editorEl.value?.removeEventListener('wheel', onWheel);
});

/** 顶上那两颗翻页箭头（← / → 的鼠标版）：到头的方向置灰，跟键盘一样不绕回 */
const prevPageNum = computed(() => {
  const tabs = pageTabs.value;
  const i = tabs.indexOf(Number(page.value));
  return i > 0 ? tabs[i - 1] : null;
});
const nextPageNum = computed(() => {
  const tabs = pageTabs.value;
  const i = tabs.indexOf(Number(page.value));
  return i >= 0 && i < tabs.length - 1 ? tabs[i + 1] : null;
});
function flipPage(dir) {
  const t = dir > 0 ? nextPageNum.value : prevPageNum.value;
  if (t == null) return;
  page.value = t;
  void nextTick(() => editorEl.value?.scrollTo({ top: 0 }));
}

/** 键盘 ↑/↓ 切上 / 下一条记录：跟滚轮同一个口径（左栏显示顺序，能跨平行组），
    所以平行实验之间照旧一条一条走，走到组尾就进下一条普通记录。 */
function onParallelKey(ev) {
  if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
  if (arrowBusy(ev)) return;
  const dir = ev.key === 'ArrowUp' ? -1 : 1;
  const next = neighborExp(dir);
  if (!next) return;
  ev.preventDefault();
  navDir = dir;
  router.push(`/e/${next.id}`);
}

onBeforeUnmount(() => {
  if (fitRO) fitRO.disconnect();
  for (const t of fitTimers) clearTimeout(t);
  fitTimers = [];
  window.removeEventListener('resize', onResize);
  window.removeEventListener('resize', updateRail);
  document.removeEventListener('paste', onPaste);
  document.removeEventListener('click', closeMenus, true);
  document.removeEventListener('keydown', onShortcut);
  document.removeEventListener('keydown', onPageKey);
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

/**
 * 点外面关掉抬头那几个小下拉（类型 / 反应类型 / 状态 / ⋯）。
 * **监听在捕获阶段**：页签、状态胶囊、保存这些按钮都带 `@click.stop`（它们自己的点击要
 * 先处理完），冒泡阶段根本轮不到这里 —— 以前点一下别处、下拉还挂着就是这个原因。
 * 捕获阶段先关，再让按钮干它的事；下拉自己那块（`.xxx-wrap`）里点的不算外面。
 */
function closeMenus(e) {
  if (ignoreOutsideClick()) return;   // 刚打开的那一下不算「点外面」
  const t = e.target;
  if (!t?.closest?.('.menu-wrap')) closeMore();
  if (!t?.closest?.('.status-wrap')) statusMenu.value = false;
  if (!t?.closest?.('.rxn-wrap')) rxnMenu.value = false;
  if (!t?.closest?.('.kind-wrap')) kindMenu.value = false;
  if (!t?.closest?.('.tlc-note-wrap')) tlcMenu.value = false;
}

function payload() {
  const body = {};
  for (const k of FIELD_KEYS) body[k] = fields[k];
  body.base_mmol = reagent.base;
  body.steps = reagent.steps.map((s) => ({ ...s }));
  body.reagents = reagent.rows.map(({ mwText, amountText, ...r }) => r);
  body.field_vars = fieldVars.value.map((v) => ({ key: v.key, label: v.label }));
  const activeSlots = new Set(condVars.value.map((v) => v.ph));
  body.conds = conds.value
    .filter(
      (c) =>
        String(c.label || '').trim() ||
        c.yield_pct != null ||
        String(c.mass ?? '').trim() ||
        String(c.sel || '').trim() ||
        String(c.note || '').trim() ||
        Object.values(c.vars || {}).some((v) => String(v || '').trim())
    )
    .map((c) => ({
      label: c.label || '',
      mass: c.mass ?? '',
      yield_pct: c.yield_pct ?? null,
      sel: c.sel || '',
      note: c.note || '',
      // 只留当前那个变量槽的取值：换了变量以后，旧槽的值不该还藏在行里（筛选表会把它抖出来）
      vars: Object.fromEntries(
        Object.entries(c.vars || {}).filter(([k, v]) => String(v || '').trim() && (!activeSlots.size || activeSlots.has(k)))
      ),
      varEq: Object.fromEntries(
        Object.entries(c.varEq || {}).filter(([k, v]) => String(v || '').trim() && (!activeSlots.size || activeSlots.has(k)))
      ),
    }));
  return body;
}

/** 条件组：加一行 / 删一行（删除前把焦点那格的值也一并丢掉） */
/**
 * 同一变量槽只该留一行（`Cat [Cat]`）：老数据里可能已经躺着两行（用户截图里那个红框）。
 * 打开记录时把第 2 行起收进条件组（名字当候选），并从投料表删掉；改名 / 加行的实时收编
 * 在 `ReagentTable.maybePromote` 里（那条是用户手动加行时触发）。
 */
function collapseVarRows() {
  const seen = new Map();   // slot → 第一个占用它的行
  const drop = [];
  for (const r of reagent.rows) {
    const slot = String(r.variable || '').trim();
    if (!slot) continue;
    if (!seen.has(slot)) {
      seen.set(slot, r);
      continue;
    }
    const name = String(r.name || '').trim();
    if (name) {
      const has = conds.value.some((c) => String((c.vars || {})[slot] || '').trim() === name);
      if (!has) conds.value.push({ label: '', yield_pct: null, mass: '', sel: '', note: '', vars: { [slot]: name }, varEq: {} });
    }
    drop.push(r);
  }
  if (!drop.length) return;
  for (const r of drop) {
    const i = reagent.rows.indexOf(r);
    if (i >= 0) reagent.rows.splice(i, 1);
  }
  toast(`同一变量槽只留一行：多出来的 ${drop.length} 行已收进条件组当候选`, 'ok');
  notify();
}

function addCond() {
  conds.value.push({ label: '', yield_pct: null, mass: '', sel: '', note: '', vars: {}, varEq: {} });
  notify();
}
function removeCond(i) {
  conds.value.splice(i, 1);
  notify();
}
/** 从候选菜单挑了一个名字：填进这一格，试剂库知道常用当量就顺手带过来（还能改） */
function pickCondCand(c, ph, it) {
  if (!c.vars) c.vars = {};
  c.vars[ph] = it.name;
  if (it.eq) {
    if (!c.varEq) c.varEq = {};
    c.varEq[ph] = it.eq;
  }
  notify();
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
  if (Array.isArray(prev.conds)) conds.value = prev.conds.map((c) => ({ ...c, vars: { ...(c.vars || {}) }, varEq: { ...(c.varEq || {}) } }));
  if (Array.isArray(prev.field_vars)) fieldVars.value = prev.field_vars.map((v) => ({ ...v }));
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
    'print-page-3': opts.pages === 'lit',
    'print-no-lit': !litHasContent.value,
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
const SCHEME_SIG_VERSION = 'v13';  // 改了出图规则就加一，让旧缓存失效（v13：多步记录按步分段；v12：箭头上只排一行）
const liveSig = computed(() =>
  SCHEME_SIG_VERSION +
  JSON.stringify({
    sf: sheetSchemeFmt.fmt,
    // 变量（投料行的占位符 + 字段变量）也要进 sig：标了变量箭头就写 [L]/[T]，缓存得跟着失效
    r: (reagent.rows || []).map((r) => [r.role || '', r.name || '', String(r.eq ?? ''), r.compound_id ?? '', r.variable || '']),
    fv: (fieldVars.value || []).map((v) => v.key).join(','),
    s: fields.solvent || '',
    t: fields.temperature || '',
    d: fields.duration || '',
    pn: fields.product_name || '',
    pc: fields.product_compound_id ?? '',
    // 两步反应：接的是哪条、要不要连起来画（都进 sig，不然切开关不重画）
    pv: fields.prev_exp_id ?? '',
    cd: Number(fields.chain_draw) === 1 ? 1 : 0,
    // 一条记录里有好几步时，每步的条件 / 中间体产物 / 行归属都要进 sig，
    // 不然改了第一步的条件，那张两段箭头不会重画。单步记录不加（sig 不变，缓存照样命中）
    ...(multiStep.value
      ? {
          sp: (reagent.rows || []).map((r) => Number(r.step) || 1),
          st: (reagent.steps || []).map((s) => [s.condition || '', s.product_name || '', s.product_compound_id ?? '']),
        }
      : {}),
  })
);
/* 这张图用到的化合物「结构改过没有」：`id:updated_at` 拼一串。
   **不能塞进 liveSig**：化合物库是页面打开后才读完的，sig 里一带这个，首帧永远对不上缓存、
   每次打开都要重画一次（用户报过「闪一下」）。所以单独记一份，跟缓存里存的那份比。 */
const liveFp = computed(() => {
  const ids = new Set();
  for (const r of reagent.rows || []) if (r.compound_id) ids.add(Number(r.compound_id));
  if (fields.product_compound_id) ids.add(Number(fields.product_compound_id));
  if (!ids.size) return '';
  const lib = new Map((store.compounds || []).map((c) => [Number(c.id), c]));
  const out = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const c = lib.get(id);
    if (!c) return null;      // 化合物库还没读进来：指纹未知，别当成「结构变过」白重画
    out.push(`${id}:${String(c.updated_at || '')}`);
  }
  return out.join('|');
});
const liveFpShown = ref('');
/* 这条记录是不是「一步里分了好几步」（投料表按第 N 步分段） */
const multiStep = computed(
  () => (reagent.steps || []).length > 1 || (reagent.rows || []).some((r) => Number(r.step) > 1)
);
/* 正在画这张图：没有旧图可贴的时候，反应式格子里先别冒出「点击上传」那行提示 */
const liveDrawing = ref(false);

/* ---------- 两步反应：一条记录接在「上一步」后面 ---------- */
const prevExp = ref(null);      // 上一步那条记录（id / code / title）
const nextExps = ref([]);       // 下一步：可能有好几条（同一步重复做）
const chainStep = ref(1);       // 自己排第几步
/** 交给 SchemeBlock 的那条小字条；没接就不显示 */
const chainInfo = computed(() => {
  if (!exp.value) return null;
  const prev = prevExp.value;
  const next = nextExps.value || [];
  if (!prev && !next.length) return null;
  return {
    step: chainStep.value || 1,
    prev: prev ? { id: prev.id, code: prev.code } : null,
    next: next.map((n) => ({ id: n.id, code: n.code })),
    join: Number(fields.chain_draw) === 1,
  };
});
async function refreshChain() {
  const id = exp.value?.id;
  if (!id) return;
  const e = await api.experiment(id).catch(() => null);
  if (!e || exp.value?.id !== id) return;
  prevExp.value = e.prev || null;
  nextExps.value = Array.isArray(e.next) ? e.next : [];
  chainStep.value = Number(e.chain_step) || 1;
}
const prevPickOpen = ref(false);
/** 「接上一步」弹窗里往前排的那几条：产物正好是本条底物的记录（链上通常就是这个） */
const prevPrefers = computed(() => {
  const mine = new Set(
    (reagent.rows || []).filter((r) => r.role === '底物' && r.compound_id).map((r) => Number(r.compound_id))
  );
  if (!mine.size) return [];
  return (store.items || [])
    .filter((e) => Number(e.id) !== Number(exp.value?.id) && mine.has(Number(e.product_compound_id)))
    .map((e) => e.id);
});
function openPrevPick() {
  moreMenu.value = false;
  prevPickOpen.value = true;
}
function openRecord(id) {
  if (id) router.push(`/e/${id}`);
}
async function linkPrev(ids) {
  prevPickOpen.value = false;
  const id = Array.isArray(ids) ? Number(ids[0]) : Number(ids);
  if (!id || id === Number(exp.value?.id)) return;
  fields.prev_exp_id = id;
  notify();
  await flush();
  await refreshChain();
  scheduleLive(0);
  const code = prevExp.value?.code || '';
  if (code) toast(`接上了：${code} → ${exp.value.code}`, 'ok');
}
async function unlinkPrev() {
  const ok = await confirm({ title: '断开上一步？', body: '只断这个链接，两条记录本身都不动。反应式会回到只画这一段。' });
  if (!ok) return;
  fields.prev_exp_id = null;
  notify();
  await flush();
  await refreshChain();
  scheduleLive(0);
}
/** 反应式连上一步一起画（A → B → C 一张图） */
function toggleChainDraw() {
  fields.chain_draw = Number(fields.chain_draw) === 1 ? 0 : 1;
  notify();
  scheduleLive(0);
}
/** 「上一步」那条记录的构件（画连着的那张图要用）：不缓存，画的次数不多，省得改完不同步 */
async function prevParts(id) {
  const e = await api.experiment(id).catch(() => null);
  if (!e) return null;
  if (!(store.compounds && store.compounds.length)) await loadCompounds();
  return schemeParts({ ...e, field_vars: e.field_vars || [], steps: e.steps || [], reagents: e.reagents || [] }, store.compounds || []);
}
let liveTimer = null;
function scheduleLive(ms = 700) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => void renderLive(), ms);
}
/* 好几个 watcher（sig / 结构指纹 / 化合物库读完）可能同时把它叫起来，同一个 tick 里连画两张：
   前面那张白画了，还容易闪。同一时间只画一张，画的过程中又被叫就等画完补最后一次。 */
let liveBusy = false;
let livePending = false;
function renderLive() {
  if (liveBusy) {
    livePending = true;
    return Promise.resolve();
  }
  liveBusy = true;
  return drawLive().finally(() => {
    liveBusy = false;
    if (livePending) {
      livePending = false;
      scheduleLive(0);
    }
  });
}
async function drawLive() {
  const id = exp.value?.id;
  if (!id || exp.value.locked) {
    liveScheme.value = '';
    liveSigShown.value = '';
    liveFpShown.value = '';
    return;
  }
  const sig = liveSig.value;
  const fp = liveFp.value;
  // 已经是这张了、而且用到的结构也没改过，就别白画一遍（指纹还不知道就先认这张）
  if (liveScheme.value && liveSigShown.value === sig && (fp === null || liveFpShown.value === fp)) return;
  try {
    // 化合物库还没读进来时（刚打开页面）先读一次，否则底物挂不上结构、反应式是空的
    if (!(store.compounds && store.compounds.length)) await loadCompounds();
    // 画这张图实际用到的结构状态（可能是刚读进来的，跟进去时那个 fp 不一样）
    const fpUsed = liveFp.value;
    const parts = schemeParts(
      { ...fields, field_vars: fieldVars.value, steps: reagent.steps, reagents: reagent.rows },
      store.compounds || []
    );
    if (!parts.reactants.length) {
      liveScheme.value = '';
      liveSigShown.value = '';
      liveFpShown.value = '';
      return;
    }
    liveDrawing.value = true;
    const stage = (p) => ({
      reactants: p.reactants,
      reactantIds: p.reactantIds,
      reactantVers: p.reactantVers,
      product: p.product,
      productId: p.productId,
      productVer: p.productVer,
      productLabel: p.product ? '' : (p.productLabel || p.prodName),   // 还不知道产物结构就把名字写在箭头右边
      above: p.above,
      below: p.below,
    });
    // 一条记录里有好几步（投料表按「第 N 步」分段）→ 每步一段箭头，中间体只画一次
    const stages = (parts.stages || []).length > 1 ? parts.stages.map(stage) : [stage(parts)];
    // 「连上一步一起画」：把上一步那条也算进这张图（中间体只画一次，两段箭头各带各的条件）
    if (stages.length === 1 && Number(fields.chain_draw) === 1 && prevExp.value?.id) {
      const pp = await prevParts(prevExp.value.id);
      if (pp && pp.reactants.length) stages.unshift(stage(pp));
    }
    const svg = await composeChainSvg({
      stages,
      background: false,     // 直接贴在纸面上，别垫一块白方块
      fmt: sheetSchemeFmt.fmt,   // 箭头上那行条件的排版格式（设置页 06）
    });
    if (exp.value?.id !== id) return;   // 等的时候切到别的记录了：这份丢掉
    liveScheme.value = svg;
    liveSigShown.value = sig;
    liveFpShown.value = fpUsed ?? '';
    liveDrawing.value = false;
    api.saveSchemeCache(id, { sig, svg }).catch(() => {});   // 存不下也不影响显示
  } catch {
    if (exp.value?.id === id) {
      liveScheme.value = '';
      liveSigShown.value = '';
      liveFpShown.value = '';
      liveDrawing.value = false;
    }
  }
}
/**
 * 同一个变量槽（比如都标成 `[Cat]`）加了**多行**时，那些行的名字就是这一槽的候选，
 * 自动补成条件组里的行（已经有了就不重复加）。只有一个候选时不自动加——那是标准条件。
 * 为什么：筛催化剂/配体时连着加两个同类试剂，本来就是「两个候选」的意思，
 * 不该让人再手动去条件组里敲一遍，也不该让投料表里同时躺着两个催化剂。
 */
/** 投料表里同槽的第二行被「收编」时调用：把它当这个变量槽的一个候选写进条件组 */
function promoteVarCandidate({ slot, name }) {
  const key = String(slot || '').trim();
  const val = String(name || '').trim();
  if (!key || !val) return;
  const has = conds.value.some((c) => String((c.vars || {})[key] || '').trim() === val);
  if (!has) {
    conds.value.push({ label: '', yield_pct: null, mass: '', sel: '', note: '', vars: { [key]: val } });
    notify();
    toast(`已作为候选加进条件组：[${key}] = ${val}`, 'ok');
  }
}

function syncVarCandidates() {
  const bySlot = new Map();
  for (const r of reagent.rows) {
    const slot = String(r.variable || '').trim();
    const name = String(r.name || '').trim();
    if (!slot || !name) continue;
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(name);
  }
  let added = false;
  for (const [slot, names] of bySlot) {
    if (names.length < 2) continue;   // 只有一个候选 = 标准条件，交给用户自己填条件组
    for (const name of names) {
      const has = conds.value.some((c) => String((c.vars || {})[slot] || '').trim() === name);
      if (has) continue;
      conds.value.push({ label: '', yield_pct: null, mass: '', sel: '', note: '', vars: { [slot]: name }, varEq: {} });
      added = true;
    }
  }
  if (added) notify();
}
watch(
  () => reagent.rows.map((r) => `${r.variable || ''}:${r.name || ''}`).join('|'),
  () => syncVarCandidates()
);

watch(liveSig, () => scheduleLive());
// 结构在画板里改过（加了 / 去了缩写标签）→ 重画这张反应式；化合物库读完那一下也会走这里
watch(liveFp, () => scheduleLive(200));
watch(() => (store.compounds || []).length, () => scheduleLive(50));

async function schemeFromTable() {
  if (!exp.value || exp.value.locked) return;
  try {
    await loadCompounds();
  } catch (e) {
    return toast(e.message || '化合物库没读出来', 'err');
  }
  // 构件（反应物 / 产物 / 箭头上下的字）跟筛选表共用一份，见 lib/expScheme.js
  const parts = schemeParts({ ...fields, steps: reagent.steps, reagents: reagent.rows }, store.compounds || []);
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
    const stage2 = (p) => ({
      reactants: p.reactants,
      reactantIds: p.reactantIds,
      reactantVers: p.reactantVers,
      product: p.product,
      productId: p.productId,
      productVer: p.productVer,
      productLabel: p.product ? '' : (p.productLabel || p.prodName),
      above: p.above,
      below: p.below,
    });
    const stages2 = (parts.stages || []).length > 1 ? parts.stages.map(stage2) : [stage2(parts)];
    if (stages2.length === 1 && Number(fields.chain_draw) === 1 && prevExp.value?.id) {
      const pp = await prevParts(prevExp.value.id);
      if (pp && pp.reactants.length) stages2.unshift(stage2(pp));
    }
    svg = await composeChainSvg({ stages: stages2, fmt: sheetSchemeFmt.fmt });
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
  // 条件行也要一起搬：温度 / 时间 / 气氛 / 装置 / 光照 以前压根没带过来，
  // 套完配方反应式底下只剩个溶剂（用户：「套用配方这边为什么是空的」）。
  // 只填空着的格子——已经手填过的保留（套配方不该把当前记录的条件盖掉）
  let filled = 0;
  for (const k of ['temperature', 'duration', 'atmosphere', 'apparatus', 'light']) {
    if (String(fields[k] ?? '').trim()) continue;
    const v = String(full[k] ?? '').trim();
    if (!v) continue;
    fields[k] = full[k];
    filled += 1;
  }
  notify();
  if (filled) toast(`已套用配方的投料表，顺带填了 ${filled} 个条件格`, 'ok', 2200);
}

/** 绑定产物：弹窗里三条路（反应式里读 / 库里挑 / 画一个），都落到「product_compound_id + 名称 + MW」 */
const productBindOpen = ref(false);
const productSketchOpen = ref(false);
function openProductBind() {
  moreMenu.value = false;
  productBindOpen.value = true;
}

/** 绑定库里已有的那个：名称和分子量跟着库走（同名不同 MW 的老坑就在这儿） */
function bindProduct(c) {
  if (!c) return;
  fields.product_compound_id = c.id;
  if (c.name || c.code) fields.product_name = c.name || c.code;
  if (num(c.mw) !== null) fields.product_mw = round(c.mw, 2);
  productBindOpen.value = false;
  notify();
  toast(`已绑定 ${c.code || c.name}；名称和分子量按库里那份`);
}

/** 用一条结构（反应式里读出来的 / 画板画回来的）新建化合物并绑定 */
async function createProductFromStructure({ smiles, svg, formula, mw, name, mol } = {}) {
  if (!exp.value) return;
  const s = String(smiles || '').trim();
  let fm = formula || '';
  let m = num(mw);
  if (s && (!fm || m === null)) {
    const a = await analyzeSmiles(s);
    if (a) {
      fm = fm || a.formula || '';
      if (m === null) m = a.mw ?? null;
      svg = svg || a.svg || '';
    }
  }
  const c = await api.createCompound({
    code: '',
    name: String(name || '').trim() || `${exp.value.code} 产物`,
    kind: '产物',
    project: fields.project || '',
    standard_exp_id: exp.value.id,
    smiles: s,
    mol: mol || '',
    formula: fm,
    mw: m,
  });
  if (svg) {
    const fd = new FormData();
    fd.append('file', svgToFile(svg), '结构式.svg');
    fd.append('category', 'structure');
    await api.uploadCompoundFile(c.id, fd);
  }
  await loadBoot();
  fields.product_compound_id = c.id;
  fields.product_name = c.name || '';
  if (num(c.mw) !== null) fields.product_mw = round(c.mw, 2);
  productBindOpen.value = false;
  notify();
  toast(`建好了 ${c.code || c.name}，已绑定到这条记录`);
}

function drawProduct() {
  productBindOpen.value = false;
  productSketchOpen.value = true;
}

async function onProductPicked({ smiles, mol, svg, info }) {
  productSketchOpen.value = false;
  try {
    await createProductFromStructure({
      smiles: smiles || info?.smiles || '',
      mol: mol || '',
      svg: svg || '',
      formula: info?.formula || '',
      mw: info?.mw ?? null,
      name: fields.product_name || '',
    });
  } catch (e) {
    toast(e.message || '没能建化合物', 'err');
  }
}

/** 给一个化合物补上「产物结构」那张图（从反应式里的产物 SMILES 算；没有就跳过） */
async function attachProductStructure(compoundId) {
  const smiles = productSmilesOf(fields.scheme_smiles);
  if (!smiles || !compoundId) return false;
  const a = await analyzeSmiles(smiles);
  if (!a || !a.svg) return false;
  const fd = new FormData();
  fd.append('file', svgToFile(a.svg), '结构式.svg');
  fd.append('category', 'structure');
  await api.uploadCompoundFile(compoundId, fd);
  return true;
}

/** 老的「产物存库」：连表征 / TLC / 操作一起搬一份档案（弹窗底部那条小字） */
function archiveProduct() {
  productBindOpen.value = false;
  void saveToCompound();
}

/** 冲突列表（补档案时两边都有但不一样的格子） */
const syncOpen = ref(false);
const syncData = ref(null);
const syncBusy = ref(false);

/** 冲突里的值太长就截一下（NMR / 操作步骤都是一大段） */
const shortVal = (v) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 30 ? `${t.slice(0, 30)}…` : t;
};

/**
 * 产物存库 = **建 / 补**（幂等）：先 `dry` 问一次会补什么、哪几格跟档案不一样，
 * 有冲突就让人选「用记录里的覆盖」还是「只补空着的」；谱图只补缺的，那边已有同类的不动。
 */
async function saveToCompound() {
  moreMenu.value = false;
  try {
    const pre = await api.compoundFromExperiment(exp.value.id, { dry: true });

    if (pre.created) {
      const ok = await confirm({
        title: '将本实验产物存入化合物库？',
        body: '库里还没有这条记录的产物档案：会新建一份，带入名称、分子量、性状、表征、TLC 与操作步骤，谱图一并复制。',
        confirmText: '新建并绑定',
      });
      if (!ok) return;
      await applyArchive(false);
      return;
    }

    const c = pre.compound;
    const name = c?.code || c?.name || '那份档案';

    // 有冲突：开「冲突列表」，一格一格选要哪边（像代码合并那样）
    if (pre.conflicts.length) {
      syncData.value = {
        compound: pre.compound,
        conflicts: pre.conflicts,
        fills: pre.fills,
        filesCopy: pre.filesCopy,
        filesSkip: pre.filesSkip,
      };
      syncOpen.value = true;
      return;
    }

    if (!pre.fills.length && !pre.filesCopy.length) {
      toast(
        pre.conflicts.length
          ? `那就保持「${name}」里的值，什么都没改`
          : `${name} 已经跟这条记录一致，没什么可补的`
      );
      return;
    }
    const ok = await confirmLines({
      title: pre.conflicts.length ? `那就保留「${name}」里的值，只补空着的？` : `补一下「${name}」空着的格子？`,
      lines: pre.fills.map((x) => `${x.label}：空着 → 「${shortVal(x.value)}」`),
      hint:
        (pre.filesCopy.length ? `谱图会搬 ${pre.filesCopy.join(' / ')}。` : '') +
        (pre.filesSkip.length ? `这边已有的 ${pre.filesSkip.join(' / ')} 不重复搬、也不覆盖。` : '') +
        '已经有内容的一律不动。',
      confirmText: '补一下',
    });
    if (!ok) return;
    await applyArchive(false);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 按冲突列表里选的来：`fields` = 要「用记录里的」那几格（空数组＝只补空着的） */
async function applySync({ fields = [] } = {}) {
  syncBusy.value = true;
  try {
    await applyArchive(false, fields);
    syncOpen.value = false;
  } finally {
    syncBusy.value = false;
  }
}

/** 真正执行一次（`fields` 里的那几格用记录里的值覆盖，其余只补空着的） */
async function applyArchive(overwrite, fields = []) {
  const r = await api.compoundFromExperiment(exp.value.id, {
    overwrite,
    overwriteFields: fields,
  });
  const c = r.compound;
  if (!c) return;
  fields.product_compound_id = c.id;
  if (r.created) await attachProductStructure(c.id).catch(() => {});
  await loadBoot();
  const name = c.code || c.name || '档案';
  const bits = [];
  if (r.created) bits.push(`新建了「${name}」`);
  else if (overwrite) bits.push(`「${name}」按记录覆盖了冲突的格子`);
  else if (fields.length) bits.push(`「${name}」按记录覆盖了 ${fields.length} 格`);
  else bits.push(`「${name}」只补了空着的格子`);
  if (r.fills?.length) bits.push(`补 ${r.fills.length} 格`);
  if (r.filesCopy?.length) bits.push(`搬了 ${r.filesCopy.length} 份谱图`);
  if (r.filesSkip?.length) bits.push(`${r.filesSkip.join('/')} 那边已有，没重复搬`);
  toast(bits.join('；'));
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
/* 这排书签不再折叠：以前点「平行 ×N」能收成一枚「平行 ▸」，收起后纸面左上角
   只剩一个带焦点圈的小框，用户说没必要——现在它只是个静态标签，书签常驻。 */
/** 短杠长度按产率来：14–22px（没填产率就是 14） */
function tickW(s) {
  const y = Number(s.yield_pct);
  return Number.isFinite(y) ? Math.round(14 + Math.min(Math.max(y, 0), 100) / 100 * 8) : 14;
}
const railStyle = ref({});
function updateRail() {
  updateEdgeBox();
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
  nextTick(() => {
    updateRail();
    updateEdgeBox();
  });
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

/**
 * 「一页汇报卡」：给导师看的**一张纸** —— 反应式 / 条件 / 投料 / 产率·选择性 / TLC。
 * 不带记录簿抬头、操作现象、后处理、表征、讨论（那些是自己看的）；谱图也不进纸面。
 */
async function exportReportCard() {
  closeMore();
  if (!exp.value) return;
  if (dirty.value) await flush();
  try {
    await renderLive();                      // 反应式按当前投料表重画一遍（缓存命中很快）
    const rows = reagent.rows
      .filter((r) => String(r.name || '').trim() && !r.variable)
      .map((r) => ({
        role: r.role,
        name: r.name,
        mw: num(r.mw),
        eqText: r.role === '溶剂' ? '' : eqLabel(r.eq),
        mmol: num(r.mmol),
        amount: String(r.amountText || '').trim() || amountText(derive({ ...r })),
      }));
    const subs = reagent.rows
      .filter((r) => r.role === '底物' && String(r.name || '').trim() && !r.variable)
      .map((r) => r.name);
    const prod = String(fields.product_name || '').trim();
    const conds = [
      { k: '反应温度', v: fields.temperature },
      { k: '时间', v: fields.duration },
      { k: '气氛', v: fields.atmosphere },
      { k: '装置', v: fields.apparatus },
      { k: '光照', v: fields.light },
      { k: '反应规模', v: reagent.base ? `${round(reagent.base, 3)} mmol` : '' },
    ];
    const yields = fields.no_yield
      ? '不计产率'
      : String(fields.yield_pct ?? '').trim()
        ? `${round(Number(fields.yield_pct), 1)}%`
        : '';
    const sel = [String(fields.dr_ee || '').trim(), String(fields.ee_pct || '').trim() ? `ee ${fields.ee_pct}%` : '']
      .filter(Boolean)
      .join(' / ');
    const html = buildReportCard({
      code: exp.value.code,
      date: fields.date,
      title: String(fields.title || fields.objective || exp.value.code || '').trim(),
      subtitle: subs.length || prod ? `${subs.join(' + ') || '?'} → ${prod || '产物（待定）'}` : '',
      schemeSvg: liveScheme.value || '',
      conds,
      base: reagent.base,
      rows,
      result: { name: prod, appearance: fields.appearance, yieldText: yields, selText: sel, drText: '' },
      tlc: { note: fields.tlc_note, plates: tlcShots.value.map((f) => `/api/files/${f.id}`) },
    });
    const name = `汇报卡-${exp.value.code || '记录'}.pdf`;
    const blob = await api.snapshotPdf({
      pages: [html],
      css: `${reportCardCss()}\n${SNAP_NO_ZOOM}`,
      width: 794,
      snapWidth: 1588,
      filename: name,
    });
    downloadBlob(blob, name);
    toast('汇报卡好了，一张 A4，直接发就行');
  } catch (e) {
    toast(e.message || '生成汇报卡失败', 'err');
  }
}

/** 点 TLC 图 / 反应式看大图：走弹窗预览（要下载再在弹窗里下） */
const preview = ref(null);
const openAttachment = (id) => {
  const a = (exp.value?.attachments || []).find((x) => x.id === id);
  if (!a) return;
  preview.value = { src: `/api/files/${id}`, name: a.original_name || a.filename || '附件', category: a.category || 'tlc' };

/** 图片下载时烧进底部的那一行（字段在设置 › 界面里挑） */
const previewMeta = computed(() => ({
  code: exp.value?.code || '',
  cat: CATEGORY_LABEL[preview.value?.category] || '',
  tlc: [exp.value?.tlc_solvent, exp.value?.tlc_rf ? `Rf ${exp.value.tlc_rf}` : ''].filter(Boolean).join(' · '),
  date: exp.value?.date || '',
  project: exp.value?.project || '',
  owner: store.boot?.settings?.owner_name || '',
}));
};
</script>

<template>
  <ExperimentMobile v-if="isPhone" :id="route.params.id" />

  <div v-else-if="error" class="single"><div class="empty-note" style="padding: 80px">{{ error }}</div></div>

  <div v-else class="panes">
    <!-- 左：实验列表。读取中就一直挂着——从列表/卡片墙点进来时，这栏以前会跟着
         整棵 v-if 分支一起卸载重建，看着就是闪一下 -->
    <ExpListPane />
    <!-- 纸左右那两条空白当翻页热区（只在鼠标够得着的地方出现，纸上和工具栏都不拦） -->
    <div
      v-if="exp && edgeFlip && !isPhone"
      class="edge-flip is-l noprint"
      :class="[`look-${edgeLook}`, { 'is-off': prevPageNum == null }]"
      :style="edgeBox.left"
      title="上一页（←）"
      aria-label="上一页"
      @click="flipPage(-1)"
    >
      <span class="edge-arrow">‹</span>
    </div>
    <div
      v-if="exp && edgeFlip && !isPhone"
      class="edge-flip is-r noprint"
      :class="[`look-${edgeLook}`, { 'is-off': nextPageNum == null }]"
      :style="edgeBox.right"
      title="下一页（→）"
      aria-label="下一页"
      @click="flipPage(1)"
    >
      <span class="edge-arrow">›</span>
    </div>
    <div class="editor" :class="{ 'is-fit': editorFits }" ref="editorEl" @scroll="updateRail">
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
        <!-- 翻页箭头（键盘 ←/→ 的鼠标版）：到头就置灰，跟键盘一样不绕回 -->
        <button
          class="pg-arrow noprint"
          type="button"
          :disabled="prevPageNum == null"
          title="上一页（←）"
          aria-label="上一页"
          @click="flipPage(-1)"
        >
          ‹
        </button>
        <div class="page-tabs noprint" role="tablist">
          <button class="ptab" :aria-selected="page === 1 ? 'true' : 'false'" title="← → 翻页，↑ ↓ 切平行实验" @click="page = 1">第 1 页 · 主记录</button>
          <button class="ptab" :aria-selected="page === 2 ? 'true' : 'false'" title="← → 翻页，↑ ↓ 切平行实验" @click="page = 2">第 2 页 · 续页</button>
          <button
            v-if="sheetPrefs.lit"
            class="ptab"
            :aria-selected="page === 3 ? 'true' : 'false'"
            title="文献：要点 + 文献里的反应式 / 条件表截图（算记录的第 3 页，打印 / 存 PDF 会带上）"
            @click="page = 3"
          >
            第 3 页 · 文献
          </button>
          <button
            v-if="sheetPrefs.attachments"
            class="ptab"
            :aria-selected="page === 4 ? 'true' : 'false'"
            :title="`原始文件都在这儿：谱图、TLC、照片、文献图（${(exp.attachments || []).length} 个）`"
            @click="page = 4"
          >
            附件 · {{ (exp.attachments || []).length }}
          </button>
        </div>
        <button
          class="pg-arrow noprint"
          type="button"
          :disabled="nextPageNum == null"
          title="下一页（→）"
          aria-label="下一页"
          @click="flipPage(1)"
        >
          ›
        </button>
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
          <button class="btn btn-sm btn-ghost" title="更多" @click.stop="moreMenu = !moreMenu; if (moreMenu) markPopupOpen()">
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
                <button @click="exportReportCard()"><Icon name="file" :size="13" /> 一页汇报卡（PDF）</button>
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
            <button @click="openProductBind()"><Icon name="molecule" :size="13" /> 绑定产物…</button>
            <button @click="openPrevPick()"><Icon name="arrow-left" :size="13" /> 接上一步…</button>
            <button v-if="prevExp" @click="unlinkPrev(); moreMenu = false"><Icon name="x" :size="13" /> 断开上一步（{{ prevExp.code }}）</button>
            <button v-if="prevExp" @click="toggleChainDraw(); moreMenu = false">
              <Icon name="molecule" :size="13" /> {{ fields.chain_draw ? '只画这一段（不连起来）' : '反应式连上一步一起画' }}
            </button>
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
            <!-- 8 列固定宽 + 最后一列吃剩下的：纸面内宽只有 ~595px，
                 以前前 7 列加起来 594，最后那列只剩 1px —— 湿度（第 1 行）和状态（第 2 行）
                 都溢出到那一格里，叠在一起、被推到表格右边缘（用户报「抬头表格排得不对」）。 -->
            <colgroup>
              <!-- 用百分比而不是 px：纸面内宽会跟着内容区宽变（572 / 595 / 更宽），
                   定长加起来一超，最后一列（湿度 / 状态）就被挤成 1px、两边叠在一起。 -->
              <col style="width: 8%" /><col style="width: 13%" /><col style="width: 7%" /><col style="width: 18%" />
              <col style="width: 7%" /><col style="width: 25%" /><col style="width: 7%" /><col style="width: 15%" />
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
                    <div class="kind-wrap">
                      <input
                        class="kind-pick"
                        :value="fields.kind || '通用'"
                        readonly
                        :disabled="exp.locked"
                        title="记录类型（通用 / 原料 / 试反应 / 条件筛选 / 底物扩展，并行存在）——换类型会换这套版式"
                        @click.stop="kindMenu = !kindMenu"
                        @focus="kindMenu = true"
                        @keydown.esc="kindMenu = false"
                      />
                      <Icon name="down" :size="10" class="kind-caret" />
                      <div v-if="kindMenu && !exp.locked" class="kind-opt-menu" @click.stop>
                        <button
                          v-for="k in KIND_OPTIONS"
                          :key="k.value || 'plain'"
                          type="button"
                          class="rxn-opt"
                          :class="{ 'is-on': (fields.kind || '') === k.value }"
                          @click="pickKind(k.value)"
                        >
                          {{ k.label }}
                        </button>
                      </div>
                    </div>
                    <div class="rxn-wrap">
                      <input
                        class="kind-rxn"
                        v-model="fields.rxn_type"
                        placeholder="反应类型"
                        :disabled="exp.locked"
                        title="反应类型：改当量 / 放大实验 / 转化…（也可以自己写）"
                        @click.stop="rxnMenu = true; markPopupOpen()"
                        @focus="rxnMenu = true; markPopupOpen()"
                        @keydown.esc="rxnMenu = false"
                      />
                      <div v-if="rxnMenu && !exp.locked" class="rxn-menu">
                        <button
                          v-for="t in rxnTypes"
                          :key="t"
                          type="button"
                          class="rxn-opt"
                          :class="{ 'is-on': fields.rxn_type === t }"
                          @click="fields.rxn_type = t; rxnMenu = false; notify()"
                        >
                          {{ t }}
                        </button>
                        <button
                          v-if="rxnCanRemember"
                          type="button"
                          class="rxn-opt is-remember"
                          title="把刚敲的这个加进候选（设置里也能加）"
                          @click="rememberRxnType()"
                        >
                          ＋ 记下「{{ rxnTyped }}」
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
                    <button type="button" class="status-chip" :class="`tone-${STATUS_TONE[fields.status] || 'plain'}`" @click.stop="statusMenu = !statusMenu; if (statusMenu) markPopupOpen()">
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
            :busy="liveDrawing"
            :chain="chainInfo"
            @open-prev="openRecord"
            @open-next="openRecord"
            @toggle-join="toggleChainDraw"
          />

          <ReagentTable
            v-if="sheetPrefs.reagents"
            :model="reagent"
            :notify="notify"
            :locked="exp.locked"
            :var-counts="varCounts"
            :var-candidates="varCandidates"
            :drop-var-rows="sheetPrefs.conds"
            :show-check="sheetFx.check"
            @recipe="openRecipe"
            @promote-var="promoteVarCandidate"
            @focus-var="scrollToConds"
            @var-toggled="onReagentVarToggled"
          >
            <template #cond="{ step }">
              <!-- 多步记录：条件行跟着每一步的表走（两步 = 两张表，各自记温度 / 时间 / 气氛）；
                   单步记录还是记录本身那一行 -->
              <CondRow
                v-if="multiStep"
                :model="reagent.steps[step]"
                :notify="notify"
                :locked="exp.locked"
                :fixed="condFixed"
                :field-vars="[]"
              />
              <CondRow
                v-else
                :model="fields"
                :notify="notify"
                :locked="exp.locked"
                :fixed="condFixed"
                :field-vars="fieldVars"
                @toggle-var="toggleFieldVar"
              />
            </template>

            <!-- 变量：接在投料表合计线下面、用一条虚线隔开——一行一个条件，只写「换了什么」；
                 产率 / 选择性在下面的结果块里，别混在这张投料表里 -->
            <template #vars>
              <template v-if="sheetPrefs.conds">
                <tr ref="condsEl" class="rt-vars-head" :class="{ noprint: !conds.length }">
                  <td class="grip-cell" />
                  <td colspan="8">
                    <div class="vars-head">
                      <span class="vars-lbl">变量</span>
                      <span v-for="v in condVars" :key="v.key" class="var-slot">[{{ v.ph }}]</span>
                      <span class="vars-rule" />
                      <span v-if="!conds.length" class="vars-hint">要筛条件就一行一个</span>
                      <button
                        v-if="condVars.length && !exp.locked"
                        type="button"
                        class="vars-add vars-drop"
                        title="取消这个变量：投料表里那一行回来，下面只是候选的行一起收掉"
                        @click="dropVariable"
                      >取消变量</button>
                      <button v-if="!exp.locked" type="button" class="vars-add" @click="addCond">＋ 加变量</button>
                    </div>
                  </td>
                </tr>
                <!-- 这一行的格子数必须**正好 9 列**（跟 rtable 的 colgroup 对齐）：
                     试剂类 = grip + 序号 + 试剂 + MW/当量/mmol/用量 + 说明 + ×；
                     字段类 = grip + 序号 + 合并 6 格 + ×。多一格整张表就会多出一条空列，
                     页面上表现为一块空白的「框」（踩过）。 -->
                <tr v-for="row in varRows" :key="`v${row.i}`" class="rt-var">
                  <td class="grip-cell" />
                  <td class="var-idx-cell">Entry {{ row.i + 1 }}</td>
                  <td class="var-name-cell" :colspan="row.isMol ? 1 : 6">
                    <!-- 只有字段变量才写这行小字；自由写法（`−40 °C / LDA…`）没有名字可写，
                         留一个空 span 会在块级输入框上面多顶出一行，整行高到 48px -->
                    <span v-if="row.fieldName" class="var-field-lbl">{{ row.fieldName }}</span>
                    <span v-if="condVars.length" class="var-vals">
                      <template v-for="(v, vi) in condVars" :key="v.key">
                        <span v-if="vi" class="var-val-sep">·</span>
                        <CondCand
                          v-model="row.c.vars[v.ph]"
                          :role="v.role || ''"
                          :cands="varCandidates[v.ph] || []"
                          :disabled="exp.locked"
                          :placeholder="varPlaceholder(v)"
                          @pick="(it) => pickCondCand(row.c, v.ph, it)"
                        />
                      </template>
                    </span>
                    <input
                      v-else
                      v-model="row.c.label"
                      class="cond-in"
                      :disabled="exp.locked"
                      placeholder="−40 °C / LDA 1.2 eq / DCM 代替 THF"
                      @input="notify()"
                    />
                  </td>
                  <!-- 温度 / 时间 / 气氛这种变量：没有分子量 / 当量 / mmol / 用量，
                       干脆把那五格并成一格，写清楚「变的是哪样」（一排「—」看着像挖了个洞） -->
                  <td v-if="row.isMol" class="n var-mw">
                    <template v-if="row.info.mw != null">{{ round(row.info.mw, 2) }}</template>
                    <span v-else class="var-na">—</span>
                  </td>
                  <td v-if="row.isMol" class="n var-eq">
                    <input
                      class="cond-eq"
                      :value="row.c.varEq?.[row.ph] ?? ''"
                      :disabled="exp.locked"
                      placeholder="—"
                      :title="`这个条件的当量（空 = 用投料表里的标准当量）`"
                      @input="setVarEq(row.c, row.ph, $event.target.value)"
                    />
                  </td>
                  <td v-if="row.isMol" class="n var-mmol">
                    <template v-if="row.info.mmol != null">{{ round(row.info.mmol, 3) }}</template>
                    <span v-else class="var-na">—</span>
                  </td>
                  <td v-if="row.isMol" class="n var-amt" :class="{ 'is-liquid': /[µu]L|mL$/.test(row.info.amount || '') }">
                    <span :class="{ 'var-na': row.info.amount === '—' }">{{ row.info.amount }}</span>
                  </td>
                  <td v-if="row.isMol" class="var-note-cell">
                    <!-- 变量行里的试剂名不在投料表里，本地往往没分子量：给一颗「查 MW」，
                         查到的东西会落进试剂库（下次自动带出）。有 MW 了就不显示。 -->
                    <button
                      v-if="row.c.vars?.[row.ph] && mwOfName(row.c.vars?.[row.ph]) == null"
                      type="button"
                      class="var-look noprint"
                      :class="`is-${varLookState(row.c.vars?.[row.ph]) || 'idle'}`"
                      :disabled="exp.locked || varLookBusy(row.c.vars?.[row.ph])"
                      :title="varLookTitle(row.c.vars?.[row.ph])"
                      @click.stop="lookupVarName(row.c.vars?.[row.ph], { force: true, role: condVars[0]?.role || '' })"
                    >
                      {{ varLookLabel(row.c.vars?.[row.ph]) }}
                    </button>
                  </td>
                  <td class="noprint">
                    <button v-if="!exp.locked" type="button" class="cond-x" title="删掉这个变量" @click="removeCond(row.i)">×</button>
                  </td>
                </tr>
              </template>
            </template>
          </ReagentTable>

          <ResultBlock
            v-if="sheetPrefs.result"
            ref="resBlock"
            :model="fields"
            :steps="reagent.steps"
            :base="reagent.base" :notify="notify" :locked="exp.locked" :kind="fields.kind"
            :yield-default="sheetFx.yield" :tlc="tlcShots" :exp-id="exp.id"
            :show-appear="sheetFx.resAppear" :show-dr-ee="sheetFx.resDrEe"
            :tlc-max="sheetTlcMax.n"
            :cands="conds"
            :cand-label="condWhat"
            @refresh="refreshAttachments"
            @open-compound="(id) => router.push(`/compounds/${id}`)"
          >
          </ResultBlock>


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
                <textarea class="sheet-text" rows="3" v-autogrow v-model="fields.procedure" :disabled="exp.locked" placeholder="加料、换气、升温、取样…" />
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
              <div class="tlc-note-wrap" @mousedown.stop="onTlcDown($event)">
                <input
                  class="tlc-note"
                  :class="{ 'is-editing': tlcEditing }"
                  :style="{ width: tlcBoxW }"
                  :ref="setTlcInput"
                  v-model="fields.tlc_note"
                  :placeholder="TLC_PH"
                  title="展开剂 / 显色方式，如 PE:EA = 10:1，UV + 磷钼酸"
                  :disabled="exp.locked"
                  @blur="tlcEditing = false"
                  @keydown.esc="tlcMenu = false; tlcEditing = false"
                />
                <span ref="tlcMirrorEl" class="tlc-mirror" aria-hidden="true">{{ tlcMirrorText }}</span>
                <button
                  type="button"
                  class="tlc-caret"
                  title="选常用展开剂（也可以双击格子直接改字）"
                  @click.stop="openTlcMenu()"
                >
                  <Icon name="down" :size="12" />
                </button>
                <div v-if="tlcMenu && !exp.locked" class="qmenu cond-menu tlc-menu" @click.stop>
                  <button
                    v-for="t in tlcNotes"
                    :key="t"
                    type="button"
                    class="qchip is-own"
                    :aria-selected="tlcTyped === t"
                    @click="pickTlc(t)"
                  >
                    {{ t }}
                    <span class="qchip-x" role="button" title="从常用选项里去掉" @click.stop.prevent="delTlc(t)">×</span>
                  </button>
                  <button
                    type="button"
                    class="qchip is-add"
                    title="把自己常用的展开剂加进来（跟着记录本一起备份）"
                    @click.stop="addTlc()"
                  >
                    ＋ 自定义
                  </button>
                </div>
              </div>
              <TlcOcr :shots="tlcShots" scope="attachment" @pick="applyTlcOcr" />
            </div>
            <TlcStrip
              captions
              cap-placeholder="图注，如 2 h / 对照"
              :attachments="exp.attachments || []"
              :locked="exp.locked"
              :hovered="hovered"
              :on-hover="onHover"
              :on-pick="pickFile"
              :on-open="openAttachment"
              :on-caption="saveCaption"
              :on-delete="async (id) => { await api.deleteAttachment(id); await refreshAttachments(); }"
            />
          </section>
          <section v-if="sheetPrefs.conclusion" class="sec">
            <h2 class="sec-title"><span class="num">三</span>讨论与结论</h2>
            <textarea class="sheet-text" rows="2" v-autogrow v-model="fields.conclusion" :disabled="exp.locked" placeholder="本组条件的结论与下一轮拟考察的变量" />
          </section>


        </article>


        <!-- ============ 第 3 页 · 文献（可选；没内容时打印不带这一页） ============ -->
          <article v-if="sheetPrefs.lit" class="sheet sheet-p3" :class="{ 'is-hidden': page !== 3 }">
            <div class="sheet-runner">
              <span>{{ store.boot?.settings?.lab_heading || '方法学实验记录' }} · 文献</span>
              <span>{{ exp.code }}</span>
            </div>
            <section class="sec">
              <h2 class="sec-title">文献</h2>
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
            <div class="sheet-foot noprint">
              <span class="hint">文献里的标准条件 / 产率写在这一页；出处仍写第 1 页抬头那格「文献」。</span>
            </div>
          </article>

        <!-- ============ 附件（不占纸面：原始文件不是记录正文，打印 / 存 PDF 也不带它） ============ -->
        <article v-if="sheetPrefs.attachments && page === 4" class="sheet sheet-att">
          <div class="sheet-runner">
            <span>{{ store.boot?.settings?.lab_heading || '方法学实验记录' }} · 附件</span>
            <span>{{ exp.code }}</span>
          </div>
          <AttachmentsBlock
            :exp-id="exp.id"
            :attachments="exp.attachments || []"
            :locked="exp.locked"
            @refresh="refreshAttachments"
          />
          <div class="sheet-foot">
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

    <FilePreview
      v-if="preview"
      :src="preview.src"
      :name="preview.name"
      :exp-id="exp.id"
      :category="preview.category || 'tlc'"
      :meta="previewMeta"
      @close="preview = null"
      @saved="refreshAttachments"
    />

    <SketcherModal
      :open="schemeSketcherOpen"
      mode="reaction"
      :initial="schemePadSeed || fields.scheme_rxn || ''"
      @close="schemeSketcherOpen = false"
      @pick="applySketchScheme"
    />

    <!-- 画产物结构（绑定产物的第三条路）：单结构模式，跟反应式那个画板互不相干 -->
    <SketcherModal
      :open="productSketchOpen"
      mode="molecule"
      :initial="''"
      @close="productSketchOpen = false"
      @pick="onProductPicked"
    />

    <SyncConflicts
      v-if="syncOpen && syncData"
      :compound="syncData.compound"
      :conflicts="syncData.conflicts"
      :fills="syncData.fills"
      :files-copy="syncData.filesCopy"
      :files-skip="syncData.filesSkip"
      :busy="syncBusy"
      @close="syncOpen = false"
      @apply="applySync"
    />

    <ProductBind
      v-if="productBindOpen && exp"
      :model="fields"
      :exp-code="exp.code"
      :locked="exp.locked"
      @close="productBindOpen = false"
      @bind="bindProduct"
      @create="(info) => createProductFromStructure(info).catch((e) => toast(e.message || '没能建化合物', 'err'))"
      @draw="drawProduct"
      @archive="archiveProduct"
    />

    <!-- 「接上一步」：从记录里挑一条当这条的前一步（产物正好是本条底物的排前面） -->
    <ExpPick
      :model-value="prevPickOpen"
      title="这一步接在哪条记录后面？"
      confirm-text="接上"
      :exclude="exp ? [exp.id] : []"
      :prefer-ids="prevPrefers"
      @close="prevPickOpen = false"
      @confirm="linkPrev"
    />

    <PrintPanel
      v-if="printPanel"
      :title="`打印 · ${exp?.code || ''}`"
      :filename="`${exp?.code || '记录'}.pdf`"
      @close="printPanel = false"
      :lit="litHasContent"
      @print="runPrint"
    />

  </div>
</template>
