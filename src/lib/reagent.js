/** 投料表用到的纯计算 —— 不碰 DOM，方便以后写测试。 */

export const ROLES = ['底物', '试剂', '催化剂', '配体', '碱', '添加剂', '氧化剂', '还原剂', '溶剂', '其他'];

/** 组分在投料表里直接显示英文缩写（数据仍存中文，颜色 / 统计都按中文走） */
export const ROLE_EN = {
  底物: 'Sub',
  试剂: 'Rgt',
  催化剂: 'Cat',
  配体: 'L',
  碱: 'Base',
  添加剂: 'Add',
  氧化剂: 'Ox',
  还原剂: 'Red',
  溶剂: 'Sol',
  其他: 'Oth',
};

/** 手输时的旧写法 / 常见缩写，仍认成对应组分（配体现在显示成 L） */
export const ROLE_ALIAS = { lig: '配体', ligand: '配体', rg: '试剂', sub: '底物' };

export const ROLE_TONE = {
  底物: 'sub',
  碱: 'base',
  催化剂: 'cat',
  配体: 'lig',
  溶剂: 'sol',
  添加剂: 'add',
  氧化剂: 'ox',
  还原剂: 'red',
};

export const roleTone = (role) => {
  if (ROLE_TONE[role]) return ROLE_TONE[role];
  const zh = Object.entries(ROLE_EN).find(([, en]) => en.toLowerCase() === String(role || '').toLowerCase());
  return zh ? ROLE_TONE[zh[0]] : 'plain';
};


export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export const round = (v, d = 2) => {
  const x = num(v);
  if (x === null) return '';
  const p = 10 ** d;
  return String(Math.round(x * p) / p);
};

/** ≤15 当浓度（2 → 2M），>15 当分子量（174.2 → MW） */
const CONC_CEILING = 15;

export function parseMwCell(text) {
  const t = String(text ?? '').trim();
  if (!t) return { mw: null, conc: null };
  const v = Number(t.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(v) || v <= 0) return { mw: null, conc: null };
  if (/(g\s*\/\s*mol|mw)\s*$/i.test(t)) return { mw: v, conc: null };
  if (/m\s*$/i.test(t)) return { mw: null, conc: v };
  if (v <= CONC_CEILING) return { mw: null, conc: v };
  return { mw: v, conc: null };
}

export function mwText(r) {
  if (num(r.conc)) return `${round(r.conc, 2)}M`;
  if (num(r.mw) !== null) return round(r.mw, 2);
  return '';
}

export function amountText(r) {
  const mmol = num(r.mmol);
  const conc = num(r.conc);
  if (conc && mmol) return `${round(mmol / conc, 2)} mL`;
  const mg = num(r.mass_mg);
  if (mg !== null) {
    const d = num(r.density);
    if (d) {
      const ml = mg / d / 1000;
      if (ml >= 0.1) return `${round(ml, 2)} mL`;
    }
    return mg >= 1000 ? `${round(mg / 1000, 4)} g` : `${round(mg, 1)} mg`;
  }
  const ul = num(r.volume_ul);
  if (ul !== null) return `${round(ul / 1000, 2)} mL`;
  return '';
}

/** 固体（按 g 称）/ 液体（按 mL 量） */
export function rowKind(r) {
  const mmol = num(r.mmol);
  if (num(r.conc) && mmol) return 'liquid';
  if (num(r.mass_mg) !== null) return 'solid';
  if (num(r.volume_ul) !== null) return 'liquid';
  return '';
}

/** 由 mmol 推质量 / 体积 */
export function derive(row) {
  const mmol = num(row.mmol);
  if (mmol === null) return row;
  const conc = num(row.conc);
  const mw = num(row.mw);
  const density = num(row.density);
  if (conc) return { ...row, volume_ul: Math.round((mmol / conc) * 1000 * 1000) / 1000, mass_mg: null };
  if (mw) {
    const mg = mmol * mw;
    return {
      ...row,
      mass_mg: Math.round(mg * 10000) / 10000,
      volume_ul: density ? Math.round((mg / density) * 1000) / 1000 : null,
    };
  }
  return row;
}

/** 一行用了多少 mmol，合计用 */
export function totals(rows) {
  let solidMg = 0;
  let liquidUl = 0;
  let solventUl = 0;
  let count = 0;
  for (const r of rows) {
    if (!r.name && !r.role) continue;
    count += 1;
    if (r.role === '溶剂') {
      solventUl += num(r.volume_ul) || 0;
      continue;
    }
    const kind = rowKind(r);
    if (kind === 'solid') solidMg += num(r.mass_mg) || 0;
    else if (kind === 'liquid') liquidUl += num(r.volume_ul) || 0;
  }
  return { count, solidMg, liquidUl, solventUl };
}

/** 理论产量 / 实测产率 */
export function yieldInfo({ base_mmol, product_mw, product_mass, yield_pct }) {
  const base = num(base_mmol);
  const pmw = num(product_mw);
  const mass = num(product_mass);
  const theo = base && pmw ? (base * pmw) / 1000 : null;
  const calc = theo && mass !== null ? (mass / theo) * 100 : null;
  return { theo, calc, over: calc !== null && calc > 105, saved: num(yield_pct) };
}
