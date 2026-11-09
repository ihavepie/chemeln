/**
 * 一条记录的「标准条件」：反应式需要的几个构件（交给 `lib/scheme.js` 拼图）+ 一行文字。
 *
 * 记录页的「按投料表生成反应式」和筛选表的表头注释都从这里取——不然同一份投料表
 * 在两个页面拼出来的箭头上文字会不一样。筛选表那边拿到的记录没有 `compound_id`，
 * 所以这里按名字去化合物库里找，**只在名字唯一时**才认，免得挂错结构。
 */
import { num, round } from './reagent.js';

const MAX_ABOVE = 34; // 箭头上方一行大约放得下多少「字」（中文按 1、西文按 0.55 估）
const str = (v) => (v == null ? '' : String(v).trim());
/** 名字比对前先抹掉空格 / 括号 / 标点：库里叫「环丁酮甲酯」、表里写成「环丁酮甲酯 (1)」也能对上 */
const norm = (v) => str(v).replace(/[\s()（）\[\]【】·,，、\-—_]/g, '').toLowerCase();
const widthOf = (t) => [...t].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 1 : 0.55), 0);

/** 试剂名 / 当量写成箭头上那种标签：`LDA (2 eq)`，1 eq 就只写名字 */
function label(r, c) {
  const name = str(r.name) || (c ? str(c.name || c.code) : '');
  if (!name) return '';
  const eq = num(r.eq);
  return eq != null && eq !== 1 ? `${name} (${round(eq, 2)} eq)` : name;
}

/**
 * 投料表 → `{ reactants, product, prodName, above, below }`。
 * 缺结构式的项留空字符串，由调用方决定提示什么（记录页要弹 toast，筛选表只是不画图）。
 */
export function schemeParts(model, compounds) {
  const lib = compounds || [];
  const byId = new Map(lib.map((c) => [Number(c.id), c]));
  const byName = new Map();
  for (const c of lib) {
    for (const key of [norm(c.name), norm(c.code)]) {
      if (!key) continue;
      byName.set(key, byName.has(key) ? null : c); // 重名就置 null，宁可不认
    }
  }
  const lookup = (r) => {
    if (r.compound_id) {
      const c = byId.get(Number(r.compound_id));
      if (c) return c;
    }
    return byName.get(norm(r.name)) || null;
  };

  const reactants = [];
  const others = []; // 试剂 / 催化剂 / 碱……能塞进箭头上方就塞，塞不下挪到下方
  const loose = [];  // 写了名字但挂不上化合物库的底物：画不出结构，名字放箭头上，别默默吞掉
  for (const r of model.reagents || []) {
    if (r.role === '溶剂') continue;
    const c = lookup(r);
    const text = label(r, c);
    if (r.role === '底物' && c && c.smiles) {
      reactants.push(c.smiles);
      continue;
    }
    if (r.role === '底物') {
      if (text) loose.push(text);
      continue;
    }
    if (text) others.push(text);
  }
  if (loose.length) others.unshift(...loose);

  const prod = model.product_compound_id
    ? byId.get(Number(model.product_compound_id)) || null
    : byName.get(norm(model.product_name)) || null;

  const cond = [model.solvent, model.concentration, model.temperature, model.duration]
    .map(str)
    .filter(Boolean)
    .join('，');

  const fit = [];
  const over = [];
  let used = 0;
  for (const t of others) {
    const need = (fit.length ? 1 : 0) + widthOf(t);
    if (used + need <= MAX_ABOVE) {
      fit.push(t);
      used += need;
    } else {
      over.push(t);
    }
  }

  return {
    reactants,
    product: prod && prod.smiles ? prod.smiles : '',
    prodName: prod ? str(prod.name || prod.code) : str(model.product_name),
    loose: loose.length, // 有名字但挂不上库的底物，记录页据此提示
    above: fit.length ? [fit.join('，')] : [],
    below: [over.join('，'), cond].filter(Boolean),
  };
}

/**
 * 「标准条件」写成一行字（筛选表的表头注释用，没有结构式也能读）：
 * `环丁酮甲酯 (1 eq)，LDA (2 eq)，BnBr (1.2 eq)，THF，-78 °C，8 h，N2 → 苯基化产物`
 */
export function standardLine(exp) {
  if (!exp) return '';
  const rows = exp.reagents || [];
  const sub = [];
  const re = [];
  rows.forEach((r) => {
    if (r.role === '溶剂') return;
    const text = label(r, null);
    if (text) (r.role === '底物' ? sub : re).push(text);
  });
  const solvent = str((rows.find((r) => r.role === '溶剂') || {}).name) || str(exp.solvent);
  const tail = [solvent, str(exp.temperature), str(exp.duration), str(exp.atmosphere)]
    .filter(Boolean)
    .join('，');
  const prod = str(exp.product_name);
  const line = [[...sub, ...re].join('，'), tail].filter(Boolean).join('，') + (prod ? ` → ${prod}` : '');
  // 数值和单位之间用不断行空格：窄一点的时候不会把「-78 °C」「1.2 eq」从中间断开
  return line.replace(/(\d)\s(°C|℃|h|eq|mL|mol)/g, '$1\u00A0$2');
}
