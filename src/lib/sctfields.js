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
  if (source === 'variation') {
    if (!base || base.id === exp.id) return '标准条件';
    const v = variations(base, exp);
    return v.length ? v.join(' · ') : '重复';
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
   文献里的优化表都有一列「Variations from the standard conditions」，
   写成 `105 °C instead of 110 °C` / `without HFIP` / `P(Cy)3 instead of DTMBPP`。
   这里按同样口径从记录里算出来（基准 = 第一行）：改值写「A 代替 B」，加减试剂写「加 / 去掉」。 */
const COND_LABEL = {
  temperature: '温度',
  solvent: '溶剂',
  duration: '时间',
  atmosphere: '气氛',
  addition: '加料',
};

const reagentMapOf = (exp) =>
  new Map((exp?.reagents || []).filter((r) => r.name).map((r) => [`${r.role}:${r.name}`, r.eq]));

const eqText = (v) => (v === null || v === undefined || v === '' ? '' : `${v} eq`);

export function variations(base, cur) {
  if (!base || !cur) return [];
  const out = [];
  for (const [key, label] of Object.entries(COND_LABEL)) {
    const a = String(base[key] ?? '').trim();
    const b = String(cur[key] ?? '').trim();
    if (a === b) continue;
    if (!a) out.push(`加${label} ${b}`);
    else if (!b) out.push(`去掉${label}（原 ${a}）`);
    else out.push(`${b} 代替 ${a}`);
  }
  const bm = reagentMapOf(base);
  const cm = reagentMapOf(cur);
  const nameOf = (k) => k.split(':')[1];
  const added = [...cm.keys()].filter((k) => !bm.has(k));
  const removed = [...bm.keys()].filter((k) => !cm.has(k));

  // 一进一出、而且**角色相同**（配体换配体、催化剂换催化剂）就写成「B 代替 A」，
  // 跟文献里的 `P(Cy)3 instead of DTMBPP` 一个意思；对不上才写「加 / 去掉」。
  const takenDel = new Set();
  for (const a of added) {
    const role = a.split(':')[0];
    const d = removed.find((k) => !takenDel.has(k) && k.split(':')[0] === role);
    if (!d) continue;
    takenDel.add(d);
    const eqA = cm.get(a);
    const eqD = bm.get(d);
    // 当量一样就只写名字（文献里 `P(Cy)3 instead of DTMBPP` 那样），不一样才把 eq 带上
    const sameEq = String(eqText(eqA)) === String(eqText(eqD));
    const left = sameEq ? nameOf(a) : [nameOf(a), eqText(eqA)].filter(Boolean).join(' ');
    const right = sameEq ? nameOf(d) : [nameOf(d), eqText(eqD)].filter(Boolean).join(' ');
    out.push(`${left} 代替 ${right}`);
  }
  for (const a of added) {
    if (out.some((x) => x.includes(`代替`) && x.startsWith(nameOf(a)))) continue;
    out.push(`加 ${nameOf(a)}${eqText(cm.get(a)) ? ` ${eqText(cm.get(a))}` : ''}`);
  }
  for (const d of removed) {
    if (takenDel.has(d)) continue;
    if (out.some((x) => x.includes(`代替 ${nameOf(d)}`))) continue;
    out.push(`去掉 ${nameOf(d)}`);
  }
  // 同一个试剂只改了当量
  for (const [k, eq] of cm) {
    if (!bm.has(k)) continue;
    if (String(bm.get(k) ?? '') !== String(eq ?? '')) {
      out.push(`${nameOf(k)} ${eqText(eq) || '—'} 代替 ${eqText(bm.get(k)) || '—'}`);
    }
  }
  return out;
}
