<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import CatPick from '../components/CatPick.vue';
import ProjPick from '../components/ProjPick.vue';
import CmpListPane from '../components/CmpListPane.vue';
import CompoundMobile from '../components/CompoundMobile.vue';
import AppModal from '../components/AppModal.vue';
import HistoryModal from '../components/HistoryModal.vue';
import SketcherModal from '../components/SketcherModal.vue';
import TlcOcr from '../components/TlcOcr.vue';
import { api } from '../api.js';
import { loadBoot, loadCompounds, store, categoriesOfProject, addCategory } from '../store.js';
import { printCompoundLabel } from '../lib/label.js';
import { structureInfo, pubchemUrl, describeInfo, LOOKUP_SITES } from '../lib/lookup.js';
import { CMP_CAT_LABEL, CMP_CAT_ORDER, fmtSize, guessCmpCategory, isImageName } from '../lib/ui.js';
import KindPick from '../components/KindPick.vue';
import { useAutosave } from '../lib/autosave.js';
import { applyNumeric } from '../lib/numinput.js';
import { analyzeSmiles, analyzeStructureText, looksLikeMolfile, looksLikeSmiles, svgToFile } from '../lib/chem.js';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { round } from '../lib/reagent.js';

const props = defineProps({ compoundId: { type: [String, Number], required: true } });
const router = useRouter();
const route = useRoute();

const c = ref(null);
const editorEl = ref(null);  // 滚动容器
const error = ref('');
const hovered = ref('');
const stdModal = ref(false);
const stdList = ref([]);
const stdPick = ref(null);
const recat = ref(null);
const pathModal = ref(false);
const pathValue = ref('');
const cat = ref('auto');

const form = reactive({
  code: '', name: '', kind: '底物', category_id: '', project: '', formula: '', mw: '', cas: '', appearance: '', mp: '', smiles: '',
  // 画板那版的 molfile（带坐标）：再打开画板时拿它当底，Ketcher 就不会重排一遍
  mol: '',
  hrms: '', ir: '', rotation: '',
  tlc_solvent: '', tlc_rf: '', procedure: '', notes: '',
});

/** 核磁改成贴截图：三类谱图各一排 */
const NMR_DEFS = [
  { key: 'h1', label: '¹H' },
  { key: 'c13', label: '¹³C' },
  { key: 'nmr_other', label: '其他' },
];

const spectra = (kind) =>
  (c.value?.files || []).filter((f) => f.category === kind && isImageName(f.original_name || f.filename));

const files = computed(() => c.value?.files || []);
const struct = computed(() => files.value.find((f) => f.category === 'structure' && isImageName(f.original_name || f.filename)));
const tlcShots = computed(() => files.value.filter((f) => f.category === 'tlc' && isImageName(f.original_name || f.filename)));
const used = computed(() => c.value?.usedIn || []);
/** 化合物跟分类一样挂课题：这里可以给它换一个（「共用课题」= 留空） */
const projectList = computed(() => store.boot?.projects || []);
const std = computed(() => c.value?.standardExp || null);

const baseline = ref('');

function fill(data) {
  c.value = data;
  smiEditing.value = false;
  for (const k of Object.keys(form)) form[k] = data[k] ?? '';
  baseline.value = JSON.stringify({ ...form });
  markLoaded();
}

async function load() {
  try {
    fill(await api.compound(props.compoundId));
  } catch (e) {
    error.value = e.message;
  }
}

/** 库里换一个化合物：组件会被复用，自己重新读一次 */
watch(
  () => props.compoundId,
  async (id, old) => {
    if (!id || id === old) return;
    try {
      if (dirty.value) await flush();
    } catch {
      /* 状态栏已有提示 */
    }
    recat.value = null;
    pathModal.value = false;
    stdModal.value = false;
    moreMenu.value = false;
    await load();
    const label = c.value?.code || c.value?.name;
    if (label) toast(`已切换到 ${label}`, 'info', 1800);
    // 换了化合物就当翻到新的一页：滚回顶部
    await nextTick();
    editorEl.value?.scrollTo({ top: 0 });
  }
);

const moreMenu = ref(false);
const preview = ref(null);   // 附件 / 谱图就地预览（不再甩到新标签页）
const sketcherOpen = ref(false);   // 画结构式（Ketcher 画板）
const historyOpen = ref(false);

function closeMenus(e) {
  if (!e.target.closest?.('.menu-wrap')) moreMenu.value = false;
}

/** 窄屏（手机）走只读精简页，桌面版式完全不渲染 */
const isPhone = ref(typeof window !== 'undefined' && window.innerWidth <= 820);
function onResize() {
  isPhone.value = window.innerWidth <= 820;
}

onMounted(async () => {
  window.addEventListener('resize', onResize);
  if (!isPhone.value) await load();
  document.addEventListener('paste', onPaste);
  document.addEventListener('click', closeMenus);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  document.removeEventListener('paste', onPaste);
  document.removeEventListener('click', closeMenus);
});

const payload = () => ({ ...form });

/** 中栏列表 / 卡片墙读的是 store.compounds，改完名字得就地改掉那一份，不然要刷新页面才变 */
const LIST_FIELDS = ['code', 'name', 'kind', 'formula', 'mw', 'cas', 'tlc_rf', 'project', 'category_id', 'category_name'];

function patchListRow(updated) {
  const row = (store.compounds || []).find((x) => String(x.id) === String(updated.id));
  if (!row) return;
  for (const k of LIST_FIELDS) if (k in updated) row[k] = updated[k];
  // 分类名是列表接口拼的，改了分类就得问一下服务端
  if (updated.category_id !== undefined && !('category_name' in updated)) {
    row.category_name = categoriesOfProject('compound', row.project || '').find(
      (g) => Number(g.id) === Number(updated.category_id)
    )?.name || '';
  }
}

