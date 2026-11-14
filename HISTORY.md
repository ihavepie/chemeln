- **导出全线改「截图 PDF」+ 画布第一轮（任意角度箭头 / 四角手柄 / 撤销 / 吸附）**。
  ① **导出**：用户「不想走会变 CSS 样式的那种 pdf，可以接受压信息，所有导出都是」。`shot.swift` 重写成**多页**（`shot <out> <宽> <snapWidth> <url…>`，`.pdf` 时每张截图铺满一页），`/api/snapshot/pdf` 收 `pages[]`（≤40）；`PrintPanel`（记录两页/三页）、`LabelBatchPanel`（标签多页）、`EditorView` 的汇报卡、板页全部改走它，CSS 末尾追加 `SNAP_NO_ZOOM`（`print.js`，把 `body{zoom:0.7498}` 压回 1，截图才按 794px = A4 出图）。`snapWidth` = 794×2 ≈190dpi。矢量 `print/pdf` 留着但界面不再用。
  ② **任意角度箭头**：原来只有「水平一根 CSS 三角」，现在画成 **inline SVG**（viewBox 用 mm，两端铺满）：`dir` 左右 + `up` 上下决定「尾 → 头」是哪条对角，箭头三角在 mm 空间里算，所以任意角度、粗细、放大都不糊。**老数据没有 `up`** → 按中线水平画（不这么兼容，历史板子里的箭头会全变斜）。
  ③ **手柄**：形状出四角（nw/ne/sw/se）、块和文字出左右两个（高度是内容撑的，上下拉没意义）。`startDrag(ev, it, mode, corner)`，`applyMove` 里按方位算 x/y/w/h；从左上/右上拉时 x/y 跟着走。
  ④ **撤销 / 重做**：整份快照栈（`undoStack`/`redoStack`，各 80 步），挂在 items 的 deep watcher 上、**400ms 归组**——一次拖动 / 连续几下键盘算一步；`restoring` 标记防止恢复本身入栈；⌘Z / ⇧⌘Z + 头部两个 ↶ ↷ 按钮。
  ⑤ **吸附**：除了纸边/纸中线，还能贴**别的块**的左中右、上中下（4.5mm 内取最近），出竖 / 横两条参考线（`.board-guide.is-h` 新加）。工具条的方向按钮改成 ⇄ / ⇅ 两颗。
  坑（**记一下**）：手柄名是方位（'ne'/'sw'…），第一版用 `corner.includes('r') / ('b')` 判断方向，'se' 里根本没有 'r'，结果拖角完全不动、查了半天——现在改成 `endsWith('e') / startsWith('n')` 这类方位判断。
  验证：临时板（24，验完删）——选中箭头出现 4 个手柄；拖 se 角 (+140,+170) 后 `width:190mm / height:169.6mm`、`svg viewBox 0 0 190 94.8`、line 从 (0,0) 斜到 (187,93)（任意角度成立）；⌘Z 回到 190×94.8、⇧⌘Z 又回到 169.6（撤销/重做对）；拖动方块时出现竖参考线、松手 `left:0mm`（吸到纸左边）；截图 PDF 两页测试 MediaBox `595.5×842.25`、内容正着。
- **排版板导出改成「截图做 PDF」+ 另给 PNG**（用户：「pdf 导出感觉不是特别需要了……那个 pdf 导出好像会出问题，感觉截图做成 pdf 更好」）。
  矢量那条路（`print.swift` 的 `createPDF` + PDFKit 合并）在板页上不稳，干脆不用了：
  ① `shot.swift` 加了一种输出——`out` 以 `.pdf` 结尾时，把**整页截图铺满一页 PDF**（页面尺寸按 CSS px 折 pt：A4 竖 595.5×842.25、横 842.25×595.5），另收一个 `snapWidth` 参数按像素出图（A4 宽 794 → 1588 = 2 倍 ≈190dpi，2382 ≈288dpi）。
  ② 两条新路由 `POST /api/snapshot/pdf`（截图铺满一页）/ `POST /api/snapshot/png`（多收 `snapWidth`），`api.js` 里加了 `snapshotPdf / snapshotPng`（共用 `binary()` 助手）。
  ③ 板页：`snapDoc()` 用 `boardHtml()` 出整页 HTML + `SNAP_CSS`（BOARD_CSS + 清边距，**不带 `body{zoom:0.7498}`**——那是给 595px 打印视口缩页的，截图按 CSS px 出图），宽度按纸张算（竖 794 / 横 1123）；「导出 PDF」= 2 倍像素铺满一页，「存图」= 3 倍 PNG。
  坑：**CGImage 画进 PDF 时别再翻**——按老经验 `translate + scale(1,-1)` 翻了一次，结果整页倒着（实测 `ctx.draw(cg, in:)` 直接就是正的）；另外 `shot.swift` 有缓存二进制（`.cache/shot*-render`），改了源就得把文件名换一个，否则还是旧行为（这次换成 `shot3-render`）。
  验证：`node` 里直接 import `src/lib/board.js` 造一张板 → 打这两个接口：PDF 200 / 80KB / MediaBox `595.5 842.25`（横版 `842.25 595.5`）、PNG 200 / 2382×3369；`sips` 转出来的 PDF 截图与 PNG 的排版一致、字是正的；UI 里点「导出 PDF」拿到 `PDF 好了（截图铺满一页）` 提示（临时板 23，验完删）。
- **排版板：框选 + 多选（PPT / ChemDraw 那种）**（用户：「需要框选工具，有类似的轮子吗」）。
  **结论：没有直接用现成库**——`selecto` / `moveable`（daybrush）确实是专门做这个的轮子，`fabric.js` / `konva` / `tldraw` 也能，但这块画布是「HTML 块 + 0.1mm 坐标 + 整纸 `zoom` + 内容统一走 `itemHtml()`」，换成 canvas 框架等于把渲染层重写（还会跟导出 PDF 那条路分叉）。所以按现有 mouse-event 体系自己写，一共 ~120 行。
  ① 选中从「一个 id」改成**一组 id**（`selIds`）：`isSel(it)` 给模板挂 `.is-sel`，`selItem` 只在恰好选一个时才有（缩放手柄也只在这时出现），`selItems` 给多选操作；`clearSel / selectOne` 收口。
  ② **框选**：纸面空白处 `@mousedown.self="onPageDown"` 起橡皮筋（`.bd-marquee`，`position:fixed` 贴鼠标的虚线框，挂 body），命中**按每块的真实 DOM 矩形**比——块的高度是内容撑的，只有 `getBoundingClientRect` 量得准；Shift 框选 = 加选；点一下空白 = 取消选择。
  ③ **整组操作**：多选里拖其中一块 → 整组一起挪（`dragGroup` 记每块的 `el` 和原坐标，拖动期间只改各块 transform，松手才写 left/top）；`clampDelta()` 把整组当一个矩形夹边界（别把组拉变形）；置顶/置底/⌘D 复制/Delete/方向键都支持整组。
  验证：临时板（22，验完删，塞了方框 / 箭头 / 远处文字三块）——框住前两块，`.is-sel` = 2、工具条显示「2 块 置顶 置底 复制 删除」；拖其中一块 +60/+40px，两块都跟着（15mm→40.6mm、y 同步 +17.1mm），第三块没动；⌘D 后 3→5 块且新的 2 块被选中，Delete 后回到 3 块。
- **排版板：工具改成「先拿在手上，再在纸上点 / 拖」（像 ChemDraw 的画布）**（用户：「点击那些工具不是马上添加，是鼠标在页面点击之后才能加，然后可以控制箭头位置什么的」）。
  ① **落笔状态**：`tool` 存当前拿着的工具（`'' | text | concl | arrow | box`），点 `＋文字 / ＋结论 / ＋箭头 / ＋方框` 只是 `armTool(kind)`（再点一次 / Esc / 右键收笔）；拿在手上时按钮 `.is-on` 高亮、标题右边出一句提示（`TOOL_HINTS`），整张纸 `.is-armed` 变十字光标（纸上的块也跟着变，不然看不出在落笔状态）。
  ② **画的关系**：`.board-page` 上挂 `@mousedown.capture="onDrawDown"` —— 落笔时把 `mousedown` 在捕获阶段吃下来（`stopPropagation`），块自己的拖拽 / 选中一律不触发。按下记起点（画布单位），拖到哪儿画到哪儿：**箭头**按横向拖的距离定长度、按拖动方向定箭头朝向（往左拖就是 `dir:'left'`、箭头在左头），**方框**按拖出的矩形定位置和长宽；**点一下不拖**（位移 < 1.2mm）就给默认大小（箭头 150mm / 方框 140×60mm）。文字和结论就是点一下落在点上。
  ③ **草稿**：拖的过程中先按 `itemHtml` 渲一块 `.is-draft`（透明度 .62、`pointer-events:none`），松手前就能看出粗细和朝向；松手才 `push` 进 `items`（防抖 700ms 自动存照旧）。工具**用完不收笔**，可以连着画好几根，Esc / 右键 / 再点按钮才收。
  坑（**这个必须记住**）：Safari 里 `zoom` 元素的 `getBoundingClientRect()` —— **位置要再乘一次 zoom、尺寸也是乘 zoom**（实测 zoom .619 时 `rect.left` 1170、纸上真实左边 724 = 1170×.619；`rect.width` 794、可视 491 = 794×.619）。`pointAt()` 里写 `(clientX - rect.left * zoom) * unitsPerPx()` 才对；只减 `rect.left` 会让整笔偏移好几百像素（第一版就是这样，箭头落到了纸外）。用 `elementFromPoint` 扫纸的真实边界核对过。
  验证：临时板（20、21，验完删）——点工具后按钮高亮 / 提示在 / 纸变十字光标；按住 200px 往左拖，出来的箭头 `left:40.5mm / width:85.4mm` 与按几何算的 40.5 / 85.5mm 一致，箭头头在左端（截图里对着按下点 / 松手点画的红蓝标记核过）；拖矩形出方框、点一下出默认大小的文字；Esc 之后提示和高亮都消失、光标回 `auto`。
- **排版板素材栏：搜记录里的字 + 悬停预览**（用户：「需要搜索内部文字，然后悬浮在某个胶囊或者图片上就能查看」）。
  ① **搜索**：抽屉头加 `.searchbox.bd-q`（复用中栏列表那个），`bdQ` → `q`；`hayOf(e)` 把「编号 / 题目 / 描述 / 底物 / 产物 / 分类 / 类型 / 溶剂 / 温度 / 试剂名 / TLC 注 / 详情正文」拼一串小写再 `includes`。**试剂名从 `reagent_sig` 拆**（列表接口没有 `reagents`，sig 是 `role:名字:当量:…|…`，取第二段）；**详情正文**（`procedure` / `workup` / `characterization` / `conclusion` / `notes` / `tlc_note` / `addition` / `steps_json`）要靠 `expCache`，所以输入后 220ms 补一把 `ensureExp`（`ensureExp` 现在按 id 去重 in-flight，边敲边搜不会一轮轮重发）。命中的不是编号 / 题目时，`hintOf(e)` 在编号下面标一行「结论 · …预搅拌30min以上」。
  ② **悬停预览**：胶囊 / TLC 小图 `@mouseenter` → 170ms 延迟后在素材栏右边弹 `.bd-peek`（`pointer-events:none`，纯看不吃点击；`@scroll` / `mouseleave` 收掉），标题是「编号 · 块名」，内容**还是走 `blockHtml`**（详情没到先给「读取中…」，别拿列表那份去画成「投料表是空的」）；块按真实毫米宽排完再 `zoom` 到卡片宽度（`peekZoom`，反应式和对比表不缩）；TLC 那张**不设卡片宽度**、让图自己定宽（`max-width:300px; max-height:56vh`）——踩过：写死 420 宽时竖构图板子只占一小条、右边一片白。
  坑：`img` 有一条全局规则带 `max-height:142px`，`.bd-peek-img` 得显式盖掉（`max-width/max-height` 都要写，只写一个会被裁成 60px 宽）。
  验证：临时板（id 19，验完删）搜「LAH」命中 1/9 并标出「试剂 · …LDA LAH THF」；搜「预搅拌」（只在 SJ-2-2 的结论里）命中 1/9，说明补拉详情那条路通了；悬停「投料」「结果」「条件」三种胶囊各有预览，TLC 小图出大图；1440×900 截图核对。
- **排版板：素材搬到页面级左栏 + 收集工具上顶**（用户截图圈着抽屉左边那片空地说「素材的话放在侧边栏，然后一些工具就放在内容区的顶部」）。
  ① **`.board-drawer` 从 `.inner` 里搬出去**，跟导轨并排：`flex: 0 0 288px`、通高、纸白底 + 右边一条 `--line` 淡分界，内部拆成 `.board-drawer-top`（「素材 · N 条记录」+ 对比表… / 成组摆放…）和 `.board-drawer-body`（自己滚）；`.board-single` 改成 `display:flex; padding:0`，留白挪到 `.board-single > .inner`（`34px 48px 16px`）。原来抽屉只有 196px 挤在内容区里，胶囊老折成两行、纸也被压扁；现在 288px 一行排得下（字号顺手从 10.5 提到 11–13，TLC 小图 38 → 46）。
  ② **收集工具（＋文字 / ＋结论 / ＋箭头 / ＋方框）从抽屉底部挪到内容区顶部**：`.board-head` 加了 `display:flex`（以前 `.page-head` 压根不是 flex，那些按钮其实是左对齐掉在说明下面一行），右边 `.board-head-acts` 两行——第一行 已保存 / A4 / 100% / 导出 PDF / 删除，第二行 `.board-palette` 那四颗。**不额外占一行高度**（正好顶在左边说明那两行的高度里），纸不会被挤小。说明文字顺手删掉了「（靠边 / 居中有吸附）」「拖右下角改宽」，不然和右边工具撞成两行。
  ③ **板页只留右边那条 `.doc-grip`**：内容区贴到素材栏边时，左边那条 34px 判定区会压在胶囊上抢点击，板上直接 `display:none`（双击右边那条一样回默认宽度）。
  坑：`.mv` 覆写 `BoardView.vue` 时报 `set owner/group: Operation not permitted`（外置盘），内容其实写进去了；`evaljs` 返回 Promise 会报 `unsupported type`，要测点击后的 DOM 就改用 `.cache/jssnap` 的 seed 里点、等 3 秒截图。
  验证：临时板（id 18，验完删）点「＋文字」「箭头」都能落到纸上、颜色条/粗细/方向都出得来，点素材胶囊能加块（`elementFromPoint` 命中 chip）；1440×900 与 1180×720 两个宽度截了图；用户板 16 只读、7 个块没动。
- **设置页侧边栏「更像侧边栏」+ 功能搜索**（用户：「更像侧边栏一点吧，然后加上功能搜索」）。
  ① 样子收敛到导轨那套语言：模块条目 13px、当前项 `#eae7e1` 实底 + 500 字重（原来是纸白卡 + 投影，看着像浮在内容上的卡片，没有「栏」的感觉）；侧栏头里塞了搜索框（`.searchbox`，跟中栏列表同款）。
  ② **功能搜索**：`SET_SEARCH` 是一张「设置项 → 模块 + 锚点」的索引（记录本标题 / 编号前缀 / 局域网 / 备份 / 课题分类 / 快捷键 / 书签预览 / 显示哪几块 / 块里的功能 / 反应式条件格式 / 挂几张板 / 用量小数位 / 常用选项），`kw` 里放英文别名。输入就先把侧栏换成命中列表（每条两行：设置项 + 所属模块），点一条 = **切到那个模块 + 滚到那一行 + `is-flash` 闪一下**（1.4s）。
  行上加了锚点 `set-blocks` / `set-fx` / `set-scheme` / `set-tlc-n` / `set-decimals` / `set-quick`（`scrollIntoView({block:'center'})`，滚动容器是 `.editor`）。
  验证：输 `tlc` 命中「结果表最右那格 · 挂几张板（记录页）」，点它 → 模块切到 05 记录页、页面滚到那一行；搜「备份」「产率」「编号」也各有命中；不输入时侧栏回模块列表。
- **设置页的二级侧边栏改成真的中栏**（用户：「这个二级侧边栏不要属于内容区域，干脆直接做成二级侧边栏，类似化合物或者实验侧边栏」）。
  上一版是塞在内容卡片里的一列字（sticky 的 `.set-nav`，还带灰底），看着像内容的一部分。现在整页换成 `.panes` 布局：
  **左边 `.listpane`（bone 底 + 右分隔线 + 自己滚，宽 208px）**，头是 serif 的「设置」，下面一列模块（编号 mono + 名称；当前块是**纸白卡 + 淡投影 + 强调色编号**，跟中栏列表的当前条一个调子）；
  **右边 `.editor > .editor-inner`**（跟别的页面同一套纸面留白），页头换成当前模块的名字 + 说明。`DocGrip` 从这个页面拿掉了（panes 布局不需要拖内容宽度）。
  窄屏（≤900px）：侧栏变成上方一条（标题 + 横向胶囊），正文在下面。
  验证：1400px 下左侧是独立的一栏（跟「实验记录」那根一模一样，只是窄）、模块切换只换右半边；880px 下侧栏收成顶部胶囊行。
- **「TLC 那列开关」和「挂几张板」合并成一个控件**（用户截了设置页那两行：「这两个是不是有点功能重复了」）——确实重复：关掉列时张数无意义，张数 > 0 又暗含列存在。
  改法：删掉 `SHEET_FX` 里的 `resTlc`（不再按记录类型各记一个开关），`tlcN` 的取值范围放到 **0–3**：**0 = 不挂这一列**、1–3 = 挂几张；设置页那一行改叫「结果表最右那格 · 挂几张板」，胶囊 `不挂 / 1 张 / 2 张 / 3 张`（`TLC_N_LABEL`）。`ResultBlock` 的 `showTlc` prop 去掉，`hasTlcCol = tlcMax > 0 && tlc.length`。
  验证：`tlcN = 0` → 结果表表头没有 TLC、缩略图 0 张；`= 2` → 有 TLC 列、2 张；设回 `1` 后 1 张。
- **设置页分模块 + 二级侧边栏**（用户：「设置这边开始有点复杂了，可以分模块然后做二级侧边栏」）。
  原来七张卡一竖排滚到底。现在左侧一列模块（`.set-nav`，sticky，纸面滚它不动），右侧只渲染当前那一块（卡片 `v-if="mod === 'xx'"`）：
  **01 记录本**（记录本信息）/ **02 数据与备份** / **03 课题与分类** / **04 界面**（快捷键 + 书签悬停预览）/ **05 记录页**（记录页显示 + 常用选项）。
  卡片上原来那些 `01`–`07` 大号数字去掉了（侧边栏已经编号，留着会跳号），页头那句说明改成**当前模块的说明**（`SET_MODS[].desc`）。
  当前块存 `uiprefs` 新键 `setMod`（服务端 `UI_PREF_KEY_RE` 同步加了）；**`onUiMerged` 里要再读一次**——bootstrap 的合并比组件 setup 晚一拍，
  不重读的话刷新后总是停在默认那块（踩过：本地缓存明明是 `page`，界面却回「记录本」）。
  窄窗口（≤900px）侧栏收成一行胶囊（`border-radius: 999px`），避免挤掉正文。
  验证：五个模块点着都能正确切换、内容只挂当前那块（`.set-nav-item.is-on` + 对应卡片），刷新后停在上次的模块（`localStorage` 与服务器 `ui_prefs.setMod` 一致）；880px 宽下侧栏变成横向胶囊、正文铺满。
- **反应式条件排版做成「格式」可选项：设一个，不满足就自动退到另一个**（用户：「设置一个格式，然后如果不满足这个格式的话就默认到另一个格式，这个格式也可以到模块定义那边」）。
  三种格式，全局一个（不分记录类型，整本子长相要一致）：
  `auto`（默认）——先按**单行**排，那一行字超过 **430px** 就退回**两行**（再宽整张图会被拉长、结构被缩小）；
  `single`——永远单行，箭头跟着字变长；
  `wrap`——最多两行（每行 340），箭头短、结构大。
  `composeChainSvg({ stages, background, fmt })` 多收一个 `fmt`；实现就是两套 `caps` 预算：`oneLine() = caps(above, 1, ∞)`、`twoLine() = caps(above, 2, 340)`，`auto` 量完 `widest(...)` 再决定。
  设置放在**设置页 06（模块定义那张卡）**：「反应式 · 箭头上那行条件」一排胶囊 + 当前格式的说明；存 `uiprefs` 新键 `schemeFmt`（服务端 `UI_PREF_KEY_RE` 加了这个 key，白名单和 `sheetprefs.js` 的 `sheetSchemeFmt` / `setSchemeFmt` / `SCHEME_FMT_OPTS` 一处都不能漏）。
  调用方全传上了：记录页实时那张、生成反应式附件那张、条件筛选清单的组头缩略图、我的筛选表表头；`liveSig` 里加了 `sf`（换格式要重画），`SCHEME_LAYOUT_VER` 3 → 4（老缓存清掉）。
  验证：206（条件那行 ~420px）→ `auto` 与 `single` 都是单行（viewBox 874×262、画到 570×171）；切 `wrap` → 两行（768×282、画到 570×209），第 1 页 `scrollHeight - clientHeight` 都是 0；设回 `auto`。
- **反应式铺满格子、条件强制单行、空白收紧**（用户：「条件单行，不要超出箭头，左右间距空白不要太大，不要缩成一小块、空白尽可能少，宽松一点但不要太散」）。
  量出来真正的毛病在 CSS：`.scheme-live svg` 是 `max-width:100% + max-height:190px + width:auto`，**高度先撞顶**——206 那条的图自然比例 710×290，被压成 465×190 塞在 572 宽的格子里，**左右各空 53px**（就是「缩成一小块 + 左右空白大」）。改成 `width:100%; height:auto; max-height:240px` → 570×171，宽度吃满、高度还矮了 19px（第 1 页更宽松）。打印那份 `max-height` 保持 190 不动（打印恒 2 页是硬规矩）。
  图内部（`lib/scheme.js`）：① **箭头上那行条件永远一行**——`above = caps(st.above, 1, 1e6)`，不再按 360 预算折两行；`MAX_ARROW` 提到 680、只当极端长的兜底；② **箭头跟着字长**：`arrowLen = max(110, 字宽 + 50)`（两头各留 25px，字绝不会画出箭头），节点宽 = 线长 + 26（原来是 `max(arrowLen, capW) + 26`，字贴着箭头边缘）；③ 空白收紧：`PAD 12→8`、每个分子自带的透明边 `EDGE 10→6`，`GAP 12→14`（结构之间略松一点，别太挤）。
  `SCHEME_LAYOUT_VER` 2 → 3（启动清 `scheme_cache`，否则老图继续贴）。验证：206 单段 → 图 570×171（格子 572），条件「Pd(OPiv)₂ (10 mol%), CsOPiv (10 mol%), [L], HFIP (2.0 eq)」一行落在箭头里、两侧各留 ~25px；287 两步反应 → 1157×262 缩进 570 宽、两根箭头的条件各自单行；三条记录第 1 页 `scrollHeight - clientHeight` 都还是 0。
- **变量行的数字跟投料表对齐**（用户截着 变量 [L] 那两行：「需要和投料表里面的接近一点，字体什么的还有格式」）。
  量出来差的正是四样：投料表那几格是 `<input class="n">` = **SF Mono / 11px / 500 / 强调色 `rgb(124,51,21)` / 右对齐 / `padding 4px 4px 4px 6px`**；
  变量行的 `td.n` 是 **11.5px / 400 / `--ink-4` 灰**（看着像「没填」），当量那格 `.cond-eq` 又是 SF Pro 12.5px 深色，名字格比上面小一号、td 内边距也差 1px。
  改法（末尾追加一段，不动原来那几条）：`tr.rt-var td.n` 对齐成 mono 11 / 500 / 强调色 / `0 3px`；`var-amt` 给 600（跟投料表「用量」一样粗）；`.cond-eq` 也按 `.n` 排（mono 11 / 500 / 强调色 / 右对齐）；`.cond-in`（名字）12.5px、内边距 `4px 6px`；`tr.rt-var > td` 左右各 3px。
  「—」不能跟着变强调色 —— 模板里改成 `<span class="var-na">—</span>`，单独压成 `--ink-4`、字重 400（跟溶剂行那个 — 一个调子）。
  验证（`getComputedStyle` 一行行量）：变量行的 MW / 当量 / mmol 现在都是 `SF Mono 11px 500 rgb(124,51,21)`、`padding 0 3px`，量与名字也对上了；截图里两行跟上面 HFIP / dioxane 那两行的数字粗细、颜色、右边距看着是一条线。
