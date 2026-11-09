import { reactive, ref } from 'vue';

/**
 * 表格视图的表头拖拽改列宽（`ExpTable` / `CmpTable` 共用）。
 *
 * 按住某一列标题的右边界横拖：这一列变宽、**它旁边那列等量变窄**（最后一列则吃左边那列），
 * 所有列的宽度和不变，所以整张表不会跳、拖多少就是多少。
 * 宽度按表存进 localStorage（`eln:colw:<表名>`），下次进来还是你调好的样子。
 *
 * 只吃鼠标事件（`mousedown` → window 上 `mousemove` / `mouseup`）：WebKit 里
 * 表格单元格上的 pointer 事件常被「拖选文字」吞掉，跟拖卡片那套一个理由。
 */
const KEY = 'eln:colw:';
const MIN_W = 44;      // 任何一列都不能压到看不见

export function useColResize(name, defaults) {
  const order = Object.keys(defaults);

  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY + name) || 'null');
      // 只认表里真有的列：删列 / 改列名后残留的键别带进来
      if (v && typeof v === 'object') for (const k of order) if (typeof v[k] === 'number') defaults[k] = v[k];
    } catch {}
    return { ...defaults };
  };

  const widths = reactive(read());
  const tableEl = ref(null);
  let drag = null;

  const save = () => {
    try {
      localStorage.setItem(KEY + name, JSON.stringify({ ...widths }));
    } catch {}
  };

  function start(ev, colKey) {
    const table = tableEl.value;
    const i = order.indexOf(colKey);
    if (!table || i < 0 || order.length < 2) return;
    ev.preventDefault();
    ev.stopPropagation();
    // 把当前实测宽度全固化成 px：列里还写着默认值时，拖起来会跟鼠标对不上
    for (const th of table.querySelectorAll('thead th')) {
      const k = th.dataset.col;
      if (k) widths[k] = Math.round(th.getBoundingClientRect().width);
    }
    // 换谁的空间：优先右边那列；拖的是最后一列就吃左边那列
    const otherKey = order[i + 1] || order[i - 1];
    drag = {
      colKey,
      otherKey,
      base: widths[colKey],
      otherBase: widths[otherKey],
      startX: ev.clientX,
      moved: false,
    };
    document.body.classList.add('is-col-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onMove(ev) {
    if (!drag) return;
    const dx = ev.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    // 增量在这一列和邻居之间搬，两头都夹住
    const d = Math.min(Math.max(dx, MIN_W - drag.base), drag.otherBase - MIN_W);
    widths[drag.colKey] = Math.round(drag.base + d);
    widths[drag.otherKey] = Math.round(drag.otherBase - d);
  }

  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.classList.remove('is-col-resizing');
    if (drag?.moved) save();
    drag = null;
  }

  const total = () => Object.values(widths).reduce((a, b) => a + (b || 0), 0) || 1;

  /**
   * 给 <col> 用的 style：内部按 px 记（拖起来好算），渲染时换成百分比。
   * 换百分比是因为窗口一变窄，px 宽度的表会顶出横向滚动条；百分比永远刚好铺满，
   * 而拖拽时两列一增一减、总和不变，所以视觉上还是 1:1。
   */
  const colStyle = (key) => {
    const w = widths[key];
    return w ? `width: ${((w / total()) * 100).toFixed(3)}%` : '';
  };

  return { widths, tableEl, start, colStyle };
}
