import { reactive } from 'vue';
import { onUiMerged, uiGet, uiSetIfChanged } from './uiprefs.js';

/**
 * 记录页（那张 A4 纸）上要显示哪几块。
 * 纯界面偏好：走 `lib/uiprefs.js`（浏览器当缓存、数据库当长期存储，换浏览器也还在），
 * 跟记录内容无关，所以不影响打印出来的内容本身。
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

const DEFAULTS = Object.fromEntries(Object.keys(SHEET_BLOCKS).map((k) => [k, true]));

function read() {
  const v = uiGet(KEY, null);
  return { ...DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
}

export const sheetPrefs = reactive(read());

export function setSheetPref(key, value) {
  const v = !!value;
  if (sheetPrefs[key] === v) return;
  sheetPrefs[key] = v;
  uiSetIfChanged(KEY, { ...sheetPrefs });
}

/** 全部显示 */
export function showAllSheetBlocks() {
  for (const key of Object.keys(SHEET_BLOCKS)) setSheetPref(key, true);
}

// 开机时从服务器合并下来的更"新"的那份，回灌到这个 reactive 对象里（页面跟着变）
onUiMerged(() => Object.assign(sheetPrefs, read()));