- **设置页 07「常用选项」：内置那几条也能删、也能挪了**（用户看着那一排 `−78 ℃ … 回流` 问：「要不内置也可以删？」）。
  以前内置的在 `lib/ui.js` 的 `QUICK` 里写死，设置页只给「只显示」，自己加的才带 `‹ › ×`；现在整行就是**一份完整列表**：
  动过之后存 `quickFull:<字段>`（连内置一起，删掉的就不在里面），读的时候它优先于「内置 + 以前自己加的」旧的 `quick:<字段>`；
  设置页多一颗「恢复默认」（`items: null` 删掉 `quickFull`，就回到内置那几条）——动过才出现。
  ① 服务端 `PUT /api/quick` 多收 `full`：`full:true` 写 `quickFull:<字段>`（**空数组也照存**，用户可以把一行删光），`items:null` 才是删掉这一份；
  ② `store.js` 新增 `quickFull(field)`（`null` = 没动过）/`quickList(field)`（完整列表，前端所有下拉都读它）；
  ③ `CondRow` 的候选和下拉里的 × 全改成 `quickList` + `full:true`（内置的也能在记录页就地删掉）；④ 设置页那排 chip 不再分「内置 / 自己加的」，一律带 `‹ › ×`。
  验证：删掉「时间节点」里的 **30 min** → `quickFull:duration` 落盘且列表里没有它、设置页出现「恢复默认」、其余四行照旧（没有 reset 按钮）；点「恢复默认」→ 该键被删、30 min 回来、按钮消失；`quick:temperature` 里自己加的「110 ℃」等旧数据不受影响（读路径会把它并进来）。
- **白边这轮翻回来了：定宽盒子 + 图注按盒宽排**（上一轮把盒子改成 `fit-content` 跟着图缩，用户看了实拍：「感觉还是允许白边吧，图注被裁剪掉了」）。
  窄板（562×1330，宽高比 0.42）跟着缩到 60px 宽时，下面那行图注「预搅拌时间不够」被输入框裁掉一半 —— 图注比板子宽是常态（「和氢化环化对比」7 个字就 63px 起）。现在 `.sec-tlc .tlc-shot.has-cap` 定宽 **104**、图 `width:100% + height:142 + object-fit:contain`（居中、两侧留白），图注 `width:100%`；照片 `.sec-shots` 同规定宽 **124**（文献图 200），打印高度 TLC 104 / 照片 120 不变。
  量过：129 那 5 块板和 5 条图注都是 **104 / 102px**，`scrollWidth === clientWidth`（一个字都没被截），第 2 页纸张仍 `over=0`。
- **条件组「变量」那几行的试剂名也能查分子量，查到的自动落进试剂库**（用户截了「变量 [L] Entry 1 RuPhos / Entry 2 Dcpf」：「这边也要可以查询，如果查不到就自己去找网站关联上」）。
  原本这两行只有本地字典（化合物库 → 试剂库）能找到 MW 才显示；而**变量行里的试剂名不在投料表里**，保存时不会走 `touchReagentLib`，所以永远不会进试剂库、也就永远查不到（RuPhos 恰好以前在投料表用过才有数，Dcpf 一直 `—`）。
  改法：① **服务端 `verifyReagent` 补了「库里没这条就插入」**——查到了才落一行进 `reagent_lib`（带 role、MW、密度、`checked_at`/`ok`），查不到不落（免得堆一堆空条目）；`POST /api/reagents/verify` 多收一个 `role`，记录页把变量槽的组分名（配体 / 催化剂…）报上去，试剂库里就归到对的一组。② **前端 `EditorView`**：抽出 `mwOfName(name)`（化合物库 → 试剂库）给 `varInfo` 和查询共用；`lookupVarName(name, {force, role})` 打 `/api/reagents/verify`，成功后 `loadBoot()` 重读字典 → 那一行的 MW / mmol / 用量 立刻算出来；变量值**停下来 900ms 自动查一次**（只在本地确实没有 MW、名字 ≥2 字时发请求），表里还留一颗小按钮（`查 MW` / `查中…` / `查不到`，红色、点了强制重查）可以手动触发。
  验证：`POST /api/reagents/verify {name:"XPhos"}` → `ok, mw 476.72` 且 `reagent_lib` 多一行（清理掉了）；假名字 → `miss`、库里不落行。打开 SJ-2-8（206）后两行自动关联上：**RuPhos → 456.54**、**Dcpf → 578.57**（都是「配体」，PubChem 里 Dcpf 是 1,1'-双(二环己基膦)二茂铁），表里 Entry 1 变成 `456.54 / 20% / 0.04 mmol / 0.0183 g`、Entry 2 `578.57`，行高仍是 26 / 27px。试剂库里也出现 RuPhos（组分 配体、ρ 1.26、用法签 20%×6）。
  坑：`watch` 的 getter 在 setup 里**立刻跑一次**，我第一版把它写在 `condVars` 之前 → TDZ 报错、变量行整块不渲染（页面其余部分照常，截图看不出来，靠 `document.querySelectorAll('.rt-var').length` 才发现）；移到 `condVars` 之后就好了。
- **图片盒子跟着图自己的比例走，去掉那圈白边**（用户截了第 2 页的 TLC 区：「这种图片什么的尽量不要白边」）。
  成因有两层：① `TlcStrip` 里照片 / TLC 的盒子都是**写死宽度**（`.sec-shots` 124px、我上一轮给 TLC 图注那版 112px）配 `object-fit: contain`，竖长条或横长的图就只能在框里居中留白——实测他这块板子是 562×1330（宽高比 0.42），塞进 112×142 的框里左右各留 26px 白；② 图注 `width: 100%` 让输入框**自带的 20 字符固有宽度（123px）**参与了 shrink-to-fit，把 60px 宽的板子撑成 123px 的白框（量出来 `fig=125 img=60` 才发现的）。
  改法：盒子只给「最大」尺寸，`display: block; width: fit-content; overflow: visible; background: transparent`，图 `height` 定住（TLC 142 / 照片 164 / 文献 140）、`width: auto` 按比例长，图注 `width: 0; min-width: 100%`（百分比不参与 shrink-to-fit，最后按父宽算）；打印另给一套（TLC 104 / 照片 120）。`@media print` 里那条 `.sheet .tlc-shot{height:116px}` 的硬高度照旧要 `height:auto !important` 顶掉，否则图注被裁。
  验证（只读看 129 / 182）：129 那 6 块板（74×167 到 84×168）和 2 张照片（109×167 / 132×167）现在都贴边、没有白圈，宽度各不相同、高度一致；182 那块 562×1330 从「112×142 里留一圈白」变成 `fig=62 img=60`（`getBoundingClientRect` 量的），第 2 页纸张 `scrollHeight - clientHeight = 0`。
- **结果表那几列可以关、TLC 那格能放 1–3 张**（用户：「这边那个 tlc 缩略图可以自选放置多少吗，然后结果那个字段也可以选择性显示」）。`SHEET_FX`（设置页 06 第三层，**按记录类型各记一套**）新增三条：`resAppear`（性状列）/ `resDrEe`（dr·ee 列）/ `resTlc`（TLC 板图列），默认全开；`ResultBlock` 多收 `showAppear` / `showDrEe` / `showTlc`，`<colgroup>` 的 `<col v-if>` 必须跟着一起挂（只挂 `<td>` 会错位）。张数是**全局一个数** `sheetTlcMax`（`uiprefs` 新键 `tlcN`，1/2/3，服务端 `UI_PREF_KEY_RE` 同步加了 `tlcN` 和之前漏掉的 `sheetFx`），设置页 06 用一排 `qchip` 选；`ResultBlock` 里 `refShot` 换成 `refShots`：明确引用的那张排第一，其余按 id 新→旧，`slice(0, tlcMax)`，那一列宽度按张数算（`n*28+10`）；每张各点各的看大图，「换」还是那个挑板弹窗（现在语义是「先挂哪张」）。验证：把「试反应」那一套的 性状 / dr·ee 关掉、`tlcN` 设 2 → 结果表只剩 产物名称 / MW / 质量 / 产率 / TLC，最右那格两张缩略并排；清掉测试偏好后回到 5 列 + 1 张（测试只写浏览器缓存，服务器的 `ui_prefs` 事后核对过没被改）。
- **第 2 页 TLC 板图能写图注 + 大图上能批注**（用户：「第二页那个 tlc 也需要图注，然后展开图可以加批注什么的吗」）。
  ① **图注**：`TlcStrip` 早就带 `captions` / `onCaption`（照片、文献图在用，注释里写着「TLC 不写」），这次把 TLC 也接上：`EditorView` 那段传 `captions` + `cap-placeholder="图注，如 2 h / 对照"` + `:on-caption="saveCaption"`，存进 `attachments.note`（跟照片同一份，`PUT /api/attachments/:id`）。**板子跟着长大**：base 的 `.tlc-shot` 是 `92×132 + overflow:hidden` 死高度，图注会被裁掉，所以 `.sec-tlc .tlc-shot.has-cap` 改成 `112px` 宽、`height:auto`、`overflow:visible`，img `112×142`、图注 `112px` 宽 9px 小字（96px 时占位文字被截得只剩半句）；打印另给一套（`height:auto !important` + img `104px`），比原来的 116px 还略矮，第 2 页没变高。
  ② **批注**：`FilePreview` 多收 `expId` / `category`（传了 `expId` 才有「批注」按钮，化合物页那种没有，保持原样）。点「批注」→ `.fp-shot` 里铺一张绝对定位的 canvas，红笔（`#c0392b`，2.4px）自由画圈 / 划线；笔画存**归一化坐标**（0–1），窗口缩放、换设备都不跑位；「撤销 / 清空 / 存成新图」。「存成新图」= 把原图和笔画合成一张：`canvas` 按**原图原始尺寸**铺（`k = naturalW / 显示宽`，线宽也跟着乘，另加 1.6px 下限——几十像素宽的小截图按比例算出来不到半像素）、`toBlob` → `FormData(file, category)` → **`POST /api/experiments/:id/attachments`**，名字 `原名-批注.png`（原图是 JPEG 就存 JPEG q0.92，否则一张 90 KB 的手机照会变成 1 MB+ PNG，排版板和 PDF 都要吃这个体积）。**原图一个字节不动**：合成图就是一张普通附件，打印 / 排版板 / 汇报卡 / 手机版全都不用改；`@saved` 让 `EditorView.refreshAttachments()` 刷一遍，新图立刻出现在 TLC 里（也立刻成为结果区那格的默认板）。
  ③ **批注时把图放大**：小截图（TLC 板常常只有 84px 宽）按原尺寸画根本圈不准，所以 `pen` 打开时弹窗固定 `min(620px, 92vw)`，并把 `.fp` / `.fp-shot` 从 `width:fit-content` 顶成 `100%`、img `width:100%`（`.fp.is-image` 那条是 shrink-to-fit，不改它 img 的 100% 也是缩着的，踩过）。
  验证（只读用户的 129 / 182，临时附件与文件都已删干净）：画一个圈 + 一条线 → 画布上有像素（737）、工具条出来、点「存成新图」后附件数 +1；合成图取回来与原图**同尺寸**、红笔位置对得上（84×168 那张、1200×1600 的 TLC 照片都试了）；JPEG 原图存下来 176 KB（PNG 版本 1.17 MB）；图注写进 `attachments.note` 后页面上真的显示，清掉后回到占位文字；第 2 页纸张 `scrollHeight - clientHeight = 0`（图注没把它顶出去）。
- **结果表最右一列挂 TLC 板图；「TLC 判断」五档和「选择性测定」两行撤掉**（用户截了结果区圈了三处：「放在这个里，然后这些好像不是很必要」，追问后回「直接收掉了，应该不需要这个，加了之后就太繁琐了」）。
  ① **板图进表格**：`ResultBlock` 结果表加一列 `TLC`（`<col class="r-tlc">` 40px / 窄窗口 36px），格子里是 26px 高的板子缩略（`box-shadow: 0 0 0 1px var(--line-2)` 当细边），**点开就是大图**（原来那个 `FilePreview`），多张板时格子右下角**悬停**出「换」（`.tlc-mini-swap`，`opacity 0 → 1`，`noprint`），开原来的 `.tlc-pick` 弹窗挑。**没引用过 `tlc_shot_id` 就默认最新一张**（`id` 最大）——空着一格等用户先点「选」太啰嗦。**这条记录一张板都没有时整列不出现**（`v-if="tlc.length"` 同时挂 `<col>` / `<th>` / `<td>`，否则所有人白搭 40px 宽）。多步记录只在最后一行挂缩略（板是整条记录的，不是某一步的）。
  ② **两行撤掉**：结果表下面那行「TLC 判断」五档胶囊（上一轮刚加的）、以及「选择性测定」那行（ee / 方式 / 手性柱 / tR，原来由设置页 06 的 `sel` 开关管，顺手把 `SHEET_FX` 里那条也删了，免得留一个点了没反应的开关）。**数据列一个没删**：`tlc_verdict` / `ee_pct` / `sel_method` / `sel_condition` / `sel_rt` 还在库里、`EXP_COLUMNS` 里、导出里，排版板的「TLC 判断」块和对比表那一列照旧读它（现在没人往里写，所以板上是空/`—`）。产率格的「待测」占位跟着撤了（它靠 `tlc_verdict` 触发）。
  ③ **踩的坑（花了不少时间）**：`refShot` 里写 `props.tlc.reduce((a, b) => Number(b.id) > Number(a.id) ? b : a, null)` —— 种子是 `null`，**第一次回调就读 `a.id`** → `TypeError: null is not an object`，而这个错是在 computed 里、渲染时抛的，**生产构建下整块 `.res-table` 静默消失**（没有红字、没有 toast，页面其余部分照常），一开始误判成「块开关被关了」。正确写法 `(!a || Number(b.id) > Number(a.id) ? b : a)`，种子也能用 `tlc[0]`。定位办法：临时加一个 `try/catch` 的 computed 把 `e.message` 写进 `window.__dbg`，再用 `.cache/evaljs` 读；`console.error` / `app.config.errorHandler` 都抓不到它。A/B 靠 `git stash` + 只改一个文件 + `npm run build` 二分（`document.querySelectorAll('.res-table').length` 一句就够）。
  验证（只读看用户记录，测试用的附件行和文件都已删干净）：SJ-2-6（1 张板）→ 结果表 8 格、最右一格是 `1000051760.jpg` 的缩略；SJ-2-7（1 张）同上；SJ-2-2（2 张）→ 缩略是最新那张、悬停出「换」、弹窗 2 个选项、点缩略 `.fp-img` 的 `src` 就是 `/api/files/98` 那张；SJ-2-12（无板）→ 表头回到 7 列、没有空列；1280 宽下表格 `scrollWidth - clientWidth = -1`（不外溢）；结果块高度 81px → 83px（第 1 页余量没变）。

- **「单击还是进光标」的根治：让输入框平时点不到**（用户又截了一张：单击后那一格真的拿了焦点、带上了聚焦边框）：`mousedown` 里 `preventDefault()` 在 Safari 上**拦不干净**（光标照样进去），所以换结构：CSS 给值输入框 `pointer-events: none` —— **鼠标根本命中不到它**（`elementFromPoint` 落在 `SPAN.cond-f-val` 上），自然拿不到焦点、也没有 I 形光标；`mousedown` 改挂在外层 `.cond-f-val` 上：单击 → 开选择，双击 → 程序化 `focus()`（不受 `pointer-events` 影响）。进编辑态用**一个 class**（`editing` ref，双击时设、`@blur` 清）把 `pointer-events` 放开，编辑时才给 `cursor: text`。**别用 `:focus` 干这件事**：WebKit 里 `input:focus` 的 `pointer-events` / `cursor` 算出来还是旧值（实测），`matches(':focus')` 对得上但计算样式不跟。
- **整页禁选字（连 teleport 到 body 的弹窗一起管住）**：「一些不必要选中文字的也禁用好了，但是别影响点击」。原来那条规则写在 `.app` / `.app *` 上，而 Element Plus 的弹窗、胶囊菜单、toast 都是 teleport 到 `body` 的 —— 点开一个菜单在上面拖两下，那一片字照样被选中。改成 **`body { user-select: none }` 一条统管全站**，再把「真该能选」的单独放开：`input / textarea / select / [contenteditable]（含子节点）/ .selectable`（含子节点），以及 **纸面本身 `.sheet` / `.sheet *`**（纸上的编号、分子式、合计、换算算式、备注要能复制走；以前 `.sheet-runner` 这种单类选择器还打不过 `.app *` 的两段优先级，顺手修了）。`user-select` 只管拖选文字、不拦 `mousedown`/`click`，所以按钮、胶囊、卡片、表头照常点。验证（WKWebView 实测计算样式，注意这个 WebKit 里 `.userSelect` 是 `undefined`，要读 `webkitUserSelect`）：`body`/`.app`/`.el-popper`（挂到 body 上的）都是 `none`，`.sheet`/`.sheet table td`/`.sheet input`/弹窗里的 `input` 都是 `text`。
- **条件行的单击落点从「值那一行」放大到「整格」**：用户截了一张「温度那格点开下拉」的图，说「单击非展开箭头区域可能有点不太灵敏，触发区域是不是要大一点」。原来 `mousedown` 挂在 `.cond-f-val` 上，那一行只有 25px 高、右边还占着小箭头，点在**标签**上或字上面一点就整个没反应。现在挂在 `.cond-f`（标签 + 值 + 中间空隙）上，整格四周无死区；菜单/刻度条/小箭头/「变量」小开关各自 `bail`（`.cond-caret, .cond-var-tog, .cond-menu, .ruler-pop`），否则菜单里的 mousedown 会冒上来把菜单在 mouseup 之前关掉、那一下选不中；整格 `cursor: pointer`（值那一行是 `pointer-events:none`，光标由外层给，编辑态仍是 `is-editing` 的 I 形光标）。开菜单的延时 180ms → **130ms**（那 180ms 也是「点了没反应」的一部分），再点同一格 = 收起（以前只会重复设成同一个值）。验证（WKWebView 真实命中测试，`elementFromPoint` + 派发 mousedown）：值上方 1px / 标签行 / 值文字 / 小箭头左边 30px / 格子顶边都是 `open=true`，小箭头是 `open=false`（它靠自己那下 click）、「变量」开关 `open=false`、双击仍是进编辑且不会把菜单又开出来、胶囊菜单里 mousedown 不误关且点一下值到手、刻度条里 mousedown 也照旧不关。
- **刻度弹窗里的「＋ 自定义」挪到右下角、改成虚线小胶囊**：用户截了温度刻度弹窗（红框圈着底部那条 `＋ 自定义`）问「这个位置要不要改一下」。原来它独占弹窗底部一整行、上面还压一道虚线，看着像弹窗里多出来的一块空白；现在跟胶囊菜单**同一套语言**（`1px dashed var(--line-2)` + 圆角 5px + `ink-3`，hover 转强调色），右对齐贴在右下角，分隔线去掉 —— 弹窗也短了约 8px，少压投料表几行。改的是 `.ruler-foot` / `.ruler-add` 那几条（在 `.ruler-*` 那一段里就地改，别再加重复规则），点击行为没动（还是 `emit('add')` → 弹 prompt → `PUT /api/quick`）。
- **「＋ 自定义」两处都能管 + 页面设置改成「浏览器缓存 / 数据库长期存储」**：用户先问「这个自定义什么的，位置要不要改一下」，又说「这些页面什么的按钮，是不是都存到数据库了，就是页面设置」，最后选了「两处都有」+ 自己提的方案「数据库当长期存储、浏览器短期缓存，日常读浏览器，服务器启动/关闭时上传」。
  ① **设置页多了 06 记录页显示 / 07 常用选项**（06 原来就有，只是编号提到明面上）：07 一行一个字段（反应温度 / 时间节点 / 气氛 / 装置 / 光照），内置的只显示、自己加的 hover 出 `‹ › ×`（`‹ ›` 在自己加的那几条里挪位置，顺序就是刻度条 / 胶囊里的顺序），数据还是 `settings` 表的 `quick:<字段>`，跟条件行那个「＋ 自定义」同一份。
  ② **`src/lib/uiprefs.js`（新）**：本地一份 `eln:ui` = `{key:{v,t}}`（头一次跑把老的 `eln:sheet` / `eln:view` / `eln:group` / `eln:peek` / `eln:docw` / `eln:colw:*` 单键搬进来，搬完删掉）。**浏览器是日常读写的那一层（同步、零延迟）**；开本子时 `uiMerge(boot.uiPrefs)` 跟服务器那份**按 key 比时间戳、谁新用谁的**（服务器新的会回灌进 reactive 的 `sheetPrefs` / `peekPrefs` / `store.views` / `store.groups` / `--docw`）；改完防抖 1.2s 推 `PUT /api/uiprefs`，`pagehide` / 切后台再补推一次（`keepalive`）。**「服务器启动/关闭时上传」浏览器是不知道的**，所以换成上面两个等价时机。写一律走 `uiSetIfChanged`——值没变别刷新时间戳（记录页每次打开都会按 `KIND_BLOCKS` 重设「显示哪几块」，不判等就会每开一条记录推一次、还盖掉别的设备更新的那份）。
  ③ **服务端**：`settings` 表一个 `ui_prefs`（同一份 JSON），`PUT /api/uiprefs` 按 key 合并（白名单 `view|group|sheet|peek|docw|colw:<表名>`，单值 ≤20 KB、最多 40 个 key），bootstrap 多返回一个 `uiPrefs`。
  **当前课题 `eln:project` 故意不同步**：那是「这台机器上我正想看哪个课题」，被别的设备改掉很怪。
  验证（WKWebView + 临时记录 + 直接查库）：`PUT /api/uiprefs` 白名单外的键不认、`t` 小的不覆盖大的、`t` 大的覆盖——都对；页面上点「表格视图」→ 本地 `eln:ui` 立刻有 `view`、`pagehide` 时发出的正是 `PUT /api/uiprefs`（`keepalive:true`）、库里落盘；换一个全新 profile 打开 `#/list` → 直接是表格视图（说明合并下行也通）；设置页 07 卡点 `‹` 顺序真改了（库里 `["60 ℃","45 ℃"]`）、点 `×` 真删、点 `＋ 添加` 弹出的标题是「加一条「反应温度」常用选项」；记录页打开不再往库里写（值没变就不推）。测试用的 `ui_prefs` / `quick:*` 行都清掉了，`exp: 7 / trash: 70`。
