
- **选择器开着时把页面锁住，滚轮别带着整页跑**（用户：「页面可能会被滚轮滚动，页面需要固定一下」）：`CondRow` 里 `watch(open)` → 开的时候在 `document` 上挂 **capture 阶段的 `wheel` 监听** `onLockWheel`（`preventDefault()`，`passive:false`），关的时候摘掉；刻度滑条自己的 `@wheel` 照样继续拨格子（`preventDefault` 不影响冒泡）。另外 `.editor { overscroll-behavior: contain }`，滚到头不把橡皮筋传给外层。**验证**：弹窗开着时在 `.editor` 上发一个 wheel → `defaultPrevented: true`；关着 → `false`（页面照常滚）。
