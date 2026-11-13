/**
 * 「点外面就关」的守卫。
 *
 * 为什么需要它：鼠标一抖、或者手快连着点两下的时候，第一下把弹窗打开、第二下落在弹窗
 * 外面（同一格但不在弹窗上，或者干脆是别处），document 上的「点外面」立刻把刚出来的
 * 弹窗关掉 —— 用户看到的是「点了没反应」或者「太灵敏」。所以**刚打开的这一小会儿，
 * 外面那一下点击不算数**。
 *
 * 用法：弹窗打开时 `markPopupOpen()`；在「点外面关闭」的处理器开头
 * `if (ignoreOutsideClick()) return;`。
 */
let lastOpenAt = 0;
const GUARD_MS = 320;

/** 弹窗（下拉 / 胶囊菜单 / 候选列表 / 浮层）打开时调一次 */
export function markPopupOpen() {
  lastOpenAt = Date.now();
}

/** 这次「外面」的点击要不要忽略？（刚打开 → 忽略，别把弹窗秒关） */
export function ignoreOutsideClick() {
  return Date.now() - lastOpenAt < GUARD_MS;
}
