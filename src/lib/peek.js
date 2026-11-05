import { reactive } from 'vue';

/**
 * 编辑页「平行书签悬停预览」要显示哪些块。
 * 纯前端偏好（存 localStorage），跟记录本身无关，所以不进 settings 表。
 */
const KEY = 'eln:peek';
const DEFAULTS = {
  conditions: true, // 溶剂 / 浓度 / 温度 / 时长 / 气氛
  substrates: true, // 底物 → 产物
  result: true, // 产率 / ee / dr / 质量
  conclusion: true, // 结论
  notes: false, // 备注
};

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const peekPrefs = reactive(read());

export function setPeekPref(key, value) {
  peekPrefs[key] = !!value;
  try {
    localStorage.setItem(KEY, JSON.stringify(peekPrefs));
  } catch {
    /* 存不了就算了，本页仍然生效 */
  }
}

export const PEEK_LABELS = {
  conditions: '条件（溶剂 / 浓度 / 温度 / 时长 / 气氛）',
  substrates: '底物 → 产物',
  result: '结果（产率 / ee / dr / 质量）',
  conclusion: '结论',
  notes: '备注',
};