async function save() {
  const before = { project: form.project, category_id: form.category_id, kind: form.kind };
  const saved = await api.saveCompound(c.value.id, payload());
  c.value = saved;
  patchListRow(saved);
  // 课题 / 分类 / 类型变了会影响这条记录还属不属于当前列表和分组，得真的重拉一次
  const moved =
    (before.project || '') !== (saved.project || '') ||
    String(before.category_id ?? '') !== String(saved.category_id ?? '') ||
    (before.kind || '') !== (saved.kind || '');
  await loadBoot();
  if (moved) await loadCompounds();
}

/** 立刻存一次 / 丢掉这次改动（跟实验页那两个按钮一个意思） */
async function saveNow() {
  if (!c.value) return;
  try {
    await flush();
  } catch {
    /* 保存状态栏已经提示了 */
  }
}

async function resetForm() {
  if (!c.value || !baseline.value) return;
  const snap = baseline.value;
  if (JSON.stringify(payload()) === snap) {
    toast('没有要撤销的改动');
    return;
  }
  const ok = await confirm({
    title: '重置到打开时的状态？',
    body: '将撤销打开本档案之后的全部修改。',
    confirmText: '重置',
    danger: true,
  });
  if (!ok) return;
  Object.assign(form, JSON.parse(snap));
  baseline.value = snap;
  markLoaded();
  try {
    await flush();
    toast('已重置');
  } catch {
    /* 错误显示在保存状态里 */
  }
}

const { state: saveState, dirty, flush, markLoaded } = useAutosave(payload, save, {
  delay: 700,
  enabled: () => !!c.value,
  onError: (e) => toast(e.message, 'err'),
});

/** 填了 SMILES：算分子式 / MW（空着的才填），并在没有结构图时画一张存进去 */
/** 画板交回来的结构：重画结构式图（有旧的会先确认再删），再填 SMILES / 分子式 / MW */
/** 最近一次查出来的结构信息（只用来显示 PubChem / ChemicalBook 两个链接，不落库） */
const lastLookup = ref(null);

/** 哪些格子是 PubChem 代填的（记下我们填进去的值）。换了结构要先还原，
    否则旧结构的 CAS / 熔点 / 性状会赖着不走，跟新结构对不上 */
const autoFilled = ref({});

function rememberAuto(key, value) {
  if (!value) return;
  autoFilled.value = { ...autoFilled.value, [key]: String(value) };
}

function clearAutoFilled() {
  for (const [k, v] of Object.entries(autoFilled.value)) {
    if (form[k] === v) form[k] = '';
  }
  autoFilled.value = {};
}

/**
 * 联网查这个结构「叫什么 / CAS 多少」（PubChem，服务端代查并缓存）。
 * 只补空格子：名称 / CAS / 分子式 / MW 里已经有值的一律不动，免得把用户自己写的覆盖掉。
 */
/** replaceCas：结构刚换过（画板 / 粘贴）时允许把 CAS 换成新结构查出来的那个——
    CAS 是跟着结构走的标识，留着旧结构的只会错。熔点 / 性状这种可能是用户手写的数据不覆盖。 */
async function fillFromLookup(smiles, { replaceCas = false } = {}) {
  const info = await structureInfo(String(smiles || '').trim());
  if (!info || !info.found) return null;
  lastLookup.value = info;
  const filled = [];
  if (!String(form.name || '').trim() && info.name) {
    form.name = info.name;
    rememberAuto('name', info.name);
    filled.push('名称');
  }
  const curCas = String(form.cas || '').trim();
  if (info.cas && info.cas.length) {
    if (!curCas) {
      form.cas = info.cas[0];
      rememberAuto('cas', info.cas[0]);
      filled.push('CAS');
    } else if (replaceCas && curCas !== info.cas[0]) {
      // 换了结构：旧 CAS 不再对应这结构，直接换成新的（会弹提示，不会闷着改）
      form.cas = info.cas[0];
      rememberAuto('cas', info.cas[0]);
      filled.push('CAS');
    }
  }
  if (!String(form.formula || '').trim() && info.formula) {
    form.formula = info.formula;
    rememberAuto('formula', info.formula);
    filled.push('分子式');
  }
  if (!String(form.mw || '').trim() && info.mw) {
    form.mw = info.mw;
    rememberAuto('mw', info.mw);
    filled.push('MW');
  }
  // 物性：PubChem 的「实验性质」那一节。熔点 / 性状有对应的格子，其余（密度 / 沸点…）只显示不落库
  const pr = info.props || {};
  if (!String(form.mp || '').trim() && pr.mp) {
    form.mp = pr.mp;
    rememberAuto('mp', pr.mp);
    filled.push('熔点');
  }
  if (!String(form.appearance || '').trim() && pr.appearance) {
    form.appearance = pr.appearance;
    rememberAuto('appearance', pr.appearance);
    filled.push('性状');
  }
  if (filled.length) toast(`PubChem：已补上${filled.join(' / ')}`, 'ok');
  return info;
}

/** 手动查一次（⋯ 菜单里），跟自动那次共用一套逻辑 */
async function lookupNow() {
  const smiles = String(form.smiles || '').trim();
  if (!smiles) return toast('这格还没有结构，先画一个或粘贴 SMILES', 'warn');
  const before = `${form.name}|${form.cas}|${form.formula}|${form.mw}`;
  const info = await fillFromLookup(smiles);
  if (!info) return toast('没查到：确认结构没问题、也联网了', 'warn');
  // 该填的都填过了（多半是点了第二次）：至少说一声查到了什么，别让人以为没反应
  if (`${form.name}|${form.cas}|${form.formula}|${form.mw}` === before) {
    toast(describeInfo(info) || `PubChem #${info.cid}`, 'info');
  }
}

