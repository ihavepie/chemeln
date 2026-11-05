/**
 * 文本域高度跟着内容走 + 打印时把文本域换成 div。
 *
 * 为什么：`.sheet-text` 是 rows=2~4 的 textarea，内容一长就变成内部滚动框——
 * 屏幕上只看得见开头几行，打印 / 存 PDF 时更是只印得出它自己那几行高，
 * 后面的表征数据直接没了（用真实打印链路实测过：12 行只印出 5 行）。
 */

export function growTextarea(el) {
  if (!el || el.tagName !== 'TEXTAREA') return;
  // 高度用 !important 写内联，盖过 @media print 里那条 .sheet-text{height:auto!important}
  el.style.setProperty('height', 'auto', 'important');
  const h = el.scrollHeight;
  if (h > 0) el.style.setProperty('height', `${h + 2}px`, 'important');
}

/** 窗口变化后重量一遍（宽度一变，折行数就变了） */
export function growAll() {
  document.querySelectorAll('textarea[data-autogrow]').forEach(growTextarea);
}

/**
 * 把一块 DOM 里的文本域换成同样式的 div（打印 / 存 PDF 用）。
 *
 * 光靠屏幕上的高度不够：纸面比屏幕窄（打印版心 180mm ≈ 680px，屏幕 752px），
 * 折行数会变多，按屏幕量出来的高度照样会截断；div 是自然高度，纸上能完整排下去
 * （页数自然会多，但内容不丢）。
 *
 * 返回「换回去」的函数——系统打印走的是真实 DOM，打完必须还回来。
 */
export function flattenTextareas(root) {
  const saved = [];
  if (!root || !root.querySelectorAll) return () => {};
  for (const ta of root.querySelectorAll('textarea')) {
    const d = document.createElement('div');
    d.className = `${ta.className} is-print-text`;
    d.textContent = ta.value || '';
    ta.parentNode.replaceChild(d, ta);
    saved.push({ ta, div: d });
  }
  return () => {
    for (const { ta, div } of saved) if (div.parentNode) div.parentNode.replaceChild(ta, div);
  };
}
