/**
 * 教程（漫游式引导）的文案 + 「看没看过」的标记。
 *
 * 每一页一套，按路由 name 取。`target` 是 CSS 选择器：**找不到这一块就跳过那一步**
 * （折叠起来的栏目、还没渲染完的画布都会这样），所以文案不用关心页面当前状态。
 *
 * 标记存在 uiprefs 的 `tour` 一个键里（`{ home: 1, board: 1 }`）：服务器白名单里就一个
 * `tour`，比每页一个 key 省事，也不会把 `ui_prefs` 撑大。
 */
import { uiGet, uiSet, uiSetIfChanged } from './uiprefs.js';

const KEY = 'tour';

/** 左侧导航：几乎每页都讲一遍太啰嗦，只在工作台讲 */
const NAV = {
  target: '.rail',
  title: '左侧导航',
  text: '工作台看总览；实验记录写条目；化合物库 / 试剂库 / 条件筛选按需查；排版板把条目摆到 A4 上导出 PDF。',
  place: 'right',
};

export const TOURS = {
  /* ---------------- 工作台 ---------------- */
  home: [
    NAV,
    {
      target: '.page-head',
      title: '当前课题',
      text: '标题就是正在用的课题，下面一行是这条本子里的实验数、附件数。数据全部存在这台机器上。',
      place: 'bottom',
    },
    {
      target: '.stat-grid',
      title: '四个数字',
      text: '实验总数 / 本月新增 / 中位产率 / 筛选表。产率用中位数：一条填错的产率不会把这格拉歪。',
      place: 'bottom',
    },
    {
      target: '.dash-search',
      title: '全局搜索',
      text: '编号、名称、试剂、条件，或者化合物编号 / 名称 / 分子式都能搜；回车直接进实验记录列表。',
      place: 'bottom',
    },
  ],

  /* ---------------- 实验记录（列表） ---------------- */
  list: [
    NAV,
    {
      target: '.listpane',
      title: '左栏：条目列表',
      text: '按日期倒序。上面的输入框边打边筛，右上角「新建实验」建一条。',
      place: 'right',
    },
    {
      target: '.workspace',
      title: '右边：空着',
      text: '从左边点一条实验就在这里打开；没有选中时就是这块空面板。',
      place: 'left',
    },
  ],

  /* ---------------- 单条实验 ---------------- */
  editor: [
    {
      target: '.listpane',
      title: '同一条本子里的其它实验',
      text: '左栏随时切换，切换不会丢未保存的内容（自动保存会先跑一次）。',
      place: 'right',
    },
    {
      target: '.editor-bar',
      title: '顶部工具条',
      text: '编号 / 状态 / 打印 / 导出 PDF / 复制成新实验都在这一条。打印前它会自动隐藏。',
      place: 'bottom',
    },
    {
      target: '.sheet',
      title: '正文就是这张 A4',
      text: '段落块直接打字，表格回车加行；反应式、投料、结果、TLC 都是块，可以上下拖动手柄换位置。',
      place: 'left',
    },
  ],

  /* ---------------- 化合物库 ---------------- */
  compounds: [
    NAV,
    {
      target: '.listpane',
      title: '化合物列表',
      text: '左边是全部化合物，按分类分堆。点一条在右边看详情，扫瓶签也能直接跳过来。',
      place: 'right',
    },
    {
      target: '.grid-tools',
      title: '视图与工具',
      text: '卡片墙 / 表格切换、批量打印标签、新建分类都在这。',
      place: 'bottom',
    },
  ],

  /* ---------------- 试剂库 ---------------- */
  reagents: [
    NAV,
    {
      target: '.rl-head',
      title: '试剂库',
      text: '这里自动汇总所有记录里出现过的试剂：最近一次的角色、分子量、密度 / 浓度，以及按 1 mmol 折算的质量与体积。',
      place: 'bottom',
    },
    {
      target: '.rl-tools',
      title: '右上这几颗',
      text: '「全部核对」重新比对分子量；「检索站点」挑要在每行后面显示哪几个外部库（PubChem / ChemBook / NIST / TCI / CAS）。',
      place: 'bottom',
    },
    {
      target: '.rl-legend',
      title: '状态记号',
      text: '✓ 已核对、? 待核对、! 查不到。点一下就能改；平时只看颜色和符号，不占一列文字。',
      place: 'bottom',
    },
    {
      target: '.rl-table',
      title: '一行一个试剂',
      text: '单击一行复制名称。表头竖线可以左右拖，宽度会记住；右键还有「只看这类角色 / 打开外部库」。',
      place: 'top',
    },
  ],

  /* ---------------- 条件筛选 ---------------- */
  screenings: [
    NAV,
    {
      target: '.sct-head',
      title: '筛选表',
      text: '一摞平行实验里，只把「跟基准不一样」的那几条列出来 —— 整摞都是重复 / 平行或都是原料的不占地方。',
      place: 'bottom',
    },
    {
      target: '.cx-group',
      title: '一张表一组',
      text: '每组上面是基准条件，下面是偏离基准的那几条。点组标题进详情页看全表。',
      place: 'top',
    },
  ],

  /* ---------------- 排版板列表 ---------------- */
  boards: [
    NAV,
    {
      target: '.page-head',
      title: '排版板',
      text: '自由画布：把一条记录里的编号 / 反应式 / 条件 / 投料 / 结果 / 结论 / TLC 摆到一张 A4 上，导出 PDF 贴进汇报。',
      place: 'bottom',
    },
    {
      target: '.board-row',
      title: '一行一张板',
      text: '单击打开；右键有重命名 / 复制 / 删除。板子里的内容不会动原始记录。',
      place: 'bottom',
    },
  ],

  /* ---------------- 排版板画布 ---------------- */
  board: [
    {
      target: '.bv2-drawer',
      title: '素材栏',
      text: '点一个块（编号 / 反应式 / 条件 / 投料 / 结果 / 结论 / TLC）就落到纸上；悬停能先看大图。最上面可以收起整栏。',
      place: 'right',
    },
    {
      target: '.bv2-canvas .FixedSideContainer_side_top',
      title: '画布工具条',
      text: '选择 / 手 / 矩形 / 菱形 / 圆 / 箭头 / 线 / 画笔 / 文字 / 图片。数字是快捷键，⌘Z 撤销。',
      place: 'bottom',
    },
    {
      target: '.bv2-fbar',
      title: '右上角',
      text: '存图（PNG）、导出 PDF（铺满一页 A4）、☰（画布背景 / 重置画布 / 帮助）。改了什么都会自动存。',
      place: 'bottom',
    },
    {
      target: '.bv2-canvas',
      title: '画布',
      text: '白纸就是 A4，拖拽 / 框选 / 八点手柄都能用。选中图形后左下角会自动出现样式面板（颜色、线宽、线型、透明度、图层）。',
      place: 'center',
    },
  ],

  /* ---------------- 回收站 ---------------- */
  trash: [
    NAV,
    {
      target: '.trash-head',
      title: '回收站',
      text: '删掉的实验和化合物先放这里，附件文件还在磁盘上。恢复后编号、投料表、附件都还原；只有「彻底删除」才真删文件。',
      place: 'bottom',
    },
    {
      target: '.page-card',
      title: '一条一条处理',
      text: '每行右边是恢复 / 彻底删除，右键菜单里也有。右上角「清空回收站」= 全删，慎点。',
      place: 'bottom',
    },
  ],

  /* ---------------- 设置 ---------------- */
  settings: [
    NAV,
    {
      target: '.set-pane',
      title: '设置分类',
      text: '左边按模块分组：试剂库外部链接、卡片质感、TLC 默认参数、备份…上面还有搜索框，输关键词直接定位。',
      place: 'right',
    },
    {
      target: '.set-panes .editor',
      title: '改完立刻生效',
      text: '这一页没有「保存」按钮：改一下就写进偏好，刷新 / 重启都还在。',
      place: 'left',
    },
  ],
};

