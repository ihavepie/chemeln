/**
 * 拖动排序（自己实现，不走 HTML5 拖放）。
 *
 * **为什么不用原生拖放**：卡片都是 `<button>`，Safari/WebKit 对 button 上的 `draggable="true"`
 * 经常不起拖（`-webkit-user-drag: element` 也不一定救得回来），用户实测就是「按着拖没反应」。
 * 这里用最普通的 **mouse 事件** 自己做（mousedown / mousemove / mouseup）：不依赖拖放实现，
 * 也不用 Pointer Events（某些 Safari 版本上 button 里的 pointer 事件会被吞），任何浏览器都一样。
 *
 * 约定（调用方给卡片挂这几个属性）：
 * - 卡片：`data-drag-card="<id>"` + `data-drag-group="<组 key>"` + `data-drag-index="<组内下标>"`
 * - 组容器：`data-drag-group="<组 key>"` + `data-drag-count="<组内条数>"`
 *
 * 用法：
 * ```js
 * const sorter = createPointerSort({
 *   onTarget: (groupKey, gapAt) => { dropKey.value = groupKey; gapIdx.value = gapAt; },
 *   onDrop: (id, groupKey, gapAt) => moveTo(id, groupKey, gapAt),
 * });
 * // 卡片上：@pointerdown="sorter.down($event)"，点击处用 sorter.clickIsDrag() 拦一下
 * ```
 */

/** 移动超过这个距离（px）才算「拖」，否则当成点击 */
const THRESHOLD = 6;

/** 刚放手那一下的点击要吞掉（不然拖完还会跳进那张卡片） */
let lastDropAt = 0;

export function clickAfterDrag() {
  return Date.now() - lastDropAt < 300;
}

export function createPointerSort({ onStart, onTarget, onDrop, onCancel } = {}) {
  let st = null;

  function cleanup() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('blur', onCancel_, true);
    document.body.classList.remove('is-pointer-dragging');
    st = null;
  }

  function hitTest(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const card = el.closest('[data-drag-card]');
    if (card && card.dataset.dragGroup !== undefined) {
      const groupKey = card.dataset.dragGroup;
      const idx = Number(card.dataset.dragIndex);
      const r = card.getBoundingClientRect();
      // 横排看左右半边、竖排看上下半边（两种墙/列表都能用）
      const horizontal = r.width > r.height * 0.6;
      const after = horizontal ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
      return { groupKey, gapAt: idx + (after ? 1 : 0) };
    }
    const group = el.closest('[data-drag-group][data-drag-count]');
    if (group) return { groupKey: group.dataset.dragGroup, gapAt: Number(group.dataset.dragCount) };
    return null;
  }

  function onMove(ev) {
    if (!st) return;
    if (!st.moved) {
      if (Math.abs(ev.clientX - st.x0) < THRESHOLD && Math.abs(ev.clientY - st.y0) < THRESHOLD) return;
      st.moved = true;
      document.body.classList.add('is-pointer-dragging');
      onStart?.(st.id);
    }
    ev.preventDefault();
    const hit = hitTest(ev.clientX, ev.clientY);
    if (hit && hit.groupKey !== undefined) onTarget?.(st.id, hit.groupKey, hit.gapAt);
    st.last = hit;
  }

  function onUp() {
    if (!st) return;
    const { id, moved, last } = st;
    cleanup();
    onCancel?.();
    if (moved) {
      lastDropAt = Date.now();
      if (last && last.groupKey !== undefined) onDrop?.(Number(id), last.groupKey, last.gapAt);
    }
  }

  function onCancel_() {
    cleanup();
    onCancel?.();
  }

  return {
    /** 卡片上 @pointerdown="sorter.down($event, c.id)" */
    down(ev, id) {
      if (ev.button !== 0) return;
      if (id === undefined || id === null) return;
      st = {
        id,
        x0: ev.clientX,
        y0: ev.clientY,
        moved: false,
        last: null,
      };
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('blur', onCancel_, true);
    },
    /** 点击时先问一句：这次点击是不是拖动收尾？是就别跳转 */
    clickIsDrag() {
      return clickAfterDrag();
    },
    cancel: onCancel_,
  };
}