- **「原料」类记录补上反应式块**：用户截了 SJ-2-1（`kind=原料`）问「这个没有化学式吗」——那条明明存过反应式（附件 48 `反应式.svg`）却不显示。原因：`lib/kind.js` 的 `KIND_BLOCKS['原料']` 里**没有 `scheme`**（当初按「原料是单个化合物、不是反应」想的），于是纸面从抬头表格直接跳到投料表。现在加回去：`原料: ['env','literature','scheme','reagents',…]`。记录页的 `applyKindBlocks` 每次打开记录都会按类型重设一遍，所以老记录打开就跟上，不用手动勾。验证：**拦掉所有非 GET 请求**再用 WKWebView 打开 121（只读，不改用户数据）→ `.scheme-block` 出现，里面是「按投料表实时画的那张」（592×223 的 SVG：A + LDA/BnBr，THF −78 ℃ 8 h，→ B-Cr），不是退回的附件图；第 1 页仍是 抬头 + 反应式 + 投料表(含条件行) + 结果 + TLC，没挤爆。
- **「原料」类记录默认不计产率**：用户截着中间体的结果块问「就这种中间体产物的话是不是就不用加产率了」。原来只有结果块表头那颗 `∅`（存 `no_yield`）能手动切，默认还是一条「产率 / % 自动」。现在 `ResultBlock` 多收一个 `kind`：**`kind === '原料'` 且产率还空着 → 按不计处理**（产率格 `—` 且禁用、表头给一颗**不可点**的「不计」小字提示「要产率就换记录类型」、下面那行写「理论产量 … · 不计产率」）；`syncYield()` 本来就在 `noYield` 时早退，所以填了质量也不会把产率算回来。**已经手填过产率的老记录照旧显示**（`num(yield_pct) !== null` 就不套用这条默认），不把已有数据藏起来；别的类型（试反应 / 条件筛选 / 底物扩展 / 通用）一点没动，`∅` 开关还在。验证（只读打开）：SJ-2-1（原料）→ 表头 `产率 / % 不计`、产率格 `—` 禁用、脚注带「不计产率」；SJ-2-7（试反应）与 SJ-2-8（条件筛选）→ 仍是 `∅` 可点、产率格 `自动` 可填。
- **「记录页显示」改成按记录类型各记一套**（用户选了「按记录类型各记一套」）：以前 `sheet` 只存一套，而 `EditorView.fill()` 每次打开记录都按 `KIND_BLOCKS` 整套重写 —— 于是设置页 06 里手勾的会被盖掉（实测：关掉 TLC → 打开一条「试反应」记录 → `sheet.tlc` 又变 true）。现在存成 `{'<类型>': {块: bool}}`（`''` = 通用），`lib/sheetprefs.js` 加了 `useSheetBlocks(kind)`（**只「选」不「写」**，打开记录/切类型时调）、`SHEET_KINDS`、`defaultBlocksFor(kind)`（没改过的类用 `KIND_BLOCKS` 默认）；设置页 06 卡多一排「改哪一类」胶囊（通用 / 原料 / 试反应 / 条件筛选 / 底物扩展），改的是当前那一套、「全部显示」也只作用于当前那套。老数据兼容：`sheet` 里如果放的是平的一套（有 `env`/`tlc` 这种键）就当「通用」那一套读进来。验证（只读、拦掉写请求）：设置里选「试反应」→ 取关 TLC → 存下来的是 `试反应.tlc=false`，别的类不受影响；再打开 SJ-2-7（试反应）→ 页面上真的没有 TLC 了（`tlcOnPage=false`）；SJ-2-1（原料）那一套仍是有反应式、有无 TLC。
- **「产物存库」改成「绑定产物」**（用户：「这个产物进库改成绑定吧，就是画好产物然后绑定实验这样吗，还是可以从反应式中直接读取，但这样会很麻烦吗」）。回答是**从反应式里读不麻烦**：`scheme_smiles` 里本来就是 `反应物>>产物`（「按投料表生成」和画板画的反应式都写这个格式），把 `>>` 后面那段交给 openchemlib 就能算出分子式 / MW / 结构图。
  `⋯` 菜单那条现在是「绑定产物…」，开 `ProductBind.vue`（`src/components/ProductBind.vue`），三条路：
  ① **反应式里的产物**：解析出 SMILES → 算结构 + 分子式 + MW（列 `C15H20O4 · 264.32`）；**库里已经有同样结构就直接「绑定 B-Cr」**（纯 SMILES 字符串比对），没有就「新建化合物并绑定」——建 compound（kind=产物、smiles/formula/mw、`standard_exp_id` 指向这条记录）+ 把算出来的 SVG 上传成它的 `structure` 文件，再写回 `product_compound_id`。
  ② **从库里挑**：带结构缩略图的可搜索列表（复用 `.recipe-*` 样式），点一下即绑，名称 / MW 跟着库走。
  ③ **画一个**：开单结构模式的画板，`pick` 回来同样走「新建 + 绑定」。
  底部一条小字留着老的整档搬运（连表征 / TLC / 操作一起建档案）。顺手修了个真错：`compoundFromExperiment` 以前把**整张反应式图**当产物的结构图搬进化合物档案（`category: 'scheme' → 'structure'`），现在不搬了，改成建完之后由前端从产物 SMILES 补一张真结构图。
  验证（临时记录 282 + 只读实测）：建 `CCO>>CCC(=O)OC` 那条 → 点「新建化合物并绑定」→ 库里多出 `C4H8O2 / 88.11 / CCC(=O)OC`、结构文件 2110 B、记录 `product_compound_id` 写上了；在真记录 121 上（拦掉写请求）走「从库里挑」→ 结果块立刻变成 `A 甲氧基环丁烷`、弹窗关掉。测试记录 / 化合物都用「彻底删除」清掉（`exp 9 / cmp 10 / trash 70`）。
- **「产物存库」变成幂等（再点不会多建一份）+ 绑定产物里说清「已经绑好了」**：用户问「那如果已经有了呢，再点这个存化合物会怎么样」。**以前会多建一份**：`compoundFromExperiment` 无条件 `INSERT`（编号走 `uniqueCompoundCode` → `SJ-2-1-2`），还把记录偷偷改绑到新的那份上，老档案留在库里 → 点两次两个档案。
  现在：①**服务端 `compoundFromExperiment` 改成「建 / 补」二合一**——记录里已经有 `product_compound_id` 就**只补空着的格子**（名称 / MW / 性状 / NMR 三栏 / TLC / 操作），已经有内容的一律不动（跟「手填过就不动」一个规矩），谱图也只在缺那一类时补（新抽了个 `copyExpFilesToCompound(..., {skipExisting})`），补了哪些字段进 `events`（kind=`sync`）；返回 `{compound, created}`，路由和 `api.js` 一起改成这个形状。②`EditorView.saveToCompound()` 按 `created` 换标题和提示：「补一下空着的格子？」/「早就在库里了：只把空着的格子补上，没另建一份」，并且只有新建时才补结构图。③`ProductBind` ①区：**已经绑的就是反应式里这个结构** → 显示对勾「已经绑好了」+ 一句解释，不再给「新建」按钮；绑的是别的结构时，按钮旁会写「会另建一份，现在绑的 X 留在库里不动」。
  验证：临时记录 `EXP-22` 连点两次存库 → 第一次 `created:true` 建了 86，第二次 `created:false` 还是 86（库里没多）；把化合物 86 的「性状」清空、记录改成「淡黄色固体」再点 → 化合物性状补上了，`name` / `mw` 没被覆盖（还是「幂等测试产物」/123.45）；真记录 SJ-2-1 打开绑定弹窗 → 显示「已经绑好了 / 反应式里的产物就是「B-Cr」，不用再建」。临时数据已删净，**踩到一个坑**：删 `trash` 行只按 `entity_id` 筛，把一条 2026-11-06 的旧回收站条目（`EXP-0081`，实验 id 恰好也是 86）一起删了——从 `.backups/2026-11-12/` 里捞回来重新插回去（`trash` 又回到 70 条），规矩记进 AGENTS §7。
- **存库/补档案：附件直接复制、解绑不删、冲突先对比再问**（用户问「如果有档案附件是不是直接复制进化合物那边，然后解绑定也不删除这样，然后如果已有的话需要对比吗，就是如果有冲突的话提示一下」）。
  ① **附件**：仍然是**复制**（`h1` / `c13` / `nmr_other` / `nmr_raw` / `nmr_pdf` / `tlc` 这六类），原文件留在实验那边；化合物那边**已经有同类的不重复搬、也不覆盖**（那是他自己传的原件），只在缺的时候补。
  ② **解绑不删**：`ResultBlock.unlink()` 只清 `product_compound_id`，档案和搬过去的谱图一个都不动。**顺手补了个坑**：解绑后再点存库，以前会再建一份；现在 `compoundOfExperiment(exp)` 先看绑着的，再看有没有哪份档案的 `standard_exp_id` 指着这条记录 —— 找到就直接**接回去**（`created:false`）。
  ③ **冲突提示**：`POST /api/compounds/from-experiment` 支持 `dry: true`（只算不改，返回 `fills` / `conflicts` / `files_copy` / `files_skip`）和 `overwrite: true`。前端 `saveToCompound()` 先 dry 一次，有冲突就弹 `confirmLines`（`feedback.js` 新加的多行确认框，内容转义过）逐条列「分子量：档案「200.5」／记录「210.9」」，两个按钮 **用记录里的覆盖** / **不要覆盖**；不覆盖就只补空着的，要是连空着的都没有就提示「那就保持档案里的值，什么都没改」。谱图跳过的那几类也在提示里写清楚（「这边已有的 h1 不重复搬、也不覆盖」）。
  验证（临时记录，全程只碰临时数据）：dry 报 `fills`（名称/分子量/性状/¹H/¹³C/TLC）；建完改记录里两格再 dry → `conflicts` 两条且 `created:false`、同一个 id；不覆盖执行 → 档案还是原值；`overwrite:true` → 按记录覆盖；上传一份 `h1` 后 dry → `filesCopy:['h1']`，执行后再 dry → `filesCopy:[] / filesSkip:['h1']`（没重复搬）；解绑（`product_compound_id:null`）再存 → `created:false` 仍是同一个 id。清理时 `trash` 按 **entity + entity_id** 两条一起筛（上次的教训），`EXP-0081` 那条还在。
- **冲突做成「代码合并那样」的列表**（用户：「就是做一个类似代码的冲突列表那种」）：不再用一坨文字问「要不要覆盖」，而是新组件 `src/components/SyncConflicts.vue` —— 一行一格，左边「档案里的」、右边「记录里的」，**点哪边就取哪边**（默认全取档案里的，最安全）；选中的那边描边 + 淡底，另一边淡下去；顶上两个一键「全用记录里的 / 全用档案里的」，底下实时写「用记录里的覆盖 N 格」，按钮跟着变（一格没选时是「只补空着的」）。空着会被填的那几格、谱图会搬 / 会跳过的几类都在下面按小胶囊列出来。服务端 `/api/compounds/from-experiment` 多收一个 `overwrite_fields`（逐字段覆盖，白名单校验），`overwrite:true`（整片覆盖）保留。要一格一格选就不能再是「全盖或全不盖」，所以 `applyArchive(overwrite, fields)` 两个参数都在传。
  验证：临时记录造 3 处冲突（分子量 200.5/210.9、性状 白色/淡黄色、TLC PE:EA/DCM:MeOH）→ 打开列表只点「性状」右边再应用 → 库里 `appearance` 变「淡黄色固体」，`mw` 还是 200.5、`tlc_solvent` 还是 `PE:EA = 5:1`（**只有选中的那格被覆盖**），提示「「EXP-22」按记录覆盖了 1 格」。测试数据按 `entity + entity_id` 清干净（`exp 9 / cmp 10 / trash 70`，`EXP-0081` 也在）。
- **「固体」标记 + 投料表「说明」格的「核对」**（用户：「查询的试剂能在说明那边添加一个跳转核对一下吗，TsCl 应该是固体」）。根因：PubChem 的「Density」对固体是**结晶密度**（TsCl 1.3325），而 `密度只对 溶剂/添加剂/试剂 有意义` 这条规则把它当液体算，于是 4.29 g 被折成「3.22 mL」。
  ① **`reagent_lib.solid`**（`ensureColumn`）：`densityUsable()` 对固体返回 null → 不折体积、用量按 g；标记进 `reagentDict`，`/api/reagents` 也带（`per_mmol_ul` 对固体为 null）；`fixReagentRows()` 打开记录时按词库补到行上（老记录不用手改）；`verifyReagent` 按**熔点**判固体（≥25 ℃）就不写密度，`PATCH /api/reagents/:key {solid}` 手动改；试剂库每行多了颗「固 / 液」小签，`/reagents?q=名字` 支持从投料表跳过来（自动筛到那一个）。
  ② **说明格的「核对」**：hover 才浮出的小字，点开是个小浮层 —— 名称 / MW / 密度 /「按固体记（不折体积）」、`固体`|`液体` 一键切（写回试剂库并重算这一行）、「按 PubChem 重查」（`recheck()` 现在也会看熔点，固体不取密度）、「去试剂库」（新标签页打开 `/#/reagents?q=名字`，不顶掉当前记录）。浮层下面放不下就翻到上面（`is-up`）——**踩过一个坑**：`$event.currentTarget` 在事件派发结束后就是 null，量位置必须当场算，不能等 `nextTick`。
  验证：TsCl 在试剂库里 `solid:1`、`per_mmol_ul` 变 null，SJ-2-10 那一行用量从 `3.22 mL` 变成 **3.43 g**（按 18 mmol）；试剂库 `?q=TsCl` 只筛出它、状态签显示「固」；浮层实测翻到上方、不越出窗口。数据没动（`exp 9 / cmp 10 / trash 70`）。
- **投料表「用量」的小数位可调（自适应 / 2 / 3 / 4 位）**（用户：「这边需要小数点后四位，或者可以弄一个每个模块单独的内部设置」）。`lib/reagent.js` 加了 `amountDecimals()` / `setAmountDecimals(0|2|3|4)`（0 = 老行为：按量级 2/3/4 位），所有 `round(...)` 出数的地方统一走 `dec()`（`toFixed` 后去掉多余的 0，12.3400 → 12.34、4.9625 保持）；`amountText` / `volText` 都吃这个设置，所以 ml / µL / g / mg、试剂库小签、汇报卡也跟着一致。投料表工具行多一颗 `# 4 位小数` 的小按钮，点一下循环切（自适应 → 2 → 3 → 4）；存 `uiprefs` 的 `reagentPrec`（服务端白名单补了这个 key，跟着数据库走），`store.js` 开机就套上、合并后重套。
  **两个坑**：①精度是模块级状态，用普通变量的话按钮标签不跟着变 → 改成 `ref`；②改完精度要**逐行 `syncAmount()`**，直接用 `recomputeAll()` 会跳过第一行（第一行的量不跟着变，看着像没生效）。
  验证：SJ-2-10 切到 4 位后 `苄基环丁烷醇 3.6628 g / TsCl 3.5461 g / DMAP 0.9468 g / Et3N 4.3119 mL / DCM 25 mL`；`amountText` 单测：4 位 → `4.9625 g`，自适应 → `4.96 g`。
- **设置页三层：记录类型 → 模块 → 模块里的功能**（用户：「就是可以针对页面的模块单独设置吗，第一层就是反应类型分类，然后就内部模块分类，然后模块内部功能可以添加或者不添加…然后就是这边设置是产物，但还是没计入产率」）。原来「原料 → 不计产率」是**写死在 ResultBlock 里**的（`kind === '原料'`），用户在设置里打开结果块也一样不记产率。
  现在 06 卡是三段：**改哪一类**（通用 / 原料 / 试反应 / 条件筛选 / 底物扩展）→ **A4 上哪几块** → **块里的功能**（新 `sheetFx`，也是按类型各记一套）：
  · 计产率（取消 = 只记质量和选择性；「原料」默认取消，其它类型默认勾上 —— 也就是把写死的那条规则搬成了默认值）
  · 选择性测定那行（ee / 方法 / 柱子 / tR）
  · 说明格的「核对」（查 MW / 密度 / 固体）
  · 「用量」小数位（自适应 / 2 / 3 / 4，跟投料表工具行那颗按钮同一个设置）
  `ResultBlock` 不再看 `kind` 字符串，改收 `yieldDefault` / `showSel` 两个 prop；`ReagentTable` 收 `showCheck`；`useSheetBlocks(kind)` 一次把块和功能两套都灌进去。
  **踩了个 TDZ 坑**：`sheetFx = reactive({...fxDefaultsFor('')})` 在模块初始化时就跑，而 `fxDefaultsFor` 里要读 `SHEET_KINDS`——那段被放在 `SHEET_KINDS` 之前，于是整站白屏（`Cannot access uninitialized variable`，用 `_probe-err.html` 抓到的）。顺序改成 `SHEET_KINDS` → `normKind` → `SHEET_FX/fxDefaultsFor/sheetFx`。
  验证：设置里选「原料」勾上「计产率」→ 打开 SJ-2-10，产率格变成可填的「自动」；再取消「计产率」「选择性测定」→ 表头回到「不计」、产率格禁用、`.res-sel` 那行消失，`sheetFx` 存成 `{"原料":{"yield":false,"sel":false,"check":true}}`。`ui_prefs` 白名单补了 `sheetFx` / `reagentPrec`。
- **条件行去掉「长得像真值」的占位文字**：用户圈着投料表上面那条条件行说「不要这些灰色占位字符，有误导」——那几格原本有 `placeholder`：`−78 ℃` / `8:45 → 15:11` / `N₂，封管` / `封管 / Schlenk / 微波` / `365 nm / 蓝光 LED`，灰字放在那儿看着像已经填过。现在五格 `ph` 全清空（`CondRow` 的 `fields`），只剩上方的小标签 + 右边那个出候选的小箭头；空着就空着，点一下照样能选。验证：SJ-2-10 的条件行 `placeholder` 全是 `''`、页面上没有灰字。
- **化合物不再「按类型分类」，改成按来源标「原料产物 / 小反应产物」**（用户截着那个类型菜单说「这边感觉没什么必要按类型分类，先移除吧，然后就是小反应产物和原料产物怎么区别」）。
  撤掉的：①化合物页的「类型」下拉（`KindPick.vue` 已删，`COMPOUND_KINDS` 也删了）；②化合物卡片墙的「按类型分组」（`groupOf()` 恒为 `'cat'`，`CmpGrid` 里那段按 `kind` 分桶的死代码一并删）；③中栏化合物筛选下拉里的「类型」那一节；④化合物表格视图的「类型」列。`compounds.kind` 这一列**没删**，只是界面不编辑、不分组了。
  换上的 `compoundSourceLabel(c)`（`lib/ui.js`）：看化合物**从哪条记录来的**——`standard_exp_id` 那条记录的 `kind`（原料 → 原料产物、试反应 → 小反应产物、条件筛选 → 筛选产物、底物扩展 → 扩展产物）；`standard_exp_id` 空的话反查 `experiments.product_compound_id`（老数据只有记录那一侧指着化合物）；老类型是「试剂」的显示「试剂」。列表 SQL 多返回 `source_kind`，`getCompound` 的 `standardExp` 也用同一个「正手 / 反查」拿。
  **坑**：`compounds.standard_exp_id` 是 TEXT 列、空值是 `''` 而不是 NULL，`COALESCE(c.standard_exp_id, …)` 会取到 `''` → 反查永远不生效（`NULLIF(c.standard_exp_id, '')` 才对）。
  验证：`/api/compounds` 里 B-Cr→原料、1→试反应、C/D→原料；卡片上显示「试剂」/「原料产物」，化合物页那格显示「来源=原料产物」；卡片墙工具行只剩 表格视图 / 批量标签 / 新建分类 / 新建化合物。
- **反应式「莫名其妙变了」：产物结构被画成展开式**（用户圈着 SJ-2-9 的产物问「这边为什么莫名其妙变了」——反应物是缩写标签 `OMe`/`Bn`/`CO2Me`，产物却是把苯环、`O–CH3` 全摊开的放大图，还把箭头挤歪）。
  诊断过程：①`/api/compounds/72/abbrev-mol` 返回 2255 字符的 S-group molfile（`M  STY` / `SAL Bn` / `SMT OMe`），Indigo 直接渲是**对的缩写式**；②用真数据重算（`schemeParts` + `composeSchemeSvg`，productId=72）也是**对的缩写式** —— 说明画法没问题；③但 `scheme_cache` 里那条（14:41 写的）**就是展开式**，而页面比 `sig` 相等就直接贴缓存、不再重画。根因：`sig` 只由投料表字段拼出来，用户在画板里给产物画上缩写标签 / 改坐标以后 `sig` 不变，**旧图就永远贴在那**；另外前端 `abbrevMolCache` 按 `compound_id` 缓存、连空串都缓存，同一页面里改过结构也不会重拉。
  改法：
  ① **服务端**：`scheme_cache` 加一列 `fp`（`ensureColumn`），值是「这条图用到的化合物 `id:updated_at`」按 id 排序拼起来（`schemeFp(expId)`：投料表里所有 `reagents.compound_id` + `product_compound_id`）。写缓存时存、读缓存时（`getExperiment` 的 `scheme_cache` 和 `GET /api/experiments/:id/scheme.svg` 两处）比一下，对不上就当没有 → 前端重画。
  ② **前端**：`scheme.js` 的 `abbrevMol(id, ver)` 缓存键改成 `id|ver`、**空结果不缓存**；`composeSchemeSvg` 收 `reactantVers` / `productVer`（`expScheme.schemeParts` 一起返回），`EditorView` 两处调用都传。
  ③ **`liveFp`**（编辑器内）：同样的指纹，`watch` 到变化就重画；`scheduleLive` 改成**单飞**（`liveBusy`/`livePending`）—— 以前 sig / 指纹 / 化合物库三个 watcher 同一 tick 里能连画两张，白画还闪。`abbrevMol` 的 ver 也从这里来，所以「回画板改了结构再回记录页」会在 200ms 内重画。
  **坑**：`fp` 千万别塞进 `liveSig`。`liveSig` 是缓存的 key，而化合物库是**页面打开之后**才读完的 —— 带进去首帧永远对不上缓存，每次打开都要重画（就是以前那种「闪一下」）。所以单独一个 `liveFp`：指纹**还不知道（返回 null）时不比**，画完再把「画这张时用的 fp」记下来（`fpUsed`，在 `await loadCompounds()` 之后取，不能在函数入口取）。
  **顺带**：卡片墙缩略图 `img` 加了 `@error` → 缓存被作废（404）时退回反应式附件 / 结构图，不再显示一个裂图标。
  验证：真记录 SJ-2-9（280）—— 修之前产物是展开式，修之后产物跟反应物一样是缩写式（`OMe`/`Bn`/`OH`）；连开 4 次，`scheme_cache.at` 不再变（缓存命中、不再重画），产物依旧正确；临时记录 + 临时化合物实测「改一下结构 → 缓存读出来是 null（作废）→ 重开记录重画一次 → 再开又是 0 次重画」；`npm run build` 后 4780 上同样是缩写式。测试数据全清（`exp 11 / cmp 10 / trash 0`，`fp` 列已迁移）。
- **两步反应：两条记录串成链，反应式可以连着画**（用户：「两个实验能绑在一起作为两步反应吗，但是不要之前那种投料表里面挤两个，感觉不是很好，或者用堆叠卡片吗」）。
  选的是「串成链 + 反应式能连起来画」（另外两个选项是「只串链」「只在列表里竖着叠」，用户选了最全的那个）。
  **数据**：`experiments.prev_exp_id`（指向上一步那条记录）+ `chain_draw`（0/1，反应式要不要连上一步一起画）。不往投料表里塞第二个 step——两步本来就是两次投料、两次后处理。
  **服务端**：`normalizeExperiment` 收这两个字段（`chain_draw` 归一成 0/1，它是 NOT NULL 列）；`PUT` 时校验「不能接自己」「不能成环」（顺着 `prev_exp_id` 往上走，走到自己就 400）；`getExperiment` 多返回 `prev`（id/code/title/kind/product_name）、`next[]`、`chain_step`（顺手把指向已删记录的 `prev_exp_id` 抹成 null）；`listExperiments` 每条多给 `prev_exp_id` / `chain_step` / `chain_len`（`chain_len > 1` 才在列表上标步子），另外把 `product_compound_id` 也加进列表 SELECT（挑「上一步」时要用）；`trashExperiment` 删记录时把别人指着它的 `prev_exp_id` 清掉；缓存指纹 `schemeFp` 拆成 `compoundFp` + 上一步的 `schemeTextSig`（溶剂/温度/时间/产物名 + 投料行），这样**改了第一步的条件，第二步那张连画的图会失效**。
  **画图**：`lib/scheme.js` 把原来「一根箭头」的 `composeSchemeSvg` 重构成 `composeChainSvg({stages})`——每段自己有反应物 / 产物 / 箭头上下的字，排成一串节点（结构 / 加号 / 箭头 / 产物名）再统一算宽高，所有结构共一条中轴，每根箭头的条件按各自行数往上下长；**上一段的产物就是下一段的底物（同一个化合物）时只画一次**，中间那道桥不会重复。`composeSchemeSvg(opts)` 保留成「一段」的薄壳，筛选表那两处照旧用它。
  **前端**：`EditorView` 的 `fields` 加 `prev_exp_id` / `chain_draw`，`liveSig` 加 `pv`/`cd`（切开关 / 换上一步都要重画）；`drawLive()` 在 `chain_draw` 开着且有上一步时，先 `api.experiment(prevId)` 取上一步、`schemeParts()` 拆成 stage 1，自己的当 stage 2，一次 `composeChainSvg` 画完（画附件那张「按投料表生成」也吃同一套）。`⋯` 菜单加「接上一步…」（开 `ExpPick`，`preferIds` = 产物正好是本条底物的记录，排最前并挂「产物是这条的底物」小标）、「断开上一步（编号）」、「反应式连上一步一起画 / 只画这一段」。`SchemeBlock` 标题行多一条小字条：`第 2 步 · 上一步 SJ-2-9 ←`（点了跳过去）/ `第 1 步 · 下一步 SJ-2-10 →`，旁边一颗 `连上一步画` 胶囊（选中是暖色）。中栏列表卡片和卡片墙标「第 N 步」（中性细胶囊 `.tag.is-step`）。
  **顺手补的**：`ExpPick` 以前没有任何样式（纯原生按钮列表）——补了 `.xpick-*`（照 `.recipe-opt`：整行可点、悬停淡底、选中一圈极淡描边），确认按钮文案改成可传（接上一步时是「接上」）。
  **坑**：①`chain_draw` 是 NOT NULL 列，三条 INSERT 路径（新建 / 复制 / 从回收站恢复）里显式写 `null` 会报 `NOT NULL constraint failed`，都要给 0；②指纹 / sig 里不带「上一步」的话，改第一步的条件第二步那张图不会重画；③`ExpPick` 的 `.click()` 用普通 `MouseEvent` 就行（`el-dialog` 点遮罩才关，这里不涉及）。
  **验证**（临时记录 290/291 + 只读看图）：`PUT prev_exp_id` 接上 → `prev` / `next` / `chain_step=2` 都对；接自己 400「不能把记录接成自己的上一步」、A→B→A 400「这样会绕回来」；断开后 `chain_step` 回到 1。SJ 那套结构造了一条 `51→72→73` 的两步链：开「连上一步画」→ 一张图里 `A →(LAH 1.5 eq, THF rt)→ B →(TsCl 1.2 eq, DCM 0 °C)→ C`，中间体只画一次；点胶囊关掉 → 图宽从 497 变回单段、`chain_draw` 存成 0。挑上一步的弹窗里 EXP-22 和 SJ-2-9 都排在前面（产物 = 本条底物）。列表卡片上「第 1 步 / 第 2 步」都在。临时记录已删净（`exp 11 / cmp 10 / trash 0`），`prev_exp_id` 悬空 0 条。
