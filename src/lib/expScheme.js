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
      if (text) loose.push({ text, role: r.role });
      continue;
    }
    if (text) others.push({ text, role: r.role });
  }
  if (loose.length) others.unshift(...loose);

  const prod = model.product_compound_id
    ? byId.get(Number(model.product_compound_id)) || null
    : byName.get(norm(model.product_name)) || null;

  // 箭头上下的条件不写「浓度」（那个数是按投料表折算出来的，常常是个没意义的 M 值，
  // 化学式上写出来反而干扰）；溶剂 / 温度 / 时间照旧
  const cond = [model.solvent, model.temperature, model.duration]
    .map(str)
    .filter(Boolean)
    .join('，');

  const fit = [];
  const over = [];
  let used = 0;
  for (const t of others) {
    const need = (fit.length ? 1 : 0) + widthOf(t.text);
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
    // 试剂名按组分上色（Sub 棕 / Cat 紫 / Base 蓝 / Lig 绿 / Add 金…），跟投料表一致
    above: fit.length ? [fit] : [],
    below: [over.length ? over : '', cond].filter(Boolean),
  };
}

