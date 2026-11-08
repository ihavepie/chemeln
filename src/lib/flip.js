import { nextTick } from 'vue';

/**
 * 让「占位格一插进去、整面墙重排」变成滑动，而不是瞬间跳一格。
 *
 * 为什么不能直接用 CSS 过渡：网格（grid)里的卡片重排是**布局变化**，`transition` 管不到
 * `top/left` 这种由布局算出来的位置（连 `transition: all` 也不行）。业界通用做法是 FLIP：
 *   First  —— 改状态前，先把每张卡现在的屏幕位置记下来；
 *   Last   —— 改完（DOM 已更新）再量一次新位置；
 *   Invert —— 立刻给它一个 `transform`，把它从**旧位置**摆回去（这时看着没动）；
 *   Play   —— 下一帧把这个 transform 清掉，卡片就顺着过渡滑到新位置。
 *
 * 用法：
 * ```js
 * onTarget: (id, groupKey, gap) => {
 *   withFlip([...document.querySelectorAll('[data-drag-card]')], () => {
 *     dropKey.value = groupKey;
 *     gapAt.value = gap;
 *   });
 * }
 * ```
 * 注意：别把要拖动的那张（`.drag-ghost` 是克隆体，不在列表里）算进来是没问题的，
 * 被拖的原卡本来就淡着，跟着滑反而自然。
 */
export function withFlip(elements, mutate, { ms = 180 } = {}) {
  const first = new Map();
  for (const el of elements) first.set(el, el.getBoundingClientRect());
  mutate();
  nextTick(() => {
    for (const el of elements) {
      const a = first.get(el);
      if (!a || !el.isConnected) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;   // 没挪就不折腾
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      // 强制一次样式计算，让「摆回旧位置」先落进布局，否则下一帧的过渡不会发生
      void el.offsetWidth;
      el.style.transition = `transform ${ms}ms var(--ease, ease)`;
      el.style.transform = '';
      window.setTimeout(() => {
        el.style.transition = '';
        el.style.transform = '';
      }, ms + 40);
    }
  });
}
