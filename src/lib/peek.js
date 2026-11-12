import { reactive } from 'vue';
import { onUiMerged, uiGet, uiSetIfChanged } from './uiprefs.js';

/**
 * 编辑页「平行书签悬停预览」要显示哪些块。
 * 纯界面偏好：走 `lib/uiprefs.js`（浏览器缓存 + 数据库长期存储），跟记录内容无关。
 */
const KEY = 'peek';
const DEFAULTS = {
  conditions: true, // 溶剂 / 浓度 / 温度 / 时长 / 气氛
  substrates: true, // 底物 → 产物
  result: true, // 产率 / ee / dr / 质量
  conclusion: true, // 结论
  notes: false, // 备注
};

function read() {
  const v = uiGet(KEY, null);
  return { ...DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
}

export const peekPrefs = reactive(read());

export function setPeekPref(key, value) {
  const v = !!value;
  if (peekPrefs[key] === v) return;
  peekPrefs[key] = v;
  uiSetIfChanged(KEY, { ...peekPrefs });
}

export const PEEK_LABELS = {
  conditions: '条件（溶剂 / 浓度 / 温度 / 时长 / 气氛）',
  substrates: '底物 → 产物',
  result: '结果（产率 / ee / dr / 质量）',
  conclusion: '结论',
  notes: '备注',
};

// 开机合并后回灌（另一台机器改过的话，这一页也跟着变）
onUiMerged(() => Object.assign(peekPrefs, read()));
