/** 一些 v1 里散落的小工具，集中到这里。 */

export const STATUSES = ['进行中', '已完成', '部分完成', '失败', '重复'];

/** 小签 / 书签这种窄地方用的状态简称 */
export const STATUS_SHORT = {
  进行中: '进行',
  已完成: '完成',
  部分完成: '部分',
  失败: '失败',
  重复: '重复',
};

export const STATUS_TONE = {
  进行中: 'warn',
  已完成: 'ok',
  部分完成: 'info',
  失败: 'bad',
  重复: 'accent',
};

export const CATEGORY_ORDER = ['scheme', 'tlc', 'h1', 'c13', 'nmr_other', 'nmr_raw', 'nmr_pdf', 'hrms', 'ir', 'photo', 'other'];

export const CATEGORY_LABEL = {
  scheme: '反应式',
  tlc: 'TLC 板',
  h1: '¹H NMR',
  c13: '¹³C NMR',
  nmr_other: '其他核磁 · 19F / 31P / 2D',
  nmr_raw: '原始数据 · FID / mnova',
  nmr_pdf: '谱图 PDF',
  hrms: 'HRMS',
  ir: 'IR',
  photo: '实验照片',
  other: '其他附件',
};

/** 化合物附件分类 */
export const CMP_CAT_ORDER = ['structure', 'tlc', 'h1', 'c13', 'nmr_other', 'nmr_raw', 'nmr_pdf', 'hrms', 'ir', 'photo', 'other'];

export const CMP_CAT_LABEL = {
  structure: '结构式',
  tlc: 'TLC 板',
  h1: '¹H NMR',
  c13: '¹³C NMR',
  nmr_other: '其他核磁 · 19F / 31P / 2D',
  nmr_raw: '原始数据 · FID / mnova',
  nmr_pdf: '谱图 PDF',
  hrms: 'HRMS',
  ir: 'IR',
  photo: '照片',
  other: '其他',
};

/** 化合物的「类型」：按一条合成路线的顺序排（原料 → 中间体 → 粗品 → 成品），后面几个是工具型角色。
    注意「中间体」就是用户说的「中间产物」，别再加一个同义的选项。 */
export const COMPOUND_KINDS = [
  '底物',
  '试剂',
  '中间体',
  '粗产物',
  '纯化产物',
  '产物',
  '催化剂',
  '配体',
  '添加剂',
  '标准品',
  '其他',
];

export const isImageName = (name) => /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(String(name || ''));

export const fmtSize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const todayISO = () => {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 「已保存 12:34」—— v1 在保存状态里带时间 */
export const savedLabel = () =>
  `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;

/** 按文件名猜附件分类（和 v1 同一套规则） */
export function guessCategory(name) {
  const n = String(name || '');
  const has = (re) => re.test(n);
  if (has(/\.mnova$/i)) return 'nmr_raw';
  if (has(/(^|[/_\s.-])(fid|acqus|pdata|ser)([/_\s.-]|$)/i)) return 'nmr_raw';
  if (has(/(^|[/_\s.-])(13c|13cnmr)([/_\s.-]|$)/i)) return 'c13';
  if (has(/(^|[/_\s.-])(1h|1hnmr|proton)([/_\s.-]|$)/i)) return 'h1';
  if (has(/(^|[/_\s.-])(19f|31p|cosy|hsqc|hmbc|noesy|2d)([/_\s.-]|$)/i)) return 'nmr_other';
  if (has(/\.(dx|jdx|jcamp|jdf)$/i)) return 'nmr_other';
  if (has(/tlc/i)) return 'tlc';
  if (has(/scheme|reaction|rxn/i)) return 'scheme';
  if (has(/\.pdf$/i)) return 'nmr_pdf';
  if (has(/hrms|\bms\b/i)) return 'hrms';
  if (has(/\bir\b|\.spa$/i)) return 'ir';
  if (has(/\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i)) return 'photo';
  return 'other';
}

export function guessCmpCategory(name) {
  const g = guessCategory(name);
  return g === 'scheme' ? 'structure' : g;
}

/** 条件栏的快速选择值（和 v1 一致） */
export const QUICK = {
  'f-solvent': ['THF', 'Et₂O', 'DCM', 'DMF', 'DMSO', 'MeCN', '甲苯', '1,4-dioxane', 'MeOH', 'H₂O', 'AcOH', '丙酮'],
  'f-concentration': ['0.05 M', '0.1 M', '0.2 M', '0.3 M', '0.5 M', '0.8 M', '1.0 M', '2.0 M'],
  'f-temperature': ['−78 ℃', '−40 ℃', '−20 ℃', '−10 ℃', '0 ℃', 'rt', '25 ℃', '40 ℃', '60 ℃', '80 ℃', '100 ℃', '120 ℃', '回流'],
  'f-duration': ['1 h', '2 h', '4 h', '6 h', '8 h', '12 h', '16 h', '24 h', '过夜', '30 min'],
  'f-atmosphere': ['N₂', 'Ar', '空气', '手套箱', 'N₂ 封管', 'N₂ 双排管', 'Ar Schlenk'],
  'f-apparatus': ['圆底烧瓶', '封管', 'Schlenk 管', '耐压瓶', '微波反应器', '光反应器', '连续流', '手套箱内'],
  'f-light': ['365 nm', '395 nm', '蓝光 450 nm', '绿光 520 nm', '白光', '日光灯', '太阳光'],
};