- **反应式文字里的上下标（规则）**：`splitScript()` + `tspan` 的 `dy`。字母或右括号后面的数字当下标（`Pd(PPh3)4` → `Pd(PPh₃)₄`、`H2O` → `H₂O`、`CuSO4·5H2O` 也认 `·`）；**空格开头的数字不动**（`0.05 eq` / `12 h` / `-78 °C` / `4:1` 都不是计量数）；字母后紧跟空白或结尾的 `+/-` 当上标（`Na+`）；想强制就手写 `_{3}` / `^{2}`。**`dy` 按「目标偏移 − 当前偏移」算**（下标 +3、上标 −4），以前写成「先记 pending 再还回去」，下标没往下挪、后面的字反而被抬起，整行看着上下飘（用户截过图）。
- **固定小数位时质量的尾零不丢了**（用户圈着 TsNH2 那格 `2.671 g` 说「0 不要忽略，四位显示的话」）：`amountText()` 里固定位数那条分支原来 `trimZeros(g.toFixed(n))`，2.671 → `2.671`；现在直接 `toFixed(n)`，**设了四位就是四位**（`2.6710 g`、`5.0765 g`、`6.7771 g`），只有小到 0 才退回 mg。**体积不跟着补零**（DMF 还是 `30 mL`，不是 `30.0000 mL`）——溶剂按量级写才像实验记录。自适应（小数位 = 0）的行为没变（`5.08 g`）。验证：`amountText` 单测 SJ-2-11 那张表三行质量 `5.0765 / 2.9032 / 7.3661 g`、溶剂 `30 mL`；打开 SJ-2-11 页面对得上（顺手确认那页数据没被我改动：events 里最后一条编辑是之前的，base_mmol 14.13 是用户自己改的）。
- **反应式图缩小一点 + 纸放得下就不许滚**（用户看图说「图片可能需要缩小一点，然后页面没有超出画面的话，就默认不能滚动，现在会上下动」）。
  ① **反应式**：`.scheme-live svg` 的上限从 240px 收到 **190px**（SJ-2-1 那张从 568×223 变成 484×190，格子 225 → 192 高，第 1 页整张纸矮了 33px）。宽度还是按容器比例缩，结构不会被拉扁；打印那份上限一起改成 190。
  ② **滚不滚**：`.editor` 底部有 120px 呼吸位（长内容时不贴边），纸本身放得下的时候它白出一段可滚空间，所以页面会「上下动」。现在 `EditorView` 量 `scrollHeight − paddingBottom ≤ clientHeight + 1`，够就挂 `is-fit`（`overflow-y: hidden`），不够就正常滚；用 `ResizeObserver`（观察 `.editor-inner`）跟着内容变，另外 `window.resize` / 翻页 / `liveScheme` 变化时重量一次。
  验证：1280×820 窗口下 SJ-2-1 纸高 942 > 820 → `class="editor"`（照常滚）；把纸里的块临时藏掉（模拟矮内容）→ `class="editor is-fit"`、`scrollHeight == clientHeight`；1280×1150 的窗口截图上整张纸都在画面里、底下没有白滚段。
- **第二个底物不再写在箭头上，改成「sub1 + sub2」放箭头下面**（用户圈着 SJ-2-12 的箭头说「如果是另一个 sub 的话，就不要放在反应式上，就放在下面，然后用 sub1+sub2 的形式」）。
  以前 `schemeParts` 只要底物行挂不上结构（没 compound / 没 smiles）就 `loose` → 塞进 `others` → 以「苄基溴丙炔 (1.0 eq)」的形式跑到**箭头上方**，跟试剂混在一起，看着像试剂。
  现在：底物行单独收集名字（`subNames`）；有画不出结构的底物时，**箭头下面**（条件行上面）单起一行 `底物1 + 底物2`（按投料表顺序用 ` + ` 连），箭头上只剩试剂 / 碱这些；两个底物都有结构时照旧画「结构1 + 结构2」，不再重复写名字。`loose` 仍然计数，记录页那条「还没挂化合物库」的提示照旧。
  验证（只读探针，不碰记录）：SJ-2-12 现在两个底物都有 smiles → 画成 `结构1 + 结构2 →`，上面只有 `Cs2CO3 (1.6 eq)`、下面是 `DMF, 40 °C`；把 compound 90 的 smiles 临时抹掉模拟原图那种情况 → 箭头上面只有碱，下面一行 `NHTs环丁烷 + 苯基溴丙炔` 再接条件行。
- **箭头上只排一行**（用户：「然后反应式箭头上最好不要两行」）。以前两处会摞两行：①`expScheme` 的 `MAX_ABOVE_LINES = 2`（第一行装不下就把剩下的排第二行）②`scheme.js` 的 `wrapPhrases(..., maxLines=2)`（一行字超过 250px 就折成两行）。现在：**箭头上只排一行**——`MAX_ABOVE_LINES = 1`（装不下的试剂直接挪到箭头下方，跟「放不下的那几行」原来那条路一起）、`caps(list, 1)`（不折行），`MAX_ARROW` 320 → 360 让一行字放得下（再长也是截在 360，字稍微出箭头两头一点点，比摞两行好看）。箭头**下面**还是最多两行（溶剂 / 温度 + 放不下的试剂）。
  `SCHEME_SIG_VERSION` v11 → **v12**：出图规则改了，旧缓存必须失效，否则还是贴两行那版。
  验证（只读探针）：SJ-2-1（LDA + BnBr）单行 `LDA (1.2 eq), BnBr (1.2 eq)`；SJ-2-11（TsNH2 + Cs2CO3）单行；合成的「四个带当量试剂」那种 → 一行排开、箭头跟着变长（约 300px），下面仍是 `THF, -78 °C, 12 h`。
- **切换记录时反应式会闪一下**（用户：「每次切换实验，反应式都会闪烁」）。用 60ms 轮询记 `.scheme-live` 的 innerHTML 长度，实测出两种情况：
  ①**缓存能对上**（同一套出图规则、结构没改）→ 切过去是 0ms 直接换图，**本来就不闪**（`len 30590 → 20848`，中间没有 0）；
  ②**缓存对不上**（结构改过 / 出图规则改过，例如我刚把 sig 升到 v12）→ `fill()` 走 else 分支把 `liveScheme` 清空，格子里先冒出「点击上传反应式」那行灰字，过 240–800ms 才画出新图 —— **这才是用户看到的闪**。
  改法：**旧的也先贴**（stale-while-revalidate）。服务端 `readSchemeCache` 指纹对不上时不再返回 null，而是照给 `{sig, svg, fp, stale: true}`；前端 `fill()` 只要有 `cache.svg` 就先贴上去（记下它的 sig / fp），`stale` 或 sig 不同再 `scheduleLive(0)` 在后台重画，画完悄悄换掉；同时给 `SchemeBlock` 一个 `busy` 标记，**正在画的时候格子空着就空着**，别让「点击上传」那行提示闪（`.scheme-slot.is-busy .scheme-empty { visibility: hidden }`）。
  验证：把 `scheme_cache.fp` 全部清空（模拟「全都不新鲜」）再连切 4 条记录，日志里只有 `len X → Y`、**没有一次 `→ 0`**，`empty` 那一项也一直是 `-`（提示行没出现）；单独开一条 stale 记录，6 秒后 `fp` 被重画写回（fplen=55）。踩了一个坑：新加的状态名 `liveBusy` 跟 `renderLive` 的单飞标志重名，Vite 直接报 `Identifier 'liveBusy' has already been declared`（整页红屏），改名 `liveDrawing`。
- **补正：不要「旧图→新图」，切记录就应该是 0ms 直达**（用户：「所以就不能把正常的先存附件里，然后直接取吗，不要其他的旧的占位，不然感觉还是闪烁，就是从旧的闪到新的」）。
  **先说清楚一件事**：画好的那张反应式**本来就存在服务器上**（`scheme_cache` 里就是完整 SVG，跟存附件是一回事），打开记录时随 `/api/experiments/:id` 一起回来，直接贴——不重画、不重新加载图片。上一条加的「先贴旧图、后台重画」（stale-while-revalidate）不干了：用户说得对，从旧图换成新图照样是闪。
  现在的规则：**只认「就是现在这份数据画的」那份缓存**（`stale === false && sig 一致`）→ 直接贴、一次都不重画；过期就清空重画，空的那一小段由 `.is-busy` 把「点击上传」那行提示也藏起来（一片纸白，不闪字）。
  **根因（我自己作的）**：上一条测试时把 `scheme_cache.fp` 全部清空过（`UPDATE scheme_cache SET fp=''`），等于把所有记录都判成「过期」，于是每次切换都走「重画」那条路 —— 用户看到的「从旧闪到新」就是它。现在写了个脚本按服务端的算法（`compoundFp` + `纯文本签名 schemeTextSig` + `prev`）把 9 行缓存指纹全部重算回去。
  验证：连切 281 → 280 → 286 → 121 → 286，日志里每次只有一次 `len X → Y`（都是**正确那张**），既没有 `→ 0`，`scheme_cache.at` 也一直不变（说明根本没重画）。
  **教训**：调试缓存别再直接清库里的指纹（会连累用户的全部记录）；要复现过期，用临时记录。
- **两步反应改成「一条记录里两步」**（用户问「或者还是放一起可能会好一点吗」，最后选了「真的放一条记录里」）。以前只有两条记录 + `prev_exp_id` 串链这条路；现在**同一份记录**就能连着两步：
  **数据**：`steps_json` 里每一步多一个 `product_name`（这一步的产物 / 中间体；`server` 的 `normalizeSteps` 收这个字段，前端 `fill()` 也要带——**以前 fill 的 steps 映射是一串白名单，会把新字段丢掉，然后自动保存把它写空**，踩过）。
  **投料表**：表尾把「＋ 加一步」加回来了（`addStep()`）；一步以上的记录，「第 N 步」那一行右侧多一格「产物」（除了最后一步）——写中间体名字，名字要能在化合物库里找到才画得出结构（按名字查，跟底物那条规则一样）。
  **反应式**：`expScheme.schemeParts` 重构成「按步出 stage」：每步的底物当左边、这一步的试剂当箭头上、这一步的溶剂 + 「条件」格文字当箭头下，第一步的产物是「第 1 步」那行的产物、最后一步是结果块里挂的产物。返回里多一个 `stages`（单步记录就是长度 1，字段摊平后跟以前一模一样，别的调用方不用改）。`EditorView` 画图时 `stages` 有 2 段以上就用 `composeChainSvg` 画多段箭头（中间体只画一次）——于是两步一条记录也能出 `A →(条件1)→ B →(条件2)→ C` 一张图，跟「两条记录连起来画」是同一个渲染器。
  **缓存**：`liveSig` 在多步记录里额外带上「每行的 step」和「每步的条件 / 中间体」，改了第一步的条件那张图会重画；单步记录不加这两个键（sig 不变，缓存照样命中、不闪）。`SCHEME_SIG_VERSION` v12 → **v13**（多步分段是新的出图规则）。
  **验证**（临时记录，51→72→73 那套结构）：一条记录两步——第 1 步底物 51 + LAH、条件 `THF, rt`、产物写「苄基环丁烷醇」；第 2 步底物 72 + TsCl、条件 `DCM, 0 °C`；结果块产物 73。反应式画出两段箭头、中间体只画一次、两段条件各归各的（改第一步条件 → 图跟着变）；单步记录 SJ-2-11 画出来跟以前一样。**坑**：`schemeParts` 的三处调用都要把 `steps` 传进去（以前只传 reagents，条件格和中间体就丢了）；多步记录的「产物」格初版没生效，是 fill 的白名单 + 自动保存把字段洗掉了。临时数据已清（`exp 11 / cmp 10 / trash 0`）。
- **步骤分隔改成「一条虚线」，不要那种整块浅色横条**（用户：「可以不用太复杂，就是分隔一下就行了，类似筛选条件那个横线这样？」）。
  「第 N 步」那行原来是一整块浅色横条（`background:#f8f6f0` + 上下描边），上面塞了 本步内容 / 条件 / 之后 / 加料 / 搅拌 / 起止 一堆格子。现在：**一步一条虚线**（跟「变量」那条 `.vars-rule` 一个样式），左边 `第 N 步`，中间 `本步内容`，虚线后面挂两个真正用得上的格子 `条件` / `产物`（最后一步没有产物格），右端是「＋ 加一行 / ✕ 删这一步」。
  第二行（`之后 / 加料 / 搅拌 / 起止`）**只在老记录里真填过东西时**才出现（`stepHasMore()`），新记录不再摆一堆空格子；单步记录维持原样（没有标题行，除非填过那些字段）。
  验证：临时两步记录（51→72→73）——投料表里 `第 1 步 ┈┈ 条件 THF, rt 产物 苄基环丁烷醇`、`第 2 步 ┈┈ 条件 DCM, 0 °C`，反应式两段箭头照旧；临时数据已清（`exp 11 / cmp 10 / trash 0`）。
- **多步记录：条件改成「每步一条条件行」**（用户先问「反应条件这样放着感觉有点难受」，又补「或者稍微拉高一点呢，两排放反应条件，就是温度反应时间那些，就是针对多步反应的页面设置这样」）。
  **问题**：多步记录所有条件挤在投料表下面**同一条** `CondRow` 里，两步的温度 / 时间只能写成文字塞进「条件」格（`THF, rt` / `DCM, 0 °C`），画反应式时再当字符串挂到箭头上——写得出、但没法按步编辑，也不是真正的温度 / 时间字段。
  **数据**：`steps_json` 每一步多存 `temperature` / `duration` / `atmosphere` / `apparatus` / `light`（`server/index.js` 的 `normalizeSteps` 收这五个；前端 `fill()` 的 steps 映射同步带上，不然白名单又会洗掉）。
  **页面**：投料表下面改成 **一步一条 `CondRow`**（`v-for` over `reagent.steps`，用 `.cond-step` 行 + 左边一颗 `N 步` 小签），**只有第 1 步显示字段标签**（第 2 步起 `CondRow` 收 `hideLabels`、只留格子，靠上面的小签认步）；单步记录还是原来那一条（不显示 `1 步` 小签）。
  **画图**：`expScheme.schemeParts` 每段的条件取**那一步的条件行**（溶剂行 + 那步的 temperature/duration/atmosphere），不再拼 `step.condition` 那段自由文字；于是第 1 步箭头写 `THF, -78 °C, 12 h`、第 2 步箭头写 `DCM, 0 °C, 2 h`。
  **顺手**：`ReagentTable` 步骤分隔那条虚线上去掉了「条件」输入格（条件已经归到下面的条件行），只留 `本步内容` + 虚线 + `产物` + ＋/✕。
  **验证**（临时两步记录 51→72→73）：第 1 步 `-78 °C, 12 h`、第 2 步 `0 °C, 2 h` → 两张箭头各自带上自己那组条件；单步记录 SJ-2-11 的箭头还是 `THF, -78 °C, 12 h` 一条，没变。临时数据已清（`exp 11 / cmp 10 / trash 0`）。
- **把真实的 A→C 落成一条两步记录**（用户：「AtoC那两步你能帮我弄一下吗」→「就做成两步反应」）。
  **做法**：SJ-2-1（121，原来「A to CrB」）就地改成两步记录——标题 `A to C`；第 1 步投料行原样留着（甲氧基环丁烷 / LDA / BnBr / THF，`−78 ℃, 12 h, N₂, 圆底烧瓶`），第 2 步把 SJ-2-9（280）的三行搬进来（底物 苄基甲氧基环丁烷 cmp 51、还原剂 LAH 1.5 eq、溶剂 THF，条件 `rt`）；`steps_json` 两条，第 1 步的 `product_name` 写中间体「苄基甲氧基环丁烷」；结果块换成最终产物苄基环丁烷醇（cmp 72、MW 236.31、4.9476 g、52.3%）。SJ-2-9 那条移进回收站（可恢复），它指着的 `prev_exp_id` 链跟着断掉，于是 SJ-2-1 不再显示「第 1 步 · 下一步」——现在这就是一条独立的两步记录。
  顺带清掉 `scheme_cache` 里 exp 280 的孤儿行（回收站里的记录没有缓存也照样能重画）。
  **验证**：`steps 2 / 投料行 7`；打开 `/#/e/121` 反应式画出两段箭头（`A →(LDA 1.2 eq, BnBr 1.2 eq / THF, −78 ℃, 12 h, N₂)→ CrB →(LAH 1.5 eq / THF, rt)→ C`），投料表分「第 1 步 / 第 2 步」两段、两段条件行各自一条；第 1 页高 1086px < A4 1123px，仍是一页不溢出；列表卡片标题变 `A to C`、旁边没有「第 N 步」了；`回收站 1`（就是 SJ-2-9）。
  **两个样式坑**（多步条件行第一次就是这么挤坏的）：
  ①`.cond-above` 本身是**六列 grid**（单步那行靠它跟投料表对齐），所以一条一条塞 `.cond-step` 会被排进第 2 列、第 2 步跟第 1 步挤在同一排 → 加 `.cond-above .cond-step { grid-column: 1 / -1 }` 让每步占满一整行；
  ②`.cond-f.no-label` 原先是「`visibility:hidden` + `height:0`」，第 2 步的数字会比第 1 步高一截、列对不齐 → 只留 `visibility:hidden`，把标签那行的高度占着，两行的值才落在同一个基线上。
- **多步记录改成「每一步一张投料表」，结果一步一行**（用户：「或者单独一个投料表，然后结果这样，就是条件表和投料表一起，然后两步分别一个这样」→「1，但是结果放一起」）。
  **投料表**：一步以上时不再是一张表里塞两段行，而是**每一步自成一张**：`第 N 步 · 本步内容 ┈ 产物 [中间体]` → 这一步的条件行 → 这一步的列头 → 这一步的投料行。条件行以前在整张表上面（一条对两段），现在跟着各自的表走（「条件表和投料表一起」）。实现上还是**一张 `<table>`**：`<thead>` 只在单步时出现，多步时每个步骤开头插两条 `<tr>`（`step-cond-row` 装条件行、`step-cols` 是这一步的列头），共用一个 `<colgroup>`（两张表的列宽天然对齐）；步骤之间靠「第 N 步」那条虚线 + 上边距分开。单步记录的 DOM 完全没变。
  **结果**：一步一行（`第 N 步 | 产物名称 | 产物 MW | 质量 / g | 产率 / % | ×`），**最后一行直接读写记录本身的结果字段**（列表、筛选表、导出读的都是记录那几格），前面几步写 `steps[i]`；产率照旧按「质量 ÷ (规模 × MW)」自动算，手填过就不再覆盖（这个标志按行记）。「性状 / dr,ee」只有终产物才有意义，纸面又装不下八列，挪到表格下面一行小字（`最终产物 性状 … dr / ee …`），跟「选择性测定」那一行同款。多步时不给产物那种「整条不计产率」的 ∅ 开关——哪步没算就把那格空着；多步的行也不给「像真值」的灰占位（用户讨厌那个）。
  **数据**：`steps_json` 每步多六个字段 `product_compound_id / product_mw / product_mass / yield_pct / appearance / dr_ee`（服务端 `normalizeSteps` 收，`fill()` 的步骤映射同步补——白名单漏一个就会被自动保存洗掉）。`expScheme` 找中间体时**先按这一步挂的化合物 id、再按名字**，挂库了就不怕重名。`compoundFp` 把每步挂的中间体也算进结构指纹，`schemeTextSig` 带上每步的条件 / 产物名 / 行归属 → **所有缓存的 fp 变了**，用脚本按新算法整批重算了一遍（8 行），否则每条记录下次打开都要白重画一次。`stepsText()`（历史里那句）也带上中间体和产率，导出 md 的多步部分补了每步条件（温度/时间/气氛）+「各步结果」。
  **验证**：SJ-2-1（A to C）两步记录：两张表各带条件行和列头，反应式仍是两段箭头；结果两行（第 1 步 中间体 264.32、第 2 步 终产物 236.31 / 4.9476 / 52.3），下面「最终产物 性状 黄色油状液体」。临时记录验事务：改第 1 步质量 5.0 → 该行产率自动 94.6%、记录产率仍 50.8；改第 2 行质量 2.5 → 记录 `product_mass 2.5` / `yield_pct 52.9`；「＋ 加一步」新步骤的六个结果字段都在。单步记录 SJ-2-10 的版式没动（条件行还在表上、结果仍是一行带性状/dr）。第 1 页打印内容底 961px / 限度 1062px，还是一页。临时记录已清（`exp 10 / cmp 10 / trash 1`，回收站里只剩 SJ-2-9）。
  **坑**：①`.rtable` 是 `table-layout: fixed`，但结果那张表原来靠 auto 布局分宽度，多了一列「第 N 步」之后产物名被压到 166px（「苄基甲氧基环丁」被切）→ 多步这张表显式列宽 + `table-layout: fixed`；②`.cond-above` 本身是六列 grid（单步要对齐反应规模那格），塞进 `<td colspan=9>` 后要改成五列才铺满。
- **两步记录的版式收一轮：更少横条、更矮**（用户看完成品说「感觉还行，就是有点丑，然后页面也太高了」）。
  **砍掉的东西**：①**每步那份列头**撤了——两步的列一模一样，每步再抄一遍「组分 / 试剂 / MW / 浓度…」只是把纸分成一条条横带（铺底色那版更像三道横杠），现在整张表一条列头，两步靠「第 N 步」那条虚线和各自的投料行分开；②**步骤头里的「产物」格撤了**——中间体就在下面「结果」表那一步的产物格里填，同一个字段摆两个地方（还只对前几步露）又乱又长；③条件行不再挂「变量」小开关（筛条件的变量是整条记录的事，多步里摆两遍是噪音）；④「说明」列的灰字占位去掉（跟表头重复）；⑤多步的结果块不再重复那行「理论产量 … 实测产率」——每步的质量 / 产率在表里都有，只有「称到的比理论还多」这种异常才报。
  **收紧的尺寸**：条件行的值 12.5 → 11.5px、标签 8px、`padding` 压到 `0 2px 3px`（一行 48 → 35px）；步骤头 `padding-bottom: 0`、行高 15px、两步之间 14 → 9px；多步的结果表改 `table-layout: fixed` 显式列宽（原来 auto 布局把「产物名称」压到 166px，「苄基甲氧基环丁烷」被切）。
  **结果**：这张纸的屏幕高度 1166 → **1084**（投料表 442 → 387，结果 197 → 170），打印那页的内容底 886 / 限度 1062，余量更宽。单步记录（SJ-2-10）除了「说明」列不再有灰字占位，别的地方没动。
