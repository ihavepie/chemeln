import { reactive } from 'vue';
import { api } from './api.js';
import { onUiMerged, uiGet, uiMerge, uiSetIfChanged } from './lib/uiprefs.js';
import { QUICK } from './lib/ui.js';
import { setAmountDecimals, setVolumeDecimals } from './lib/reagent.js';

/** 当前课题存在 localStorage：刷新页面还留在同一个「空间」里。
 *  这一项**故意不进「页面设置」的同步**——那是「这台机器上我正想看哪个课题」，
 *  别被另一台设备打开过的课题改掉。 */
const PROJECT_KEY = 'eln:project';
const readProject = () => {
  try {
    return localStorage.getItem(PROJECT_KEY) || '';
  } catch {
    return '';
  }
};
const saveProject = (name) => {
  try {
    if (name) localStorage.setItem(PROJECT_KEY, name);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {}
};

/** 卡片 / 表格两种视图，按页记（走 uiprefs：浏览器缓存 + 数据库长期存储） */
const VIEW_KEY = 'view';
const readViews = () => {
  const v = uiGet(VIEW_KEY, {});
  return v && typeof v === 'object' ? v : {};
};

/** 卡片墙按什么分组：'cat' 按分类（默认）/ 'kind' 按类型（化合物的底物/产物/配体…） */
const GROUP_KEY = 'group';
const readGroups = () => {
  const v = uiGet(GROUP_KEY, {});
  return v && typeof v === 'object' ? v : {};
};

/** 一份全局状态：跟 v1 的 S 对象对应 */
export const store = reactive({
  boot: null,
  items: [],
  project: readProject(),
  filters: { q: '', status: '', category: '', sort: 'newest' },
  compoundFilters: { q: '', kind: '', category: '' },
  compounds: [],
  screenings: [],
  listTotal: 0,       // 符合筛选的全部条数（items 可能被服务端 LIMIT 截断）
  compoundTotal: 0,
  views: readViews(),   // { exp: 'card' | 'table', cmp: ... }
  groups: readGroups(), // { cmp: 'cat' | 'kind' }：化合物墙按分类还是按类型分组
  /* 中栏列表「正在怎么看」的状态：哪些卡片堆展开着、滚到哪儿了。
     放全局而不是组件里——/list 和 /e/:id 是两个页面，点一条记录 ExpListPane 会整个重建，
     组件内的 ref 一重建就归零，表现出来就是「点一下组员或卡片，卡片堆自己收起了」。 */
  openStacks: {},       // { [groupId]: true }
  listScroll: 0,
  /* 左栏列表里那几条的**显示顺序**（ExpListPane 算好放进来：分类分组 + 卡片堆展开后的 id 序列）。
     记录页上下切换（↑↓ / 滚轮）按它走，所以能跨平行组、跨分类一路翻下去。 */
  listOrder: [],
});

/** 当前用哪种视图看列表：'card' 卡片墙 / 'table' 表格（都读同一份 store.items / store.compounds） */
export const viewOf = (kind) => (store.views?.[kind] === 'table' ? 'table' : 'card');

export function setView(kind, mode) {
  store.views = { ...store.views, [kind]: mode === 'table' ? 'table' : 'card' };
  uiSetIfChanged(VIEW_KEY, store.views);
}

// 化合物墙只按分类分组了（「按类型分组」已撤：类型不再手工选，见 lib/ui.js 的 compoundSourceLabel）
export const groupOf = () => 'cat';

export function setGroup(kind, mode) {
  store.groups = { ...store.groups, [kind]: mode === 'kind' ? 'kind' : 'cat' };
  uiSetIfChanged(GROUP_KEY, store.groups);
}

// 投料表「用量」显示几位小数（0 = 按量级自适应）：存 uiprefs，开机先按本地的套上
setAmountDecimals(uiGet('reagentPrec', 0));
setVolumeDecimals(uiGet('reagentPrecVol', 0));

// 开机合并后回灌（另一台机器改过视图/分组的话，这一页也跟着换）
onUiMerged(() => {
  setAmountDecimals(uiGet('reagentPrec', 0));
  setVolumeDecimals(uiGet('reagentPrecVol', 0));
  const v = readViews();
  if (JSON.stringify(v) !== JSON.stringify(store.views)) store.views = v;
  const g = readGroups();
  if (JSON.stringify(g) !== JSON.stringify(store.groups)) store.groups = g;
});

/**
 * 每次拉取领一个序号：连点两个课题、或者搜索框连续输入时，
 * 先发出去的请求可能后回来，不认序号就会把新数据盖成旧的
 * （表现为：侧栏写着课题 B，卡片墙却是 A 的内容）。
 */
let bootSeq = 0;
let listSeq = 0;
let cmpSeq = 0;

export async function loadBoot() {
  const seq = ++bootSeq;
  const boot = await api.bootstrap(store.project);
  if (seq !== bootSeq) return store.boot;          // 期间又拉过一次，这份作废
  store.boot = boot;
  // 页面设置：开机先跟数据库对一次（两边按 key 的时间戳合并，谁新用谁的）
  uiMerge(boot.uiPrefs);
  // 课题被删了/改了名：清单里已经没有它，就退回「全部课题」，别卡在一个空空间里
  if (store.project && !(store.boot.projects || []).some((p) => p.name === store.project)) {
    store.project = '';
    saveProject('');
    const again = await api.bootstrap('');
    if (seq !== bootSeq) return store.boot;
    store.boot = again;
  }
  return store.boot;
}

export async function loadList() {
  const seq = ++listSeq;
  const page = await api.experimentsPage({
    q: store.filters.q.trim(),
    status: store.filters.status,
    category: store.filters.category,
    sort: store.filters.sort,
    project: store.project,
  });
  if (seq !== listSeq) return store.items;
  store.items = page.items;
  store.listTotal = page.total;
  return store.items;
}

/**
 * 切课题 = 换一个「空间」：列表、卡片墙、工作台统计全跟着走。
 * 分类筛选清掉——分类是全库共用的，跨课题切过来容易筛出空列表。
 */
export async function setProject(name) {
  store.project = name || '';
  saveProject(store.project);
  store.filters.category = '';
  store.compoundFilters.category = '';
  // 化合物也严格按课题走，换课题要重新拉一遍
  await Promise.all([loadBoot(), loadList(), loadCompounds()]);
}

/** 新建课题（可以顺手定编号前缀），建完直接切过去 */
export async function addProject(name, prefix = '') {
  await api.createProject({ name, prefix });
  await setProject(name);
}

/** 分类筛选里选着的那一类（新建记录时直接落进去）；'none' 和空都算没选 */
const filteredCat = (value) => (value && value !== 'none' ? Number(value) : null);

/**
 * 新建一条实验 / 一个化合物：工具栏和卡片墙的「＋」都走这里。
 * categoryId 不传 = 跟着当前筛选；显式传 null = 明确不归类（未分类那一组）。
 */
/**
 * 新建实验。`categoryId = undefined` 跟着当前筛选走，传 `null` = 明确未分类，传数字 = 落这个分类。
 * **指定了分类时，课题要跟着分类走**：分类属于哪个课题、记录就落哪个课题——否则在「全部课题」
 * 下点某个分类的＋新建，记录会落进共用课题、分类又被服务端判成悬空引用清掉（踩过）。
 */
export async function createExperiment(categoryId = undefined) {
  const catId = categoryId === undefined ? filteredCat(store.filters.category) : categoryId;
  const cat = catId == null ? null : recordCategories('experiment').find((c) => Number(c.id) === Number(catId));
  const exp = await api.createExperiment({
    title: '',
    date: new Date().toISOString().slice(0, 10),
    status: '进行中',
    category_id: catId,
    project: cat ? cat.project || '' : store.project,   // 「全部课题」下新建的落进共用课题
  });
  await Promise.all([loadBoot(), loadList()]);
  return exp;
}

export async function createCompound(categoryId = undefined) {
  const catId = categoryId === undefined ? filteredCat(store.compoundFilters.category) : categoryId;
  const cat = catId == null ? null : recordCategories('compound').find((c) => Number(c.id) === Number(catId));
  const cmp = await api.createCompound({
    kind: '底物',
    category_id: catId,
    project: cat ? cat.project || '' : store.project,
  });
  await Promise.all([loadBoot(), loadCompounds()]);
  return cmp;
}

export async function loadCompounds() {
  const seq = ++cmpSeq;
  const page = await api.compoundsPage({
    q: store.compoundFilters.q.trim(),
    kind: store.compoundFilters.kind,
    category: store.compoundFilters.category,
    project: store.project,
  });
  if (seq !== cmpSeq) return store.compounds;
  store.compounds = page.items;
  store.compoundTotal = page.total;
  return store.compounds;
}


/**
 * 新建一个分类（scope: 'experiment' | 'compound'）。
 * project 不传就跟当前课题走；在「全部课题」下新建就落进「共用课题」（project = ''）。
 */
export async function addCategory(name, scope, project = undefined) {
  const target = project === undefined ? store.project : project;
  await api.createCategory({ name, scope, project: target });
  return loadBoot();
}

export const settings = () => store.boot?.settings || {};
export const compoundDict = () => store.boot?.compoundDict || [];
/**
 * 「常用选项」里自己加的那几条（条件行的小下拉）。
 * 存服务端 settings 的 `quick:<field>`（JSON 数组）——跟着 data/ 一起备份，
 * 不像 localStorage 那样换台机器 / 清缓存就没了。
 */
export const quickExtra = (field) => {
  try {
    const raw = store.boot?.settings?.[`quick:${field}`];
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

/**
 * 这一行**完整**的常用选项。
 * 改过（`quickFull:<字段>` 存在）就照那份来 —— 内置那几条也在里面，删掉的已经不在；
 * 没改过就是「内置 + 以前自己加的」。`null` = 没改过（设置页据此显示「恢复默认」）。
 */
export const quickFull = (field) => {
  const raw = store.boot?.settings?.[`quickFull:${field}`];
  if (raw == null || raw === '') return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : null;
  } catch {
    return null;
  }
};

export const quickList = (field) => {
  const full = quickFull(field);
  if (full) return full;
  const out = [...(QUICK[`f-${field}`] || [])];
  for (const v of quickExtra(field)) if (!out.includes(v)) out.push(v);
  return out;
};

/** 自己记录本里用过的试剂（名字 / MW / 浓度），服务端从历史行汇总好的 */
export const reagentDict = () => store.boot?.reagentDict || [];

/**
 * 自己建的分类：实验、化合物各一套，取的时候要说清是哪边。
 * 分类严格挂在课题下（'' = 共用课题），按当前课题筛；
 * 「全部课题」不筛——卡片墙上是全库的记录，各课题的分类都得在，否则卡片会掉进不了任何一组。
 */
export const recordCategories = (scope) =>
  (store.boot?.recordCategories || []).filter(
    (g) => g.scope === scope && (!store.project || g.project === store.project)
  );

/** 分类清单（两种 scope 混在一起，设置页用） */
export const allCategories = () =>
  (store.boot?.recordCategories || []).filter((g) => !store.project || g.project === store.project);

/**
 * 给记录「归类」时用的分类清单：只列这条记录自己那个课题的分类。
 * 记录页在「全部课题」下也编辑记录，若照 recordCategories 那样全给，
 * 就会选到别的课题的分类 —— 记录留在共用课题、分类却在别的课题里，
 * 卡片墙上它一个组都落不进去（服务端现在也会把这种 category_id 当悬空引用丢掉）。
 */
export const categoriesOfProject = (scope, project) =>
  (store.boot?.recordCategories || []).filter(
    (g) => g.scope === scope && (g.project || '') === (project || '')
  );
