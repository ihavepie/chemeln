import { round } from './reagent.js';

/**
 * 一摞平行实验 → 一张对照表（`ScreeningsView` 用）。
 *
 * 行是条件项（温度 / 溶剂 / 时间 / 气氛 / 加料，再是投料表里出现过的每个试剂，最后是结果），
 * 列是一条记录，第一列永远是基准。**整列都没填的条件项不占行**——不然一个都没填表就全是 —。
 * 每行自带 `diff`：跟基准不同的那些格子要标出来，筛条件时一眼看出是哪一格动了。
 */
const COND_ROWS = [
  ['temperature', '温度'],
  ['solvent', '溶剂'],
  ['duration', '时间'],
  ['atmosphere', '气氛'],
  ['addition', '加料'],
];

const cellText = (v) => String(v ?? '').trim();

export function compareMembers(members) {
  const rows = [];

  for (const [key, label] of COND_ROWS) {
    const cells = members.map((m) => cellText(m[key]));
    if (cells.every((v) => !v)) continue;
    rows.push({ key, label, section: 'cond', cells });
  }

  // 投料：把各成员出现过的「角色:名字」并起来，按第一次出现的顺序排
  const order = [];
  const maps = members.map((m) => {
    const map = new Map();
    for (const r of m.reagents || []) {
      const k = `${r.role}:${r.name}`;
      if (!order.includes(k)) order.push(k);
      const eq = r.eq === null || r.eq === undefined || r.eq === '' ? '' : `${r.eq} eq`;
      map.set(k, eq || (r.mmol ? `${r.mmol} mmol` : ''));
    }
    return map;
  });
  for (const k of order) {
    const [role, name] = k.split(':');
    rows.push({ key: `r:${k}`, label: name, role, section: 'reagent', cells: maps.map((m) => m.get(k) ?? '') });
  }

  rows.push({
    key: 'yield',
    label: '产率',
    section: 'result',
    cells: members.map((m) =>
      m.no_yield ? '不计' : m.yield_pct === null || m.yield_pct === undefined ? '' : `${round(m.yield_pct, 1)}%`
    ),
  });
  rows.push({
    key: 'sel',
    label: '选择性',
    section: 'result',
    cells: members.map((m) => cellText(m.dr_ee) || (m.ee_pct === null || m.ee_pct === undefined ? '' : `${m.ee_pct}% ee`)),
  });
  const products = members.map((m) => cellText(m.product_name));
  if (products.some(Boolean)) rows.push({ key: 'product', label: '产物', section: 'result', cells: products });

  for (const r of rows) r.diff = r.cells.some((c, i) => i > 0 && c !== r.cells[0]);
  return rows;
}

/** 每一列「相对基准改了什么」：只数条件和投料那些行（产率不同是结果，不算改条件） */
export function memberDiffs(members, rows = compareMembers(members)) {
  const pick = rows.filter((r) => r.section === 'cond' || r.section === 'reagent');
  return members.map((m, i) => {
    if (i === 0) return { base: true, labels: [] };
    const labels = pick.filter((r) => r.cells[i] !== r.cells[0]).map((r) => r.label);
    return { base: false, labels };
  });
}
