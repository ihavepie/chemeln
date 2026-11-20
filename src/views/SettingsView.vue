<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import AppModal from '../components/AppModal.vue';
import { api } from '../api.js';
import { peekPrefs, setPeekPref, PEEK_LABELS } from '../lib/peek.js';
import {
  sheetPrefs,
  setSheetPref,
  setSheetFx,
  showAllSheetBlocks,
  sheetTlcMax,
  setTlcMax,
  TLC_N_OPTS,
  TLC_N_LABEL,
  sheetSchemeFmt,
  setSchemeFmt,
  SCHEME_FMT_OPTS,
  useSheetBlocks,
  currentSheetKind,
  sheetFx,
  SHEET_BLOCKS,
  SHEET_FX,
  SHEET_KINDS,
} from '../lib/sheetprefs.js';
import { amountDecimals, setAmountDecimals, setVolumeDecimals, volumeDecimals } from '../lib/reagent.js';
import { onUiMerged, uiGet, uiSetIfChanged } from '../lib/uiprefs.js';
import { CARD_STYLES, CARD_RADII, cardPref, setCardStyle, resetCardStyle } from '../lib/cardstyle.js';
import { resetTours } from '../lib/tours.js';
import { loadBoot, setProject, settings, store, allCategories, addCategory, quickFull, quickList } from '../store.js';
import { confirm, prompt, toast } from '../lib/feedback.js';

const saving = ref(false);

const form = reactive({ lab_heading: '', code_prefix: 'EXP', owner_name: '', group_name: '', label_base_url: '', lan_access: false });

/** 全局那套：课题里编辑时当占位符，让人看得见「留空会用成什么」 */
const globalSettings = computed(() => store.boot?.settingsGlobal || {});
const ph = computed(() => ({
  lab_heading: globalSettings.value.lab_heading || '方法学实验记录',
  code_prefix: globalSettings.value.code_prefix || 'EXP',
  owner_name: globalSettings.value.owner_name || '记录人姓名',
  group_name: globalSettings.value.group_name || '导师 / 组名',
  label_base_url: globalSettings.value.label_base_url || store.boot?.lanUrl || '',
}));

/** fill() 之后表单长什么样：用来判断现在有没有还没点「保存」的改动 */
let filledSig = '';

/**
 * 在某个课题里就编辑这个课题自己的覆盖值（空 = 跟着全局），
 * 「全部课题」时编辑的就是全局那份。
 */
function fill() {
  const g = settings();
  const ov = store.boot?.projectOverrides || {};
  if (store.project) {
    // 课题里「标题」就是课题名：改它等于改名
    form.lab_heading = store.project;
    form.code_prefix = ov.code_prefix || '';
    form.owner_name = ov.owner_name || '';
    form.group_name = ov.group_name || '';
    form.label_base_url = ov.label_base_url || '';
    form.lan_access = !!store.boot?.lanAccess;
  } else {
    form.lab_heading = g.lab_heading || '';
    form.code_prefix = g.code_prefix || 'EXP';
    form.owner_name = g.owner_name || '';
    form.group_name = g.group_name || '';
    form.label_base_url = g.label_base_url || '';
    form.lan_access = !!store.boot?.lanAccess;
  }
  filledSig = JSON.stringify(form);
}

/** 01 卡有没有没保存的改动 */
const formDirty = () => JSON.stringify(form) !== filledSig;

onMounted(async () => {
  if (!store.boot) await loadBoot();
  fill();
  await loadAllCats();
});

/* ---- 课题与分类：一颗树 ---- */

/** 全部分类（不按当前课题筛）：设置页要看「所有课题下各有什么分类」 */
const allCats = ref([]);

async function loadAllCats() {
  try {
    allCats.value = await api.categories();
  } catch {
    allCats.value = [];
  }
}

/** 改完分类 / 课题：boot（当前课题视角）和全量清单一起刷 */
async function refresh() {
  await loadBoot();
  await loadAllCats();
}

/**
 * 「共用课题」+ 每个课题挂在下面的分类（课题清单里没有的残留也列出来，别让它们消失）。
 * 共用课题就是 project = '' 这个课题：在「全部课题」下新建的记录和分类都落在这里。
 */
const catTree = computed(() => {
  const all = allCats.value;
  const shared = all.filter((g) => !g.project);
  const known = new Set((store.boot?.projects || []).map((x) => x.name));
  const groups = (store.boot?.projects || []).map((x) => ({
    key: x.name,
    name: x.name,
    info: x,
    items: all.filter((g) => g.project === x.name),
  }));
  const orphanNames = [...new Set(all.filter((g) => g.project && !known.has(g.project)).map((g) => g.project))];
  const orphans = orphanNames.map((name) => ({
    key: name,
    name,
    info: { name, n: 0, prefix: '' },
    items: all.filter((g) => g.project === name),
  }));
  return { shared, groups: [...groups, ...orphans] };
});

/** 共用课题的记录数：跟别的课题组一样在组头显示「条 / 个」 */
const sharedCounts = computed(() => store.boot?.sharedCounts || { exp: 0, cmp: 0 });

/**
 * 「未分类」是固定桶（category_id = NULL），不是真的分类：
 * 树里给它占一行、显示条数，但不能改名 / 删除 / 拖动。
 */
const uncatLabel = (e, c) => [e ? `${e} 条` : '', c ? `${c} 个` : ''].filter(Boolean).join(' · ');

const isCurrentProject = (name) => store.project === name;

/**
 * 新建分类落到哪个课题下：null = 跟着侧栏当前课题；
 * 点某个课题组的标题就把它设成目标（'' = 共用课题）。
 */
const catTarget = ref(null);
const targetProject = computed(() => (catTarget.value === null ? store.project : catTarget.value));
const targetLabel = computed(() => (targetProject.value ? `「${targetProject.value}」` : '共用课题'));
const isTarget = (name) => targetProject.value === name;
const catCount = (g) => (g.scope === 'compound' ? `${g.cmp_count || 0} 个` : `${g.exp_count || 0} 条`);



// 侧栏切了课题（或 boot 重新拉过），这块要跟着换成那个课题的值。
// 但 03 卡的新建分类 / 改名 / 删课题都会触发 loadBoot（boot 换新对象），
// 这时候如果 01 卡有没保存的输入，重填会把它悄悄冲掉 —— 换课题才重填，其余情况有改动就不动。
watch([() => store.project, () => store.boot], ([newProject], [oldProject]) => {
  if (newProject !== oldProject || !formDirty()) fill();
});

async function save() {
  saving.value = true;
  try {
    const res = await api.saveSettings({
      project: store.project,
      lab_heading: form.lab_heading,
      // 全局那份前缀不能空（要有个默认值）；课题里空着就是没覆盖
      code_prefix: store.project ? form.code_prefix.trim() : form.code_prefix.trim() || 'EXP',
      owner_name: form.owner_name,
      group_name: form.group_name,
      label_base_url: form.label_base_url.trim(),
      lan_access: !!form.lan_access,
    });
    if (res?.renamedTo) {
      // 标题改了 = 课题改名，前端当前课题跟着切过去
      await setProject(res.renamedTo);
      toast(`标题改了，课题名也一起改成「${res.renamedTo}」`);
    } else {
      await loadBoot();
      toast(store.project ? `「${store.project}」的信息已保存` : '设置已保存');
    }
    fill();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    saving.value = false;
  }
}