- **表头只包「投料行」，两步各带一条**（用户圈着投料表：「就这个表头能不能只包裹投料试剂，不要把条件也包裹进去，然后分步都加一个表头」）。
  原来一步以上时是「一条共用表头顶在最上面 → 第 1 步 → 条件行 → 投料行 → 第 2 步 → 条件行 → 投料行」，那条表头看着把两段条件也一起包进去了。现在：**单步记录还是顶部一条表头**（条件行本来就在表外），**一步以上时顶部那条撤掉**，每一步在自己「第 N 步」和条件行之后各带一条表头（`.step-cols`），只罩住这一步的投料行。表头样式跟顶部那条同一套字和底色（`#f0eee6` + 上下各一条 `#ddd9cf` 细线），只把上下 padding 压到 3px、步骤头 `padding-bottom: 0`，别让两张表各多出一条厚带。
  屏幕高度 1084 → 1105（每条表头 24px，×2），打印那页内容底 911 / 限度 1062 还是一页。单步记录（SJ-2-10）的 DOM 和样子都没变。
- **两步各是一个框，表尾那排操作挪到框外**（用户：「然后两步不要用一个外部框线包在一起，稍微分开一点」）。
  原来两步共用一张 `<table>`（`.sheet .rtable` 那条 1px 外框把两段一起圈住）。现在**一步一张 `<table>`**：`v-for` 提到 table 上，每张自带外框、表头、条件行和这一步的投料行，两张之间留 12px（`.rtable.is-step-table + .rtable.is-step-table`）。表尾那排「添加试剂 / 加溶剂 / 加一步 / 从试剂库选 / 按相态整理 / 套用配方」管的是整条记录，所以**从最后一个框里挪到所有表外面**（`.rtable-tools`，仍带 `noprint`，打印时不出）。
  单步记录受影响很小：还是那一张表，只是表尾那排按钮从框里挪到了框下面。
  **坑**：CSS 里那些 `#rtable` 的规则（打印时把「删行」那一列收成 0 宽）现在只匹配第一张表；第二张靠 `noprint` 把 × 藏掉，宽度留着也看不出来，就没再复制一份规则。另外两张表的列宽对齐靠的是 `table-layout: fixed` + 同一套 `<colgroup>`，别把某列改成 auto。
  屏幕高度 1105 → 1122，打印那页内容底 920 / 限度 1062 还是一页；单步 SJ-2-10 的版式只有表尾按钮位置变了。
- **两步回到一张投料表，条件仍然一步一块**（用户：「或者两步能写在一个投料表里吗」→「改回一张表，然后还是那个虚线，然后就条件表做两个好了，然后投料表内部就是虚线分隔」）。
  版式：投料表**一张**（一条列头、一个外框），上面先是这一步的「条件块」——`第 N 步` + `本步内容` + 那条虚线 + 这一步的五格条件行，一步一块（几个步骤就几块）；表里两步的投料行**只用一条虚线 + 左端一个小「第 N 步」分开**（`.step-divider`，没有重复的步骤头，也没有每步一组表头）。表尾那排操作仍在表外。
  实现：`<table>` 取消 `v-for`（回到一张），`<thead>` 恢复常显；条件块从表里挪到表前的 `.step-cond-block`（自带 `step-caret / 第 N 步 / 本步内容 / 虚线 / ＋ / ✕`，折叠仍然生效）；`tbody` 里 `v-for` 步骤，第一步之后插 `tr.step-divider`。上一轮的 `.step-cols / .step-cond-row / is-step-table` 样式都撤了。
  屏幕高度 1122 → **1083**（省回一条外框 + 一组表头），打印那页内容底 901 / 限度 1062。单步记录（SJ-2-10）完全没变；折叠、组分菜单点过正常。
- **结果表对齐 + 条件表去掉折叠箭头、再压一档**（用户：「结果那边对齐一下，然后条件表那个折叠箭头不需要，然后再压缩一下条件表」）。
  **结果表**：①产物那一列原来是「化合物小签 + 名字」——小签把名字往右顶了 30px，「产物名称」表头却从列首起排，整列看着跟表头错开一截；现在**名字在前、小签挂在右边**（`ResultBlock` 的 `.pick-wrap` 换了顺序），名字跟表头左对齐；②「产物 MW / 质量 / 产率」那三个数字列表头原来比数字往右偏 5px，表头 `padding-right` 跟输入框文字对齐（`9px = 格子 3 + 输入框 6`，选择器要写到 `.sheet .rtable.res-table thead th.n` 才压得过后面的 `padding-right: 4px`）；③单步那条结果的「性状 / 选择性」两列各让出一点，名字列宽 112 → 约 150px（`Ts苄基环丁烷` 以前被切）。
  **条件表**：①折叠箭头撤了（多步记录现在没法手动收那一步，`collapsed` 只剩单步表内那个头用得上）；②压矮：标题那行 15 → 13px、`本步内容` 宽 170 → 150、标签 8 → 7.5px、值 11.5 → 11px、上下 padding 各收 1px；③**第 2 步起不再重复那排小标签**（顺序固定、上面刚写过），少一层灰字、每步再省 11px。
  屏幕高度 1083 → **1054**（投料表 386 → 357），打印那页内容底 871 / 限度 1062，余量更宽。单步记录 SJ-2-10 只有结果表更宽一点。
- **产物小签收回左边（但保持列对齐）**（用户：「不要把产物那个标放到右侧吧，还是放在左侧可能好一点」）。
  上一轮把化合物小签移到名字右边是为了跟「产物名称」表头对齐，但小签在左边的读法更顺。现在两头都要：**小签在左、名字在右，但小签占一个定宽槽**（`.prod-link / .prod-slot`，`--res-tag-w: 46px`），所以不管有没有挂库、号是长是短，名字都从同一个 x 起排；表头 `.r-name` 用同样的偏移左缩进（`calc(--res-tag-w + 12px)`）压在名字上面（实测表头文字 736 == 名字文字 736）。
  解绑那个 × 改成**绝对定位**（`right: -9px`，hover 才显形不占宽度），否则它会把槽里的号挤成「B…」。
- **试剂名那格：双击弹化合物库的坑 + 单元格点击收一收**（用户：「为什么有时候单击也会出现这个弹窗，单元格这边还是再检查一下」）。
  **根因**：「从化合物库选一个」原来只挂在 `@dblclick.prevent` 上（`ReagentTable` 名字输入框）。而名字那一格 `td` 上还挂着 `@click="pinPreview(r)"`——**点一下输入框（想放光标）就会从 td 冒出一张结构卡**，再点一下（想挪光标 / 关那张卡）就落在双击判定窗口里，浏览器合成 `dblclick` → 库弹窗出来了。所以「有时候单击也弹」= 连着点了两下。
  **改法**：①**双击触发删了**，换成名字格右侧一颗小按钮（`molecule` 图标，`opacity .3`、鼠标进这一行才显形，title「从化合物库选一个」；挂了库的行不显示，改库先点结构卡里的「移除」）；②`td` 的点击改成 `onNameCellClick`：**点在 `input / button / .cmp-pop / .cmp-pick` 上不算「我要看结构」**——以前点进名字框也会弹一张卡把下面的行挡住；③PubChem 那颗放大镜让到左边一格（`right: 22px`），给新按钮腾位置。
  **验证**（探针脚本，注意 Vue 是异步渲染，要等一拍再看）：点输入框 + 合成 dblclick → 没有库弹窗、没有结构卡；点单元格空白处（td 自己）→ 结构卡照旧弹出且是 pinned；点新按钮 → 库弹窗正常打开。
- **组分里加一个「酸」**（用户：「试剂类型还要加一个酸」）。`lib/reagent.js` 的 `ROLES` 在「碱」后面插 `酸`，`ROLE_EN` 给缩写 `Acid`，`ROLE_TONE` 给 `acid`；颜色用**青绿 `#1b6e73`**（跟「碱」的蓝 `#1f6c9f`、「配体」的墨绿 `#2f6b4f` 都错得开），三处都补了：投料行的 `--tone`、组分菜单的 `.qchip[data-tone="acid"]`、反应式箭头文字的颜色表（`scheme.js` 的 `TONE_COLOR`）。
  验证：临时记录里 `酸 / TsOH 1.2 eq` 一行在投料表显成青绿 `Acid`，箭头上 `TsOH (1.2 eq)` 也是青绿（旁边 `Et3N` 还是蓝的）；组分菜单第四行现在九颗胶囊（底物/试剂/催化剂 · 配体/碱/酸 · 添加剂/氧化剂/还原剂 · 溶剂/其他/设为变量）。临时记录已删（`exp 10 / cmp 10`，回收站里只剩 SJ-2-9）。
- **组分菜单：别选字、点得准一点**（用户：「弹窗好像太灵敏感觉又不太灵敏，然后不要文字选中」）。截图里能看到按住菜单时把底下的表格一起拖选了一片。
  **根因**：`.role-menu` / `.role-caret` 上都没有 `@mousedown.prevent`（旁边的 `.cmp-pick`、`CondCand` 早就有）——按住胶囊那一下会先开始**拖选文字**，只要鼠标挪一两像素，浏览器就把这次操作当成拖选、`click` 不触发，于是「有时候点不生效」；同时选中的那一片还会把白色字盖掉（截图里选中的「酸」看起来是个空色块）。
  **改法**：①菜单面板和那颗小箭头都加 `@mousedown.prevent`；②`.qmenu` 统一 `user-select: none`（组分 / 条件 / 时间刻度这些面板都吃这条）；③箭头的点击区域从 11px 图标那一点扩到 `padding: 3px 4px`（原来边上 1–2px 就点空了）。点空白关菜单、点胶囊即选即存的老行为都没变。
  验证（临时记录，验完删了）：`mousedown` 的 `defaultPrevented` 箭头是 true、面板是 true；点「酸」那颗胶囊 → 记录里 role 真的存成 `酸`（服务端回读确认），菜单随之关掉；面板打开时截图里没有选中文字的痕迹。数据仍是 `exp 10 / cmp 10 / trash 1`（只剩 SJ-2-9）。
- **试剂名那两格小按钮：留一颗明确的，PubChem 那颗收进 hover**（用户圈着名字右边那两颗小圆点问「查询或者挂库按钮需要明显一点吗」）。
  原来两颗都是 hover 才显形的极淡圆点（`#d2cdc4` / opacity .3 和 0），小到看不出是按钮、也分不清哪颗是哪个。
  现在：①**「从化合物库选一个」那颗常显**（六边形，13px、`#9e978a`、opacity .7，鼠标进这行加深，`title` 写明用途）；②**PubChem 那颗平时收起**（`opacity 0`，鼠标进这一行才露）——MW 本来就是按名字自动查的，手动重查在「说明」格的「核对」浮层里也有，`is-miss` 那个小暖点仍然会在查不到时把按钮露出来。
- **所有弹窗「太灵敏」的根治：刚打开那 320ms 内，外面的点击不算数**（用户自己点出了原因：「一旦鼠标过于灵敏导致触发两次单击，第二次落点不在弹窗打开区域就直接关掉」）。
  新增 `src/lib/popguard.js`：`markPopupOpen()`（弹窗打开时调）+ `ignoreOutsideClick()`（在「点外面关闭」的处理器开头 `if (ignoreOutsideClick()) return;`），窗口 320ms。
  接进去的地方（都是这套「document 上点外面关」）：`ReagentTable`（名称候选 / 结构卡 / 组分菜单 / 核对浮层 / 化合物库弹窗）、`CondRow`（条件格的选择器，130ms 后开，开的时候 mark）、`CondCand`（候选名下拉）、`CatPick` / `ProjPick`（分类、课题下拉）、`AppRail`（课题切换）、`RulerPick`（温度/时间刻度带）、`EditorView`（⋯ 菜单 / 状态 / 反应类型）、`CompoundDetail`（⋯ 菜单）。
  验证（探针脚本）：点开组分菜单后**立刻**在 body 上补一次 click → 菜单还开着（以前这一下就把它关了）；等 500ms 再点外面 → 菜单正常关掉。列表 / 化合物库 / 设置页都过了一遍没红。
- **投料表「用量」小数位：质量（g）和体积（mL / µL）分开设**（用户：「液体和固体的小数点可以单独设置吗」）。
  以前只有一个 `reagentPrec`，管的是**质量**；体积走同一个数（设 4 位时 BnBr 会写成 `5.7089 mL`，其实量体积没那么精）。现在多一个 `reagentPrecVol`（同样 0/2/3/4，0 = 按量级自适应）：
  - `lib/reagent.js`：`volumeDecimals()` / `setVolumeDecimals()`；体积那几处（浓度折算、存了 µL 的行、按密度折出来的体积、`volText`）统一走新的 `vdec()`。**体积固定位数时去掉尾零**（`30 mL` 不会变成 `30.000 mL`），精度只在真有小数时体现（5.7089 → `5.709 mL`）；质量仍然「设了几位就几位」（`6.9680 g`）。
  - 投料表工具行那颗 `# 小数位` 从「点一下循环」改成**点开一个小弹层**：`质量（g）` / `体积（mL / µL）` 各一排胶囊（自适应 · 2 · 3 · 4 位），按钮上显示当前档位 `4·自`；弹层走 `popguard`，点外面关。
  - 设置页 06 里也拆成两行（原来只有一行「用量小数位」），带一句说明各自的效果。
  - 服务端 `UI_PREF_KEY_RE` 白名单加 `reagentPrecVol`；`store.js` 开机和 `onUiMerged` 都灌两个值。
  验证：质量 4 位 + 体积 3 位 → `6.9680 g` / `5.709 mL` / `24 mL` / `30 mL`（体积不再跟着质量走，也不再补尾零）；弹层开关、点外面关都正常；设置页两行都在。
- **在分类里就地新建，别落到「未分类」**（用户圈着中栏的分段：「在对应分类新建的话，不要默认去未分类里，卡片墙也是」）。
  **中栏列表**：分类段头（`.list-cat-head`）右边多一颗小「＋」（`.list-cat-add`，鼠标进这一段才显形），点了就在这个分类里新建并跳进去（`.list-cat-row` 里并排放，`createIn(sec)`）。「未分类」那一段传 `null`，明确落未分类。
  **卡片墙**：`.grid-group-add` 原来只在 **0 条**的分类上出现；现在**每个组头都有**——0 条时写着「新建实验 / 新建化合物」，有内容的平时收成一颗小「＋」（`.is-quiet`，鼠标进这一组才展开）。实验墙和化合物墙都改了。
  **顺手修掉的坑（重要）**：`store.createExperiment/ createCompound` 原来只传 `category_id`，课题还是取侧栏当前的 `store.project`。在「全部课题」下点某个分类的＋新建 → 记录落进**共用课题**，而那个分类属于「氨基环丁酮类」→ 服务端 `liveCategoryId` 判定「分类在别的课题」直接把 `category_id` 清成 null，于是新建的记录又进了未分类（实测 EXP-22 / category_id null 就是这么来的）。现在**指定了分类就让课题跟着分类走**（从 `recordCategories` 里取那个分类的 `project`）。
  验证：点「原料合成」段头的＋ → 新记录 `SJ-2-13, category_id 18, project 氨基环丁酮类`（改之前是 `EXP-22, category_id null, project ''`）；卡片墙两个组头都露出＋，0 条的那组仍写着「新建实验」。测试记录已删（`exp 10 / cmp 10 / trash 1`，只剩回收站里的 SJ-2-9）。
- **分类那一行改成右键菜单，左键不再「点一下就跳」**（用户：「发挥右键菜单的作用……侧边栏点分类，然后直接跳过去了，有点容易误操作」）。
  中栏列表的分类段头（`.list-cat-row`）原来左键点一下就把整个下拉筛到这一类、整列跳过去，太容易误触。现在**左键什么都不做**（`cursor: default`、`user-select: none`），要做的都进右键菜单：`只看「X」/ 在这里新建实验 / ── / 重命名分类 / 删除分类`（未分类那一段只有前两项——固定桶，不能改名删）。分类筛选仍然可以在顶部那个「状态 + 分类」下拉里做。
  卡片墙的组头右键菜单（实验墙 / 化合物墙）也补上了同样的 `只看「X」` 和 `在这里新建实验 / 化合物`，跟中栏一致。卡片本身的右键菜单（平行 / 复制 / 锁 / 删…）本来就有，没动。
  验证：右键「原料合成」→ 弹层四项，`只看` 动作是筛这一分类、`在这里新建` 走上一轮的 `createIn`（课题跟着分类）；`.list-cat-head` 现在是个 span，左键点到不会筛选。
- **右键在「分类区域」里任何地方都能新建到那个分类**（用户接着问：「就是在对应分类区域可以新建到对应分类吗」）。
  ①右键监听从段头那一行挪到整个分类段 `.list-cat` 上——段头、段内的空白处右键都出分类菜单（卡片自己 `stopPropagation`，仍走卡片菜单，不打架）；②**卡片右键菜单里也补了两项**：`在「X」里新建实验` / `只看「X」`（`experimentMenu` 新增 `opts.category`，中栏列表和卡片墙的卡片都传了；化合物墙同理，`compoundMenu` 也支持「在这个分类里新建化合物 / 只看」）。新建都走 `store.createExperiment(catId)`，**课题跟着分类走**。
  验证：右键卡片 SJ-2-10 → 菜单底部多了「在「原料合成」里新建实验 / 只看「原料合成」」；右键分类名（冒泡到段）→ 弹出四项分类菜单。
- **跨分类拖拽的落点位置修好**（用户：「侧边栏这边跨分类拖拽的时候有点奇怪」）。
  原因：`pointdrag.js` 的命中判定里，**落在「组里但没有卡片」的地方**（分类段头、卡片之间的缝、卡片下面那片空白）以前一律 `gapAt = count`，也就是**排到那一组的最后面**。所以明明把卡片拖到「未分类」最上面，松手却跑到那一组的最底下，看着就是「有点不对」。
  现在加了一个 `gapInGroup()`：在组内卡片里找**离指针最近的那张**，再用跟卡片命中同一套「前后判定」算插入位——指在段头上 = 这一组第 0 位，指在最后一张卡下面 = 末尾；`elementFromPoint` 那条老路（没有快照时才走）也一起换掉了。
  验证（临时记录 SJ-2-14，验完已删）：把它从「原料合成」拖到「未分类」第一张卡的上沿 → 落点槽出现在第一位，松手后 `category_id` 变 null、`sort_index 12` **排在 ZZ-TEST（13）前面**，确实插到了最前；改之前同样操作会排到最末。
- **新增「对照」页：两条记录并排看**（用户：「就是两个实验之间可以做对照吗，如果我要对比板怎么办，或者我要把信息陈列在一起然后做一些推理的话」）。
  新页面 `src/views/CompareView.vue` + 路由 `/compare?a=<id>&b=<id>`（只读，不动任何记录）：
  - 上面是**两块并排**：各自的反应式（`schemeParts` + `composeChainSvg / composeSchemeSvg`，不铺白底、最多 180px 高）和 **TLC 图**（附件里 `category === 'tlc'` 的那几张，并排铺开、点一下用 `FilePreview` 放大），TLC 那行记录（`tlc_note`）跟在图下面——**对比板就看这块**。
  - 下面是**逐行对齐的表**：条件（溶剂 / 温度 / 时间 / 气氛 / 装置 / 光照 / 规模）、结果（产物 / MW / 质量 / 产率 / 选择性）、以及**按试剂名并排的投料**（同名同当量才不算差异）；**不一样的行**左边一条强调色竖条、值变成强调色。
  - 顶部一句「不同：温度 · 溶剂 · Cs2CO3 · HFCI …」，一眼知道差在哪；每条记录都能「打开记录」。
  - 两边都能换：`换 A / 换 B` 走 `ExpPick`。
  **入口**：记录页 `⋯` 菜单「与其他记录对照…」（带当前这条）→ 挑另一条；列表卡片右键「与另一条对照…」（`rowmenu.experimentMenu` 新增 `opts.category`/`onCompare`）。
  验证：`/compare?a=286&b=287`（两块箭头、差异标色、投料逐行）、`/compare?a=182&b=183`（两张 TLC 板并排、点开可放大）、空页提示「上面各挑一条记录」；两个入口都点到底、确实跳到 `/compare?a=…&b=…`。
- **「对照」进了左侧导航**（用户：「就是可以单独出来吗，到侧边栏的话」）。
  `AppRail` 在「条件筛选」和「回收站」之间加了**对照**（新图标 `compare`：两块并排的框，`lib/icons.js`），点进去是 `/compare` 的空页（两个「挑 A / 挑 B」）；带参数从记录/卡片进来时这一项也会点亮，`route.name = compare` 天然对上 `active`。
  顺带把顶部那句差异摘要收了口：超过 7 项只列前 7 个 + 「等 N 处」，不然两条很不像的记录会甩一长串。
- **「对照」改成多实验摊开 + 写结论**（用户澄清：「也不算是对照，就是多个实验放在一起然后对比信息，然后得处结论」）。
  `CompareView` 从「固定 A/B 两列」改成 **N 列（≤5）**：URL 用 `?ids=1,2,3`（还认老的 `?a=&b=`），上面一排记录小签（点 × 拿掉）、「＋ 再加一条」走 `ExpPick`（它能多选）。
  - 并排区列数跟着条数走（`--cmp-cols`，最多 4 列，再多横向滚）：每条一格，反应式 + 自己的 TLC 板。
  - 下面一张**动态列表**：条件 / 结果 / **投料按试剂名对齐**，每一行「不全一样」就标强调色（两条时就是「不同」）。
  - 底部**「结论 / 推理」**输入框（草稿存 `localStorage`，key 按参与记录的 id 排序）+ **「存成筛选表」**：`POST /api/screenings`，`vars` 用 `DEFAULT_FIELDS`（相对标准条件 / 产率 / 选择性），结论进表注，存完直接跳 `/s/:id`——于是「多条实验 + 结论」进了记录本（条件筛选 → 我的筛选表）。
  **顺手修的**：筛选表「相对标准条件」列里规模差原来直接甩浮点数（`0.19996770994303112 mmol`），现在按 3 位收（`0.2 mmol`）。
  验证：`/compare?ids=182,183,206` 三列并排（两张 TLC + 一格没图）、投料行对齐且 CsOPiv 那行标了差异；存表接口用 3 条 + 结论建了一张表（列齐全、渲染成三线表）后删掉；测试用的筛选表已清（库里只剩原来那张 22）。
- **对照页改成「干净陈列」（用户：要「类似信息陈列对比」，从信息里取推理信息，不相干信息处理一下）**：用户先选了「只要干净陈列 + 保住现有骨架」，所以没做任何自动生成文字（**别再往里加自动结论 / 素材句**，用户明确不要）。
  ① **表格只列不一样的行**：`rowOf()` 把每个字段按 `empty` / `same` / `diff` 分档——`empty`（一条都没填）**直接不渲染**（以前满屏「—」），`same` 收成一行「相同：溶剂 dioxane · 温度 110 ℃ … N 项」，点一下才把这几十行摊平（`.cmp-same-row` / `.is-same` 淡色），`diff` 才是表格主体。
  ② **「相同」的判定必须是「每条都有值且全一样」**：一开始按「去重后只剩一个值」判，于是 `RuPhos — — 20 mol%`（只有一条有这个试剂）被错判成相同、藏进「相同」里——那恰恰是「加/去试剂」的**差异**。改成 `filled === vals.length && new Set(vals).size === 1`。
  ③ **派生量降级**：`产物 MW` / `质量` 标 `minor`，平时不出现，只有右上「全部字段」开关打开才露（那条开关同时把空行以「—」摊出来）。只挑一条记录时 `allRows` 恒真（没啥可折叠），但派生量与空行仍按上面的规则收着。
  ④ **结果放大**：每条一列在反应式和 TLC 之间多一条结果条——产率 17px mono 大字，后面跟**相对第一列的差量**（`+11.2` / `−11`，第一列挂「基准」小签），右边吊选择性；产率和选择性都空时整条不渲染（不然只剩一个孤零零的「—」）。
  ⑤ **分段改成因果序**：条件 → 投料（当量）→ 结果（结果压最下面，跟筛选表一个读法；原来是 条件/结果/投料）。
  ⑥ **TLC 压到 190px**（只在对照页 `.cmp-col .cmp-tlc img`）：三张板图会把变量表顶出第一屏。**图本身不裁**（height auto + contain），符合「TLC 图不许裁」那条。
  验证（WKWebView 实测 DOM，5173 + 4780 都看过）：三条条件筛选记录 → 只有「气氛」和 `P(Cy)3 / CsOPiv / RuPhos` 三行摊在表里，「相同」两条分别 6 项 / 4 项、点开摊平、再点「收起」回来；「全部字段」开关把空行和 MW/质量放出来；四条带产率的记录 → `52.3% / 63.5% +11.2 / 96.3% +44 / 41.3% −11`；单条记录（`ids=281`）不再有灰掉的 is-same 行、也不再出现空行。只碰了 `CompareView.vue` + `eln.css`，没动数据。

