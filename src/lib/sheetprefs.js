import { reactive } from 'vue';

/**
 * 记录页（那张 A4 纸）上要显示哪几块。
 * 纯前端偏好：存 localStorage `eln:sheet`，跟记录本身无关，所以不进 settings 表。
 * 关掉的块**页面和打印 / 存 PDF 都不出现**（打印是克隆页面 DOM，v-if 掉的自然没有），
 * 数据本身不会丢，重新勾上就回来了。
 */
const KEY = 'eln:sheet';

export const SHEET_BLOCKS = {
  env: '环境（温度 / 湿度）',
  literature: '文献',
  scheme: '反应式',
  reagents: '投料表 + 条件',
  result: '结果与选择性',
  tlc: 'TLC',
  procedure: '一 · 实验操作与现象',
  workup: '二 · 后处理',
  characterization: '三 · 表征数据',
  conclusion: '四 · 讨论与结论',
  attachments: '附件',
};

const DEFAULTS = Object.fromEntries(Object.keys(SHEET_BLOCKS).map((k) => [k, true]));

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const sheetPrefs = reactive(read());

export function setSheetPref(key, value) {
  sheetPrefs[key] = !!value;
  try {
    localStorage.setItem(KEY, JSON.stringify(sheetPrefs));
  } catch {
    /* 存不了就算了，本页仍然生效 */
  }
}

/** 全部显示 */
export function showAllSheetBlocks() {
  for (const key of Object.keys(SHEET_BLOCKS)) setSheetPref(key, true);
}