const openLink = (url) => window.open(url, '_blank');
/** 在某个课题里就只导这个课题 */
const exportLink = computed(
  () => `/api/export/notebook.md${store.project ? `?project=${encodeURIComponent(store.project)}` : ''}`
);

/* ---- 分类管理 ---- */

async function newCategory(scope) {
  const where = `（${targetLabel.value}）`;
  const name = await prompt({
    title: `${scope === 'compound' ? '新建化合物分类' : '新建实验分类'}${where}`,
    placeholder: scope === 'compound' ? '比如：手性配体库、中间体' : '比如：方法学 A、条件筛选',
    confirmText: '新建',
  });
  if (!name) return;
  try {
    await addCategory(name, scope, targetProject.value);
    await loadAllCats();
    toast(`已新建分类，归到${targetLabel.value}`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function renameCategory(g) {
  const name = await prompt({ title: '重命名', value: g.name, confirmText: '确定' });
  if (!name || name === g.name) return;
  try {
    await api.saveCategory(g.id, { name });
    await refresh();
    toast('已重命名');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 正在拖的那个分类（拖到别的课题组标题上就移过去） */
const dragCat = ref(null);
/** 鼠标此刻悬在哪个组头上（'共用' 用空串表示）——落点高亮靠它 */
const dropTarget = ref(null);

const sameProject = (g, project) => (g?.project || '') === (project || '');

function onCatDragStart(ev, g) {
  dragCat.value = g;
  dropTarget.value = null;
  document.body.classList.add('cat-dragging');
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(g.id));
  // 默认的拖动影像太淡，给一格更明显的描边（浏览器会把它当缩略图）
  const row = ev.currentTarget.closest('.cat-item');
  if (row) ev.dataTransfer.setDragImage(row, 24, 12);
}

function onCatDragEnd() {
  dragCat.value = null;
  dropTarget.value = null;
  document.body.classList.remove('cat-dragging');
}

/** 拖着分类时，组头要么是落点（描强调色 + 淡底），要么是它现在待的那个（灰掉、不放） */
function onHeadDragOver(name) {
  if (!dragCat.value) return;
  dropTarget.value = sameProject(dragCat.value, name) ? null : name;
}

function onHeadDragLeave(ev, name) {
  if (ev.currentTarget.contains(ev.relatedTarget)) return;
  if (dropTarget.value === name) dropTarget.value = null;
}

/** 拖到某个课题组标题上：把分类（连同里面的记录）移过去 */
async function onCatDrop(project) {
  const g = dragCat.value;
  onCatDragEnd();
  if (!g || (g.project || '') === (project || '')) return;
  await moveCategoryTo(g, project);
}

/** 分类的归属：改到共用或某个课题；换课题时分类里的记录一起搬 */
async function moveCategoryTo(g, nextProject) {
  if (nextProject === (g.project || '')) return;
  const n = (g.exp_count || 0) + (g.cmp_count || 0);
  const target = nextProject || '共用';
  if (nextProject && n) {
    const from = String(g.exp_projects || '')
      .split(',')
      .filter(Boolean);
    const spread = from.length > 1 ? `注意：这些记录目前分属 ${from.length} 个课题（${from.join('、')}）。` : '';
    const ok = await confirm({
      title: `将分类「${g.name}」移到「${target}」？`,
      body: `该分类下的 ${n} 条记录（实验 ${g.exp_count || 0} 条、化合物 ${g.cmp_count || 0} 个）将一并移到「${target}」，在原课题中不再出现。${spread}`,
      confirmText: '一并移入',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const r = await api.saveCategory(g.id, { project: nextProject });
    await refresh();
    const moved = r?.moved;
    toast(
      moved && (moved.experiments || moved.compounds)
        ? `已移到「${target}」，连同 ${moved.experiments} 条实验、${moved.compounds} 个化合物`
        : `已移到「${target}」`
    );
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function removeCategory(g) {
  const n = g.scope === 'compound' ? g.cmp_count || 0 : g.exp_count || 0;
  const unit = g.scope === 'compound' ? '个化合物' : '条实验';
  const ok = await confirm({
    title: `删除分类「${g.name}」？`,
    body: n
      ? `里面有 ${n} ${unit}。删掉分类只是把它们变回「未分类」，记录本身不会动。`
      : '该分类下暂无记录，可直接删除。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteCategory(g.id);
    await refresh();
    toast('已删除分类');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---- 课题 ---- */

const projects = computed(() => store.boot?.projects || []);

/** 「用量」小数位（跟投料表工具行那颗按钮同一个设置） */
const DECIMAL_OPTS = [
  { v: 0, t: '自适应' },
  { v: 2, t: '2 位' },
  { v: 3, t: '3 位' },
  { v: 4, t: '4 位' },
];
function pickDecimals(which, v) {
  if (which === 'vol') {
    setVolumeDecimals(v);
    uiSetIfChanged('reagentPrecVol', v);
    return;
  }
  setAmountDecimals(v);
  uiSetIfChanged('reagentPrec', v);
}

/* ---- 试剂库外部库链接：常显 / 悬停才出现 ---- */
const rlLinks = ref(uiGet('reagentLinks', 'always'));
function setRlLinks(v) {
  rlLinks.value = v;
  uiSetIfChanged('reagentLinks', v);
}

/* ---- 卡片质感（页面里的白卡 / 排版板那张画布卡）---- */
const card = ref(cardPref());
function pickCardStyle(key) {
  card.value = setCardStyle({ style: key });
}
function pickCardRadius(value) {
  card.value = setCardStyle({ radius: value });
}
function cardReset() {
  card.value = resetCardStyle();
}
/** 教程：清掉「已看过」的标记，下次进每一页都会再自动放一遍 */
function resetTour() {
  resetTours();
  toast('已重置：下次进任意一页都会再放一遍教程', 'ok');
}

/* ---- 排版板：图注要不要跟着图缩放 ----
   `fixed` = 只跟着走、不跟着缩（缩图的时候字还是那个字号，缩到看不清的问题就没了）；
   `scale` = 跟 Excalidraw 原生一样，整组一起放大缩小。 */
const boardCap = ref(uiGet('boardCap', 'fixed'));
function setBoardCap(v) {
  boardCap.value = v;
  uiSetIfChanged('boardCap', v);
}

/* ---- 二级侧边栏：把设置分成 5 块，一块一块看（用户：「设置这边开始有点复杂了」）----
   编号沿用卡片上那 01–07（模块顺序就按编号排），当前停在哪一块记在 `uiprefs` 的 `setMod`，
   下次进来还是那一块。 */
const SET_MODS = [
  { key: 'book', n: '01', label: '记录本', desc: '记录本信息：标题、编号前缀、记录人、局域网访问、瓶签二维码地址。' },
  { key: 'data', n: '02', label: '数据与备份', desc: '数据目录、备份与还原（整个 data/ 拷走就是完整备份）。' },
  { key: 'cats', n: '03', label: '课题与分类', desc: '课题清单与分类树：改名、编号前缀、删除、拖动排序。' },
  { key: 'ui', n: '04', label: '界面', desc: '快捷键与书签悬停预览（这些是这台机器上的界面偏好）。' },
  { key: 'page', n: '05', label: '记录页', desc: 'A4 上显示哪几块、块里的功能、反应式排版与常用选项。' },
];
/** 构建时间（服务端按 public/index.html 的 mtime 给）：页面没刷新时这里还是旧的 */
const buildAt = computed(() => {
  const t = String((store.boot && store.boot.buildAt) || '');
  const d = t ? new Date(t) : null;
  if (!d || Number.isNaN(d.getTime())) return '未知';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
});

const mod = ref(uiGet('setMod', 'book'));
/** 哪些模块是展开的（存 `uiprefs` 的 `setOpen`，跟 `setMod` 一样换浏览器/重开都还在）。
    没存过 = 只展开当前那块。 */
function readOpen() {
  const v = uiGet('setOpen', null);
  if (!Array.isArray(v)) return [String(uiGet('setMod', 'book') || 'book')];
  return v.filter((k) => SET_MODS.some((m) => m.key === k));
}
const openMods = ref(readOpen());
function isOpen(key) {
  return openMods.value.includes(key);
}
function setOpen(key, on) {
  const next = on ? [...new Set([...openMods.value, key])] : openMods.value.filter((k) => k !== key);
  openMods.value = next;
  uiSetIfChanged('setOpen', next);
}
// 开机合并是异步的（bootstrap 回来比打开页面晚一拍）：合并完再对一次，免得停在默认那块
onUiMerged(() => {
  mod.value = String(uiGet('setMod', 'book') || 'book');
  openMods.value = readOpen();
});
const curMod = computed(() => SET_MODS.find((m) => m.key === mod.value) || SET_MODS[0]);
/** 点模块 = 切到它 + 展开它；点的是「已经选中的那块」就把它的子项收起来（再点一下又展开）。 */
function pickMod(key) {
  const wasActive = mod.value === key;
  if (!wasActive) {
    mod.value = key;
    uiSetIfChanged('setMod', key);
    setOpen(key, true);
    return;
  }
  setOpen(key, !isOpen(key));
}
/** 子项那几条的高度（`max-height` 用它算，好动画到「刚好的高度」而不是一个瞎猜的大值） */
const SUB_ROW_H = 27;
function subsMax(key) {
  const n = (SET_SUBS[key] || []).length;
  return isOpen(key) ? `${n * SUB_ROW_H}px` : '0px';
}

/* ---- 功能搜索（用户：「加上功能搜索」）----
   设置页十来块东西，翻起来还是要找：顶上给一个搜索框，输「TLC」「产率」「备份」「编号」这种词
   直接命中到**具体那一行**（切到对应模块 + 滚过去 + 闪一下），比一层层点模块快。
   `kw` 里放英文 / 别名，中文按 label 直接匹配。 */
const SET_SEARCH = [
  { m: 'book', label: '记录本标题（课题名）', kw: 'title heading 名字' },
  { m: 'book', label: '编号前缀', kw: 'prefix code 编号' },
  { m: 'book', label: '记录人 / 课题组', kw: 'owner group' },
  { m: 'book', label: '手机 / 局域网访问', kw: 'lan wifi 手机 访问' },
  { m: 'book', label: '瓶子标签二维码地址', kw: 'qr 标签 二维码 url' },
  { m: 'data', label: '数据目录', kw: 'data dir 路径' },
  { m: 'data', label: '备份 / 还原', kw: 'backup restore 导出 备份' },
  { m: 'cats', label: '课题与分类树（改名 / 编号前缀 / 删除）', kw: 'project category 课题 分类' },
  { m: 'cats', label: '新建分类 / 拖动排序', kw: 'new category 拖' },
  { m: 'ui', label: '快捷键', kw: 'keyboard shortcut 快捷键' },
  { m: 'ui', label: '书签悬停预览', kw: 'peek 书签 预览' },
  { m: 'ui', label: '排版板图注（跟着图缩 / 固定字号）', kw: 'board caption 图注 缩放 字号', anchor: 'set-boardcap' },
  { m: 'ui', label: '切记录时停在同一页', kw: 'page keep 翻页 第2页 续页 切记录 滚轮 动画 推 力度' },
  { m: 'ui', label: '教程（重新看一遍）', kw: 'tour guide 教程 引导 帮助 help', anchor: 'set-tour' },
  { m: 'page', label: 'A4 上显示哪几块（按记录类型）', kw: 'blocks 版式 块 显示', anchor: 'set-blocks' },
  { m: 'page', label: '块里的功能（计产率 / 核对 / 结果表列）', kw: 'fx 产率 核对 性状 dr ee', anchor: 'set-fx' },
  { m: 'page', label: '反应式 · 箭头上那行条件（自动 / 单行 / 两行）', kw: 'scheme 反应式 条件 格式', anchor: 'set-scheme' },
  { m: 'page', label: '结果表最右那格 · 挂几张板', kw: 'tlc 板 缩略 几张', anchor: 'set-tlc-n' },
  { m: 'page', label: '投料表「用量」小数位', kw: 'decimal 小数 位 质量 体积', anchor: 'set-decimals' },
  { m: 'page', label: '常用选项（温度 / 时间 / 气氛 / 装置 / 光照）', kw: 'quick 下拉 候选 温度 时间 气氛 装置 光照', anchor: 'set-quick' },
];
/* 每个模块的**子功能**（用户：「还有就是子功能快速选择」）：当前模块在侧栏里展开这几条，
   点一下就滚到那一节 + 闪一下——不用先切模块再往下翻。只列真有锚点的。 */
const SET_SUBS = {
  book: [
    { label: '标题 / 编号前缀 / 记录人', anchor: 'set-book-basic' },
    { label: '手机 / 局域网访问', anchor: 'set-lan' },
    { label: '瓶子标签二维码地址', anchor: 'set-qr' },
  ],
  data: [
    { label: '数据目录', anchor: 'set-datadir' },
    { label: '备份 / 还原', anchor: 'set-backup' },
  ],
  ui: [
    { label: '快捷键', anchor: 'set-keys' },
    { label: '书签悬停预览', anchor: 'set-peek' },
    { label: '排版板图注', anchor: 'set-boardcap' },
    { label: '切记录时停在同一页', anchor: 'set-pagekeep' },
  ],
  page: [
    { label: 'A4 上显示哪几块', anchor: 'set-blocks' },
    { label: '块里的功能', anchor: 'set-fx' },
    { label: '反应式条件格式', anchor: 'set-scheme' },
    { label: '挂几张板', anchor: 'set-tlc-n' },
    { label: '用量小数位', anchor: 'set-decimals' },
    { label: '常用选项', anchor: 'set-quick' },
  ],
};
/** 滚到某个锚点 + 闪一下（搜索命中和子功能共用） */
function jumpTo(anchor) {
  const el = anchor ? document.getElementById(anchor) : null;
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('is-flash');
  setTimeout(() => el.classList.remove('is-flash'), 1400);
}

const q = ref('');
const modLabel = (key) => (SET_MODS.find((m) => m.key === key) || {}).label || '';
const hits = computed(() => {
  const k = q.value.trim().toLowerCase();
  if (!k) return [];
  return SET_SEARCH.filter((e) => `${e.label} ${e.kw || ''} ${modLabel(e.m)}`.toLowerCase().includes(k)).slice(0, 20);
});
async function goHit(hit) {
  if (mod.value !== hit.m) {
    mod.value = hit.m;
    uiSetIfChanged('setMod', hit.m);
  }
  setOpen(hit.m, true);   // 命中那块顺手展开，子项跟着可见（不然跳过去左边还是收着的）
  q.value = '';
  await nextTick();
  jumpTo(hit.anchor);
}

/* ---- 记录页显示：按记录类型各一套（和 `lib/sheetprefs.js` 的键一致）---- */
const editKind = ref(currentSheetKind());
if (editKind.value !== currentSheetKind()) useSheetBlocks(editKind.value);
function pickSheetKind(kind) {
  editKind.value = String(kind || '');
  useSheetBlocks(editKind.value);
}

/* ---- 常用选项（条件行那几个下拉里自己加的值）----
   存服务端 settings 的 `quick:<字段>`，跟着 data/ 一起备份；页面上「＋ 自定义」加的
   也是同一份数据，所以两边看到的是同一串。内置的那几条在 `lib/ui.js` 的 QUICK 里，
   这里只显示、删不掉（删了代码里还会再来）。 */
const QUICK_ROWS = [
  { key: 'temperature', label: '反应温度' },
  { key: 'duration', label: '时间节点' },
  { key: 'atmosphere', label: '气氛 / 容器' },
  { key: 'apparatus', label: '装置 / 器皿' },
  { key: 'light', label: '光照 / 波长' },
];
const quickItems = (key) => quickList(key);
const quickCustomized = (key) => quickFull(key) != null;

async function saveQuickList(key, items) {
  try {
    await api.saveQuick(key, items, true);
    await loadBoot();
    return true;
  } catch (e) {
    toast(e.message || '没存上', 'err');
    return false;
  }
}

async function addQuick(f) {
  const v = await prompt({
    title: `加一条「${f.label}」常用选项`,
    placeholder: '比如 45 ℃ / Ar 手套箱 / 光照 24 h',
    confirmText: '加上',
  });
  const value = String(v || '').trim();
  if (!value) return;
  if (quickItems(f.key).includes(value)) {
    toast(`「${value}」本来就在里面`);
    return;
  }
  if (await saveQuickList(f.key, [...quickItems(f.key), value])) toast(`「${value}」加好了`);
}

async function delQuick(key, value) {
  if (await saveQuickList(key, quickItems(key).filter((x) => x !== value))) toast(`去掉了「${value}」`);
}

/** 顺序就是刻度条 / 胶囊里的顺序，整份列表一起挪 */
async function moveQuick(key, i, dir) {
  const list = [...quickItems(key)];
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await saveQuickList(key, list);
}

/** 恢复默认：删掉这一份完整列表，回到内置那几条（外加以前自己加的） */
async function resetQuick(f) {
  try {
    await api.saveQuick(f.key, null, true);
    await loadBoot();
    toast(`「${f.label}」回到默认那几条`);
  } catch (e) {
    toast(e.message || '没恢复成', 'err');
  }
}

/** 改名会连带把记录、化合物、编号前缀、课题级设置一起搬过去 */
async function renameProject(p) {
  const name = await prompt({ title: `将「${p.name}」重命名为`, value: p.name, confirmText: '确定' });
  if (!name || name === p.name) return;
  try {
    await api.renameProject(p.name, name);
    if (store.project === p.name) await setProject(name); // 正站在这课题里就一起跟过去
    await loadAllCats();
    toast(`改好了，记录都跟到「${name}」名下了`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function newProject() {
  const name = await prompt({ title: '新建课题', placeholder: '比如：手性配体、光催化方法学', confirmText: '新建' });
  if (!name) return;
  try {
    await api.createProject({ name });
    await refresh();
    toast('课题建好了，侧栏最上面能切过去');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 课题自己的编号前缀；清空就按课题名自动生成（每个课题都从 xxxx-0001 起，互不干扰） */
async function editProjectPrefix(p) {
  const auto = p.auto_prefix || p.name || 'EXP';
  const prefix = await prompt({
    title: `「${p.name}」的编号前缀`,
    value: p.prefix || '',
    placeholder: `留空 = 自动用「${auto}」`,
    confirmText: '确定',
    allowEmpty: true,
  });
  if (prefix === null) return;
  try {
    await api.createProject({ name: p.name, prefix });
    await loadBoot();
    toast(prefix ? `新实验会用 ${prefix}-1 这样的编号` : `已改回自动前缀「${auto}」`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function removeProject(p) {
  const n = Number(p.n) || 0;
  const cmp = Number(p.cmp) || 0;
  const empty = !n && !cmp;
  // 有东西的课题把后果写清楚：记录 / 化合物进回收站（能恢复），分类直接删
  const body = empty
    ? '该课题暂无记录。删除仅从清单中移除，记录与文件均不受影响。'
    : `里面有 ${n} 条实验${cmp ? `、${cmp} 个化合物` : ''}。连它们一起移到回收站（分类也删掉），回收站里还能恢复。`;
  const ok = await confirm({
    title: `删除课题「${p.name}」？`,
    body,
    confirmText: empty ? '删除' : '连记录一起删',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteProject(p.name, { withRecords: !empty });
    await loadBoot();
    toast(empty ? '课题删掉了' : `课题和 ${n + cmp} 条内容已经移到回收站`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---- 切记录时停在同一页（`uiprefs` 的 `pageKeep`，默认开）----
   用户：「假设你在第二页，切换实验的话就也到对应的第二页，如果没有第 X 页就默认第一页」。 */
const keepPage = ref(uiGet('pageKeep', true) !== false);
onUiMerged(() => {
  keepPage.value = uiGet('pageKeep', true) !== false;
});
function setKeepPage(v) {
  keepPage.value = !!v;
  uiSetIfChanged('pageKeep', !!v);
}
/** 「换记录时的推拉动画」（`pageAnim`，默认开） */
const pageAnim = ref(uiGet('pageAnim', true) !== false);
onUiMerged(() => {
  pageAnim.value = uiGet('pageAnim', true) !== false;
});
function setPageAnim(v) {
  pageAnim.value = !!v;
  uiSetIfChanged('pageAnim', !!v);
}
/** 「点纸左右两侧的空白翻页」（`edgeFlip`，默认开） */
const edgeFlip = ref(uiGet('edgeFlip', true) !== false);
onUiMerged(() => {
  edgeFlip.value = uiGet('edgeFlip', true) !== false;
});
function setEdgeFlip(v) {
  edgeFlip.value = !!v;
  uiSetIfChanged('edgeFlip', !!v);
}
/** 纸边热区的长相（`edgeFlipLook`）：soft 悬停才浮 / quiet 不画 / always 一直淡淡显示 */
const EDGE_LOOKS = [
  { key: 'soft', label: '悬停才浮出来' },
  { key: 'quiet', label: '什么都不画' },
  { key: 'always', label: '一直淡显' },
];
const edgeLook = ref(String(uiGet('edgeFlipLook', 'soft') || 'soft'));
onUiMerged(() => {
  edgeLook.value = String(uiGet('edgeFlipLook', 'soft') || 'soft');
});
function setEdgeLook(k) {
  edgeLook.value = k;
  uiSetIfChanged('edgeFlipLook', k);
}
/** 滚轮力度：滚多少像素才切一条（`scrollWheel`） */
const WHEEL_PRESETS = [
  { key: 'light', label: '轻一点', px: 44 },
  { key: 'normal', label: '正好', px: 90 },
  { key: 'heavy', label: '要滚多一点', px: 160 },
];
const scrollWheel = ref(String(uiGet('scrollWheel', 'light') || 'light'));
onUiMerged(() => {
  scrollWheel.value = String(uiGet('scrollWheel', 'light') || 'light');
});
function setScrollWheel(k) {
  scrollWheel.value = k;
  uiSetIfChanged('scrollWheel', k);
}
/** 滚到头再滚 = 切上/下一条记录（`scrollSwitch`，默认开） */
const scrollSwitch = ref(uiGet('scrollSwitch', true) !== false);
onUiMerged(() => {
  scrollSwitch.value = uiGet('scrollSwitch', true) !== false;
});
function setScrollSwitch(v) {
  scrollSwitch.value = !!v;
  uiSetIfChanged('scrollSwitch', !!v);
}

/* ---- 分类与化合物不再有「跨课题共用」开关 ---- */
/* 两者都严格按课题归属；project = '' 就是「共用课题」，在「全部课题」下新建的东西落进去。 */

</script>

<template>
  <div class="panes set-panes">
    <!-- 二级侧边栏：跟「实验记录 / 化合物库」那根中栏一个样子（bone 底 + 分隔线 + 可滚动），
         不是塞在内容区里的一列字。 -->
    <aside class="listpane set-pane">
      <div class="listpane-head set-pane-head">
        <h1 class="set-pane-title">设置</h1>
        <div class="searchbox set-search">
          <Icon name="search" :size="12" />
          <input v-model="q" type="search" placeholder="搜设置项：TLC / 产率 / 备份…" autocomplete="off" />
        </div>
      </div>
      <div class="listpane-body set-pane-body">
        <template v-if="!q.trim()">
          <div v-for="m in SET_MODS" :key="m.key" class="set-group">
            <button
              type="button"
              class="set-mod"
              :class="{ 'is-on': mod === m.key, 'is-open': isOpen(m.key) }"
              :aria-current="mod === m.key ? 'page' : undefined"
              :aria-expanded="SET_SUBS[m.key] ? String(isOpen(m.key)) : undefined"
              @click="pickMod(m.key)"
            >
              <span class="set-mod-n">{{ m.n }}</span>
              <span class="set-mod-l">{{ m.label }}</span>
              <!-- 有子项的模块才有这颗箭头；转 90° 就是展开 -->
              <Icon v-if="SET_SUBS[m.key]" name="chevron" :size="11" class="set-mod-caret" />
            </button>
            <!-- 子功能：点一下直接滚到那一节。开合用 max-height 动画（高度按条数算，
                 不用瞎猜一个大值），收起时不让它接走点击 / Tab。 -->
            <div
              v-if="SET_SUBS[m.key]"
              class="set-subs"
              :class="{ 'is-shut': !isOpen(m.key) }"
              :style="{ maxHeight: subsMax(m.key) }"
              :aria-hidden="isOpen(m.key) ? undefined : 'true'"
            >
              <button
                v-for="sb in SET_SUBS[m.key]"
                :key="`${m.key}-${sb.anchor}`"
                type="button"
                class="set-sub"
                :tabindex="isOpen(m.key) ? 0 : -1"
                @click="jumpTo(sb.anchor)"
              >
                {{ sb.label }}
              </button>
            </div>
          </div>
        </template>
        <template v-else>
          <button v-for="hit in hits" :key="`${hit.m}-${hit.label}`" type="button" class="set-hit" @click="goHit(hit)">
            <span class="set-hit-l">{{ hit.label }}</span>
            <span class="set-hit-m">{{ modLabel(hit.m) }}</span>
          </button>
          <p v-if="!hits.length" class="set-hit-empty">没找到「{{ q }}」<br />试试 TLC / 产率 / 备份 / 编号</p>
        </template>
      </div>
    </aside>

    <div class="editor">
      <div class="editor-inner set-inner">
        <header class="page-head">
          <h1 class="page-title">{{ curMod.label }}</h1>
          <p class="page-desc">{{ curMod.desc }}</p>
        </header>

      <section v-if="mod === 'book'" class="card">
        <div class="card-head">
          <h2 class="card-title">
            记录本信息<span v-if="store.project" class="title-sub">· {{ store.project }}</span>
          </h2>
        </div>
        <p class="hint" v-if="store.project">
          留空的项沿用全局值。标题即课题名，改了会连带重命名这个课题。
        </p>
        <p class="hint" v-else>全局默认值；每个课题可以单独覆盖。</p>
        <div id="set-book-basic" class="grid-2" :class="{ 'mt12': true }">
          <div class="field"><label>{{ store.project ? '标题（= 课题名）' : '标题' }}</label><input class="input" v-model="form.lab_heading" :placeholder="ph.lab_heading" /></div>
          <div class="field"><label>编号前缀</label><input class="input num" v-model="form.code_prefix" :placeholder="ph.code_prefix" /></div>
          <div class="field"><label>记录人</label><input class="input" v-model="form.owner_name" :placeholder="ph.owner_name" /></div>
          <div class="field"><label>课题组</label><input class="input" v-model="form.group_name" :placeholder="ph.group_name" /></div>
          <div id="set-lan" class="field" style="grid-column: 1/-1">
            <label>手机 / 局域网访问</label>
            <label class="check-row">
              <input type="checkbox" v-model="form.lan_access" />
              <span>允许同一 Wi-Fi 下的手机打开</span>
            </label>
            <p class="hint mt8">
              当前 <b>{{ store.boot?.lanAccess ? '已允许' : '仅本机' }}</b> · 本机地址
              <span class="mono">{{ store.boot?.lanUrl || '（没检测到网卡）' }}</span> · <b>改完要重启服务</b>
            </p>
          </div>
          <div id="set-qr" class="field" style="grid-column: 1/-1">
            <label>瓶子标签的二维码地址</label>
            <input class="input mono" v-model="form.label_base_url" :placeholder="ph.label_base_url" />
            <p class="hint mt8">
              留空就用上面的本机地址；手机扫码要能打开，得先允许局域网访问并重启。
            </p>
          </div>
        </div>
        <div class="row mt16">
          <button class="btn btn-primary" :disabled="saving" @click="save">保存</button>
          <span class="hint">编号前缀仅作用于此后新建的实验，已有编号不变。</span>
        </div>
      </section>

      <section v-if="mod === 'data'" class="card">
        <div class="card-head"><h2 class="card-title">数据与备份</h2></div>
        <div id="set-datadir" class="field">
          <label>数据目录</label>
          <div class="input mono" style="background: #fafaf8; color: var(--ink-2); user-select: all">{{ store.boot?.dataDir }}</div>
        </div>
        <p class="hint mt12">
          <span class="mono">eln.db</span> + <span class="mono">attachments/</span> 就是全部；整个目录纳入备份即可。
        </p>
        <div id="set-backup" class="row mt16">
          <button class="btn" @click="openLink('/api/backup')"><Icon name="download" :size="13" /> 下载完整备份 .zip</button>
          <button class="btn" @click="openLink(exportLink)"><Icon name="download" :size="13" /> {{ store.project ? `导出「${store.project}」` : '全部导出为 Markdown' }}</button>
        </div>
      </section>

      <section v-if="mod === 'cats'" class="card">
        <div class="card-head">
          <h2 class="card-title">课题与分类</h2>
          <span class="spacer" />
          <span class="newcat-target">新建到 {{ targetLabel }}</span>
          <button class="btn btn-sm btn-ghost" @click="newProject"><Icon name="plus" :size="11" /> 课题</button>
          <button class="btn btn-sm btn-ghost" @click="newCategory('experiment')"><Icon name="plus" :size="11" /> 实验分类</button>
          <button class="btn btn-sm btn-ghost" @click="newCategory('compound')"><Icon name="plus" :size="11" /> 化合物分类</button>
        </div>
        <p class="hint mt12">
          分类和化合物都归属一个课题；换课题时里面的记录跟着走。
        </p>

        <!-- 共用课题（project = ''）：在「全部课题」下新建的东西落在这里 -->
        <div
          class="tree-group"
          :class="{
            'is-drop-live': dropTarget === '',
            'is-drop-self': !!dragCat && sameProject(dragCat, ''),
          }"
          @dragover.prevent="onHeadDragOver('')"
          @dragleave="onHeadDragLeave($event, '')"
          @drop.prevent="onCatDrop('')"
        >
          <div class="tree-head" :class="{ 'is-pickable': true, 'is-target': isTarget('') }" @click="catTarget = ''">
            <span class="tree-name">共用课题</span>
            <span v-if="isTarget('')" class="tree-tag is-fill">新建到此</span>
            <span class="tree-meta mono">{{ sharedCounts.exp }} 条 · {{ sharedCounts.cmp }} 个</span>
          </div>
          <div
            v-if="!catTree.shared.length && !sharedCounts.uncatExp && !sharedCounts.uncatCmp"
            class="tree-empty"
          >
            暂无记录。在「全部课题」下新建实验、化合物或分类，就落在这里。
          </div>
          <div v-else class="tree-body">
            <div
              v-for="g in catTree.shared"
              :key="g.id"
              class="cat-item merged"
              :class="{ 'is-dragging': dragCat && dragCat.id === g.id }"
            >
              <span
                class="cat-grip"
                draggable="true"
                title="拖动这个分类到别的课题组标题上＝移过去（里面的记录一起搬）"
                @dragstart="onCatDragStart($event, g)"
                @dragend="onCatDragEnd"
                >⠿</span
              >
              <span class="cat-scope-badge" :title="g.scope === 'compound' ? '化合物分类' : '实验分类'">
                {{ g.scope === 'compound' ? '化合物' : '实验' }}
              </span>
              <span class="cat-name">{{ g.name }}</span>
              <span class="cat-count mono">{{ catCount(g) }}</span>
              <span class="spacer" />
              <button class="icon-act" title="给分类改名" @click="renameCategory(g)">
                <Icon name="edit" :size="15" />
              </button>
              <button class="icon-act is-danger" title="删除这个分类" @click="removeCategory(g)">
                <Icon name="trash" :size="15" />
              </button>
            </div>
            <!-- 未分类是固定桶：没归分类的记录都在这儿，不能改名 / 删除 -->
            <div v-if="sharedCounts.uncatExp || sharedCounts.uncatCmp" class="cat-item merged is-uncat">
              <span class="cat-name">未分类</span>
              <span class="cat-count mono">{{ uncatLabel(sharedCounts.uncatExp, sharedCounts.uncatCmp) }}</span>
            </div>
          </div>
        </div>

        <!-- 每个课题一棵 -->
        <div
          v-for="gp in catTree.groups"
          :key="gp.key"
          class="tree-group"
          :class="{
            'is-drop-live': dropTarget === gp.name,
            'is-drop-self': !!dragCat && sameProject(dragCat, gp.name),
          }"
          @dragover.prevent="onHeadDragOver(gp.name)"
          @dragleave="onHeadDragLeave($event, gp.name)"
          @drop.prevent="onCatDrop(gp.name)"
        >
          <div class="tree-head" :class="{ 'is-pickable': true, 'is-target': isTarget(gp.name) }" @click="catTarget = gp.name">
            <span class="tree-name">{{ gp.name }}</span>
            <span v-if="isCurrentProject(gp.name)" class="tree-tag">当前</span>
            <span v-if="isTarget(gp.name)" class="tree-tag is-fill">新建到此</span>
            <span class="tree-meta mono">
              {{ gp.info.prefix || (gp.name ? gp.info.auto_prefix : store.boot?.settings?.code_prefix) || 'EXP' }} · {{ gp.info.n }} 条 · {{ gp.info.cmp || 0 }} 个
            </span>
            <span class="spacer" />
            <button class="icon-act" title="给课题改名" @click.stop="renameProject(gp.info)">
              <Icon name="edit" :size="16" />
            </button>
            <button class="icon-act" title="课题的编号前缀" @click.stop="editProjectPrefix(gp.info)">
              <Icon name="hash" :size="16" />
            </button>
            <button class="icon-act is-danger" title="删除这个课题" @click.stop="removeProject(gp.info)">
              <Icon name="trash" :size="16" />
            </button>
          </div>
          <div v-if="!gp.items.length && !gp.info.uncat_exp && !gp.info.uncat_cmp" class="tree-empty">
            该课题下暂无分类。
          </div>
          <div v-else class="tree-body">
            <div
              v-for="g in gp.items"
              :key="g.id"
              class="cat-item merged"
              :class="{ 'is-dragging': dragCat && dragCat.id === g.id }"
            >
              <span
                class="cat-grip"
                draggable="true"
                title="拖动这个分类到别的课题组标题上＝移过去（里面的记录一起搬）"
                @dragstart="onCatDragStart($event, g)"
                @dragend="onCatDragEnd"
                >⠿</span
              >
              <span class="cat-scope-badge" :title="g.scope === 'compound' ? '化合物分类' : '实验分类'">
                {{ g.scope === 'compound' ? '化合物' : '实验' }}
              </span>
              <span class="cat-name">{{ g.name }}</span>
              <span class="cat-count mono">{{ catCount(g) }}</span>
              <span class="spacer" />
              <button class="icon-act" title="给分类改名" @click="renameCategory(g)">
                <Icon name="edit" :size="15" />
              </button>
              <button class="icon-act is-danger" title="删除这个分类" @click="removeCategory(g)">
                <Icon name="trash" :size="15" />
              </button>
            </div>
            <!-- 未分类是固定桶：没归分类的记录都在这儿，不能改名 / 删除 -->
            <div v-if="gp.info.uncat_exp || gp.info.uncat_cmp" class="cat-item merged is-uncat">
              <span class="cat-name">未分类</span>
              <span class="cat-count mono">{{ uncatLabel(gp.info.uncat_exp, gp.info.uncat_cmp) }}</span>
            </div>
          </div>
        </div>

      </section>

      <section v-if="mod === 'ui'" id="set-keys" class="card">
        <div class="card-head"><h2 class="card-title">快捷键</h2></div>
        <div class="row" style="gap: 24px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2)">
          <span><kbd>Enter</kbd> 确认本格</span>
          <span><kbd>Tab</kbd> 移至下一格</span>
          <span><kbd>⌘</kbd> <kbd>Enter</kbd> 新增一行</span>
          <span><kbd>⌘</kbd> <kbd>⌫</kbd> 删除本行</span>
          <span><kbd>⌘</kbd> <kbd>S</kbd> 立即保存</span>
          <span><kbd>⌘</kbd> <kbd>Z</kbd> 撤销上一次保存</span>
          <span><kbd>⌘</kbd> <kbd>N</kbd> 新建实验</span>
          <span><kbd>⌘</kbd> <kbd>K</kbd> 搜索</span>
          <span><kbd>←</kbd> <kbd>→</kbd> 记录页左右翻页</span>
          <span><kbd>↑</kbd> <kbd>↓</kbd> 上 / 下一条记录（含平行实验）</span>
          <span><kbd>Esc</kbd> 关闭对话框</span>
          <span><kbd>右键</kbd> 列表卡片上出快捷菜单（复制 / 锁定 / 删除）</span>
        </div>
      </section>

      <section v-if="mod === 'ui'" id="set-peek" class="card">
        <div class="card-head"><h2 class="card-title">书签悬停预览</h2></div>
        <p class="card-note">纸边那排平行书签，悬停时浮出的预览卡上显示哪几块。</p>
        <div class="sw-grid">
          <label v-for="(label, key) in PEEK_LABELS" :key="key">
            <span>{{ label }}</span>
            <input type="checkbox" :checked="peekPrefs[key]" @change="setPeekPref(key, $event.target.checked)" />
          </label>
        </div>
      </section>

      <section v-if="mod === 'ui'" id="set-reagent-links" class="card">
        <div class="card-head"><h2 class="card-title">试剂库的外部库链接</h2></div>
        <p class="card-note">试剂名后面那排外部库链接：常显好找，悬停才出现更干净。</p>
        <div class="seg">
          <button type="button" :class="{ 'is-on': rlLinks === 'always' }" @click="setRlLinks('always')">常显</button>
          <button type="button" :class="{ 'is-on': rlLinks === 'hover' }" @click="setRlLinks('hover')">悬停才出现</button>
        </div>
      </section>

      <section v-if="mod === 'ui'" id="set-card" class="card">
        <div class="card-head"><h2 class="card-title">卡片</h2></div>
        <p class="card-note">页面里那些白卡的质感，改完全站一起变。</p>
        <div class="seg" style="margin-bottom: 10px">
          <button
            v-for="s in CARD_STYLES"
            :key="s.key"
            type="button"
            :class="{ 'is-on': card.style === s.key }"
            :title="s.hint"
            @click="pickCardStyle(s.key)"
          >{{ s.label }}</button>
        </div>
        <div class="set-row">
          <span class="set-row-l">圆角</span>
          <span class="seg">
            <button
              v-for="r in CARD_RADII"
              :key="r.value"
              type="button"
              :class="{ 'is-on': card.radius === r.value }"
              @click="pickCardRadius(r.value)"
            >{{ r.label }}</button>
          </span>
          <span class="spacer" />
          <button class="btn btn-sm btn-ghost" @click="cardReset">恢复默认</button>
        </div>
      </section>

      <section v-if="mod === 'ui'" id="set-boardcap" class="card">
        <div class="card-head"><h2 class="card-title">排版板的图注</h2></div>
        <p class="card-note">拖到板上的 TLC 图注，缩图时跟不跟着一起缩。</p>
        <div class="seg">
          <button type="button" :class="{ 'is-on': boardCap === 'fixed' }" @click="setBoardCap('fixed')">固定字号</button>
          <button type="button" :class="{ 'is-on': boardCap === 'scale' }" @click="setBoardCap('scale')">跟着图缩放</button>
        </div>
      </section>

      <section v-if="mod === 'ui'" id="set-tour" class="card">
        <div class="card-head"><h2 class="card-title">教程</h2></div>
        <p class="card-note">每页第一次进来自动放一遍，右下角 <b>?</b> 随时重看。</p>
        <div class="row" style="gap: 8px; align-items: center">
          <button class="btn btn-sm btn-ghost" @click="resetTour">重新看一遍全部教程</button>
          <span style="font-size: 11.5px; color: var(--ink-4)">会把「已看过」的标记清掉</span>
        </div>
      </section>

      <section v-if="mod === 'ui'" id="set-pagekeep" class="card">
        <div class="card-head"><h2 class="card-title">切换记录</h2></div>
        <p class="card-note">切到另一条记录时，停在同一页还是回第 1 页。</p>
        <label class="check-row">
          <input type="checkbox" :checked="keepPage" @change="setKeepPage($event.target.checked)" />
          <span>切记录时停在同一页</span>
        </label>
        <label class="check-row mt8">
          <input type="checkbox" :checked="scrollSwitch" @change="setScrollSwitch($event.target.checked)" />
          <span>滚到头再滚就切上 / 下一条</span>
        </label>
        <label class="check-row mt8">
          <input type="checkbox" :checked="pageAnim" @change="setPageAnim($event.target.checked)" />
          <span>换记录时播「推」的动画</span>
        </label>
        <label class="check-row mt8">
          <input type="checkbox" :checked="edgeFlip" @change="setEdgeFlip($event.target.checked)" />
          <span>点纸左右两侧的空白翻页</span>
        </label>
        <div v-if="edgeFlip" class="set-row set-row-indent mt8">
          <span class="set-row-l">纸边那颗箭头的出场</span>
          <span class="seg">
            <button
              v-for="o in EDGE_LOOKS"
              :key="o.key"
              type="button"
              :class="{ 'is-on': edgeLook === o.key }"
              @click="setEdgeLook(o.key)"
            >
              {{ o.label }}
            </button>
          </span>
        </div>
        <div class="set-row mt8">
          <span class="set-row-l">滚轮切一条要滚多少</span>
          <span class="seg">
            <button
              v-for="o in WHEEL_PRESETS"
              :key="o.key"
              type="button"
              :class="{ 'is-on': scrollWheel === o.key }"
              :title="`约 ${o.px}px`"
              @click="setScrollWheel(o.key)"
            >
              {{ o.label }}
            </button>
          </span>
        </div>
        <p class="hint mt8">
          纸放得下就直接切；放不下先滚到底再多滚一点（防误触）。顺序按左栏列表，到头就停。
        </p>
      </section>

      <section v-if="mod === 'page'" class="card">
        <div class="card-head">
          <h2 class="card-title">记录页显示</h2>
          <span class="spacer" />
          <button class="btn btn-sm btn-ghost" @click="showAllSheetBlocks()">全部显示</button>
        </div>
        <p class="card-note">这一类记录的 A4 上出现哪几块，页面和打印一起变。</p>
        <div class="sheet-kind-row">
          <span class="sheet-kind-lbl">改哪一类</span>
          <span class="sheet-kind-chips seg">
            <button
              v-for="k in SHEET_KINDS"
              :key="k.key || 'all'"
              type="button"
              :class="{ 'is-on': editKind === k.key }"
              :title="k.key ? `「${k.label}」这类记录默认显示哪几块` : '没写类型的老记录（通用）'"
              @click="pickSheetKind(k.key)"
            >
              {{ k.label }}
            </button>
          </span>
        </div>
        <div id="set-blocks" class="sheet-blocks">
          <label v-for="(label, key) in SHEET_BLOCKS" :key="key">
            <input type="checkbox" :checked="sheetPrefs[key]" @change="setSheetPref(key, $event.target.checked)" />
            {{ label }}
          </label>
        </div>

        <!-- 第三层：块里面的功能（也是按记录类型各记一套） -->
        <div id="set-fx" class="sheet-fx">
          <div class="sheet-fx-head">
            块里的功能
            <span class="sheet-fx-hint">只影响「{{ SHEET_KINDS.find((k) => k.key === editKind)?.label || '通用' }}」这一类记录</span>
          </div>
          <label
            v-for="f in SHEET_FX"
            :key="f.key"
            class="sheet-fx-row"
            :class="{ 'is-off': !sheetPrefs[f.group] }"
          >
            <input type="checkbox" :checked="sheetFx[f.key]" @change="setSheetFx(f.key, $event.target.checked)" />
            <span class="sheet-fx-name">{{ f.label }}</span>
            <span class="sheet-fx-sub">{{ f.hint || '' }}</span>
            <span v-if="!sheetPrefs[f.group]" class="sheet-fx-note">所在那一块关着</span>
          </label>

          <div id="set-scheme" class="sheet-fx-row is-static">
            <span class="sheet-fx-name">反应式 · 箭头上那行条件</span>
            <span class="sheet-fx-chips seg">
              <button
                v-for="o in SCHEME_FMT_OPTS"
                :key="o.key"
                type="button"
                :class="{ 'is-on': sheetSchemeFmt.fmt === o.key }"
                :title="o.hint || ''"
                @click="setSchemeFmt(o.key)"
              >
                {{ o.label }}
              </button>
            </span>
            <span class="sheet-fx-sub">{{ SCHEME_FMT_OPTS.find((o) => o.key === sheetSchemeFmt.fmt)?.hint || '' }}</span>
          </div>
          <div id="set-tlc-n" class="sheet-fx-row is-static">
            <span class="sheet-fx-name">结果表最右那格 · 挂几张板</span>
            <span class="sheet-fx-chips seg is-mono">
              <button
                v-for="n in TLC_N_OPTS"
                :key="n"
                type="button"
                :class="{ 'is-on': sheetTlcMax.n === n }"
                @click="setTlcMax(n)"
              >
                {{ TLC_N_LABEL[n] }}
              </button>
            </span>
            <span class="sheet-fx-sub">「不挂」= 结果表不放这一列</span>
          </div>
          <div id="set-decimals" class="sheet-fx-row is-static">
            <span class="sheet-fx-name">投料表「用量」小数位 · 质量（g）</span>
            <span class="sheet-fx-chips seg is-mono">
              <button
                v-for="opt in DECIMAL_OPTS"
                :key="opt.v"
                type="button"
                :class="{ 'is-on': amountDecimals() === opt.v }"
                @click="pickDecimals('mass', opt.v)"
              >
                {{ opt.t }}
              </button>
            </span>
            <span class="sheet-fx-sub">固定位数时尾零留着</span>
          </div>
          <div class="sheet-fx-row is-static">
            <span class="sheet-fx-name">投料表「用量」小数位 · 体积（mL / µL）</span>
            <span class="sheet-fx-chips seg is-mono">
              <button
                v-for="opt in DECIMAL_OPTS"
                :key="opt.v"
                type="button"
                :class="{ 'is-on': volumeDecimals() === opt.v }"
                @click="pickDecimals('vol', opt.v)"
              >
                {{ opt.t }}
              </button>
            </span>
            <span class="sheet-fx-sub">只收小数部分，30 mL 不写成 30.000 mL</span>
          </div>
        </div>
      </section>

      <section v-if="mod === 'page'" class="card">
        <div class="card-head"><h2 class="card-title">常用选项</h2></div>
        <p class="card-note">
          条件行下拉里「＋ 自定义」加的值都在这里（跟着 data/ 一起备份）。内置的也能删、能用 ‹ › 挪位置。
        </p>
        <div id="set-quick" class="quick-rows">
          <div v-for="f in QUICK_ROWS" :key="f.key" class="quick-row">
            <span class="quick-lbl">{{ f.label }}</span>
            <span class="quick-chips">
              <span v-for="(v, i) in quickItems(f.key)" :key="`q-${v}`" class="qchip is-own">
                {{ v }}
                <span class="qchip-acts">
                  <button type="button" title="往前挪一格" :disabled="i === 0" @click="moveQuick(f.key, i, -1)">‹</button>
                  <button type="button" title="往后挪一格" :disabled="i === quickItems(f.key).length - 1" @click="moveQuick(f.key, i, 1)">›</button>
                  <button type="button" class="is-del" title="删掉这条" @click="delQuick(f.key, v)">×</button>
                </span>
              </span>
              <button type="button" class="qchip is-add" @click="addQuick(f)">＋ 添加</button>
              <button
                v-if="quickCustomized(f.key)"
                type="button"
                class="quick-reset"
                title="回到内置那几条"
                @click="resetQuick(f)"
              >恢复默认</button>
            </span>
          </div>
        </div>
      </section>

        <p class="version-line">ELN 1.1.0 · 全本机运行 · 数据存自己的盘上 · 构建于 {{ buildAt }}</p>
      </div>
    </div>
  </div>
</template>
