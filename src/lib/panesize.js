import { ref } from 'vue';
import { onUiMerged, uiGet, uiSetIfChanged } from './uiprefs.js';

/* ---- 内容区的宽度能拖（DSH 那种分隔条）----
   内容区**始终居中**，拖左右任何一条线都只是改宽度（两边同时对称地长缩），
   所以拖动量要乘 2 才能让线一直贴着鼠标。导航条宽度完全不动——用户否掉过拖导轨。
   宽度写进 `:root` 的 `--docw`，走 `lib/uiprefs.js`（浏览器缓存 + 数据库长期存储）。
   工作台 / 条件筛选 / 一张筛选表 / 回收站 / 设置 这几页都是 `.single > .inner`。 */
const DOC_KEY = 'docw';
const DOC_MIN = 560;
const DOC_MAX = 1560;

/** 宽度上限跟着窗口走，别让内容比窗口还宽 */
const maxDoc = () => Math.max(DOC_MIN, Math.min(DOC_MAX, Math.round(window.innerWidth - 300)));

const applyDoc = (w) => {
  const root = document.documentElement;
  if (w > 0) root.style.setProperty('--docw', `${w}px`);
  else root.style.removeProperty('--docw');
};

const num = () => {
  const n = Number(uiGet(DOC_KEY, 0));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const storedDoc = num();
// 小于下限的宽度当没设过（老版本可能写过更窄的值）
const docW = ref(storedDoc >= DOC_MIN ? storedDoc : 0);
if (docW.value) applyDoc(docW.value);
const docResizing = ref(false);

/** 量一下这一页的内容盒能有多宽（扣掉左右内边距） */
function box() {
  const wrap = document.querySelector('.single');
  const inner = document.querySelector('.single > .inner');
  const cs = getComputedStyle(wrap);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  return {
    width: inner.getBoundingClientRect().width,
    avail: wrap.clientWidth - padL - padR,
  };
}

function startDocDrag(e, side = 'right') {
  e.preventDefault();
  const b = box();
  const startX = e.clientX;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const cap = Math.max(DOC_MIN, Math.min(maxDoc(), b.avail));
  // 居中：宽度一半在左、一半在右，所以鼠标挪 1px 宽度得变 2px 才跟得上
  const dir = side === 'left' ? -2 : 2;
  docResizing.value = true;
  document.body.classList.add('is-doc-resizing');

  const move = (ev) => {
    const w = clamp(Math.round(b.width + (ev.clientX - startX) * dir), DOC_MIN, cap);
    docW.value = w;
    applyDoc(w);
  };
  const up = () => {
    docResizing.value = false;
    document.body.classList.remove('is-doc-resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    uiSetIfChanged(DOC_KEY, docW.value || 0);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function resetDocSize() {
  docW.value = 0;
  applyDoc(0);
  uiSetIfChanged(DOC_KEY, 0);
}

// 开机合并下来别的地方设过宽度：直接用（`--docw` 是 root 上的变量，改了立刻生效）
onUiMerged(() => {
  const w = num();
  const next = w >= DOC_MIN ? w : 0;
  if (next === docW.value) return;
  docW.value = next;
  applyDoc(next);
});

export function useDocSize() {
  return { docW, docResizing, startDocDrag, resetDocSize };
}