## 细节存档：卡片墙 / 中栏列表（原 AGENTS §4 那两条，2026-11-13 搬下来腾注入预算）

- `src/components/ExpListPane.vue` / `CmpListPane.vue` — 中栏列表。两边都是「**搜索框 + 一个筛选下拉**」并排一行（`.searchrow`，触发器宽度跟名字走、高度和输入框对齐 31px、菜单右对齐弹出）：实验那边下拉里是「状态 + 分类」，化合物那边只有「分类」，**都没有单独的 chips 行和 ＋新建分类按钮**。选中值形如 `status:进行中` / 分类 id，状态与分类**互斥**（选一个清另一个）。**卡片本身也是「亚克力」**：不描边，纸白 + 柔和投影浮在 `--bone` 列表底上，卡片之间留 **12px** 缝。卡片上那颗小标签是 `compoundSourceLabel(c)`（来源，不再是手选的类型）。**正在看的那条：不要红框、不要描边、也不要左边一条竖条**，**卡片底是一点点极淡的强调色调 `#fcf7f4`**（走强调色同族的极淡粉棕，别用暖黄），**用户点名要「一圈虚线」**：卡片内套一圈 1px 强调色虚线（`::after` + `inset:0`，不吃布局、跟着圆角走）+ 编号变强调色 + 投影深一点；**只要进到一条属于平行组的记录就自动展开那一组**（`EditorView` 的 `load()` 里：`if (e.group_id) store.openStacks[e.group_id] = true`——点卡片堆、点书签、直接开链接、首屏打开都算；用户在页面上手动「收起」仍然生效，直到下一次切记录），**一摞展开着的时候，虚线挪到具体那条组员行上**（面子卡的 `aria-current` 在展开时置 false；不然从书签切过来，选中框落在「这一摞」上、看不出是哪条子实验——用户报过）；组员行的虚线细一点（`rgba(168,71,31,.45)`、`border-radius: inherit`）。收起时虚线回到面子卡。**列表里同一个平行组**（同 `group_id`，`group_size > 1`）**收成一张「卡片堆」**：面子是最早那条（正在看的成员会翻到前面）、角上一个「平行 ×N」、下面一排组员小签（状态点 + 编号 + **状态简称** + 产率；点一下直接跳那条）、卡片头右上角「展开 ▾ / 收起 ▴」在下面列出组员行（**组员行只有文字、不加框线**，行间 2px + 行内 6px 内边距；**两张垫纸挂在 `.stack-top` 上、不能挂 `.exp-stack`**——展开后排纸会露白底在组员行下）；组员少于 2 条（比如搜索只命中一条）就当普通卡片。**组员行「改了什么」不折叠**：一条一项、各自一颗小标签（`.member-diff-item`），别合成「投料（加 X，去 Y 等）」也别让标签被挤竖排（顶栏子元素 `flex: 0 0 auto`）；**只认真改动**：基准那条投料表没填全时别把整张表标成「加」，有投料行就不再另给一颗「溶剂」，只差规模记「改：规模」+ 一句用量；`rxn_type` 只当标签（`.tag.is-rxn`），不算变量。**展开着哪些组、列表滚到哪儿存在 `store.openStacks` / `store.listScroll`**，不要放回组件内的 ref（换页面会重建）。「全部分类」时列表**按分类分段**（`.list-cat`：名字 + 条数，点一下 = 只看这一类），每段就是一个拖放落区——**拖到别段里就是换分类**（`.list-cat-blank` 只在拖的时候冒出来）。**一摞对外的下间距统一由 `.exp-stack` 给 12px**（面子卡片 `.exp-card.is-stack` 的 `margin-bottom` 归零、组员段 `.stack-members` 上距 8px 比 12px 紧一点读作「在这一摞里面」）。

- `src/components/ExpGrid.vue` / `CmpGrid.vue` — 卡片墙（分类分组、缩略图、拖拽换分类、拖到具体位置、落位虚线格；实验卡片上带「平行 ×N」小徽标，点进去左栏那个组就是卡片堆）。**「平行 ×N」钉在缩略图右上角**（`.stack-badge.is-corner`）（别放 `.top` 那行）。**缩略图定高 130px**（`.grid-thumb`，化合物的结构缩略图 `.is-structure` 仍是 148），所以实验卡片 ≈201 高、化合物卡片 ≈221 高，两面墙卡片大小基本一致；反应式是宽图，在 130 的框里居中，上下留白是正常代价。**卡片走「亚克力」那一路**：`.grid-card` **不描边**，靠三层 `box-shadow`（淡投影 + 大范围柔影 + 顶部 1px 内高光）跟画布分开，hover 只加深投影不描边；`.grid-thumb` 不用 `border-bottom` 分界，改用 `#fbfaf7` 的底色差。**同一个 `group_id` 的实验在墙上也收成一摞**（`.grid-stack`：`::before/::after` 是两张纸色纸片（`#faf8f1` / `#fdfcf7`），**和卡片一样大小**，`inset: 0` + `translate(13px,-13px)` / `(6.5px,-6.5px)`（往右上方斜着错开）；错开量别超过 16px（列距 20px 装得下），再大就成一摞砖，各带淡投影；垫纸必须用白色（`#fff` / `#fffefb`），画布是 `#f5f4f1`，纸色差一小就只剩一道灰影，看不出叠；卡片 `z-index:1` 盖住它们，并额外加一道向上的影子压在下层纸上；`stackOf()` 把每个分类里的记录折成 `cards`，面子 = 最早那条，`members` 保留全部；**模板里循环的是 `g.cards` 不是 `g.items`**，落点索引 `gapAt` 也跟着卡片算，别混回记录数）。**一摞的位置按「基准那条」（`anchor` = 最早成员）在列表里的下标算**（`rows` / `stackOf` 末尾按 `slot` 排序）：新建一条平行实验时会排到列表最前面，如果不按 anchor 排，整摞会突然跳到列表最上面（踩过）。一摞点开是面子那条，其余成员在左栏卡片堆和纸外书签里切；**拖一摞要整组一起挪**（`dropCard` 里取 `card.members` 全部 id，逐条 `moveExperiment`），只挪面子会把同一个平行组拆到两个分类里。筛出来只剩一条成员时（`card.members.length === 1`）当普通卡片画，徽标仍按 `group_size` 显示「平行 ×N」。**0 条的分类只占组头那一行**（右边一个小「＋」就地往这个分类里新建，`.grid-group-add`；**拖着卡片时那一行长成 46px 的落点框 `.grid-drop-line.is-armed`**（写着「拖到这里放进「X」」）），不再撑一整格虚线「新建」；只有一组的场景（刚建库 / 正按分类筛）才用大块 `.grid-new`——**现在是「淡色空位」不是虚线框**：半透明白底 + 淡灰「＋ 新建实验」，悬停才浮成一张带投影的白卡（用户明确不要虚线/红框那种）**「全部课题」下每个分组标题后面标出这个分类所属的课题**（`.grid-group-proj`：暖色**胶囊**小标签，`border-radius: 999px` + `#f7f0ea` 底 + `--accent-ink` 字，别做回方块；不然两个同名「321」分不清）。卡片墙的行列距是 **`gap: 26px 20px`**（`.card-grid`）。三层纸要用**色阶**分开（`#faf8f1` → `#fdfcf7` → 卡片纯白）+ 各自一道投影，否则全是白的数不清几层；**垫纸是整张卡片大小、往右上方错开**。两个墙组件都**只有 `.grid-page` 这一层**，外面的滚动容器 `.editor` 和右上角 `.grid-tools` 那一行按钮已经提到容器页（`EmptyEditor` / `CompoundsView`），因为切到表格视图时墙会卸载，工具栏得留在上面。
- **对照页第二版：改成「汇报展示」（用户：「就是类似回报展示，现在太复杂了」「主要就是 tlc 之类的吧，之前好像有个回报相关的」）**：上一版把字段表整理干净了，但一屏里还是「4 列 × 大 TLC + 几十行逐项对齐」，读起来仍是台账。这一版照 `lib/reportcard.js`（`⋯` 菜单里那张「一页汇报卡」）的版式重排：
  ① **一条一列一张小卡**：编号（第一列「基准」小签）/ 日期 → 反应式 → **条件一行**（`condLine()`：溶剂（取投料表 role=溶剂 那行，老记录回落到 `solvent` 字段）· 温度 · 时间 · 气氛 · 装置 · 光照 · 规模，空的略过）→ **相对基准改了什么**（直接调 `sctfields.variations()`，跟筛选表同一套口径；超过 4 项截成「… 等 N 项」，不然拿两条不相干的反应对照时能列出十几项）→ 产率大字 + **相对第一列差量** + 选择性 → 产物 → **TLC 78px 小图**（一排、不裁、图下不写字，点开走 `FilePreview`）。产率和选择性都空时整条结果行不渲染（不然只剩一个孤零零的「—」）。
  ② **整张字段表默认不出现**：原来那套「只列差异 + 相同折一行 + 全部字段」的逻辑保留，但改由右上角「明细 · N 处不同」开关控制（`v-if="showAll"`）。明细里空行不再摆出来，`is-diff` / `is-same` 仍标着——需要逐项对齐、比当量的时候才进。
  ③ 删掉了顶部那句「不同：…」（每张卡自己写着改了什么）；页头描述压成一句。
  验证（WKWebView，5173 + 4780）：三条同组记录 → 一张屏装下三张卡 + 结论框，「明细 · 4 处不同」点开才是整张表（`气氛` / `P(Cy)3` / `CsOPiv` / `RuPhos` 四处 `is-diff`），再点「收起明细」回去；四条带产率的记录 → `52.3% ｜ 63.5% +11.2 ｜ 96.3% +44 ｜ 41.3% −11`，改了什么那行按 4 项截断（`rt · 无时间 · 无气氛 · 20 mmol 等 11 项`）。
- **对照页第三版：突出变量（用户：「就主要是tlc什么的」→ 追问后：「突出变量，然后展示tlc之类的区别」）**：第二版把 TLC 缩到 78px、条件压成一行，但每张卡还是原样重复同一串条件，观众得自己找哪一格变了。这一版把「变量」提到视觉第一层：
  ① **几条都一样的条件只写一次**：`commonConds`（按 `COND_FIELDS` 的七格逐项比，全部有值且全等才入选）在卡片上方写成一行「相同：dioxane · 110 ℃ · 12 h · 封管 · 太阳光 · 0.2 mmol」——没被抽走的格子才是变量。
  ② **卡片上那一行换成变量行**：`varLine()`（`sctfields.variations()`）从 11.5px 淡色提到 **13px 强调色**、放在反应式下面最显眼的位置；基准那条写「基准」（淡一点）。**只挑一条记录时**没有「相对谁」可比，退回显示完整条件一行。
  ③ **TLC 从 78px 放大到 150px**（`flex-wrap: wrap` 不再截断，多出来的板子换行）——用户要的是「看 TLC 之类的区别」，缩到 78 就只剩色块了。仍然不裁图、点开看大图、图下不写字。
  验证（5173）：三条同组记录 → 上方「相同」一行 + 三张卡分别是 `基准` / `CsOPiv 1.0 eq` / `N₂，封管 · RuPhos`，TLC 三张并排 150px 可比；四条不相干反应（无共同条件）→ 「相同」那行自动不出现、变量行列到 11 项被截断；单条记录 → 回到「DCM · rt · 15.5 mmol」整行条件。
- **对照页第四版：TLC 自由对比（用户：「就是假设我需要自由对比呢」→ 追问 →「自由对比tlc」）**：前面几版一直把 TLC 当卡片里的附属图，尺寸怎么调都不对（跟着列宽挤、三条一列只能塞下一张）。这次干脆**把 TLC 从卡片里拿出来**：
  ① 新一节「TLC 对比」（`.cmp-tlc-box`）：`tlcList` 把挑进来的**所有**记录的所有 `category='tlc'` 附件摊成一排——240px 高、按原图比例、`flex-wrap` 换行，每张下面标「编号 + 展开剂/Rf」（`at.note`，没写就看记录的 `tlc_note`），点开走 `FilePreview` 看大图。
  ② 卡片里不再有 TLC（`is-thumb` 那套样式一并删掉，别留死规则）；卡上的信息就剩 编号 / 反应式 / 变量行 / 结果 / 产物。
  ③ 这一区**不跟基准、变量、列宽绑**：谁跟谁比由用户自己看——他这次要的就是这个自由（不是我前面猜的「基准可换 / 字段可勾」）。
  验证（5173）：三条同组记录 → 4 张板子并排（SJ-2-2 三张 + SJ-2-6 一张），不裁图、超出换行；点开大图正常；没 TLC 的记录这一区直接不出现。
- **TLC 图注要留着（用户：「图注需要保留吧」）**：拆成自由对比区时只写了「编号 + 展开剂」，把**文件名**那一截丢了（老版是 `at.note || at.original_name`）。图注现在三截：**编号**（强调色）+ 展开剂/Rf（附件 `note`，没写回落到记录的 `tlc_note`）+ **原文件名**（`ink-4`、10px、过长 ellipsis，`title` 里给全名）。实测这批数据附件 note 和记录的 `tlc_note` 都是空的，只有 `original_name`（`粘贴-1794365984090-1.png` / `1000051761.jpg`），所以之前等于只剩编号。
- **新增「排版板」＝自由画布（用户拿自己 ChemDraw 里拼的汇报页问「可以类似这样自由吗」，选了「先看方案再动手」→ 看完方案说「试试」）**：设计稿在 `BOARD-DESIGN.md`，第一版落地如下。
  ① **数据**：`boards` 表（`title / project / page / items_json / created_at / updated_at`），`items` 每项 `{id,type:'tlc'|'scheme'|'text',ref,code,x,y,w,caption,z}`。**坐标 0.1mm 整数**（A4 = 2100×2970）：屏幕按百分比摆，导 PDF 时 ÷10 得 mm；**图片只存宽**，高按原图比例。
  ② **接口**：`GET/POST /api/boards`、`GET/PUT/DELETE /api/boards/:id` + `GET /api/tlc?project=`（素材抽屉要的 TLC 清单，join experiments 拿编号）。**`PUT` 只认 title/project/page/items 四个字段**，items 上限 400。
  ③ **画布**（`BoardView.vue`）：白纸按「可视高度」等比缩放（`min(100%, clamp(360px, calc((100vh-210px)*比例), 780px))`），素材 `left/top/width` 全部用百分比 + `--bscale` 换算字号（图注 / 文字块跟着纸缩放）。拖动、右下角缩放都是 mouse 事件；方向键 1mm、Shift 10mm；双击改图注（`feedback.prompt`）；工具条 置顶/置底/水平居中/删除。
  ④ **导 PDF**：`boardHtml()` 把 items 拼成一张 210×297mm 的绝对定位 HTML，走现成的 `/api/print/pdf`（`server/print.swift`），不新写导出器。
  验证（WKWebView + 真接口）：建板 → 点素材加进画布（两张 TLC + 一张反应式）；拖动后 `left 5.71%→19.62%`、`top 13.47%→20.03%`；拖右下角 `w 29.52%→42.29%`；加一段文字 → 变成 4 块、Delete 又回到 3 块；防抖自动存（`GET /api/boards/1` 里 items 与屏幕一致）；**导出 PDF 实测**（用真 `lib/board.js` 拼页面 POST `/api/print/pdf`，`sips` 转图看过：两张板子 62mm 并排 + 各自图注 + 下方反应式 + 图注，都在 A4 内）。测试板已删（`boards` 回到 0 行），没碰任何记录。
  **注意**：服务端加了新表/新路由，**必须重启 4780**（`npm run serve`）才生效；我重启过一次。
- **排版板补成「记录里的信息都能摆上去」，同时把「对照」页撤掉（用户：「就是实验内部的信息都可以展示上去，然后对照感觉就不用了，只要排板板就行了，但是可以弄得完善一点」）**
  ① **块**：`lib/board.js` 里 `BLOCKS` = 编号 / 反应式 / 条件 / 投料表 / 结果 / 结论，`blockHtml(kind, exp)` 一个函数出 HTML；配上原有的 **TLC 图** 和 **一段文字**，一条记录能摆的东西就全了。**素材抽屉改成按记录分组**：一条记录一行「编号 + 六个胶囊 + 它自己的 TLC 小图」，点胶囊就落一块。
  ② **两条铁律立起来**：坐标还是 0.1mm 整数，但**屏幕上不再用百分比**——给纸张加 CSS `zoom`（`fit()` 算「适应窗口」，另有「100%」档可滚），纸里字号间距全按 **mm / pt** 写；块的 HTML **只有 `itemHtml()` 一份**，屏幕 `v-html`、PDF 拼进 `boardHtml()`。这样**屏幕和 PDF 长得一样**，以后再改块样式不用改两处。
  ③ **撤掉对照**：删 `src/views/CompareView.vue`、路由改 `/compare` → `/boards` 重定向、侧栏去掉「对照」、列表右键与记录页 `⋯` 里的「与另一条对照…」一并删除（`rowmenu.js` / `ExpListPane.vue` / `EditorView.vue`）。`ExpPick.vue` 保留（筛选表、接上一步还在用）。
  ④ **完善**：靠边 / 水平居中 4.5mm 吸附、⌘D 复制、A4 竖横一键切、100% / 适应窗口两档缩放、新块按「已排到哪儿」的实测底边往下排（`cursorY` + `syncCursor()`，连点时先按 62mm 估一格）。
  **踩到的坑**：导出 PDF 里投料表「用量」整列被裁掉 —— `server/print.swift` 给的页面视口是 **595.28×841.89 CSS px**（不是 pt），A4 = 210mm = 794px，所以 `PRINT_CSS` 必须 `body { zoom: 0.7498 }`（跟 `lib/print.js` 的 `A4_CSS` 同一个道理）。
  验证（WKWebView + 真接口 + sips 看 PDF）：抽屉 9 条记录各带胶囊；依次加 编号/反应式/条件/投料/结果/结论 六块 → 内容正确（`SJ-2-1 · A to C`、`条件 THF · −78 ℃ · 12 h · N₂ · 圆底烧瓶 · 40 mmol`、投料表 6 行、`产物 苄基环丁烷醇 · 产率 52.3% · 质量 4.9476 g`、结论占位）；新块落点 y=152.1mm 接在已有内容下方不叠；导 PDF 一页 A4，表格四列完整、图注居中、反应式与 TLC 都在；测试板都删了（用户自己建的那张 `排版板` id=2 **没动**）。
- **拖一下就「飞走」（用户报的）**：排版板第二版把坐标换成 mm 之后，`unitsPerPx()` 写成了 `1 / (MM_PER_PX * 0.1 * zoom)` = 37.8/zoom，而真值是 `MM_PER_PX / 0.1 / zoom` = 2.646/zoom —— **大了 14.3 倍**，鼠标动 1px 块就窜出 14px 的位移，看起来就是「一拖就滑走」。改成后者，并顺手加 3px 死区（不足 3px 不算拖，只是点一下别把块挪歪）。
  验证（WKWebView 派发真实 mouse 序列，board 2）：+60px / +30px 拖拽 → 块从 `8mm,7.4mm` 到 `40.2mm,23.5mm`，即 +32.2mm / +16.1mm，正好等于 `60 × 2.646 / zoom(0.4935)`。**注意**：那次验证拖的是用户自己那张板（id 2）的第一块，跑完已经按原坐标 `x=80,y=74` 写回去了。
- **拖动改顺滑（用户：「拖拽还能顺滑一点吗」）**：以前每个 `mousemove` 都改响应式坐标 → Vue 每帧重渲染 + 写 `left/top`（触发重排），加上 Safari 的 mousemove 又密，拖起来发涩。现在：
  ① **rAF 合帧**：mousemove 只记最新坐标（`pend`），一个 `requestAnimationFrame` 里最多写一次 DOM；
  ② **拖的时候不改坐标**：只写 `el.style.transform = translate(...mm)`（合成层，不触发重排），**松手才把最终 x/y 回写进响应式数据并赋值 `left/top`**（顺序是先写 left/top 再清 transform，否则会闪回原位一帧）；
  ③ 拖起来给 `will-change: transform`，`body` 挂 `is-board-dragging`（grabbing 光标）；
  ④ **吸附有参考线了**：4.5mm 内吸到左/中/右时，页面里画一根 0.28mm 的强调色竖线（`guideAt`），不再是「莫名其妙跳一下」；缩放（拖右下角）同样走 rAF + 直接写 `style.width`。
  验证（临时板 + 真实鼠标序列）：拖动中 `left` 保持 30mm 不动、`transform(64.3mm, 32.2mm)` 跟手、`will-change=transform`、`body.is-board-dragging`；吸到中线时 transform 46.1mm、参考线在 105mm；松手后 `left=74mm`（正好中线）、transform 与 willChange 清空、`items.x=740` 落库；负方向拖 -170px → -91.1mm，数值都对得上 `px × 2.646 / zoom`。
- **纸张会上下滑动（用户：「你把页面滑动的问题彻底解决一下，就是纸张会上下滑动」）**：根因有两层。
  ① **整页本来就能滚**：`.single` 是滚动容器（`overflow-y:auto` + 底部 100px 呼吸位），而画布高度是**硬算的** `calc(100vh - 250px)` —— 两者对不上，纸张连带整页上下滚。现在排版板单独一套锁死的布局：`.board-single { overflow: hidden; padding-bottom: 16px }`，`.inner` 变成 `flex column` + `height:100%`，`.board-wrap` / `.board-stage` 用 `flex:1 1 auto; min-height:0` **吃掉剩余高度**，`fit()` 按 stage 的**真实高度**算 zoom → 纸永远刚好装下、外层一点都滚不了。
  ② **工具条一出现纸会缩一下**：选中块时底部 `.board-tools` 才渲染，stage 高度变了 → `fit()` 重算 zoom → 纸张「跳」一档。现在外面包一层 `.board-tools-bar { min-height: 30px }` 常驻占位，工具条在不在高度都一样。
  `.board-stage` 默认 `overflow: hidden; align-items: center`；**只有钉住「100%」时** `is-pinned` 才 `overflow:auto; align-items:flex-start`，让纸自己在 stage 里滚，窗口照旧不动。
  验证（WKWebView，1280×820 与 1400×900 两种窗口）：`document.scrollHeight == clientHeight`、`.single` 也不可滚、stage 无内滚；纸张可视尺寸正好等于 stage 减 16px 留白；点「100%」→ document 仍不可滚、stage `1123/621` 内部可滚、zoom=1；点回「适应窗口」再拖 +60/+30px → `30mm,30mm → 59mm,44.5mm` 且落库 `x=590 y=445`；选中块前后 `zoom=0.521149` 一分不差（纸不跳）。
- **记录页「没超出页面但还是会滚动」（用户截图 /e/121）**：`is-fit` 的判断一直没生效。根因两条：
  ① 判据错：原来量 `scrollHeight − paddingBottom`，而 `.editor` 底部有 **120px** 呼吸位，`scrollHeight` 是含这段 padding 的 —— 只要内容底 + 120 超过了可视高度，`scrollHeight − 120` 就把空白当内容算，判成「放不下」；于是**内容明明装得下，还能往下滚进那 120px 空白**。
  ② 量的时机错：只在挂载 + 窗口 resize + `[exp, page, liveScheme]` 变化时量，谱图 / 反应式图 / 字体异步到位后就不再重量（实测 1435 高的窗口里内容底 1286，`is-fit` 却是 false）。
  改法：`updateEditorFit()` 改成量 **`.editor-inner` 的真实底边 + 24px** 与 `clientHeight` 比；`scheduleFit()` 立即量 + 下一帧 + 250ms + 900ms 各补一拍；`ResizeObserver` 同时盯 `.editor-inner` 和 `.sheet`；监听容器的 `load`（捕获，图片）和 `document.fonts.ready`；`.editor` 加 `overscroll-behavior: contain`；`is-fit` 时顺便把 120px 呼吸位收成 24px。
  验证（WKWebView 三档窗口，把量测值直接画在页面上截图）：**1600×1300** → `class="editor is-fit"`、内容底 1219 + 24 ≤ 1300、`scrollTop=400` 设不动（**滚不动 ✓**）；**2196×1435** → `is-fit=true`、内容底 1286、可滚=false；**1280×820** → 内容底 1202 > 820，`class="editor"`（无 is-fit）、`scrollTop=400` 生效 —— 该滚的时候照旧滚，没滚坏。
