/**
 * 拖动诊断：把一次拖动的现场发给本机服务，落到 `data/drag-debug.log`。
 *
 * 为什么需要它：合成事件在测试里永远「成功」，真鼠标却可能一个 `mousemove` 都传不到页面。
 * 用户拖一次之后，日志里就能看出到底卡在「按下没触发」「没收到移动」「起了拖但没落点」哪一步。
 * 关掉：控制台执行 `localStorage.elnDragDebug = '0'`。
 */
export function logDrag(payload) {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.elnDragDebug === '0') return;
    fetch('/api/debug/drag', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 记不上就算了，绝不能影响拖动本身 */
  }
}