/** 能拿去外部检索的标识：CAS（格式对）→ 名称 → 结构 SMILES */
const casOk = computed(() => {
  const cas = String(form.cas || '').trim();
  return /^\d{1,8}-\d{2}-\d$/.test(cas) ? cas : '';
});
const nameOk = computed(() => String(form.name || '').trim());

/**
 * 外面那几个「去别处查」的链接：**只要能拿标识就算得出来**，不用先点「查这个结构」，刷新也不会消失。
 * 站点表在 `lib/lookup.js` 的 `LOOKUP_SITES`（每个站点自己决定用 CID / CAS / 名称 / SMILES 里哪个）；
 * 拿不到标识的那一项直接不显示，不留死链。
 */
const lookupLinks = computed(() => {
  const lk = lastLookup.value && lastLookup.value.found ? lastLookup.value : null;
  const ids = {
    cid: (lk && lk.cid) || '',
    cas: casOk.value ? [casOk.value] : [],
    name: nameOk.value,
    smiles: String(form.smiles || '').trim(),
  };
  const used = casOk.value ? `CAS ${casOk.value}` : nameOk.value ? `「${nameOk.value}」` : '结构式';
  return LOOKUP_SITES.map((s) => ({
    key: s.key,
    label: s.label,
    href: s.url(ids),
    title: `${s.label}：${s.hint}（按 ${s.key === 'pubchem' && ids.cid ? `CID ${ids.cid}` : used} 查）`,
  })).filter((s) => s.href);
});

/** 熔点 / 性状已经填进格子了，这里只列没地方放的物性（密度 / 沸点 / 闪点 / 溶解度） */
const lookupProps = computed(() => {
  const pr = (lastLookup.value && lastLookup.value.props) || {};
  const bits = [];
  if (pr.density) bits.push(`密度 ${pr.density}`);
  if (pr.bp) bits.push(`沸点 ${pr.bp}`);
  if (pr.flash) bits.push(`闪点 ${pr.flash}`);
  if (pr.solubility) bits.push(`溶解度 ${pr.solubility}`);
  return bits.join(' · ');
});

/**
 * 已经画歪 / 挤在一起的结构式：按存着的 SMILES 让 openchemlib 重新排一遍坐标，
 * 画一张新的换上（旧的那张在传完之后删）。
 */
async function tidyStructure() {
  moreMenu.value = false;
  if (!c.value) return;
  const s = String(form.smiles || '').trim();
  if (!s) return toast('这条还没有 SMILES，画一个或者粘一个再整理', 'warn');
  const info = await analyzeSmiles(s);
  if (!info) return toast('这条 SMILES 读不出来，检查一下', 'err');
  const fd = new FormData();
  fd.append('file', svgToFile(info.svg), '结构式.svg');
  fd.append('category', 'structure');
  try {
    await api.uploadCompoundFile(c.value.id, fd);
    const old = struct.value;
    if (old) {
      try {
        await api.deleteCompoundFile(old.id);
      } catch {
        /* 旧的删不掉就留着，别让整理失败 */
      }
    }
    await reload();
    toast('结构式重新排过版了');
  } catch (e) {
    toast(e.message || '整理不了这张结构式', 'err');
  }
}

async function applySketched({ smiles, mol, svg: padSvg, info: sketchedInfo }) {
  if (!c.value || !smiles) return;
  // 结构图优先用**画板自己渲的那张**（用户说比我们重画的好看）；分子式 / 分子量仍按完整结构算。
  // 注意**公式必须用 SMILES 算**：Ketcher 存的 molfile 里芳香环的键级写法 openchemlib 读出来会多算氢
  // （实测同一个结构：SMILES→C9H12O4S/216.26、molfile→C9H18O4S/222.3），拿 SMILES 才准
  const info = await analyzeStructureText(smiles);
  // 换了结构：先把自己代填的那几格还回去，再按新结构重新查
  clearAutoFilled();
  if (!info) return toast('这个结构读不出来，换个画法试试', 'err');

  if (struct.value) {
    const ok = await confirm({
      title: '替换现有的结构式图？',
      body: '会用画板里的这个结构重画一张结构式图，现在那张（' + (struct.value.original_name || struct.value.filename) + '）会被删掉。',
    });
    if (!ok) return;
    try {
      await api.deleteCompoundFile(struct.value.id);
    } catch {
      /* 删不掉也没关系，先传新的 */
    }
  }

  const fd = new FormData();
  fd.append('file', svgToFile(padSvg || info.svg), '结构式.svg');
  fd.append('category', 'structure');
  await api.uploadCompoundFile(c.value.id, fd);
  await reload();

  // reload 会用服务端数据覆盖表单，所以这几格必须放在它后面填
  form.smiles = smiles;
  // 把画板这版的 molfile 一起存下来：下次打开画板拿它当底，Ketcher 直接照坐标摆，
  // 不会再按 SMILES 重排一次（用户报过「回来又重排了」）
  form.mol = mol || '';
  form.formula = info.formula;
  form.mw = String(info.mw);
  toast(`已用画板的结构：${info.formula} · MW ${info.mw}`);
  // 画板里已经查过就直接用，省一次网络来回
  if (sketchedInfo && sketchedInfo.found) {
    lastLookup.value = sketchedInfo;
    if (!String(form.name || '').trim() && sketchedInfo.name) form.name = sketchedInfo.name;
    if (!String(form.cas || '').trim() && sketchedInfo.cas && sketchedInfo.cas.length) form.cas = sketchedInfo.cas[0];
  } else {
    void fillFromLookup(smiles, { replaceCas: true });
  }
}

/**
 * 用刚解析出来的结构图换掉现在这张结构图。
 * **以前只在「还没有结构图」时才画**，于是已经有图（哪怕就是以前我们画的那张）的化合物
 * 粘了新的结构文本，画面上一动不动，看着就是「自动整理没生效」。
 * 规矩：现在这张是我们自己生成的 SVG（文件名 .svg）就直接换，没有信息量；
 * 是截图（PNG/JPG，多半是 ChemDraw 贴过来的）才问一句，别把手做的图悄悄删了。
 */
