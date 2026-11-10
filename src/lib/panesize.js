import { ref } from 'vue';

/**
 * 中栏列表和纸面之间那条分隔线可以拖（跟 DSH 布局里那条面板分隔条一个路数）。
 *
 * 宽度写进 `:root` 的 `--listw`，`.panes` 的网格列宽读它；存 localStorage，
 * 是这台浏览器上的偏好、不进库。0 = 没设过，用 CSS 里的默认宽。
 * 只吃 mouse 事件：Safari 里列表上的 pointer 事件常被拖选吞掉（跟 lib/colresize.js 一个理由）。
 */
const KEY = 'eln:listw';
const MIN = 236;
const MAX = 620;

/** 纸面得留够地方（一张 A4 加两边留白），所以上限跟着窗口走 */
const maxWidth = () => Math.max(MIN, Math.min(MAX, Math.round(window.innerWidth * 0.42)));

const apply = (w) => {
  const root = document.documentElement;
  if (w > 0) root.style.setProperty('--listw', `${w}px`);
  else root.style.removeProperty('--listw');
};

const stored = (() => {
  const n = Number(localStorage.getItem(KEY));
  return Number.isFinite(n) && n >= MIN ? Math.round(n) : 0;
})();
// 模块加载时就套上，别等挂载——不然会先按默认宽画一帧再跳过去
if (stored) apply(stored);

const width = ref(stored);
const resizing = ref(false);

function startDrag(e) {
  e.preventDefault();
  const startX = e.clientX;
  const pane = document.querySelector('.listpane');
  const startW = width.value || Math.round(pane?.getBoundingClientRect().width || 336);
  const max = maxWidth();
  resizing.value = true;
  document.body.classList.add('is-pane-resizing');
  const move = (ev) => {
    const w = Math.min(Math.max(Math.round(startW + ev.clientX - startX), MIN), max);
    width.value = w;
    apply(w);
  };
  const up = () => {
    resizing.value = false;
    document.body.classList.remove('is-pane-resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (width.value) {
      try { localStorage.setItem(KEY, String(width.value)); } catch { /* 隐私模式写不进去就算了 */ }
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function resetWidth() {
  width.value = 0;
  apply(0);
  try { localStorage.removeItem(KEY); } catch { /* 同上 */ }
}

export function usePaneSize() {
  return { width, resizing, startDrag, resetWidth };
}

/* ---- 左侧导轨（导航条）的宽度也能拖：DSH 那种「侧栏 / 内容」分隔条 ----
   只在 ≥821px 时出现（手机上导轨本来就不渲染）。宽度同样存在 localStorage。 */
const RAIL_KEY = 'eln:railw';
const RAIL_MIN = 168;
const RAIL_MAX = 320;

const applyRail = (w) => {
  const root = document.documentElement;
  if (w > 0) root.style.setProperty('--railw', `${w}px`);
  else root.style.removeProperty('--railw');
};

const storedRail = (() => {
  const n = Number(localStorage.getItem(RAIL_KEY));
  return Number.isFinite(n) && n >= RAIL_MIN ? Math.round(n) : 0;
})();
if (storedRail) applyRail(storedRail);

const railW = ref(storedRail);
const railResizing = ref(false);

function startRailDrag(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = railW.value || Math.round(document.querySelector('.rail')?.getBoundingClientRect().width || 212);
  railResizing.value = true;
  document.body.classList.add('is-rail-resizing');
  const move = (ev) => {
    const w = Math.min(Math.max(Math.round(startW + ev.clientX - startX), RAIL_MIN), RAIL_MAX);
    railW.value = w;
    applyRail(w);
  };
  const up = () => {
    railResizing.value = false;
    document.body.classList.remove('is-rail-resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (railW.value) {
      try { localStorage.setItem(RAIL_KEY, String(railW.value)); } catch { /* 同上 */ }
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function resetRailWidth() {
  railW.value = 0;
  applyRail(0);
  try { localStorage.removeItem(RAIL_KEY); } catch { /* 同上 */ }
}

export function useRailSize() {
  return { railW, railResizing, startRailDrag, resetRailWidth };
}
