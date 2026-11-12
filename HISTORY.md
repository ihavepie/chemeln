
- **投料表抬头 + 反应规模这两个孤零零的东西顺手收了一下**（用户圈着「投料表」和右边那格「反应规模 0.2 mmol」说「这两个稍微优化一下」）：①「条件」那一行改成**外层 6 列网格**（`1fr 0.8fr 1.18fr 1.05fr 1fr 0.9fr`），`CondRow` 自己那个 5 列网格用 `display: contents` **摊平** —— 六格间距均匀，反应规模不再飘在最右边、跟「光照」之间空一大截（`display: contents` 只在 EditorView 的桌面版用得到，手机版不走 CondRow）；②`ReagentTable` 的抬头加 `block-head-flat`：去掉满宽的底边线、margin 收到 1px —— 「投料表」现在紧贴心下面的条件行，当这一整块的小标题（`结果` 那些 block-head 不受影响）。