- **结果块加一层「TLC 判断」+ 修「反应式上的条件超出了」（用户：「如果变量实验但结果只有 TLC 呢，大部分小反应的变量实验都是看 TLC，然后再去详细产率」→ 选了「结果块自带 TLC」+ 五档）**
  ① **字段**：`experiments.tlc_verdict`（`ensureColumn`，老记录空串不受影响）；`EXP_COLUMNS` 白名单 + `FIELD_LABELS`（中文「TLC 判断」）一起补，**别忘了 `EditorView` 的 `fields` 也要加这个键**——`FIELD_KEYS = Object.keys(fields)` 同时管「读进页面」和「保存 payload」，漏了就点了不落库（第一版就是这样：界面上选中了、库里还是空串）。
  ② **界面**：结果块表格下面多一行「TLC 判断」——五档胶囊（`lib/ui.js` 的 `TLC_VERDICTS`：原料消失 / 部分转化 / 有新点 / 明显副点 / 没反应，再点一次取消），右边并排**最多 3 张 22mm 板图**（多出来显示 `+N`，点开 `FilePreview`）。产率那格在「选了判断但还没称」时占位写**「待测」**。
  ③ **排版板**：`BLOCKS` 多一个「TLC 判断」块（`blockHtml` 的 `verdict`：判断 + 展开剂/Rf 两行），几条记录摞起来就是一张筛选总结页；抽屉胶囊也补上。
  ④ **顺手修的**：`composeChainSvg` 的箭头上方条件**以前硬排一行 + 箭头封顶 360**，长条件会直接画出箭头区域、压到结构上甚至被裁掉（用户截图「反应式上的条件超出了」）。现在「先排一行，塞不下折两行」，箭头节点宽度取 `max(arrowLen, capW) + 26`，字永远在框里。**改完发现老图还是旧的**——`scheme_cache` 只按投料表 `sig` + 结构指纹判新旧，排版改动不算，所以加了 `server/db.js` 的 `SCHEME_LAYOUT_VER`（启动时按它一次性清空缓存），以后改反应式排版记得 +1。
  验证（WKWebView + 真接口）：点「部分转化」→ 库里 `tlc_verdict="部分转化"`、产率占位变「待测」；再点同一颗 → 回到 `""`（测试后已还原，没留在用户记录里）。排版板上两块 verdict：`TLC 判断 部分转化` / `（还没填 TLC 判断）`。给 8 个试剂的条件排在箭头上方时：改前 svg 942×270、那行字 478px 且贴着结构；改后 286×290、折成两行（290..430 / 195..525），探针确认没有字出画布或压结构。第 1 页 sheet 高度 1065 → 1035（预算 1106），**仍是一页的量**（TLC 小图压到 22mm、最多 3 张就是为了这个）。
- **分工定调：记录只做「收集」，板做「对比 + 结论」（用户提的），并按这个方向补了板的能力**：记录页这边把 TLC 收得更轻 —— 结果区不再铺一排骨图，改成 **`tlc_shot_id` 一个引用**（小缩略 + 文件名，点开大图；只有一张 TLC 时自动用它，多张点「换」挑），TLC 判断那五档保留。
  板上补三样：**对比表块**（`block:'compare'` + `refs[]`，抽屉「对比表…」挑 2–8 条 → 一张 `编号 / 改了什么 / TLC 判断 / 产率` 的小表；「改了什么」复用 `sctfields.variations()`，>3 项截断）、**结论块**（`block:'concl'`，带「结论」小标题的文字块，双击改字）、**成组摆放**（抽屉按钮 → 挑几条 → 每条自动生成 `条件` + `TLC 判断` 两块并竖排）。`itemHtml(it, exp, ctx)` 多一个 `ctx={get(id)}`，屏幕和导出都得传（模板里漏过一次，表里只剩「至少两条记录」）。
  **踩到的坑**：① `EditorView.fields` 是显式 reactive 对象、`FIELD_KEYS = Object.keys(fields)` 同时管读和存，**新字段忘了加进 `fields` 就不会落库**（第一版点完 TLC 判断，库里还是空串）；② 板子防抖 700ms，**关标签页那一下会丢**（`onBeforeUnmount` 只在路由切换时跑）→ `pagehide`/`beforeunload` 补一次 `saveNow(true)`（`api.saveBoard(..., {keepalive:true})`）。
  验证（WKWebView + 真接口）：点「部分转化」→ 库里 `tlc_verdict` 落盘、产率占位「待测」；「换」能选另一张板并写 `tlc_shot_id`；抽屉「对比表…」勾 SJ-2-1 / SJ-2-11 → 表头 `编号 | 改了什么 | TLC 判断 | 产率`、首行「基准」；「成组摆放…」勾两条 → DOM 5 块、库里 `items=5`（`concl@180 conds@880 verdict@970 conds@1130 verdict@1220`，真接口读回核对）。测试板全删了，用户自己那两张（id 2 / 7）没动。
- **设置页：功能搜索 + 子功能快速选择（用户：「设置这边开始有点复杂了」「怎么快速切」「还有就是子功能快速选择」）**。设置页换成了真·二级侧边栏（`.panes` + `.listpane`，208px，跟实验记录 / 化合物库那根中栏同一套：bone 底、分隔线、自己滚），右边 `.editor > .editor-inner.set-inner`（max 860px）。侧栏条目 13px、当前项 `#eae7e1` 实底 + 500 字重（第一版是纸白卡 + 投影，看着像浮在内容里的卡片，用户说「干脆直接做成二级侧边栏」，就改成实底了）。
  ① **功能搜索**（`SET_SEARCH`）：标题框下面一个搜索框，输入就换成命中列表（每条两行：设置项 + 它属于哪个模块），点一条 = 切模块 + `scrollIntoView({block:'center'})` + `is-flash` 闪 1.4s。索引里 `label` 是给人看的标题，`kw` 塞别名（TLC / 产率 / 备份 / 编号 / 局域网 / 二维码…），`anchor` 指到卡里那一节。
  ② **子功能快速选择**（用户最新提的）：`SET_SUBS` 给出每个模块的子项，**只在当前模块底下就地展开**（缩进 26px、11.5px、`--ink-3`），点一下走同一个 `jumpTo(anchor)` 滚过去闪一下——省掉「先切模块、再往下翻」。搜索框有字时自动收起，免得和命中列表打架（两条路都通到同一批锚点，但一个是「我知道叫什么、跨模块找」，一个是「我在这一块里、找下一节」，不重复）。窄屏（≤900px）侧栏本来就是横向胶囊，排不下就不显示子项。
  为此给各卡补了锚点：`set-book-basic` / `set-lan` / `set-qr` / `set-datadir` / `set-backup` / `set-keys` / `set-peek`，加上原有的 `set-blocks` / `set-fx` / `set-scheme` / `set-tlc-n` / `set-decimals` / `set-quick`。**踩过的坑**：`jumpTo` 抢在 `v-if` 换模块的 DOM 之前跑就找不到元素（`goHit` 里必须 `await nextTick()`）；`--ink-4`（#b4b2aa）当可点条目的字色对比度太低，换成 `--ink-3`（#8d8b84），hover 才到 `--ink`。
  ③ **持久化**：当前模块存 `uiprefs` 的 `setMod`（服务端白名单已加）。`mod = ref(uiGet('setMod','book'))` 写在 `uiMerge(boot.uiPrefs)` 之前会先拿到默认值，所以要 `onUiMerged` 重读一次，否则刷新后跳回「记录本」（踩过）。
  验证（WKWebView + 真接口）：搜「备份」→ 命中「备份 / 还原」+ 副标「数据与备份」，点进去落在 `set-backup` 那一行并闪一下；`记录页` 模块下点「挂几张板」→ 滚到 `set-tlc-n`；`界面` 模块下两条子项（快捷键 / 书签悬停预览）都在；窄屏 900px 下子项隐藏、模块变胶囊。测试完把用户原来的 `setMod` 写回去了（别留我的点击痕迹）。
- **「各条件结果」收成一张小表（用户圈图问「所以这个要怎么办」→「变成一个小表吧」）**。原来的排法是每行一组 flex 标签：`1  [L] RuPhos   产率 [__] %  选择性 [94:6 / 99% ee]  备注 [（选填）]`——**标签每行重复一遍**，两个候选都空着时满屏一样的占位字，看着像把同一份数据复制了两行。现在换成 `.rtable` 小表（跟上面结果表同一套字与线）：表头只写一次 `条件 | 产率 / % | 选择性 | 备注`，一行一个候选，占位符统一成「—」（备注留「选填」），数字格照旧 `input.n`（mono、右对齐）；`%` 挪进表头，不再每格跟着一个孤零零的 `%`。`condWhat()` 顺手补上当量（`[L] RuPhos · 20%`）——原来只写名字，两个候选都 20% 的时候看不出差别；条件那格 `max-width:0` + ellipsis，长了悬停看全。列宽 18 / 54 / 108 / 126，纸面内宽 595 下条件那格还有 ~283px。行高比原来矮一点，第 1 页 1078（预算 1106），**打印仍是一页的量**。
  死代码一并清掉：`.condres-row` / `.condres-f` / `.condres-in` / `.condres-num` / `.condres-u` / `.condres-lbl`（`grep` 确认模板里没有残留）。验证（WKWebView + 真接口）：SJ-2-8（206）两行显示 `[L] RuPhos · 20%` / `[L] Dcpf · 20%`，三个格子都是「—」，填了值的那行是 mono 右对齐、`>20:1 / 99% ee` 只在 108px 里截断不失真；测 `yield_pct` 输入只改自己那一行（不串行），且**测试值没有落库**（`conds_json` 核对过还是 null）。
- **设置页侧边栏：加宽 + 手风琴展开（用户：「稍微加长一点，类似化合物和实验那边，然后展开和收缩动画，状态保存」）**。宽度 208 → **288px**（实验记录 / 化合物库那根中栏是 336，设置页条目短，288 刚好是「同一个样子但不浪费」），窄屏（≤900px）仍是横向胶囊、没有箭头也没有子项。
  模块行右边一颗 `chevron` 小箭头（11px，朝右 = 收着，`rotate(90deg)` = 展开），只有 `SET_SUBS` 里真有子项的那几块才有箭头；`课题与分类` 没子项，就只剩「点 = 切过去」。
  展开 / 收起：`openMods`（数组）+ `setOpen(key,on)`，**点模块 = 切到它 + 展开它；点已经选中的那块 = 收起 / 再点展开**；搜索命中切模块时也顺手展开。动画走 `max-height`——`subsMax(key)` 按条数算 `n*27px`（子项定高 27px，跟 `SUB_ROW_H` 对上），不猜大值，所以高度是「刚好」的，不会有 220ms 的视觉延迟或突跳；另有 `opacity` 160ms。收起时 `pointer-events:none` + `tabindex=-1` + `aria-hidden`，不会接走点击和 Tab。
  **状态存 `uiprefs` 的 `setOpen`**（`string[]`，跟 `setMod` 一样换浏览器 / 重开还在）：服务端白名单 `UI_PREF_KEY_RE` 加了 `setOpen`（**改这个必须重启服务**，不然推上去会被丢掉），`onUiMerged` 里跟 `setMod` 一起重读。没存过 = 只展开当前那块（`readOpen()` 用 `setMod` 当默认），所以新浏览器看到的还是「当前模块展开」。
  **踩到的坑**：① 子项原来是直接挂在 `listpane-body` 这个 flex 列里，加了动画容器后必须包一层 `.set-group`，否则 `max-height` 包不住模块行；窄屏 `flex-direction: row` 时 `.set-group` 也要改成 row、并清掉组间 `margin-top`，不然胶囊会竖着叠。② 子项改成 `display:flex; height:27px` 才能让 `n*27` 真的是高度（原来 `padding:5px` + 行高算出来 26.7px，累积几行就会底部被裁一条）。
  验证（WKWebView + 真接口）：新浏览器打开 → 当前模块（界面）展开、其余收着；连点「记录页」「数据与备份」→ 三个都开着、`ui_prefs.setOpen` 跟着变；刷新后仍然三个开着；再点一次当前模块 → 收起、`setOpen` 里那条没掉其他条。测试完把 `setMod` / `setOpen` 写回用户原来的「界面 / 只开界面」。
- **结果区合并：一张表，一行一个候选（用户：「意思就是直接合并这两个，或者有其他更好的方案吗」→ 选「一张表 + 填质量自动算产率」，记录级产率「取最高」）**。
  上一版把「各条件结果」收成了第二张小表，用户圈图说还是想要**一张**。判断：真正重复的不是布局而是**两套产率**（结果表一个是整条记录的、条件表一个是每个候选的），所以按「候选成为结果表的行」来合并，而不是把两张表贴在一起。
  现在的样子（候选 ≥2 才接管，`multi` 多步优先，没候选 / 只有一个候选还是老样子）：
  ```
  结果  一行一个候选
  [1] 丙炔基氨基环丁酮   性状 [白色固体]   MW [431.6]
  理论产量 0.0863 g（0.2 mmol） · 最高 70.9%（2 个候选）
       条件                  质量 / g   产率 / %   dr / ee   备注   TLC
  1    [L] RuPhos · 20%      0.0612     70.9       > 20:1     —     图
  2    [L] Dcpf · 20%        0.0488     56.5       > 20:1     —
  ```
  ① **产物是共同的** → 名称 / 性状 / MW 提到表格上面一行（`.res-shared`，`.pick-wrap` 那套挂库小签和 `molecule` 挑库按钮照旧），`理论产量` 和「最高 X%（N 个候选）」也写在这一行；原来表下面那行 `res-note` 在候选模式下不重复。
  ② 表里每行：序号 + 条件（`condWhat()`，带当量）/ 质量 / 产率 / dr·ee / 备注 / TLC（板图 `rowspan` 挂在第一行）。**质量填了就按 `base_mmol × 产物 MW` 自动算产率**（跟投料表同一个式子，`yieldInfo()`），手填过产率就不再自动覆盖（`candTyped`，跟单行那套「手填过就不动」一致）。
  ③ **记录级 `yield_pct` = 候选里最高的**（`rollup()`）：筛选表 / 卡片墙 / 导出只认这一个数，而筛选表本来就会按 `cond` 展开、优先读 `conds[i].yield_pct`（`sctfields.autoValue`），所以两边都对得上。
  ④ 数据：`conds` 多了 `mass`（质量 / g），`EditorView` 的 load / save 映射和 `server/index.js` 的 `normalizeConds` 都加了这个字段（`filter` 里也算一条，不然只填质量的候选会被当成空行丢掉）。**改 server 要重启**。
  ⑤ 旧的两张表痕迹全删：`#conds` 插槽、`.condres*` 一整段 CSS、以及 EditorView 里那段模板。**注意**：`2026-11` 时库里带 `conds` 的记录**只有 SJ-2-8（206，空的筛选）**，它是空的所以不需要迁移；以后再改这块要记得先 `select` 一遍带候选的老记录。
  验证（WKWebView + 真接口）：206 上敲 `0.0612` / `0.0488` → 两行分别算出 `70.9` / `56.5`，库里 `conds_json` 落了 `mass`，记录级 `yield_pct=70.9`（= 最高）；多步记录 SJ-2-12（287）/ SJ-2-1（121）仍是「一步一行」，没被候选模式抢走；第 1 页高度 1078 → **1005**（预算 1106），打印仍是 2 页。测试值已还原（`conds_json` / `yield_pct` 写回空的）。
  **补：CSS 返工（用户看了一眼：「可以这样，但是 css 有点没弄好」）**。三处都是「这一行不在 `.rtable` 里」造成的：
  ① 表上面那行共同信息（产物 / 性状 / MW）的 `<input>` **没有任何样式接管**，用的是浏览器默认的 2px 灰框 + 白底，跟表里那种「没有框、悬停才出底色」的输入完全两个语言；`性状` 和 `MW` 还被挤成 84 / 56px，字被截断。现在 `.res-shared input` 自己按掉边框（transparent → hover `#f8f7f2` → focus 才出 `--line-2`），字号 / mono / 右对齐跟 `.rtable input` 对齐，宽度 88 / 60px。
  ② **「理论产量」和「最高 X%（N 个候选）」原来塞在同一行**，纸面内宽只有 ~540 时必折成两行，把「结果」这块撑到 42px 高。改成：上面一行只留 产物 / 性状 / MW（`产物` 给 `flex: 0 1 210px`，性状和 MW 紧跟，别被推到最右边留一大片空白），`理论产量 …` 回到底下那行 `.res-note`（跟单条记录一个位置），`最高 X%` 直接去掉 —— 表里每行都写着，摘要再说一遍纯占宽。
  ③ 候选表本身：`条件` 那列让出宽度，`质量 64 / 产率 64 / dr·ee 78 / 备注 96`，`.res-cand-cell` 用 flex + ellipsis（条件名长了不会把行撑开）。
  量过：第 1 页 1010（预算 1106），打印还是 2 页；填 `0.0612 / 0.0488` → `70.9 / 56.5`，库里的 `yield_pct` 仍是最高那个 70.9。测试值又还原了一次。
  **补 2：候选行改成 `Entry 1/2`（用户：「这边稍微优化一点，就还是 entry，然后不要太挤」）**。第一格原来是一个 9.5px 的裸数字 + 条件挤在一格里（`1 [L] RuPhos · 20%`），现在拆成两格：左边 `Entry 1`（跟投料表变量行同一个写法：mono 9.5px、`--ink-4`、`nowrap`，56px 宽），右边才是条件（12px、`--ink`、超长省略 + `title`）。
  同时把行松开：`.res-table.is-cand tbody td` 上下 padding 3 → 5px，行高 27 → 36px；列宽 56 / auto / 62 / 62 / 78 / 92。
  **坑**：列宽写 CSS 改不动 —— `.sheet .res-table:not(.is-multi) .r-mass`（4 个类）优先级压过 `.res-table.is-cand .r-mass`（3 个类），所以候选模式的宽度现在**直接内联写在 `<colgroup>` 的 `<col style>` 上**（以后动这几列去改模板，别去 CSS 里找）。
  量过：第 1 页 1030（预算 1106），打印仍 2 页。
- **切记录时停在同一页（用户：「假设你在第二页，切换实验的话就也到对应的第二页，如果没有第 X 页的话就默认第一页，然后这个设计也放在模块那边可以更改」）**。
  以前 `route.params.id` 的 watcher 里是 `page.value = query.p === '2' ? 2 : 1`，所以从第 2 页点另一条实验就被弹回主记录页（第 1 页）。（还有一行 `page === 3 && sheetPrefs.attachments` 的老特例，是「附件」还排在第 3 页那个年代的残留，现在附件已经是第 4 页，那行等于死了。）
  现在：`keepPage`（`uiprefs` 的 `pageKeep`，默认 **开**）→ 切记录时 `pageExists(当前页)` 就留着，否则按 URL / 回第 1 页。`pageExists()` 读 `pageTabs`：**1 / 2 永远有**，3（文献）要 `sheetPrefs.lit`、4（附件）要 `sheetPrefs.attachments` —— 也就是说「第 X 页不存在」在现在的版式里只有一种情况：那一页在设置里关掉了。
  设置入口：**设置页 04 界面 → 新增一张「切换记录」卡**（`id="set-pagekeep"`，一个勾「切记录时停在同一页」+ 一句说明），同时进了 `SET_SUBS.ui`（侧栏子项）和 `SET_SEARCH`（搜「翻页 / 第2页 / 续页 / 切记录」都能命中）。服务端白名单 `UI_PREF_KEY_RE` 加了 `pageKeep`（**改完重启服务**）。
  验证（WKWebView + 真接口）：`/e/206` 点「第 2 页」→ 切到 SJ-2-11 → 仍停在「第 2 页 · 续页」（截图里 `aria-selected` 在第 2 页那颗上），同时弹「已切换到 SJ-2-11」；把 `pageKeep` 写成 `false` 再走一遍 → 回到「第 1 页 · 主记录」。测完写回 `true`。
- **滚轮切记录 + 顶上两颗翻页箭头（用户：「滚动可以切换实验吗，然后切换页的话怎么办」→「滚动切换记录，页面上再加一个切换页面的按钮箭头，鼠标加键盘有点麻烦，但键盘快捷还是保留」）**。
  ① **滚到头再滚 = 切上/下一条记录**（`scrollSwitch`，设置页 04 的勾，默认开）。判定在 `editorEl` 的 `wheel` 上（`passive`，只读 `scrollTop` 不改布局）：先看这一下是不是**已经顶到底了**（`scrollTop + clientHeight >= scrollHeight - 2`，向上则 `scrollTop <= 1`）——纸面本来就放得下、不需要滚的时候这两个条件同时成立，竖向滚轮直接算切换；放不下就得先自己滚到底，再**累计 140px** 才切，`380ms` 手停就重新累计、切完 `700ms` 冷却，所以看着看着不会突然被弹走。`neighborExp()` 的顺序按**左栏列表**（`store.items`，当前这条被筛掉不在列表里才退回平行组），到头就停、不绕回。
  ② **顶上 `‹` `›` 两颗翻页箭头**（`.pg-arrow`，贴在页签两边；`prevPageNum` / `nextPageNum` 读 `pageTabs`，到头的方向 `disabled` 置灰）。跟 ←/→ 同一个口径、同一套「到头就停」，翻完滚回顶部。
  ③ **键盘 ←→ 翻页 / ↑↓ 切平行实验照旧保留**（用户明确说「键盘快捷还是留着」）。滚轮切换走 `router.push`，所以 `pageKeep` 照样生效（第 2 页滚走还停在第 2 页）。
  验证（WKWebView + 真接口）：`/e/206` 点 `›` → 到「第 2 页 · 续页」、`‹` 变可用；`.editor` 滚到底再发 3 个 `wheel`（80/90/100）→ 切到 SJ-2-7 并弹「已切换到 SJ-2-7」；把 `scrollSwitch` 写成 `false` 再滚 → 不动（只到底部滚动）。测完写回 `true`。服务端白名单加了 `scrollSwitch`（**改完重启服务**）。
- **换记录的平缓动画（用户：「鼠标滚动切换的话，需要有个平缓动画，在侧边栏和纸页面」）**。两处一起动：
  ① **纸面**：`animatePaper(dir)` 给 `.editor-inner` 挂 300ms 的 keyframes —— `.paper-in-down`（往下滚 / 往下切）从 `translateY(14px)` + `opacity 0` 浮上来，`.paper-in-up` 反过来。用 `classList.remove` → `void offsetWidth`（强制重排）→ `add` 才重放得出来（光靠 Vue 切 class 会被批处理掉）；300ms 后摘掉并 `updateRail()` 重新量平行书签（书签是 Teleport 到 body、按纸面位置钉的，动画期间会偏 14px）。方向由 `navDir` 记：滚轮（`down ? 1 : -1`）和 ↑↓ 都会写它，点左栏卡片就沿用上一次的方向。`prefers-reduced-motion: reduce` 时整个不做（CSS 里也补了 `@media` 兜一层），打印介质里 `animation: none`。
  ② **侧边栏**：`ExpListPane` 里 watch `route.params.id`，`nextTick` 后延迟 60ms 找 `.exp-card[aria-current="true"]`（平行组用 `.exp-stack.is-active`）`scrollIntoView({block:'nearest', behavior:'smooth'})` —— `nearest` 的意思是已经在视野里就不动，只把跑到外面的那条拉回来，不会每次都弹一下。
  验证（WKWebView）：从 `/e/206` 滚到底再发 wheel → 切到 SJ-2-7，探针在切换后 1.6s 内反复读到 `editor-inner paper-in-down`（说明动画真的挂上了），1.4s 后读回来只剩 `editor-inner`（class 有摘掉）；同一次切换左栏也跟着滚到了 `SJ-2-7` 那张卡片。
