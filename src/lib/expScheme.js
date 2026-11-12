/**
 * 一条记录的「标准条件」：反应式需要的几个构件（交给 `lib/scheme.js` 拼图）+ 一行文字。
 *
 * 记录页的「按投料表生成反应式」和筛选表的表头注释都从这里取——不然同一份投料表
 * 在两个页面拼出来的箭头上文字会不一样。筛选表那边拿到的记录没有 `compound_id`，
 * 所以这里按名字去化合物库里找，**只在名字唯一时**才认，免得挂错结构。
 */
import { eqLabel } from './reagent.js';

const MAX_ABOVE = 40;   // 箭头上方**一行**放多少「字」（中文按 1、西文按 0.55 估）：够放四个带当量的试剂（约 38）
// **箭头上只排一行**（用户：「箭头上最好不要两行」）：放不下的试剂挪到箭头下方，
// 宁可下面多一行，也不要上面摞两行
const MAX_ABOVE_LINES = 1;
const str = (v) => (v == null ? '' : String(v).trim());
/** 名字比对前先抹掉空格 / 括号 / 标点：库里叫「环丁酮甲酯」、表里写成「环丁酮甲酯 (1)」也能对上 */
const norm = (v) => str(v).replace(/[\s()（）\[\]【】·,，、\-—_]/g, '').toLowerCase();
const widthOf = (t) => [...t].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 1 : 0.55), 0);

/**
 * 试剂名 / 当量写成箭头上那种标签：`LDA (2.0 eq)`、`RuPhos (20 mol%)`。
 * 当量的写法统一在 `reagent.eqLabel()`（不到 1 写百分数 + mol%，其余一位小数）。
 * 以前 `10%` 这种摩尔百分数用 num() 读出来是 null，箭头上干脆不写当量（用户报过）。
 */
const eqText = eqLabel;

function label(r, c) {
  // 「变量」行（配体 / 碱 / 添加剂…）：箭头上只写占位符 [L]，具体是什么由每个条件填
  if (str(r.variable)) return `[${str(r.variable)}]`;
  const name = str(r.name) || (c ? str(c.name || c.code) : '');
  if (!name) return '';
  const t = eqText(r.eq);
  return t ? `${name} (${t})` : name;
}

/**
 * 投料表 → `{ reactants, product, prodName, above, below }`。
 * 缺结构式的项留空字符串，由调用方决定提示什么（记录页要弹 toast，筛选表只是不画图）。
 */
/**
 * 反应式文本里 `>>` 后面那段＝产物 SMILES（取第一个片段；空就是没有）。
 * 两条画法都往 `scheme_smiles` 写这个格式：「按投料表生成」写 `底物>>产物`，
 * 画板画的反应式也写 `反应物>>产物`。「绑定产物」靠它把产物结构读出来。
 */
