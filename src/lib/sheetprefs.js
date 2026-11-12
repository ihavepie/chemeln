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
  characterization: '三 · 表征数据',
  conclusion: '四 · 讨论与结论',
  lit: '五 · 文献',
  attachments: '附件',
};

const BLOCK_KEYS = Object.keys(SHEET_BLOCKS);
const ALL_ON = Object.fromEntries(BLOCK_KEYS.map((k) => [k, true]));

/** 设置页那排类型切换用：通用 + 四个记录类型 */
export const SHEET_KINDS = [{ key: '', label: '通用' }, ...KINDS.map((k) => ({ key: k.key, label: k.key }))];

const normKind = (kind) => {
  const s = String(kind || '');
  return SHEET_KINDS.some((k) => k.key === s) ? s : '';
};

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

// 开机时从服务器合并下来的更"新"的那份：重读当前这一套
onUiMerged(() => useSheetBlocks(activeKind));
