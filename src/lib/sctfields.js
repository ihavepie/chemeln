import { round } from './reagent.js';

/**
 * 筛选表的「字段」：一列要么**自动**（从记录里取某个值，改了记录这边就跟着变），
 * 要么**手动**（单元格自己填）。
 *
 * 以前温度 / 投料 / 产率这些是写死在模板里的，现在统一成一个 fields 数组，
 * 所以哪一列都能删、能改名、也能自己加一列自动的（比如只想要产物和 ee，或者想要日期）。
 */
export const SOURCES = [
  { key: 'variation', label: '相对标准条件改了什么' },
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

/**
 * 新建表默认几列，照文献里那种优化表来：
 * Entry | 相对标准条件改了什么 | 产率 | 选择性（想要温度 / 投料再自己加）
 */
export const DEFAULT_FIELDS = [
  { key: 'f-var', label: '相对标准条件', source: 'variation' },
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
export function autoValue(source, exp, base) {
  if (!exp) return '';
  // 这一格是照文献表写的（`none` = 基准那条，`same` = 条件没动），表里全是英文口径
  if (source === 'variation') {
    if (!base || base.id === exp.id) return 'none';
    const v = variations(base, exp);
    return v.length ? v.join(' · ') : 'same';
  }
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

/* ---- 相对标准条件改了什么 ----
   文献里的优化表都有一列「Variations from the standard conditions」，只写**变成了什么**
   （`at 115 °C` / `in THF` / `without HFIP`）——基准值已经写在表格上方的「标准条件」里，
   每条再重复一遍「A 代替 B」会把格子撑成两行（用户嫌长）。所以：
     条件改值 → 新值（`-40 °C`）；去掉 → `无溶剂`
     换试剂 / 换溶剂 / 换底物 → 只写新名字（底物加个「底物」前缀，免得看着像试剂）
     加试剂 → `+ HFIP 2 eq`；去试剂 → `− PPh3`；只改当量 → `LDA 1.2 eq`
   别再回到 `A 代替 B` / `去掉溶剂（原 THF）` 那种写法。 */
const COND_LABEL = {
  temperature: '温度',
  duration: '时间',
  atmosphere: '气氛',
  addition: '加料',
};

const reagentMapOf = (exp) =>
  new Map((exp?.reagents || []).filter((r) => r.name).map((r) => [`${r.role}:${r.name}`, r.eq]));

const eqText = (v) => (v === null || v === undefined || v === '' ? '' : `${v} eq`);

/** 溶剂现在就是投料表里 role=溶剂 的一行，`solvent` 字段只是老记录留下的壳。
 *  有投料行时一律以投料行为准，否则同一件事会在格子里写两遍（踩过）。 */
const hasSolventRow = (e) => (e?.reagents || []).some((r) => r.role === '溶剂' && String(r.name || '').trim());

export function variations(base, cur) {
  if (!base || !cur) return [];
  const out = [];
  const push = (v) => {
    const t = String(v ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  };

  for (const [key, label] of Object.entries(COND_LABEL)) {
    const a = String(base[key] ?? '').trim();
    const b = String(cur[key] ?? '').trim();
    if (a === b) continue;
    push(b || `无${label}`);
  }
  // 老记录（溶剂还不是投料行的时候）才看字段
  if (!hasSolventRow(base) && !hasSolventRow(cur)) {
    const a = String(base.solvent ?? '').trim();
    const b = String(cur.solvent ?? '').trim();
    if (a !== b) push(b || '无溶剂');
  }

  const bm = reagentMapOf(base);
  const cm = reagentMapOf(cur);
  const nameOf = (k) => k.split(':')[1];
  const roleOf = (k) => k.split(':')[0];
  const added = [...cm.keys()].filter((k) => !bm.has(k));
  const removed = [...bm.keys()].filter((k) => !cm.has(k));
  const usedAdd = new Set();
  const usedDel = new Set();

  // 一进一出、角色相同（配体换配体、底物换底物）→ 只写换成什么；当量也变了才带 eq
  for (const a of added) {
    const d = removed.find((k) => !usedDel.has(k) && roleOf(k) === roleOf(a));
    if (!d) continue;
    usedAdd.add(a);
    usedDel.add(d);
    const eqA = eqText(cm.get(a));
    const same = eqA === eqText(bm.get(d));
    const name = same ? nameOf(a) : [nameOf(a), eqA].filter(Boolean).join(' ');
    push(roleOf(a) === '底物' ? `底物 ${name}` : name);
  }
  for (const a of added) {
    if (usedAdd.has(a)) continue;
    const eq = eqText(cm.get(a));
    push(`+ ${nameOf(a)}${eq ? ` ${eq}` : ''}`);
  }
  for (const d of removed) {
    if (usedDel.has(d)) continue;
    push(`− ${nameOf(d)}`);
  }
  // 同一个试剂只改了当量：只写新当量
  for (const [k, eq] of cm) {
    if (!bm.has(k)) continue;
    if (String(bm.get(k) ?? '') !== String(eq ?? '')) push(`${nameOf(k)} ${eqText(eq) || '—'}`);
  }
  return out;
}
