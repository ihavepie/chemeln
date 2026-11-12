
- **反应规模那个数字重新排了一下**（用户圈着 `0.2mmol`：「感觉这个数字得要优化一下，看着有点奇怪」）：原来数字右对齐、`mmol` 是**绝对定位**贴在最右边（数字左边一大块空白、单位和数字像两截）。改成：输入用 `type="text" inputmode="decimal"`（`number` 在 Safari 里字号/步进器都别扭，`setBase(num())` 照样解析），数字用**等宽字体 12px + tabular-nums**（跟投料表里 MW / mmol 一个口径），`mmol` 从小定位改成 flex 里的下一个元素（9.5px、ink-3、跟数字同一个基线、间距 3px）。