async function redrawStructure(info) {
  const old = struct.value;
  if (old) {
    const isSvg = /\.svg$/i.test(old.original_name || old.filename || '');
    if (!isSvg) {
      const ok = await confirm({
        title: '换掉现在这张结构图？',
        body: `现在这张是「${old.original_name || old.filename}」，会按新结构重画一张换上，旧的那张会删掉。`,
      });
      if (!ok) return false;
    }
    try {
      await api.deleteCompoundFile(old.id);
    } catch {
      /* 删不掉就先传新的，反正页面会显示最新那张 */
    }
  }
  const fd = new FormData();
  fd.append('file', svgToFile(info.svg), '结构式.svg');
  fd.append('category', 'structure');
  await api.uploadCompoundFile(c.value.id, fd);
  await reload();
  return true;
}

async function useSmiles(text, { quiet = false } = {}) {
  const isMol = looksLikeMolfile(text);
  const info = await analyzeStructureText(text);
  if (!info) {
    if (!quiet) toast('这段 SMILES 读不出来', 'err');
    return false;
  }
  // 换了结构：先还掉之前代填的（名称 / CAS / 熔点 / 性状），不然会跟新结构对不上
  clearAutoFilled();

  // 先处理结构图（reload 会用服务端数据覆盖表单，所以必须排在赋值前面）
  try {
    await redrawStructure(info);
  } catch (e) {
    toast(e.message || '结构图没画出来', 'err');
  }

  // 分子式 / MW 是从这个结构算出来的，粘什么就是什么——留着旧值只会跟图对不上。
  // MOL 那种不把整段文件塞进 SMILES 格，存解析出来的标准 SMILES。
  if (!isMol) form.smiles = String(text).trim();
  else if (info.smiles) form.smiles = info.smiles;
  // 粘的是 MOL（ChemDraw / 画板导出的）就把它原样留着当画板底稿，坐标跟着走；
  // 粘的是 SMILES 就没有坐标可用，清掉旧的，免得打开画板时翻出上一版的结构
  form.mol = isMol ? String(text).trim() : '';
  form.formula = info.formula;
  form.mw = String(info.mw);
  if (!quiet) toast(`已识别：${info.formula} · MW ${info.mw}`);
  if (String(form.smiles || '').trim()) void fillFromLookup(form.smiles, { replaceCas: true });
  return true;
}

/** 在 SMILES 格子里直接粘贴：把 SMILES 之后的其它文本也一并收下 */
/** SMILES 平时是不可编辑的一行（点一下复制），点「改」才展开成输入框 */
const smiEditing = ref(false);

function closeSmiEdit() {
  if (!smiEditing.value) return;
  smiEditing.value = false;
  void onSmilesFieldChange();
}

/** TlcOcr 读出来的东西：只往空着的格子填，已有的值不动 */
function applyOcr({ solvent, rf, auto, raw }) {
  let filled = [];
  if (solvent && !String(form.tlc_solvent || '').trim()) {
    form.tlc_solvent = solvent;
    filled.push(`展开剂 ${solvent}`);
  }
  if (rf && !String(form.tlc_rf || '').trim()) {
    form.tlc_rf = rf;
    filled.push(`Rf ${rf}`);
  }
  if (filled.length) toast(`从图上读到 ${filled.join(' · ')}`, 'ok');
  else if (!auto) {
    // 点了一行但两个格子都有值：至少把原文糊上去，别让人以为没反应
    if (solvent) form.tlc_solvent = solvent;
    if (rf) form.tlc_rf = rf;
    if (!solvent && !rf && raw) form.tlc_solvent = raw;
  }
}

async function copySmiles() {
  const text = String(form.smiles || '').trim();
  if (!text) return toast('这格还是空的', 'warn');
  try {
    await navigator.clipboard.writeText(text);
    toast('SMILES 已复制');
  } catch {
    toast('浏览器不让写剪贴板，手动选一下再复制', 'err');
  }
}

function onSmilesFieldPaste(ev) {
  const text = ev.clipboardData?.getData('text/plain') || '';
  if (!looksLikeSmiles(text) && !looksLikeMolfile(text)) return;
  ev.preventDefault();
  void useSmiles(text);
}

/** 手输完离开这个格子：改过了就按它重画结构图，没改就只补空着的分子式 / MW */
async function onSmilesFieldChange() {
  const v = String(form.smiles || '').trim();
  if (!looksLikeSmiles(v) && !looksLikeMolfile(v)) return;
  const changed = v !== String(c.value?.smiles || '').trim();
  if (!changed && String(form.formula || '').trim() && String(form.mw || '').trim() && struct.value) return;
  await useSmiles(v, { quiet: true });
}

/** Rf 只收数字（顺带把全角数字转成半角） */
function onRf(ev) {
  applyNumeric(ev.target, '');
  form.tlc_rf = ev.target.value;
}

async function reload() {
  // 下面要拿服务端数据整段覆盖表单，所以先把还没落盘的输入存掉（粘贴结构式/拖谱图会走到这里）
  if (dirty.value) await flush().catch(() => {});
  fill(await api.compound(c.value.id));
}

/** 换课题：原来挂的分类属于别的课题就一起清掉，不然保存时会被当悬空引用丢掉 */
function onProjectChange(v) {
  form.project = v || '';
  const cat = form.category_id;
  if (cat !== '' && cat != null && !categoriesOfProject('compound', form.project).some((g) => Number(g.id) === Number(cat))) {
    form.category_id = null;
  }
  // 换课题：先把新课题存下去（自动保存有 700ms 防抖，早了会读到旧数据），再刷课题计数和中栏列表
  void refreshSpace();
}

