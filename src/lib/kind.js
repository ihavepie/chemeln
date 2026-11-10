/**
 * 记录类型：**并行存在**，不是阶段——做完小试以后照样要补做原料。
 * 它只决定「记录页默认展开哪些块、默认单位」和「卡片上怎么标」，不影响数据本身。
 * 空字符串 = 通用版式（老记录全是这个，保持原样）。
 */
export const KINDS = [
  { key: '原料', tone: 'material', tip: '制备起始原料 / 中间体，产物进化合物库' },
  { key: '试反应', tone: 'trial', tip: '试一条新反应能不能成' },
  { key: '条件筛选', tone: 'screen', tip: '一轮筛条件里的单个数据点' },
  { key: '底物扩展', tone: 'scope', tip: '扩底物里的单条实验' },
];

export const KIND_TONE = Object.fromEntries(KINDS.map((k) => [k.key, k.tone]));

/** 每种类型的默认块（用户仍可手动开关；这里只是切类型时给一套合理默认） */
export const KIND_BLOCKS = {
  原料: ['env', 'literature', 'reagents', 'result', 'tlc', 'procedure', 'workup', 'characterization', 'attachments'],
  试反应: ['env', 'scheme', 'reagents', 'result', 'tlc', 'procedure', 'attachments'],
  条件筛选: ['env', 'scheme', 'reagents', 'result', 'tlc'],
  底物扩展: ['env', 'scheme', 'reagents', 'result', 'tlc', 'procedure'],
};

export const kindLabel = (k) => (k ? String(k) : '');

/**
 * 反应类型（记录页抬头大标题右边那个小格）：**跟记录类型是两回事**——
 * 记录类型是「这条在整条路线里是干什么的」，反应类型是「这条实验本身在研究什么」。
 * 只给几个常用的当候选，照样可以自己敲别的（空着就不显示）。
 */
export const RXN_TYPES = ['改当量', '放大实验', '转化', 'C–H 活化', '底物扩展'];
