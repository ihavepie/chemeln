import { reactive } from 'vue';
import { onUiMerged, uiGet, uiSetIfChanged } from './uiprefs.js';
import { KIND_BLOCKS, KINDS } from './kind.js';

/**
 * 记录页（那张 A4 纸）上要显示哪几块 —— **按记录类型各记一套**。
 *
 * 以前是一套全局的，但打开记录时又会按类型（`KIND_BLOCKS`）整套重设一遍，
 * 于是在设置页里手勾的被盖掉（实测：关掉 TLC → 打开一条「试反应」记录 → TLC 又回来了）。
 * 现在存成 `{ '<类型>': { 块: true/false } }`（`''` = 通用），
 * 打开记录只管**选**那一套，不再写；设置页 06 改的是**当前选中的那一套**。
 *
 * 仍然走 `lib/uiprefs.js`（浏览器缓存 + 数据库长期存储）。
 * 关掉的块**页面和打印 / 存 PDF 都不出现**（打印是克隆页面 DOM，v-if 掉的自然没有），
 * 数据本身不会丢，重新勾上就回来了。
 */
const KEY = 'sheet';

export const SHEET_BLOCKS = {
  env: '环境（温度 / 湿度）',
  literature: '文献',
  scheme: '反应式',
  reagents: '投料表 + 条件',
  conds: '变量 / 各条件结果（投料表下面那几行）',
  result: '结果与选择性',
  tlc: 'TLC',
  procedure: '一 · 实验操作与现象',
  workup: '二 · 后处理',
  conclusion: '三 · 讨论与结论',
  lit: '文献（第 3 页）',
  attachments: '附件',
};

const BLOCK_KEYS = Object.keys(SHEET_BLOCKS);
const ALL_ON = Object.fromEntries(BLOCK_KEYS.map((k) => [k, true]));

/** 设置页那排类型切换用：通用 + 四个记录类型 */
export const SHEET_KINDS = [{ key: '', label: '通用' }, ...KINDS.map((k) => ({ key: k.key, label: k.key }))];

function normKind(kind) {
  const s = String(kind || '');
  return SHEET_KINDS.some((k) => k.key === s) ? s : '';
}

/* ---------- 模块内部的「功能开关」 ----------
   第三层：块开着，块里还有几样东西可以不要。跟块一样**按记录类型各记一套**。
   只列真的会改行为的；`group` 决定它挂在哪个块下面显示。 */
export const SHEET_FX = [
  {
    key: 'yield',
    group: 'result',
    label: '计产率',
    hint: '取消 = 只记质量和选择性（原料 / 粗产物 / 中间体这种不称产率的）',
  },
  { key: 'check', group: 'reagents', label: '说明格的「核对」（查 MW / 密度 / 固体）' },
  // 结果表那几列：很多人从来不填性状 / dr·ee，空着也占宽度（尤其挤掉 TLC 那格）
  { key: 'resAppear', group: 'result', label: '结果表的「性状」列', hint: '取消 = 那列不出现（已写的内容不丢，勾回来就有）' },
  { key: 'resDrEe', group: 'result', label: '结果表的「dr / ee」列', hint: '取消 = 那列不出现；总选择性那一行已经撤了，ee 就靠这格' },
];
const FX_KEYS = SHEET_FX.map((f) => f.key);
/** 某一类的默认：只有「原料」默认不记产率（以前是写死在 ResultBlock 里的） */
export const fxDefaultsFor = (kind) => ({
  yield: normKind(kind) !== '原料',
  check: true,
  resAppear: true,
  resDrEe: true,
});
/** 当前这一套的功能开关（设置页改它，记录页读它） */
export const sheetFx = reactive({ ...fxDefaultsFor('') });
const FX_STORE = 'sheetFx';

/** 某一类的默认：通用全开，其余照 `KIND_BLOCKS` */
export function defaultBlocksFor(kind) {
  const keys = KIND_BLOCKS[normKind(kind)];
  if (!keys) return { ...ALL_ON };
  return Object.fromEntries(BLOCK_KEYS.map((k) => [k, keys.includes(k)]));
}

/** 把存的整张表读出来（缺的类用默认补齐；老版本存的是「一套」平的，就当通用那一套） */
function readAll() {
  const raw = uiGet(KEY, null);
  const out = {};
  const isFlat = raw && typeof raw === 'object' && BLOCK_KEYS.some((k) => k in raw);
  if (isFlat) {
    out[''] = { ...ALL_ON, ...raw };
  } else if (raw && typeof raw === 'object') {
    for (const { key } of SHEET_KINDS) {
      const set = raw[key];
      out[key] = { ...defaultBlocksFor(key), ...(set && typeof set === 'object' ? set : {}) };
    }
  }
  for (const { key } of SHEET_KINDS) if (!out[key]) out[key] = defaultBlocksFor(key);
  return out;
}