/**
 * 课题变了要刷三样：课题下拉里的计数（bootstrap）、中栏列表（这条已经不属于原来那个课题，会被筛掉）、
 * 以及分类清单。**必须先 `flush()` 落库**——不落库就去拉，拿回来的还是旧归属（踩过，表现就是「得刷新页面才变」）。
 */
async function refreshSpace() {
  try {
    await flush();
  } catch {
    /* 存失败的话保存状态栏会提示，这里继续把界面刷成实际状态 */
  }
  try {
    await loadBoot();
    await loadCompounds();
  } catch {
    /* 刷新失败不影响正在编辑的这条 */
  }
}

function openFile(f) {
  preview.value = { src: `/api/compound-files/${f.id}`, name: f.original_name || f.filename || '文件' };
}

function pickFile(category) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async () => {
    const list = Array.from(input.files || []);
    if (!list.length) return;
    const fd = new FormData();
    for (const f of list) fd.append('file', f, f.name);
    fd.append('category', category || 'auto');
    try {
      await api.uploadCompoundFile(c.value.id, fd);
      await reload();
      toast(list.length > 1 ? `已添加 ${list.length} 个文件` : '已添加 1 个文件');
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  input.click();
}

async function onPaste(ev) {
  if (route.name !== 'compound' || !c.value) return;
  const items = Array.from(ev.clipboardData?.items || []).filter((i) => i.kind === 'file' && String(i.type).startsWith('image/'));

  // 剪贴板里如果有结构文本（SMILES / MOL）就先按它算，图片照旧存下来。
  // 除了 text/plain，也看看 text/html（有的软件会把 molfile / SMILES 塞在 HTML 里）
  const data = ev.clipboardData;
  const candidates = [data?.getData('text/plain') || '', stripHtml(data?.getData('text/html') || '')];
  for (const text of candidates) {
    if (looksLikeSmiles(text) || looksLikeMolfile(text)) {
      ev.preventDefault();
      await useSmiles(text);
      return;
    }
  }

  if (!items.length) return;
  ev.preventDefault();
  const filesOut = items.map((it, i) => {
    const f = it.getAsFile();
    return f ? new File([f], `粘贴-${Date.now()}-${i + 1}.png`, { type: f.type }) : null;
  }).filter(Boolean);
  const fd = new FormData();
  for (const f of filesOut) fd.append('file', f, f.name);
  fd.append('category', hovered.value || (struct.value ? 'photo' : 'structure'));
  await api.uploadCompoundFile(c.value.id, fd);
  await reload();

  if (!String(form.formula || '').trim() || !String(form.mw || '').trim()) {
    const kinds = Array.from(data?.types || []);
    const onlyImage = kinds.length > 0 && kinds.every((t) => t.startsWith('image/'));
    toast(
      onlyImage
        ? '这张图里只有像素，读不出结构。要用 ChemDraw 的 Edit → Copy As → SMILES（或 MOL）再粘一次'
        : `剪贴板格式：${kinds.join(' / ') || '未知'} —— 没有可解析的结构文本`,
      'warn',
      5600
    );
  }
}

/** text/html 里取纯文本（有的程序把结构文本包在 HTML 里） */
function stripHtml(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
}

async function uploadTo(cat2, list) {
  const fd = new FormData();
  for (const f of list) fd.append('file', f, f.name);
  fd.append('category', cat2);
  try {
    await api.uploadCompoundFile(c.value.id, fd);
    await reload();
    toast(list.length > 1 ? `已添加 ${list.length} 个文件` : '已添加 1 个文件');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function dropTo(category, e) {
  const list = Array.from(e.dataTransfer?.files || []);
  if (list.length) await uploadTo(category, list);
}

function onDrop(e) {
  const list = Array.from(e.dataTransfer?.files || []);
  if (list.length) void uploadTo(cat.value === 'auto' ? guessCmpCategory(list[0].name) : cat.value, list);
}

async function importPath() {
  const p = pathValue.value.trim();
  pathModal.value = false;
  if (!p) return;
  try {
    await api.uploadCompoundPath(c.value.id, { path: p, category: cat.value === 'auto' ? 'nmr_raw' : cat.value });
    pathValue.value = '';
    await reload();
    toast('已从路径导入');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function setCategory(f, category) {
  await api.updateCompoundFile(f.id, { category });
  recat.value = null;
  await reload();
  toast(`已归到「${CMP_CAT_LABEL[category] || category}」`);
}

async function removeFile(f) {
  try {
    await api.deleteCompoundFile(f.id);
    await reload();
    toast('已删除这个文件');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function openStandardPicker() {
  stdList.value = await api.experiments({ sort: 'newest' });
  stdPick.value = c.value.standard_exp_id || stdList.value[0]?.id || null;
  stdModal.value = true;
}

async function applyStandard() {
  stdModal.value = false;
  if (!stdPick.value) return;
  await api.saveCompound(c.value.id, { standard_exp_id: stdPick.value });
  await reload();
  toast('已设为标准实验');
}

async function clearStandard() {
  await api.saveCompound(c.value.id, { standard_exp_id: null });
  await reload();
  toast('已解除关联');
}

async function newCategory() {
  const name = await prompt({ title: '新建分类', placeholder: '比如：手性配体库、中间体', confirmText: '建' });
  if (!name) return;
  try {
    await addCategory(name, 'compound');
    toast(`建好了「${name}」，在分类里选它`);
  } catch (e) {
    toast(e.message || '建不了这个分类', 'err');
  }
}

async function removeCompound() {
  // 删之前先看谁在引用它：像删文件那样，把「哪些实验在用」摆出来再决定
  const refs = used.value.map((e) => `${e.code || `#${e.id}`}${e.roles?.length ? `（${e.roles.join('+')}）` : ''}`);
  const fileCount = files.value.length;
  const head = fileCount ? `该档案及其名下 ${fileCount} 个文件将一并移入回收站（文件仍保留在磁盘上）。` : '';
  const body = refs.length
    ? `${head}另有 ${refs.length} 条实验引用该化合物：${refs.join('、')}。移入回收站后这些记录中的关联将解除（结构式与分子量一并清除），实验记录本身不变。`
    : `${head}目前没有实验引用该化合物。如需彻底清除，请到「设置 → 回收站」中再删除一次。`;
  const ok = await confirm({
    title: `将化合物 ${c.value.code || c.value.name || ''} 移入回收站？`,
    body,
    confirmText: '移入回收站',
    danger: true,
  });
  if (!ok) return;
  await api.deleteCompound(c.value.id);
  await loadBoot();
  router.push('/compounds');
  toast(refs.length ? `已移入回收站，${refs.length} 条实验的关联已解除` : '已移入回收站');
}

const groups = computed(() => {
  const map = new Map();
  for (const f of files.value) {
    const k = CMP_CAT_ORDER.includes(f.category) ? f.category : 'other';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(f);
  }
  return CMP_CAT_ORDER.filter((k) => map.has(k)).map((k) => ({ key: k, label: CMP_CAT_LABEL[k], list: map.get(k) }));
});

const label = () => printCompoundLabel(c.value, { owner: store.boot?.settings?.owner_name });
</script>

<template>
  <CompoundMobile v-if="isPhone" :id="compoundId" />

  <div v-else class="panes">
    <CmpListPane />
    <div v-if="error" class="editor"><div class="empty-note" style="padding: 80px">{{ error }}</div></div>
    <div v-else-if="!c" class="editor"><div class="empty-note" style="padding: 80px">读取中…</div></div>

    <div v-else ref="editorEl" class="editor">
    <div class="editor-bar">
      <span class="mono" style="font-size: 10.5px; color: var(--ink-4); letter-spacing: 0.08em">化合物</span>
      <CatPick
        class="toolbar-cat"
        :value="form.category_id == null || form.category_id === '' ? '' : String(form.category_id)"
        :categories="categoriesOfProject('compound', form.project)"
        count-key="cmp_count"
        :show-all="false"
        @change="(v) => { form.category_id = v ? Number(v) : null; }"
        @create="newCategory"
      />
      <span class="spacer" />
      <span class="save-state" :class="{ 'is-dirty': dirty }">{{ saveState }}</span>
      <button class="btn btn-sm" title="立刻保存一次" @click="saveNow">保存</button>
      <button class="btn btn-sm btn-ghost" title="放弃本次修改，恢复到打开时的内容" @click="resetForm">重置</button>
      <div class="menu-wrap">
        <button class="btn btn-sm btn-ghost" title="更多" @click.stop="moreMenu = !moreMenu">
          <Icon name="dots" :size="15" />
        </button>
        <div v-if="moreMenu" class="menu">
          <button @click="label(); moreMenu = false"><Icon name="qr" :size="13" /> 打印瓶子标签</button>
          <button @click="historyOpen = true; moreMenu = false"><Icon name="file" :size="13" /> 修改历史</button>
          <button @click="lookupNow(); moreMenu = false"><Icon name="molecule" :size="13" /> 查这个结构（PubChem）</button>
          <div class="menu-sep" />
          <button class="menu-danger" @click="removeCompound(); moreMenu = false">
            <Icon name="trash" :size="13" /> 移入回收站
          </button>
        </div>
      </div>
    </div>

    <div class="editor-inner">
      <article class="sheet cmp-sheet">
        <div class="sheet-runner"><span>化合物档案</span><span>{{ c.code }}</span></div>

        <div class="cmp-top">
          <!-- 左栏：结构缩略图 + 「画结构式」和两个查询链接（贴在缩略图下面，别飘到整块字段底下） -->
          <div class="cmp-left">
          <div
            class="cmp-structure"
            title="点击选择文件，也可直接 ⌘V 粘贴截图"
            @mouseenter="hovered = 'structure'"
            @mouseleave="hovered = ''"
            @click="pickFile('structure')"
          >
            <img v-if="struct" :src="`/api/compound-files/${struct.id}`" alt="结构式" />
            <div v-else class="cmp-structure-empty">
              <Icon name="image" :size="20" />
              <span>结构式</span>
              <span class="hint">粘贴 / 选择</span>
            </div>
          </div>

          <!-- 懒得起 ChemDraw 时，直接在这儿画一个 -->
          <div class="cmp-structure-tools noprint">
            <button class="btn btn-sm btn-ghost" title="打开画板画结构式" @click.stop="sketcherOpen = true">
              <Icon name="molecule" :size="13" /> 画结构式
            </button>
            <!-- 外部查资料：PubChem（名称 / CAS / 性质 / 谱图）、ChemicalBook（中文资料 / 供应商）、TCI（试剂规格 / MSDS / 价格） -->
            <span class="cmp-lookup-links noprint">
              <span class="cmp-lookup-cap">外部查询</span>
              <a
                v-for="s in lookupLinks"
                :key="s.key"
                class="cmp-lookup-link"
                :href="s.href"
                target="_blank"
                rel="noreferrer"
                :title="s.title"
              >{{ s.label }} ↗</a>
            </span>
          </div>
          </div>

          <div class="cmp-fields">
            <label class="c-field"><span>编号</span><input class="mono" v-model="form.code" placeholder="1a" /></label>
            <label class="c-field wide"><span>名称</span><input v-model="form.name" placeholder="4-甲基苯甲醛" /></label>
            <label class="c-field">
              <span>类型</span>
              <KindPick v-model="form.kind" />
            </label>
            <label class="c-field">
              <span>课题</span>
              <ProjPick :model-value="form.project" :projects="projectList" count-key="cmp" @update:model-value="onProjectChange" />
            </label>
            <label class="c-field"><span>分子式</span><input v-model="form.formula" placeholder="C8H8O" /></label>
            <label class="c-field"><span>MW</span><input class="n" type="number" step="any" v-model="form.mw" placeholder="120.15" /></label>
            <label class="c-field"><span>CAS</span><input class="mono" v-model="form.cas" placeholder="50-78-2" title="结构式查出来的，也能手填；后面的 ChemicalBook 链接按它去搜" /></label>
            <label class="c-field"><span>熔点</span><input v-model="form.mp" placeholder="−26 ℃" /></label>
            <!-- 性状给两格宽（一行最多一句「白色粉末 / 无色液体」），太长就靠 hover 看全 -->
            <label class="c-field half">
              <span>性状</span>
              <input v-model="form.appearance" :title="form.appearance" placeholder="无色液体" />
            </label>
            <label class="c-field full"><span>HRMS</span><input v-model="form.hrms" placeholder="calcd for C8H9O [M+H]+ 121.0648, found 121.0651" /></label>
            <label class="c-field full"><span>IR</span><input v-model="form.ir" placeholder="ν/cm⁻¹ 2928, 1712, 1612" /></label>
            <label class="c-field full"><span>旋光</span><input v-model="form.rotation" placeholder="[α]D²⁰ = +12.4 (c 1.0, CHCl₃)" /></label>
            <!-- SMILES 常常上百个字符：平时就一行「点一下复制」，想手动敲再点「改」展开 -->
            <label class="c-field full smi-field">
              <span class="c-field-head">
                SMILES
                <button type="button" class="mini-copy noprint" title="复制整条 SMILES" @click.prevent.stop="copySmiles">复制</button>
                <button
                  type="button"
                  class="mini-copy noprint"
                  :title="smiEditing ? '收起输入框' : '手动改 / 粘贴'"
                  @click.prevent.stop="smiEditing = !smiEditing"
                >{{ smiEditing ? '收起' : '改' }}</button>
              </span>
              <textarea
                v-if="smiEditing"
                class="mono smi-text"
                rows="2"
                v-autogrow
                v-model="form.smiles"
                placeholder="粘贴 SMILES / MOL，或手敲"
                @paste="onSmilesFieldPaste"
                @blur="closeSmiEdit"
                @keydown.meta.enter="closeSmiEdit"
                @keydown.ctrl.enter="closeSmiEdit"
              />
              <div
                v-else
                class="smi-line mono"
                :class="{ 'is-empty': !String(form.smiles || '').trim() }"
                :title="form.smiles ? '点一下复制整条 SMILES' : '还没有结构'"
                @click="copySmiles"
              >{{ String(form.smiles || '').trim() || '还没有结构 —— 直接 ⌘V 粘贴 SMILES / MOL，或点左边「画结构式」' }}</div>
            </label>
          </div>
        </div>
        <div v-if="lookupProps" class="cmp-props noprint">{{ lookupProps }}</div>

        <section class="sec sec-tight">
          <div class="block-head"><span class="lbl">核磁</span><span class="spacer" /><span class="hint noprint">可拖入或 ⌘V 粘贴谱图截图</span></div>
          <div class="nmr-grid">
            <div v-for="n in NMR_DEFS" :key="n.key" class="nmr-col">
              <span class="nmr-tag">{{ n.label }}</span>
              <div
                class="nmr-strip"
                @mouseenter="hovered = n.key"
                @mouseleave="hovered = ''"
                @dragover.prevent
                @drop.prevent="dropTo(n.key, $event)"
              >
                <figure v-for="f in spectra(n.key)" :key="f.id" class="spec-shot">
                  <img :src="`/api/compound-files/${f.id}`" alt="" title="看大图" @click="openFile(f)" />
                  <button class="tlc-x" title="删除" @click.stop="removeFile(f)"><Icon name="x" :size="11" /></button>
                </figure>
                <div
                  v-if="!spectra(n.key).length"
                  class="spec-empty"
                  :title="`粘贴 / 选择 ${n.label} 谱图`"
                  @click="pickFile(n.key)"
                >
                  <span class="plus">+</span>
                  <span class="cap">谱图</span>
                </div>
                <button v-else type="button" class="spec-add" @click="pickFile(n.key)">+ 再加一张</button>
              </div>
            </div>
          </div>
        </section>

        <section class="sec sec-tight">
          <div class="block-head">
            <span class="lbl">TLC</span>
            <input class="tlc-note" v-model="form.tlc_solvent" placeholder="展开剂，如 PE:EA = 10:1" />
            <span class="rf-wrap">Rf <input class="rf-input" :value="form.tlc_rf" placeholder="0.45" @input="onRf($event)" /></span>
            <TlcOcr :shots="tlcShots" scope="compound" @pick="applyOcr" />
          </div>
          <div
            class="tlc-strip"
            @mouseenter="hovered = 'tlc'"
            @mouseleave="hovered = ''"
            @dragover.prevent
            @drop.prevent="dropTo('tlc', $event)"
          >
            <figure v-for="s in tlcShots" :key="s.id" class="tlc-shot">
              <img :src="`/api/compound-files/${s.id}`" alt="" title="看大图" @click="openFile(s)" />
              <button class="tlc-x" title="删除" @click.stop="removeFile(s)"><Icon name="x" :size="11" /></button>
            </figure>
            <div class="tlc-empty" title="粘贴 / 选择 TLC 板照片" @click="pickFile('tlc')">
              <span class="plus">+</span>
              <span class="cap">粘贴 / 选择</span>
            </div>
          </div>
        </section>

        <section class="sec">
          <h2 class="sec-title">合成与纯化</h2>
          <textarea class="sheet-text" rows="3" v-autogrow v-model="form.procedure" placeholder="合成步骤、后处理、柱层析配比、重结晶溶剂" />
        </section>

        <section class="sec">
          <h2 class="sec-title">说明</h2>
          <textarea class="sheet-text" rows="2" v-autogrow v-model="form.notes" placeholder="储存条件、危险性、别名" />
        </section>

        <section class="sec sec-att">
          <h2 class="sec-title">文件<span class="hint">{{ files.length }} 个</span></h2>
          <div class="att-tools noprint">
            <select v-model="cat" class="select">
              <option value="auto">自动识别（按文件名）</option>
              <option v-for="k in CMP_CAT_ORDER" :key="k" :value="k">{{ CMP_CAT_LABEL[k] }}</option>
            </select>
            <button class="btn btn-sm" @click="pickFile(cat === 'auto' ? 'auto' : cat)"><Icon name="upload" :size="13" /> 选择文件</button>
            <button class="btn btn-sm" @click="pathModal = true"><Icon name="folder" :size="13" /> 从路径导入</button>
          </div>
          <div class="dropzone noprint" @click="pickFile(cat === 'auto' ? 'auto' : cat)" @dragover.prevent @drop.prevent="onDrop">
            <div class="big">拖文件到这里，或者直接 ⌘V 粘贴</div>
          </div>
          <div>
            <div v-for="g in groups" :key="g.key" class="att-group">
              <div class="att-group-head"><span class="t">{{ g.label }}</span><span class="rule" /><span class="t">{{ g.list.length }}</span></div>
              <div class="att-list">
                <div v-for="f in g.list" :key="f.id" class="att-item">
                  <img v-if="isImageName(f.original_name || f.filename)" class="att-thumb" :src="`/api/compound-files/${f.id}`" alt="" loading="lazy" />
                  <div v-else class="att-ico"><Icon :name="f.is_dir ? 'folder' : 'file'" :size="14" /></div>
                  <span class="att-name" title="打开 / 预览" @click="openFile(f)">{{ f.original_name || f.filename }}</span>
                  <span class="att-sub">{{ f.is_dir ? '文件夹' : fmtSize(f.size) }}</span>
                  <button class="att-del" title="改分类" @click="recat = f"><Icon name="dots" :size="12" /></button>
                  <button class="att-del" title="删除" @click="removeFile(f)"><Icon name="trash" :size="13" /></button>
                </div>
              </div>
            </div>
            <div v-if="!files.length" class="hint noprint" style="padding: 8px 0">暂无文件。谱图、原始数据与 TLC 照片均可置于此处。</div>
          </div>
        </section>

        <section class="sec sec-tight">
          <div class="block-head"><span class="lbl">标准实验</span></div>
          <div class="linked">
            <template v-if="std">
              <span class="linkish" @click="router.push(`/e/${std.id}`)">{{ std.code }}</span>
              <span class="hint">{{ std.title || '（未命名实验）' }}{{ std.date ? ` · ${std.date}` : '' }}</span>
              <button class="btn btn-sm" @click="openStandardPicker">换</button>
              <button class="mini" title="解除关联" @click="clearStandard"><Icon name="x" :size="10" /></button>
            </template>
            <template v-else>
              <span class="hint">未指定；可关联当初合成该化合物的实验记录</span>
              <button class="btn btn-sm" @click="openStandardPicker"><Icon name="file" :size="13" /> 选一条实验</button>
            </template>
          </div>
          <div class="block-head" style="margin-top: 18px"><span class="lbl">用在哪些实验</span></div>
          <div class="linked">
            <span v-for="e in used" :key="e.id" class="linkish" @click="router.push(`/e/${e.id}`)">
              {{ e.code }}{{ e.roles?.length ? ` · ${e.roles.join(' / ')}` : '' }}{{ Number(e.id) === Number(c.standard_exp_id) ? ' · 标准' : '' }}
            </span>
            <span v-if="!used.length" class="hint">尚未在任何实验中使用</span>
          </div>
        </section>
      </article>
    </div>

    <HistoryModal v-if="historyOpen" entity="compound" :id="c.id" @close="historyOpen = false" />

    <AppModal v-if="stdModal" title="把哪条实验设成标准实验" confirm-text="设为标准实验" @close="stdModal = false" @confirm="applyStandard">
      <div class="recipe-list">
        <button
          v-for="it in stdList"
          :key="it.id"
          type="button"
          class="recipe-opt"
          :class="{ 'is-on': stdPick === it.id }"
          @click="stdPick = it.id"
        >
          <span class="recipe-code mono">{{ it.code }}</span>
          <span class="recipe-title">{{ it.title || '（未命名实验）' }}</span>
          <span class="recipe-meta">{{ it.date }}</span>
        </button>
      </div>
    </AppModal>

    <AppModal v-if="recat" title="这个文件算什么" :show-confirm="false" @close="recat = null">
      <div class="cat-picker">
        <button
          v-for="k in CMP_CAT_ORDER"
          :key="k"
          class="cat-opt"
          :aria-selected="k === recat.category ? 'true' : 'false'"
          @click="setCategory(recat, k)"
        >
          {{ CMP_CAT_LABEL[k] }}
        </button>
      </div>
    </AppModal>

    <AppModal v-if="pathModal" title="从路径导入" confirm-text="导入" @close="pathModal = false" @confirm="importPath">
      粘贴本机绝对路径（文件或文件夹）。Bruker 原始数据一般是 <span class="mono">…/样品/10</span> 这种目录。
      <input v-model="pathValue" class="input" placeholder="/Users/you/NMR/…/10" style="font-family: var(--mono); font-size: 12px; margin-top: 10px" />
    </AppModal>

    <FilePreview v-if="preview" :src="preview.src" :name="preview.name" @close="preview = null" />

    <!-- 常挂着、只切 open：Ketcher 那个包 29 MB，销毁了每次都要重下一遍 -->
    <SketcherModal
      :open="sketcherOpen"
      :initial="form.mol || form.smiles || ''"
      @close="sketcherOpen = false"
      @pick="applySketched"
    />

    </div>
  </div>
</template>
