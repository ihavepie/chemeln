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
  let ghost = null;      // 跟着光标走的那张虚影卡
  let raf = 0;           // 虚影的位置更新、边缘自动滚动都放在这一帧里做
  let holdTimer = 0;     // 落点「稳定一会儿才换」的计时器
  let pendingHit = null; // 手刚滑到、还没落定的那个落点

  function cleanup() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('blur', onCancel_, true);
    document.removeEventListener('dragstart', blockNative, true);
    document.body.classList.remove('is-pointer-dragging');
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
    pendingHit = null;
    dropGhost();
    st = null;
  }

  /**
   * 虚影卡：把卡片复制一份、fixed 跟手走。
   * 没有它的时候拖动只有「原卡淡下去 + 一道落点线」，手上完全没有抓着东西的感觉（用户说「很僵硬」）。
   * 复制体去掉 `data-drag-*`，否则它会挡住 `elementFromPoint` 的命中判断。
   */
  function makeGhost(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const g = el.cloneNode(true);
    g.removeAttribute('data-drag-card');
    g.querySelectorAll('[data-drag-card], [id]').forEach((n) => {
      n.removeAttribute('data-drag-card');
      n.removeAttribute('id');
    });
    g.classList.add('drag-ghost');
    g.style.width = `${r.width}px`;
    g.style.height = `${r.height}px`;
    g.style.left = `${r.left}px`;
    g.style.top = `${r.top}px`;
    document.body.appendChild(g);
    return g;
  }

  function dropGhost() {
    if (!ghost) return;
    const g = ghost;
    ghost = null;
    g.style.transition = 'opacity 120ms ease, transform 120ms ease';
    g.style.opacity = '0';
    window.setTimeout(() => g.remove(), 140);
  }

  /** 离上下边这么近就开始自动滚（列表 / 卡片墙比屏幕长的时候，不然得先自己滚好再拖） */
  const EDGE = 64;
  const SPEED = 16;

  /** 拖动时能滚的那个祖先（`.listpane-body` / `.editor`） */
  function scrollParentOf(el) {
    let p = el?.parentElement || null;
    while (p) {
      const ov = getComputedStyle(p).overflowY;
      if ((ov === 'auto' || ov === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
      p = p.parentElement;
    }
    return null;
  }

  /** 落点是否一样（同一个组、同一个格子） */
  function sameHit(a, b) {
    if (!a || !b) return a === b;
    return a.groupKey === b.groupKey && a.gapAt === b.gapAt;
  }

  /**
   * 落点要「稳定一小会儿」才真的换。
   * 不然手在两张卡片交界处抖一下，占位格就左右跳一次、卡片跟着哗啦哗啦闪——
   * 用户说「让位速度太快了，像是在左右跳动」。第一次落点立刻生效，之后换位置要有耐心。
   */
  const HOLD_MS = 120;
  function considerHit(hit) {
    if (!hit || hit.groupKey === undefined) return;
    if (!st.last || sameHit(hit, st.last)) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
      pendingHit = null;
      if (!sameHit(hit, st.last)) {
        st.last = hit;
        onTarget?.(st.id, hit.groupKey, hit.gapAt);
      }
      return;
    }
    pendingHit = hit;
    if (holdTimer) return;      // 已经在等了，等它落定再换
    holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      const h = pendingHit;
      pendingHit = null;
      if (!h || !st || sameHit(h, st.last)) return;
      st.last = h;
      onTarget?.(st.id, h.groupKey, h.gapAt);
    }, HOLD_MS);
  }

  function follow() {
    if (!st) return;
    const { lastX: x, lastY: y } = st;
    if (ghost) {
      ghost.style.transform = `translate3d(${x - st.x0}px, ${y - st.y0}px, 0) rotate(1.2deg) scale(1.02)`;
    }
    // 边缘自动滚：滚动之后落点要跟着重算，否则手不动、目标却变了
    let scrolled = false;
    if (st.sp) {
      const r = st.sp.getBoundingClientRect();
      const up = y < r.top + EDGE;
      const down = y > r.bottom - EDGE;
      if (up || down) {
        st.sp.scrollTop += up ? -SPEED : SPEED;
        scrolled = true;
      }
    }
    if (scrolled) {
      const hit = hitTest(x, y);
      if (hit && hit.groupKey !== undefined) {
        st.hits += 1;
        considerHit(hit);
      }
    }
    raf = requestAnimationFrame(follow);
  }

  /** 按下期间把 WebKit 的原生拖拽掐掉。
      **这是整套拖动的命门**：元素只要被 WebKit 当成可原生拖拽（`-webkit-user-drag: element`
      或卡片/图片自带的拖拽能力），真鼠标一按一拖就会起一个原生拖拽会话，之后所有 `mousemove`
      都被它吞掉——页面表现为「按着拖完全没反应」，而合成事件（`new MouseEvent`）压根不会启动
      原生拖拽，测试永远绿。所以在按住期间直接拦掉 dragstart。 */
  function blockNative(e) {
    e.preventDefault();
  }

  /**
   * 落点判定用**拖起来那一刻的几何快照**，不再每帧看元素底下是什么。
   * 因为占位格（`.drop-gap` / `.list-drop-slot`）一插进去，卡片就整体让位、
   * 光标底下换成了另一张卡 → 目标在两张卡之间来回翻，看着就是「左右跳动」。
   * 快照按「容器滚动了多少」做纵向补偿，所以自动滚动时仍然准。
   */
  function takeSnapshot() {
    const cards = [];
    document.querySelectorAll('[data-drag-card]').forEach((el) => {
      const r = el.getBoundingClientRect();
      cards.push({
        groupKey: el.dataset.dragGroup,
        idx: Number(el.dataset.dragIndex),
        l: r.left,
        t: r.top,
        w: r.width,
        h: r.height,
      });
    });
    const groups = [];
    document.querySelectorAll('[data-drag-group][data-drag-count]').forEach((el) => {
      const r = el.getBoundingClientRect();
      groups.push({ groupKey: el.dataset.dragGroup, count: Number(el.dataset.dragCount), l: r.left, t: r.top, w: r.width, h: r.height });
    });
    // 小的先试：`.exp-stack` 比整个列表容器小，落在组员行上要算「这一摞的后面」
    groups.sort((a, b) => a.w * a.h - b.w * b.h);
    return { cards, groups };
  }

  function hitTestBySnapshot(x, y) {
    const snap = st && st.snap;
    if (!snap) return null;
    const adj = st.sp ? st.sp.scrollTop - st.snapScroll : 0;
    const yy = y + adj;
    for (const c of snap.cards) {
      if (x >= c.l && x <= c.l + c.w && yy >= c.t && yy <= c.t + c.h) {
        // 落在卡片哪一半：横向网格看左右、竖向列表看上下（取离中心更远的那个轴当主轴）
        const dx = c.w > 0 ? (x - (c.l + c.w / 2)) / (c.w / 2) : 0;
        const dy = c.h > 0 ? (yy - (c.t + c.h / 2)) / (c.h / 2) : 0;
        const after = Math.abs(dx) >= Math.abs(dy) ? dx > 0 : dy > 0;
        return { groupKey: c.groupKey, gapAt: c.idx + (after ? 1 : 0) };
      }
    }
    for (const g of snap.groups) {
      if (x >= g.l && x <= g.l + g.w && yy >= g.t && yy <= g.t + g.h) {
        return { groupKey: g.groupKey, gapAt: g.count };
      }
    }
    return null;
  }

  function hitTest(x, y) {
    const snapHit = hitTestBySnapshot(x, y);
    if (snapHit) return snapHit;
    if (st && st.snap) return null;   // 有快照就以快照为准，别混着 elementFromPoint
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
    st.lastX = ev.clientX;
    st.lastY = ev.clientY;
    if (!st.moved) {
      if (Math.abs(ev.clientX - st.x0) < THRESHOLD && Math.abs(ev.clientY - st.y0) < THRESHOLD) return;
      st.moved = true;
      document.body.classList.add('is-pointer-dragging');
      ghost = makeGhost(st.el);
      if (ghost) ghost.style.transform = 'rotate(1.2deg) scale(1.02)';
      st.sp = scrollParentOf(st.el);
      st.snapScroll = st.sp ? st.sp.scrollTop : 0;
      st.snap = takeSnapshot();
      onStart?.(st.id);
      raf = requestAnimationFrame(follow);
    }
    ev.preventDefault();
    const hit = hitTest(ev.clientX, ev.clientY);
    if (hit && hit.groupKey !== undefined) {
      st.hits += 1;
      considerHit(hit);
    } else {
      st.misses += 1;
    }
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
    // 松手时优先用「刚滑到、还没等它落定」的那个落点：手快的人拖过去就松，不该掉回上一格
    const target = pendingHit || last;
    if (st.lastX !== undefined && ghost) ghost.style.transform += ' rotate(0deg) scale(1)';
    cleanup();
    onCancel?.();
    logDrag({ surface: name, phase: 'up', moved, moves, hits, drop: moved ? target || null : null });
    if (moved) {
      lastDropAt = Date.now();
      if (target && target.groupKey !== undefined) onDrop?.(Number(id), target.groupKey, target.gapAt);
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
      st = {
        id,
        el: ev.currentTarget || ev.target,
        x0: ev.clientX,
        y0: ev.clientY,
        lastX: ev.clientX,
        lastY: ev.clientY,
        sp: null,
        snap: null,
        snapScroll: 0,
        moved: false,
        last: null,
        moves: 0,
        hits: 0,
        misses: 0,
      };
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