function readFxAll() {
  const raw = uiGet(FX_STORE, null);
  const out = {};
  for (const { key } of SHEET_KINDS) {
    const set = raw && typeof raw === 'object' ? raw[key] : null;
    out[key] = { ...fxDefaultsFor(key), ...(set && typeof set === 'object' ? set : {}) };
  }
  return out;
}

/** 改一个功能开关（写库，只改当前这一类） */
export function setSheetFx(key, value) {
  const v = !!value;
  if (sheetFx[key] === v) return;
  sheetFx[key] = v;
  const all = readFxAll();
  all[activeKind] = { ...sheetFx };
  uiSetIfChanged(FX_STORE, all);
}

/** 当前在用的那一套（记录页渲染读它） */
export const sheetPrefs = reactive({ ...ALL_ON });

/** 现在这一套属于哪个类型（设置页改的就是它） */
let activeKind = '';

export const currentSheetKind = () => activeKind;

/** 打开记录 / 在设置页换类型时调：把那一套灌进 `sheetPrefs`，**不写库** */
export function useSheetBlocks(kind) {
  activeKind = normKind(kind);
  const set = readAll()[activeKind] || defaultBlocksFor(activeKind);
  for (const k of BLOCK_KEYS) sheetPrefs[k] = !!set[k];
  const fx = readFxAll()[activeKind] || fxDefaultsFor(activeKind);
  for (const k of FX_KEYS) sheetFx[k] = !!fx[k];
}

export function setSheetPref(key, value) {
  const v = !!value;
  if (sheetPrefs[key] === v) return;
  sheetPrefs[key] = v;
  const all = readAll();
  all[activeKind] = { ...sheetPrefs };
  uiSetIfChanged(KEY, all);
}

/** 全部显示（只影响当前这一套） */
export function showAllSheetBlocks() {
  for (const key of BLOCK_KEYS) setSheetPref(key, true);
}

/* ---------- 结果表最右那格挂几张板 ----------
   一条记录常常贴好几块板（0.5 h / 2 h / 过夜，或者几个条件的对照），挂几张是全局一个数：
   **0 = 不挂这一列**，1–3 = 挂几张。以前这里是「一个开关 + 一个张数」两行，
   用户看着问「这两个是不是有点功能重复了」——确实重复，合成一行了。 */
export const TLC_N_OPTS = [0, 1, 2, 3];
export const TLC_N_LABEL = { 0: '不挂', 1: '1 张', 2: '2 张', 3: '3 张' };
const TLCN_KEY = 'tlcN';
const normTlcN = (v) => (Number(v) >= 0 && Number(v) <= 3 ? Math.round(Number(v)) : 1);
export const sheetTlcMax = reactive({ n: normTlcN(uiGet(TLCN_KEY, 1)) });
export function setTlcMax(v) {
  const n = normTlcN(v);
  if (sheetTlcMax.n === n) return;
  sheetTlcMax.n = n;
  uiSetIfChanged(TLCN_KEY, n);
}

/* ---------- 反应式上那行条件怎么排 ----------
   `auto`（默认）：先单行，一行太长就退回两行；`single`：永远单行；`wrap`：最多两行。
   全局一个数，不分记录类型（同一本子里图的长相要一致）。 */
export const SCHEME_FMT_OPTS = [
  { key: 'auto', label: '自动', hint: '先单行；一行太长（>430px）就退回两行' },
  { key: 'single', label: '单行', hint: '永远一行，箭头跟着字变长' },
  { key: 'wrap', label: '两行', hint: '最多两行，箭头短、结构大' },
];
const SCHEME_FMT_KEY = 'schemeFmt';
const normFmt = (v) => (SCHEME_FMT_OPTS.some((o) => o.key === v) ? v : 'auto');
export const sheetSchemeFmt = reactive({ fmt: normFmt(uiGet(SCHEME_FMT_KEY, 'auto')) });
export function setSchemeFmt(v) {
  const fmt = normFmt(v);
  if (sheetSchemeFmt.fmt === fmt) return;
  sheetSchemeFmt.fmt = fmt;
  uiSetIfChanged(SCHEME_FMT_KEY, fmt);
}

// 开机时从服务器合并下来的更"新"的那份：重读当前这一套
onUiMerged(() => {
  useSheetBlocks(activeKind);
  sheetTlcMax.n = normTlcN(uiGet(TLCN_KEY, 1));
  sheetSchemeFmt.fmt = normFmt(uiGet(SCHEME_FMT_KEY, 'auto'));
});
