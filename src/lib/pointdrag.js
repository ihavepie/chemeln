/**
 * 拖动排序（自己实现，不走 HTML5 拖放）。
 *
 * **为什么不用原生拖放**：卡片都是 `<button>`，Safari/WebKit 对 button 上的 `draggable="true"`
 * 经常不起拖（`-webkit-user-drag: element` 也不一定救得回来），用户实测就是「按着拖没反应」；
 * Pointer Events 在 button 里也常被吞。所以这里用最普通的 **mouse 事件** 自己做。
 *
 * 约定（调用方给卡片挂这几个属性）：
 * - 卡片：`data-drag-card="<id>"` + `data-drag-group="<组 key>"` + `data-drag-index="<组内下标>"`
 * - 组容器：`data-drag-group="<组 key>"` + `data-drag-count="<组内条数>"`
 *
 * 用法：
 * ```js
 * const sorter = createPointerSort({
 *   name: 'grid',                                  // 诊断日志里好认是哪个面
 *   onTarget: (id, groupKey, gapAt) => { ... },
 *   onDrop: (id, groupKey, gapAt) => moveTo(id, groupKey, gapAt),
 * });
 * // 卡片上：@mousedown="sorter.down($event, c.id)"，点击处用 sorter.clickIsDrag() 拦一下
 * ```
 */

import { logDrag } from './draglog.js';

/** 移动超过这个距离（px）才算「拖」，否则当成点击 */
const THRESHOLD = 6;

/** 刚放手那一下的点击要吞掉（不然拖完还会跳进那张卡片） */
let lastDropAt = 0;

export function clickAfterDrag() {
  return Date.now() - lastDropAt < 300;
}

export function createPointerSort({ name = '?', onStart, onTarget, onDrop, onCancel } = {}) {
  let st = null;

  function cleanup() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('blur', onCancel_, true);
    document.removeEventListener('dragstart', blockNative, true);
    document.body.classList.remove('is-pointer-dragging');
    st = null;
  }

  /** 按下期间把 WebKit 的原生拖拽掐掉。
      **这是整套拖动的命门**：元素只要被 WebKit 当成可原生拖拽（`-webkit-user-drag: element`
      或卡片/图片自带的拖拽能力），真鼠标一按一拖就会起一个原生拖拽会话，之后所有 `mousemove`
      都被它吞掉——页面表现为「按着拖完全没反应」，而合成事件（`new MouseEvent`）压根不会启动
      原生拖拽，测试永远绿。所以在按住期间直接拦掉 dragstart。 */
  function blockNative(e) {
    e.preventDefault();
  }

  function hitTest(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const card = el.closest('[data-drag-card]');
    if (card && card.dataset.dragGroup !== undefined) {
      const groupKey = card.dataset.dragGroup;
      const idx = Number(card.dataset.dragIndex);
      const r = card.getBoundingClientRect();
      // 落在卡片哪一半：横向网格看左右、竖向列表看上下。
      // 取「离中心更远的那个轴」当主轴——比按宽高比猜稳：卡片墙里同一行的左右边缘、
      // 列表里窄卡的上下边缘都不会判错。
      const dx = r.width > 0 ? (x - (r.left + r.width / 2)) / (r.width / 2) : 0;
      const dy = r.height > 0 ? (y - (r.top + r.height / 2)) / (r.height / 2) : 0;
      const after = Math.abs(dx) >= Math.abs(dy) ? dx > 0 : dy > 0;
      return { groupKey, gapAt: idx + (after ? 1 : 0) };
    }
    const group = el.closest('[data-drag-group][data-drag-count]');
    if (group) return { groupKey: group.dataset.dragGroup, gapAt: Number(group.dataset.dragCount) };
    return null;
  }

  function onMove(ev) {
    if (!st) return;
    st.moves += 1;
    if (!st.moved) {
      if (Math.abs(ev.clientX - st.x0) < THRESHOLD && Math.abs(ev.clientY - st.y0) < THRESHOLD) return;
      st.moved = true;
      document.body.classList.add('is-pointer-dragging');
      onStart?.(st.id);
    }
    ev.preventDefault();
    const hit = hitTest(ev.clientX, ev.clientY);
    if (hit && hit.groupKey !== undefined) {
      st.hits += 1;
      onTarget?.(st.id, hit.groupKey, hit.gapAt);
    } else {
      st.misses += 1;
    }
    st.last = hit;
    // 每 8 次移动记一行：拖动现场不刷屏，也看得出移动事件到底有没有进来
    if (st.moves === 1 || st.moves % 8 === 0) {
      logDrag({
        surface: name,
        phase: 'move',
        moved: st.moved,
        moves: st.moves,
        hits: st.hits,
        misses: st.misses,
        x: ev.clientX,
        y: ev.clientY,
        hit: hit || null,
      });
    }
  }

  function onUp() {
    if (!st) return;
    const { id, moved, last, moves, hits } = st;
    cleanup();
    onCancel?.();
    logDrag({ surface: name, phase: 'up', moved, moves, hits, drop: moved ? last || null : null });
    if (moved) {
      lastDropAt = Date.now();
      if (last && last.groupKey !== undefined) onDrop?.(Number(id), last.groupKey, last.gapAt);
    }
  }

  function onCancel_() {
    if (!st) return;
    const { moves, moved } = st;
    cleanup();
    onCancel?.();
    logDrag({ surface: name, phase: 'cancel', moves, moved });
  }

  return {
    /** 卡片上 @mousedown="sorter.down($event, c.id)" */
    down(ev, id) {
      if (ev.button !== 0) return;
      if (id === undefined || id === null) return;
      st = { id, x0: ev.clientX, y0: ev.clientY, moved: false, last: null, moves: 0, hits: 0, misses: 0 };
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('blur', onCancel_, true);
      document.addEventListener('dragstart', blockNative, true);
      // 按下就记一行：日志里没有 down，就说明 mousedown 根本没到组件上
      logDrag({
        surface: name,
        phase: 'down',
        id,
        x: ev.clientX,
        y: ev.clientY,
        target: ev.target?.className || ev.target?.tagName || '',
      });
    },
    /** 点击时先问一句：这次点击是不是拖动收尾？是就别跳转 */
    clickIsDrag() {
      return clickAfterDrag();
    },
    cancel: onCancel_,
  };
}
