import { round } from './reagent.js';

/**
 * 筛选表的「字段」：一列要么**自动**（从记录里取某个值，改了记录这边就跟着变），
 * 要么**手动**（单元格自己填）。
 *
 * 以前温度 / 投料 / 产率这些是写死在模板里的，现在统一成一个 fields 数组，
 * 所以哪一列都能删、能改名、也能自己加一列自动的（比如只想要产物和 ee，或者想要日期）。
 */
export const SOURCES = [
  { key: 'temperature', label: '温度' },
  { key: 'solvent', label: '溶剂' },
  { key: 'duration', label: '时间' },
  { key: 'atmosphere', label: '气氛' },
  { key: 'addition', label: '加料' },
  { key: 'reagent', label: '投料（试剂 + 当量）' },
  { key: 'yield', label: '产率' },
  { key: 'sel', label: '选择性（dr / ee）' },
  { key: 'product', label: '产物' },
  { key: 'substrates', label: '底物' },
  { key: 'appearance', label: '性状' },
  { key: 'tlc_note', label: 'TLC 备注' },
  { key: 'conclusion', label: '结论' },
  { key: 'notes', label: '备注（记录里的）' },
  { key: 'date', label: '日期' },
];

/** 新建表默认带哪几列（都是自动的，不用手填） */
export const DEFAULT_FIELDS = [
  { key: 'f-temp', label: '温度', source: 'temperature' },
  { key: 'f-solvent', label: '溶剂', source: 'solvent' },
  { key: 'f-reagent', label: '投料', source: 'reagent' },
  { key: 'f-yield', label: '产率', source: 'yield', num: true },
  { key: 'f-sel', label: '选择性', source: 'sel', num: true },
];

const isEmpty = (v) => v === null || v === undefined || v === '';

/** 投料那一格：把试剂名和当量拼一行 */
export const reagentText = (exp) =>
  (exp?.reagents || [])
    .filter((r) => r.name)
    .map((r) => `${r.name}${isEmpty(r.eq) || r.eq === '' ? '' : ` ${r.eq} eq`}`)
    .join(' · ');

/** 自动列在某一行的值 */
export function autoValue(source, exp) {
  if (!exp) return '';
  switch (source) {
    case 'reagent':
      return reagentText(exp);
    case 'yield':
      return exp.no_yield ? '不计' : isEmpty(exp.yield_pct) ? '' : `${round(exp.yield_pct, 1)}%`;
    case 'sel':
      return String(exp.dr_ee || '').trim() || (isEmpty(exp.ee_pct) ? '' : `${exp.ee_pct}% ee`);
    case 'product':
      return exp.product_name || '';
    case 'substrates':
      return exp.substrates || '';
    default:
      return isEmpty(exp[source]) ? '' : String(exp[source]);
  }
}
