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

/* ---- 内容区的宽度也能拖（DSH 那种分隔条）----
   线在**内容区自己**的右边（`--docw`），拖它只改内容区宽度：左边导航条不动，
   多出来的空白吃到右边去。工作台 / 条件筛选 / 一张筛选表 / 回收站 / 设置
   这几页都是 `.single > .inner`，宽度读这个变量，存 localStorage。
   为什么不做成「导轨↔内容」那条：导轨宽度是固定的，拖那条等于改导航条宽度，
   用户明确说过不要（2026-11 那轮）。 */
const DOC_KEY = 'eln:docw';
const DOC_MIN = 560;
const DOC_MAX = 1560;

/** 上限跟着窗口走，别让内容比窗口还宽 */
const maxDoc = () => Math.max(DOC_MIN, Math.min(DOC_MAX, Math.round(window.innerWidth - 300)));

const applyDoc = (w) => {
  const root = document.documentElement;
  if (w > 0) root.style.setProperty('--docw', `${w}px`);
  else root.style.removeProperty('--docw');
};

const storedDoc = (() => {
  const n = Number(localStorage.getItem(DOC_KEY));
  return Number.isFinite(n) && n >= DOC_MIN ? Math.round(n) : 0;
})();
if (storedDoc) applyDoc(storedDoc);

const docW = ref(storedDoc);
const docResizing = ref(false);

function startDocDrag(e) {
  e.preventDefault();
  const startX = e.clientX;
  const inner = document.querySelector('.single > .inner');
  const startW = docW.value || Math.round(inner?.getBoundingClientRect().width || 980);
  const max = maxDoc();
  docResizing.value = true;
  document.body.classList.add('is-doc-resizing');
  const move = (ev) => {
    const w = Math.min(Math.max(Math.round(startW + ev.clientX - startX), DOC_MIN), max);
    docW.value = w;
    applyDoc(w);
  };
  const up = () => {
    docResizing.value = false;
    document.body.classList.remove('is-doc-resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (docW.value) {
      try { localStorage.setItem(DOC_KEY, String(docW.value)); } catch { /* 隐私模式写不进去就算了 */ }
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function resetDocWidth() {
  docW.value = 0;
  applyDoc(0);
  try { localStorage.removeItem(DOC_KEY); } catch { /* 同上 */ }
}

export function useDocSize() {
  return { docW, docResizing, startDocDrag, resetDocWidth };
}
