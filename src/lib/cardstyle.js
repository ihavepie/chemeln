import { uiGet, uiSetIfChanged } from './uiprefs.js';

/**
 * 「卡片」这套质感（页面里那些白卡 / 排版板那张画布卡）的可调项。
 *
 * 只存两样：**样式**（白卡 / 只要描边 / 不要卡）和**圆角**（小 6 / 中 10 / 大 14）。
 * 落到 `<html>` 上的是两个 CSS 变量 + 一个 `data-card`，
 * 所以改完所有页面立刻跟着变，不用每个组件各记一份。
 */
export const CARD_STYLES = [
  { key: 'card', label: '白卡', hint: '白底 + 极淡描边 + 轻投影' },
  { key: 'line', label: '只要描边', hint: '白底 + 一圈线，不投影' },
  { key: 'none', label: '不要卡', hint: '内容直接铺在底上' },
];
export const CARD_RADII = [
  { value: 6, label: '小' },
  { value: 10, label: '中' },
  { value: 14, label: '大' },
];
const DEFAULT = { style: 'card', radius: 10 };

export function cardPref() {
  const v = uiGet('card', null);
  const style = CARD_STYLES.some((s) => s.key === (v && v.style)) ? v.style : DEFAULT.style;
  const radius = CARD_RADII.some((r) => r.value === Number(v && v.radius)) ? Number(v.radius) : DEFAULT.radius;
  return { style, radius };
}

/** 把偏好写进 `<html>`（CSS 变量 + data-card），所有页面一次生效 */
export function applyCardStyle(pref) {
  const { style, radius } = pref || cardPref();
  const root = document.documentElement;
  root.style.setProperty('--card-r', `${radius}px`);
  root.setAttribute('data-card', style);
}

export function setCardStyle(patch) {
  const next = { ...cardPref(), ...patch };
  uiSetIfChanged('card', next);
  applyCardStyle(next);
  return next;
}

export function resetCardStyle() {
  return setCardStyle({ style: DEFAULT.style, radius: DEFAULT.radius });
}
