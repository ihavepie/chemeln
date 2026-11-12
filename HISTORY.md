
- **条件行别显示「打字光标」**（用户：「单击的时候不要是打字那个光标」）：那几格现在是「单击出选择、双击编辑」，鼠标移上去却还是输入框的 I 形光标，看着像要打字。`.cond-above .cond-f-val input { cursor: default }` 改掉。**注意**：`:focus { cursor: text }` 写了也没用 —— WebKit 在文本输入框获得焦点时自己画 I 形光标，`getComputedStyle().cursor` 也照样报 `default`（实测），别在那儿绕。