/** 路由 name → 教程 key（同一套给多个页面的在这里映射） */
const BY_ROUTE = {
  home: 'home',
  list: 'list',
  editor: 'editor',
  compounds: 'compounds',
  compound: 'compounds',
  reagents: 'reagents',
  screenings: 'screenings',
  screening: 'screenings',
  boards: 'boards',
  board: 'board',
  trash: 'trash',
  settings: 'settings',
};

export function tourKeyOf(routeName) {
  return BY_ROUTE[String(routeName || '')] || '';
}

/** uiprefs 里那份（会跟服务器合并、同步到别的设备） */
function allSeen() {
  const v = uiGet(KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * 另外再记一份**只在本机 localStorage** 的（`eln:tourSeen`）。
 * 为什么要两份：uiprefs 那份要跟服务器按时间戳合并，如果服务器上是个更早的副本，
 * 合并之后本机的标记会被盖回去 —— 表现出来就是「每次打开都又放一遍教程」。
 * 本地这份不参与合并，读到就算看过。
 */
const LOCAL = 'eln:tourSeen';
function localSeen() {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function tourSeen(key) {
  if (!key) return false;
  return !!localSeen()[key] || !!allSeen()[key];
}

export function markTourSeen(key) {
  if (!key) return;
  const ls = localSeen();
  if (!ls[key]) {
    ls[key] = 1;
    try {
      localStorage.setItem(LOCAL, JSON.stringify(ls));
    } catch {
      /* 隐私模式写不进去就算了，还有 uiprefs 那份 */
    }
  }
  const seen = allSeen();
  if (seen[key]) return;
  seen[key] = 1;
  uiSetIfChanged(KEY, seen);
}

/** 设置里「重新看一遍」：两份标记都清掉，下次进页面又会自动放一遍 */
export function resetTours() {
  try {
    localStorage.removeItem(LOCAL);
  } catch {
    /* 同上 */
  }
  uiSet(KEY, {});
}

/** 只留 target 真的在页面上的步骤（栏收起了、画布没渲染好都会缺） */
export function liveSteps(steps) {
  return (steps || []).filter((s) => {
    if (!s.target) return true;
    try {
      return !!document.querySelector(s.target);
    } catch {
      return false;
    }
  });
}