- **上下切换改走「左栏显示顺序」（用户：「就是类似原本的键盘切换吧，那个动画什么的，侧边栏那边也是，然后可以切换到非平行实验」）**。原来 `↑/↓` 只在 `siblings`（平行组）里打转，组尾就走不动了；滚轮那条用的是 `store.items`（接口顺序，跟屏幕上的分组/卡片堆顺序不是一回事）。
  现在两处统一走 `neighborExp(step)`，池子按 `store.listOrder` → `store.items` → `siblings` 依次退。`store.listOrder` 是新加的（`ExpListPane` 里 `visualOrder` = 分类分组 → 行 → 卡片堆成员 id 平铺，`watch(..., {immediate:true})` 写进 store），所以顺序**就是眼睛看到的那个顺序**：平行实验之间照旧一条一条走，走到组尾自然进下一条普通记录，往上同理。
  `↑/↓` 的说明也从「平行实验上下切换」改成「上 / 下一条记录（含平行实验）」（设置页 04 快捷键那一片）。动画和侧栏滚动不用另做——都在 `route.params.id` 的 watcher 里，任何方式切记录都会播。
  验证（WKWebView + 真接口，直接看 `location.hash`）：`/e/206`（SJ-2-8，平行组最后一个成员）按 ↓ → `183`（SJ-2-7，**组外**的普通记录）✓ 这正是用户要的；从 `/e/183` 连按 ↑ → `206` → `182`（SJ-2-6）→ `129`（SJ-2-2），组内外一路往回走 ✓；到列表尽头再按就停住（不绕回）。
- **「推」的动画 + 滚轮门槛调小（用户：「就是那种推的感觉，鼠标滚轮要滚的太多了」）**。
  ① 动画从「新页淡入」改成两段接起来的「推」：切记录一开始先 `paperOut(dir)` —— 旧纸顺着方向滑走（`paper-out-down/up`，130ms，`translateY(∓26px)` + 淡到 0.12，`forwards` 停在推走的位置），数据到齐后 `paperIn(dir)` 从反方向接手推进来（`paper-in-down/up`，260ms，`translateY(±26px)` + 0.12 → 1）。因为 out 是在 `flush()` + `load()` **之前**就开始的，等待时间正好被这段推走盖住；万一网络慢，加了个 420ms 的兜底把旧纸放回来（不然纸一直半透明）。往下滚 = 内容往上被推走、新页从下面上来。`prefers-reduced-motion` / 打印时都不播。
  ② 滚轮门槛 140px → **44px**（`WHEEL_TRIGGER`），冷却 700ms → **460ms**（`WHEEL_IDLE` 380 → 320）：一次鼠标滚轮一格就够触发，不用一直滚到底再攒一大截。
  验证（WKWebView）：两个 `deltaY: 30` 的 wheel（共 60px）就切到了下一条，探针读到 class 序列 `paper-out-down → paper-in-down` ✓；连发 8 个 `deltaY: 60`（共 480px）也只切了一次（冷却挡住了后面的）✓。
- **这些手感也放进设置页（用户：「然后刚刚这些也可以加进模块那边」）**。04 界面那张「切换记录」卡现在是完整的：
  `☑ 切记录时停在同一页`（`pageKeep`）/ `☑ 滚到头再滚就切上 / 下一条`（`scrollSwitch`）/ `☑ 换记录时播「推」的动画`（`pageAnim`）/ **滚轮切一条要滚多少**：轻一点 44px · 正好 90px · 要滚多一点 160px（`scrollWheel`，默认「轻一点」）。底下那句说明也一并改了（原来写死「700ms 内只切一次」）。
  `scrollWheel` 在 `EditorView` 里就是 `WHEEL_PX = {light:44, normal:90, heavy:160}`，门槛每次现读；`pageAnim` 直接进 `paperRoot()`（关掉就不挂 keyframes，跟 `prefers-reduced-motion` 一个效果）。两个 key 都进了服务端白名单（**改完重启服务**）和设置搜索（搜「滚轮 / 动画 / 推 / 力度」都能命中）。
  顺手补了个 `.set-row` 的小样式（左边一句说明 + 右边几颗 `qchip`），跟「记录页」那块的分段选项同一套观感。
  验证（WKWebView + 真接口）：把 `scrollWheel` 设 `heavy`、`pageAnim` 设 false → 两个 `deltaY:30`（60px）**不切**且抓不到动画 class；改成 3×60（180px）→ 切到 SJ-2-7 且仍无动画；写回 `light` + 动画开 → 60px 就切、class 序列 `paper-out-down → paper-in-down`。测完四个 key 都还原成默认（true / true / true / light）。
- **纸左右两条空白 = 翻页热区（用户：「这边可以加一些热点区域，点击可以切换页面，只用鼠标就能操作，然后也可以取消，进到模块那边」）**。
  纸上两侧那两条 canvas 色的空地现在各是一条透明热区（`.edge-flip.is-l / .is-r`），点一下就上一页 / 下一页，跟 ←/→、页签旁的 `‹ ›` 同一个 `flipPage()`（到头置灰、不绕回）。
  做法：**不做 DOM 盒子去盖纸**，而是 `updateEdgeBox()` 量 `.editor` 和当前可见 `.sheet` 的 rect，算出左右缝隙宽度直接写成 `position: fixed` 的 `left/top/height/width`（写进 `edgeBox`）。缝隙 < 16px 就不放热区（窗口窄时纸几乎贴边，点了容易点歪）。位置在 `updateRail()`（滚动 / 缩放）、`scheduleFit()`（图片和字体加载完后那几拍）、换页和 `onUiMerged` 之后都会重算 —— **第一版只在挂载时算一次，量到的是纸还没长开的尺寸，右边热区只有 34px、左边干脆没出来**，加进 `scheduleFit()` 才稳。
  视觉：平时完全透明，悬停才浮出一颗很淡的 `‹`/`›`（`--ink-4`）+ 2% 底色；到头那一侧 `is-off` 连悬停反馈都没有。`z-index: 3` 放在平行书签（45）**下面**，所以纸左边那条缝里点书签还是点书签。打印时 `display:none`。
  开关：设置页 04 那张卡加了「☑ 点纸左右两侧的空白翻页」（`edgeFlip`，默认开），服务端白名单加了它（**改完重启**）。
  验证（WKWebView + 真接口，1440 宽）：热区实测左 `w=24 x=548..572`、右 `w=34 x=1406..1440`（纸 578..1400、编辑区 548..1440）；点右边热区 → 跳到「第 2 页 · 续页」；把 `edgeFlip` 写 false → 两个热区都消失（`none`）。测完写回 true。
  **补：热区再柔和一点 + 长相可调（用户：「这个热点区域还能柔和一点吗，然后热点区域的调整可以写入设置吗」）**。原来悬停是整条缝盖一层 2% 底色 + 一颗大字号的 `‹`，视觉上像糊了一块。现在箭头收成一颗 **30px 的圆按钮**（纸白底 + 1px 阴影、`--ink-3`、15px 字），平时 `opacity: 0` + `scale(.92)`，悬停才 240ms 淡入；整条缝不再有底色。
  出场方式放进设置页 04（`edgeFlipLook`）：**悬停才浮出来**（默认）/ **什么都不画**（纯热点，`look-quiet`）/ **一直淡显**（55% 不透明，`look-always`）。这一行缩进挂在「点纸左右两侧的空白翻页」那个勾下面（`.set-row-indent`），勾掉就不显示。服务端白名单加了 `edgeFlipLook`（**改完重启**）。
  验证（WKWebView + 真接口）：1440 宽下 class 是 `edge-flip is-r noprint look-soft`，强制点亮后箭头的确是一颗居中的小圆按钮（截图）；写 `always` 后不悬停也能看到淡淡的箭头；写回 `soft`。
  **补 2：热区的光标（用户：「切换页的话，光标可以变成箭头什么的吗」）**。原来两条缝都是手型（`cursor: pointer`），现在改成系统那两种**单向箭头**：纸左边 `w-resize`（←）、右边 `e-resize`（→），一眼看出往哪边翻；那一侧没有下一页 / 上一页（`is-off`）时回落到默认箭头，不给错误暗示。没用自造的 SVG cursor —— WKWebView 里能不能渲染出来没法用截图验证（截图抓不到光标），系统箭头是稳的。
  页签（`.ptab`）和顶上两颗 `‹ ›`（`.pg-arrow`）本来就是 `cursor: pointer`，没动。
  验证（WKWebView，读 `getComputedStyle`）：第 1 页 → 左 `default`（没有上一页）、右 `e-resize`；第 2 页 → 左 `w-resize`、右 `default`（这条记录只有两页，没有下一页，判断是对的）。
## 2026-11-14 工程化三件：测试 / 服务端分层 / 样式分片（用户看了完成度评估后说「1 先做，3、4 也可以」）

- **① 纯逻辑测试（`npm run check`，零依赖）**。之前整个项目**一条自动化检查都没有**：`package.json` 里只有 vite 的 dev/build，裁判全靠人眼截图。这次不引入 vitest（要装包、要网络），直接用 Node 自带的 `node --test` + `node:assert`——项目本来就 `"type": "module"`，`src/lib/*` 大多不碰 DOM，能直接 import。新增 `test/`：
  `reagent.test.js`（`num/eqNum/eqLabel/round/saneDensity/densityUsable/amountText/volText/yieldInfo`——质量→产率这条链是记录、导出、打印共用的真理）、`sctfields.test.js`（`variations()` 的「只写变成什么」/一进一出/只改当量/基准没填/规模浮点收敛；`autoValue()` 里**条件组优先于整条记录**这条最近才加的规矩）、`export.test.js`（Markdown 抬头与三块、条件行不重复溶剂；CSV 的 BOM/CRLF/单位在表头）、`normalize.test.js`（写库前的清洗闸）。**37 条全绿**。
  写的时候就被打脸四次（都是我的预期错、代码对）：`volText`/`amountText` 的体积是**去尾零**的（`2 mL` 不是 `2.00 mL`）；`reagentText` 用 ` · ` 连不是 ` + `；`safeName` 先 `basename` 再替换（`a/b\c:d.png` → `b_c_d_.png`）；`normalizeCondVars` **不 trim**（全空白的值会留下）——这四条现在都写进测试注释里当行为说明。
  `npm run check` = `node --test test/*.test.js`（**注意不能写 `node --test test/`**：Node 24 会把目录当模块入口，报 `Cannot find module .../test`）。

- **③ 服务端先分出「纯清洗层」**：`server/lib/normalize.js`（`str` / `numOrNull` / `safeName` / `normalizeCondVars` / `parseConds` / `normalizeConds` / `normalizeFieldVars` / `parseFieldVars`）。这些东西原来散在 5000 多行的 `index.js` 里，**不碰 db、不碰 req/res**，所以能搬能测。`index.js` 改成一行 `require('./lib/normalize')` 解构（5653 → 5586 行）。
  **为什么没把 83 条路由全拆开**：handlers 都是闭包，引用着 `index.js` 里几十个模块级 helper 和可变状态（缓存、定时器、`PORT` 之类），拆成 `routes/*.js` 要先把这些显式传进去，**改错一处就是整个服务起不来**——而这是用户每天要用的东西。所以这轮只做「机械、可验证」的那部分，路由拆分留到以后按组慢慢搬（`server/lib/*` 这套模式照抄就行）。
  验证方式：`ELN_DATA_DIR=/tmp/eln-smoke PORT=4799` 起一份**数据副本**（`VACUUM INTO` 出来的自包含单文件 + `attachments/`），把 28 个 GET 端点全打一遍（全 200，`/api/compound-files/:id` 404 是那条化合物本来没有文件），再走一遍**写**路径（`PUT /api/experiments/206` 带 `conds`：`71.54 → 71.5`、`mass` 落库、空候选被滤掉，符合预期）。确认没问题才重启 4780。

- **④ `eln.css` 拆成 10 个分片**：`src/styles/eln/<分片>.css`（01-base / 02-sheet / 03-sheet-2p / 04-print / 05-compounds / 06-v2 / 07-mobile / 08-parallel / 09-screening / 10-tail），`eln.css` 只剩 `@import` 清单。**先切、后验**：切的时候按**连续行号**切，然后把分片 `cat` 起来跟原文逐字节比对（`roundtrip: True`，278→326 KB 那份），因为 `@import` 是按清单顺序内联的，顺序即层叠顺序。
  **第一次切错了**：切点落在区块横幅那一行上，把 `/* ===…` 的注释劈成两半 → `postcss-import: Unclosed comment` 直接构建失败。改成「切在横幅行之前」才对（`grep -n "^/\* =\{20,\}"` 的行号要 **−1**）。
  验证：`npm run build` 出来的 `public/assets/index-C9wXD2bS.css` **跟改之前同名同大小（559,413 B）**——Vite 的内容哈希没变，等于证明这条重构是字节级 no-op；`git diff --stat -- public/` 空。再取一份页面计算样式指纹（body / .sheet / .ptab / .exp-card / .rail / .hint / .btn 的 font/color/border/box-shadow 等 16 项）前后 `diff` → 完全一致。
  顺带发现的（不是这次引入的）：构建出来的 CSS 559 KB 里**有一半是 Element Plus 的整套主题**（`el-theme.css` + EP 样式），这是打包体积的大头，要瘦身得从「按需引入 EP 组件样式」入手。
## 2026-11-14 瘦身（A → E 的 E）：Element Plus 按需 + 路由懒加载

- **① Element Plus 只引用到的样式**。整个项目其实只用 `ElDialog`（`AppModal.vue`）、`ElMessageBox` / `ElNotification`（`lib/feedback.js`）三个组件，但 `main.js` 一直引 `element-plus/dist/index.css`——那是**整套主题**（表格 / 日期选择器 / 级联 / 走马灯…），构建产物里的 CSS 有一半是它。现在换成四个 `element-plus/es/components/<组件>/style/css`（base + dialog + message-box + notification，每个会自己带上 overlay / button / input 这些子依赖）。
  同时**去掉 `app.use(ElementPlus)`**：三个组件都是在用到处 `import` 的（`<script setup>` 里 import 过就能在模板里写 `<el-dialog>`），全局注册只是把整个组件库拖进 JS 产物。zh-cn locale 也不用装——按钮文案一直是显式传的（`feedback.js` 里每个 confirmText / cancelText）。
- **② 路由全部懒加载**（`router.js` 里 `() => import('./views/X.vue')`）：以前首屏要把编辑器 / 画板 / 筛选表 / 设置页全下完。
- **效果**：入口 CSS 559.41 KB（gzip 83.19）→ **251.14 KB（gzip 43.07）**；入口 JS 1,550.51 KB（gzip 515.32）→ **261.23 KB（gzip 96.00）**，`openchemlib`（1.1 MB）自己一个 chunk、真用到化学计算时才拉。
- **验证**（这是关键）：EP 换掉之后最怕悄悄少了什么样式。做法是拿改之前的构建产物截图、改之后同样尺寸再截，**比 sha256**：`/reagents`、`/e/206`、`/list` 三页**像素完全一致**（时间戳都碰巧一样，说明差一点就能看出来）。另外把两个 CSS 的选择器集合做差集，确认「老有新没有」的全是 EP 内部的东西（carousel / time-select / col / skeleton 的 keyframes），我们自己的规则一条没丢；`box-sizing` 的出现次数从 132 掉到 18，但那 132 条全是 EP 的，我们自己的 `* { box-sizing: border-box }` 在 `01-base.css` 里。
  交互面也逐个试了：`el-dialog`（二维码弹窗，遮罩 + 按钮都对）、`ElMessageBox.prompt`（新建分类，输入框和「取消 / 建」都在）、`ElNotification`（切记录那句 toast，`.eln-toast` 自定义类照旧生效）。路由逐条过了一遍：`/` `/list` `/compounds` `/c/80` `/screenings` `/s/22` `/boards` `/b/2` `/trash` `/reagents` `/settings` `/e/206` 全部正常挂载。
## 2026-11-14 B：把「坐标」「箭头排版」「打印恒 2 页」这三条真理补上测试

- **① 排版板的坐标换算 / 吸附（`src/lib/board.js`）**。`unitsPerPx`（1px = 多少画布单位）和 `snapX`（贴左 / 水平居中 / 贴右，4.5mm）原来是 `BoardView.vue` 里的闭包，测不到；现在抽成纯函数（`unitsPerPx(zoom)` / `pxPerUnit(zoom)` / `SNAP` / `snapX(x, w, pageW)`），BoardView 只把 `zoom` 接进去。「别写成 `1/(MM_PER_PX*0.1*zoom)`」这条注释里的警告，现在有测试钉着：那条错式子是 **14.28 倍**（`test/board.test.js` 直接断言这个数）。另外 `fit()` 里算纸张 px 的那两行改用 `pxPerUnit(1)`，少一处手写换算。
  **验证**：抽完 `npm run build`，`/b/2` 截图跟抽之前 **sha256 完全相同**（像素级 no-op）。
- **② 反应式箭头那行字的排版预算（`src/lib/scheme.js`）**。`CAP_SIZE` / `ARROW_MIN` / `AUTO_SINGLE_MAX` / `ARROW_PAD` 提成导出常量，`capTextWidth()`（西文 0.47×字号、中文全角 1.0×）/ `arrowLenFor()` / `shouldWrapCaps()` 成为可测的纯函数，`composeChainSvg` 内部改成调它们（数值一字不改）。
  测试钉的是不变量：**字永远落在箭头里面**（`arrowLen - 字宽 >= 50`，即两头各 25px）、`auto` 超过 430px 才折两行、`splitScript()` 的上下标规则（`Pd(PPh3)4` 的 3/4 是下标，`0.05 eq` / `12 h` / `-78 °C` / `4:1` / `CuSO4·5H2O` 里的 5 都不是，`Na+` 的上标，`_{3}`/`^{2}` 强制）——这条判错了箭头上的条件会变成一堆假化学式，而且不报错。
- **③ 「打印恒 2 页」（`npm run check:pages`）**。这件事只能在真浏览器里量（`.pdf-page` 是 `overflow:hidden`，超了不报错、直接裁掉）。做法：
  - 新增 `server/jsrun.swift`——和 `print.swift` / `shot.swift` / `ocr.swift` 并列的本机小工具：「用 WKWebView 打开一个 URL、跑一段 JS、把返回值打到 stdout」，首次用到才编到 `.cache/jsrun`（**不进 git**）。**踩了个坑**：`js` / `url` 必须是**文件作用域的 `let`**；用 `guard let js = …` 会编译报 `class declaration cannot close over value`，退而用全局 `var` 能编过但 `evaluateJavaScript` 一直返回 `nil`（排查了半天）——注释里写清楚了。
  - `scripts/check-pages.mjs`：挑一条记录（默认库里最新，或 `--id 206`），用 `#/e/<id>` 和 `#/e/<id>?p=2` 各量一次**当前那张纸的实际高度**，外加页签数 / 结果表数 / 投料表行数；跟 `test/print-baseline.json` 比：纸页长高超过 8px、或结果表 / 页签变少就 **exit 1**。顺带把「computed 抛错 → 整块静默消失」也纳入（`.res-table` 少一张就报）。
  - 第一次基线：`node scripts/check-pages.mjs --id 206 --update` → 第 1 页 1078px、第 2 页 327px。
  - **验证**：把基线改成假的（第 1 页 900px、结果表 2 张）再跑，能正确报两条并 exit 1，然后还原。
## 2026-11-14 排版板：内容宽度可拖 + 画布上能画箭头 / 方框（带颜色）

- **① 内容区宽度拖拽条**：`BoardView` 里加了 `<DocGrip />`（跟工作台 / 筛选表 / 回收站同一个组件、同一份 `uiprefs.docw`）。板子这边尤其需要——它左边有个素材抽屉，内容宽度定得太窄抽屉就挤。
  验证：把 `docw` 设成 1400 打开，版面跟着变宽、纸张靠 `fit()` 重新算 zoom 仍然一屏装得下。
- **② 画布上能画形状**：素材抽屉底部多了「＋ 箭头」「＋ 方框」。数据上是新的 `type: 'shape'`（`{shape, x, y, w, h, color, thick, dir}`），走的还是那套 0.1mm 坐标 + `itemHtml()` 渲染（**屏幕和 PDF 共用一份**，`boardHtml` 里给形状补上了 `height`）。
  - 颜色六档（墨 / 强调 / 灰 / 绿 / 蓝 / 红，`SHAPE_COLORS`），选中时工具条上是一排色块（`.board-swatch`），当前那档套一圈强调色环；
  - 粗细两档（`thick`）：「粗一点」→ 线条 0.55mm → 1.1mm；
  - 箭头有方向（`dir: left/right`，工具条上「← 向左 / → 向右」一键换），箭头头部用 CSS 三角，**线宽用 mm**，所以屏幕缩小看跟导出 PDF 一样粗细；
  - 方框圆角 1.4mm、只描边不填色（打印出来不会糊成一块）；
  - 右下角那个抓手对形状是「宽 + 高」一起改（`drag.oh/nh`），拖拽其余逻辑（吸附 / 参考线 / 防抖 700ms 自动存）没动。
- **踩了两个坑**：
  1. 形状一开始渲染成 3px 高的细条：`itemHtml` 外面还套着一层 `.bd-body`，`height:100%` 的百分比落到 auto 上就没高度了 → 给 `.bd-body` 加 `height:100%`（其余块高度本来就是 auto，不受影响）。
  2. `BOARD_CSS` 整个是 **JS 模板字符串**，我在注释里写了反引号把字符串截断了 → 构建报 rollup 解析错误。**这段 CSS 里不能出现反引号**（注释也不行），已经写进注释里提醒。
- 验证：临时板（新建 → 加一根箭头 → 加一个方框 → 再加一根箭头，切成蓝色 / 加粗 / 反向）截图确认三种形态都对，`items_json` 里也落了 `color/thick/dir`；测完把临时板删掉（库里只剩用户自己那块 #16），`docw` 也写回原来的 1240。
## 2026-11-14 C：JSDoc + `tsc --checkJs`（只当检查器，不写 TypeScript）

- **装什么**：`typescript@5.9.3`（devDependency）。**别用 latest（7.x，Go 版 tsgo）**：同一个 `tsconfig` 在 7.0.2 上报的错误和 5.9 不一致，先用稳定版。
- **配置**：`tsconfig.json` → `allowJs + checkJs + noEmit`，`include: ["src/lib/**/*.js", "src/shims-vue.d.ts"]`，`strict: false`、`noImplicitAny: false`（目标是先抓 `null.x` / 传错参数，不是逼人写类型）。
  `src/shims-vue.d.ts` 只是给 `.vue` 模块一个 `DefineComponent` 的声明，否则 `router.js` 里那 13 个 `import X from './views/X.vue'` 全是「找不到模块」。
- **一开始 126 条错，最后 0 条**。绝大多数是同一个病根：**「解构默认值的参数」被推成窄类型**——
  `function f({ a = 1, b } = {})` 里 tsc 会把参数推成 `{a?: number}`（丢掉没默认值的 `b`），于是每处传 `{b}` 都报「不允许的属性」。
  项目里 `request` / `confirm` / `prompt` / `confirmLines` / `createPointerSort` / `pubchemUrl` / `nistUrl` / `casCommonUrl` / `tciUrl` / `useAutosave` / `composeChainSvg` 全是这个写法，加起来 100+ 条。
  改法统一成「参数收 `opts`，再在函数体里解构」，并补 `@param {…}`（这样调用处也能得到提示）——**运行行为一字不变**。
- 剩下几十条是零碎的真问题/类型收窄：`CSSRule` 上读 `media`（收窄成 `CSSMediaRule`）、`cloneNode` 返回 `Node`、`Element.dataset`（收窄成 `HTMLElement`）、`segBoxDist` 的元组参数、`boardHtml` 的 `expOf` 被推成零参函数、`scheme.js` 里 JSDoc 写成 `@param {object[]} o.stages`（必须先声明 `o`）、`chemdraw.js` 里「先建数组后补属性」（`groups[].box/paths`）。
- **接进 CI**：`.github/workflows/check.yml` 里 `npm ci → npm run check → npm run check:types`。
- 验证：`npm run check:types` **0 error**；`npm run check` 58 条仍全绿；`npm run build` 通过；`/list` 上点「新建分类」→ ElMessageBox.prompt 正常弹出（`feedback.js` 三个函数都改了签名，这是最容易写坏的地方）。