export function productSmilesOf(schemeSmiles) {
  const s = String(schemeSmiles || '');
  const i = s.lastIndexOf('>>');
  if (i < 0) return '';
  const tail = s.slice(i + 2).split('>')[0];
  return (tail.split('.')[0] || '').trim();
}

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

  // 箭头上下的条件不写「浓度」（那个数是按投料表折算出来的，常常是个没意义的 M 值，
  // 化学式上写出来反而干扰）；溶剂 / 温度 / 时间照旧。
  // **被标成变量的字段写成占位符**（温度 → `[T]`）：具体取值由每个条件填，跟 `[L]` 一个道理。
  const fv = new Map((model.field_vars || []).map((v) => [String(v.key), String(v.label || v.key)]));
  const fieldText = (key, val) => (fv.has(key) ? `[${fv.get(key)}]` : str(val));

  const rowsAll = model.reagents || [];
  const stepMeta = Array.isArray(model.steps) ? model.steps : [];
  // 一条记录里有几步（老记录全是 1 步）
  const maxStep = Math.max(1, stepMeta.length, ...rowsAll.map((r) => Number(r.step) || 1));

  /** 箭头上面最多一行：放不下的挪到下面（用户：「箭头上最好不要两行」） */
  const packAbove = (others) => {
    const fit = [];
    const over = [];
    for (const t of others) {
      let row = fit[fit.length - 1];
      const need = row && row.length ? 1 + widthOf(t.text) : widthOf(t.text);
      if (!row || widthOf(row.map((x) => x.text).join(', ')) + need > MAX_ABOVE) {
        if (fit.length >= MAX_ABOVE_LINES) {
          over.push(t);
          continue;
        }
        row = [];
        fit.push(row);
      }
      row.push(t);
    }
    return { fit, over };
  };

  /**
   * 一步的构件：`{reactants, reactantIds, reactantVers, product…, above, below, loose, prodName}`。
   * @param {object[]} rows 这一步的投料行
   * @param {object|null} prod 这一步的产物（化合物或 null）
   * @param {string} prodName 没挂库时的产物名
   * @param {string} condText 这一步的条件文字（多步时来自「第 N 步」那行的条件格）
   */
  const stageOf = (rows, prod, prodName, condText) => {
    const seenPlaceholder = new Set();   // 同一个变量槽（两行都标成 [Cat]）箭头上只写一次
    const reactants = [];
    const reactantIds = []; // 与 reactants 平行：反应式要按库里那份「带缩写的画」出图时用
    const reactantVers = []; // 与 reactants 平行：化合物的 updated_at —— 结构改过就得换一份画
    const others = []; // 试剂 / 催化剂 / 碱……能塞进箭头上方就塞，塞不下挪到下方
    const loose = [];  // 没挂上结构的底物（画不出来）：**不写在箭头上**，见下面 subBelow
    const subNames = []; // 「底物」行的名字：双底物要写成 `底物1 + 底物2`
    const solvents = []; // 这一步的溶剂行
    for (const r of rows) {
      if (r.role === '溶剂') {
        if (str(r.name)) solvents.push(str(r.name));
        continue;
      }
      const c = lookup(r);
      const text = label(r, c);
      if (r.role === '底物' && c && c.smiles) {
        reactants.push(c.smiles);
        reactantIds.push(Number(c.id));
        reactantVers.push(String(c.updated_at || ''));
        subNames.push(str(r.name) || str(c.name || c.code));
        continue;
      }
      if (r.role === '底物') {
        // 另一个底物（双底物偶联那种）画不出结构，或者干脆不该画在箭头上——
        // 它以「底物1 + 底物2」的形式挪到箭头下面（用户：不要放在反应式上，就放在下面）
        const nm = str(r.name) || (c ? str(c.name || c.code) : '');
        if (nm) subNames.push(nm);
        if (text) loose.push({ text, role: r.role });
        continue;
      }
      if (text) {
        // 变量槽去重：同类型加了两行（都标成 [Cat]）时，箭头上只留一个 [Cat]
        if (r.variable) {
          if (seenPlaceholder.has(text)) continue;
          seenPlaceholder.add(text);
        }
        others.push({ text, role: r.role });
      }
    }
    // 双底物：有底物画不出结构时，箭头下面单起一行 `底物1 + 底物2`；
    // 两个都画出来的时候不写这行（左边已经是「结构1 + 结构2」，再写一遍是重复）
    const subBelow = loose.length && subNames.length > 1 ? subNames.join(' + ') : '';
    const { fit, over } = packAbove(others);
    // 条件：单步还是老规矩（记录里的溶剂 / 温度 / 时间）；多步时按「这一步的溶剂行 + 这一步的条件文字」
    let cond;
    if (maxStep > 1) {
      const sol = solvents.join(' + ');
      const text = str(condText);
      // 这一步的条件文字里往往已经写了溶剂（「THF, rt」），别再重复一遍
      const needSol = sol && !text.toLowerCase().includes(sol.toLowerCase());
      cond = [needSol ? sol : '', text].filter(Boolean).join('，');
    } else {
      // 单步：还是记录里那格「溶剂」（投料表的溶剂行是它的镜像，名字对不齐时以这格为准）
      cond = [str(model.solvent) || solvents.join(' + '), fieldText('temperature', model.temperature), fieldText('duration', model.duration)]
        .filter(Boolean)
        .join('，');
    }
    return {
      reactants,
      reactantIds,
      reactantVers,
      product: prod && prod.smiles ? prod.smiles : '',
      productId: prod ? Number(prod.id) : null,
      productVer: prod ? String(prod.updated_at || '') : '',
      productLabel: prod ? '' : str(prodName),
      prodName: prod ? str(prod.name || prod.code) : str(prodName),
      loose: loose.length, // 有名字但挂不上库的底物，记录页据此提示
      // 试剂名按组分上色（Sub 棕 / Cat 紫 / Base 蓝 / Lig 绿 / Add 金…），跟投料表一致
      above: fit,
      below: [over.length ? over : '', subBelow, cond].filter(Boolean),
    };
  };

  /** 产物按 id / 名字找化合物（找不到就只留名字） */
  const findProduct = (id, name) => {
    if (id) {
      const c = byId.get(Number(id));
      if (c) return c;
    }
    return byName.get(norm(name)) || null;
  };

  // 每一步的产物：中间那几步写在「第 N 步」那行的「产物」格，最后一步是记录的结果块产物
  const finalProd = findProduct(model.product_compound_id, model.product_name);
  const stages = [];
  for (let step = 1; step <= maxStep; step++) {
    const rows = rowsAll.filter((r) => (Number(r.step) || 1) === step);
    const isLast = step === maxStep;
    const meta = stepMeta[step - 1] || {};
    const prod = isLast ? finalProd : findProduct(null, meta.product_name);
    stages.push(stageOf(rows, prod, isLast ? model.product_name : meta.product_name, meta.condition));
  }

  // 单步的：把 stages[0] 摊平返回（老调用方照旧用这些字段）
  const first = stages[0];
  return {
    ...first,
    stages,
    loose: stages.reduce((n, st) => n + st.loose, 0),
  };
}
