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

/* ---- 内容区的宽度能拖（DSH 那种分隔条）----
   左右**各一条**：右边拖 = 右边缘跟手、宽度变；左边拖 = 左边缘跟手、宽度变
   （右边那条边不动）。导航条宽度完全不动——用户明确否掉过拖导轨。
   两个值写进 `:root`：`--docw`（宽）/ `--docx`（左边让出多少），存 localStorage。
   工作台 / 条件筛选 / 一张筛选表 / 回收站 / 设置 这几页都是 `.single > .inner`。 */
const DOC_KEY = 'eln:docw';
const DOCX_KEY = 'eln:docx';
const DOC_MIN = 560;
const DOC_MAX = 1560;

/** 宽度上限跟着窗口走，别让内容比窗口还宽 */
const maxDoc = () => Math.max(DOC_MIN, Math.min(DOC_MAX, Math.round(window.innerWidth - 300)));

const applyDoc = (w) => {
  const root = document.documentElement;
  if (w > 0) root.style.setProperty('--docw', `${w}px`);
  else root.style.removeProperty('--docw');
};
const applyDocX = (x) => {
  const root = document.documentElement;
  if (x > 0) root.style.setProperty('--docx', `${x}px`);
  else root.style.removeProperty('--docx');
};

const num = (k) => {
  const n = Number(localStorage.getItem(k));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const storedDoc = num(DOC_KEY);
const storedDocX = num(DOCX_KEY);
// 小于下限的宽度当没设过（老版本写过更窄的值也不会把内容压扁）
const docW = ref(storedDoc >= DOC_MIN ? storedDoc : 0);
const docX = ref(storedDocX);
if (docW.value) applyDoc(docW.value);
if (storedDocX) applyDocX(storedDocX);
const docResizing = ref(false);

/** 量一下内容区最多能有多宽（`.single` 的内容盒，扣掉左右内边距） */
function box() {
  const wrap = document.querySelector('.single');
  const inner = document.querySelector('.single > .inner');
  const cs = getComputedStyle(wrap);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const r = inner.getBoundingClientRect();
  return {
    left: r.left,
    right: r.right,
    width: r.width,
    base: wrap.getBoundingClientRect().left + padL,   // 内容区能靠到的最左边
    avail: wrap.clientWidth - padL - padR,            // 内容区最多能有多宽
  };
}

function startDocDrag(e, side = 'right') {
  e.preventDefault();
  const b = box();
  const startX = e.clientX;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  // 宽度上限：窗口上限 / 这一页能给的宽度，取小的
  const capW = Math.max(DOC_MIN, Math.min(maxDoc(), b.avail));
  docResizing.value = true;
  document.body.classList.add('is-doc-resizing');

  let move;
  if (side === 'left') {
    // 左边缘跟手：右边那条边钉住，让出来的宽度 = 左边缩进去多少
    const maxLeft = b.right - DOC_MIN;
    move = (ev) => {
      const left = clamp(b.left + ev.clientX - startX, b.base, maxLeft);
      const x = Math.round(left - b.base);
      const w = Math.round(Math.min(b.right - left, capW));
      docX.value = x;
      docW.value = w;
      applyDocX(x);
      applyDoc(w);
    };
  } else {
    // 右边缘跟手：宽度直接跟着走，左边不动
    const max = Math.max(DOC_MIN, capW - docX.value);
    move = (ev) => {
      const w = clamp(Math.round(b.width + ev.clientX - startX), DOC_MIN, max);
      docW.value = w;
      applyDoc(w);
    };
  }

  const up = () => {
    docResizing.value = false;
    document.body.classList.remove('is-doc-resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    try {
      if (docW.value) localStorage.setItem(DOC_KEY, String(docW.value));
      if (docX.value) localStorage.setItem(DOCX_KEY, String(docX.value));
    } catch { /* 隐私模式写不进去就算了 */ }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function resetDocSize() {
  docW.value = 0;
  docX.value = 0;
  applyDoc(0);
  applyDocX(0);
  try {
    localStorage.removeItem(DOC_KEY);
    localStorage.removeItem(DOCX_KEY);
  } catch { /* 同上 */ }
}

export function useDocSize() {
  return { docW, docX, docResizing, startDocDrag, resetDocSize };
}
