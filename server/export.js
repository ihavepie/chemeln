'use strict';

/** 导出：单条实验 → Markdown（SI 风格）；筛选表 → CSV / Markdown。 */

const pad2 = (x) => String(x).padStart(2, '0');
const humanTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const num = (v, d = 2) => {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '';
  const n = Number(v);
  if (Number.isInteger(n) && d >= 2) return String(n);
  return Number(n.toFixed(d)).toString();
};

const mass = (mg) => {
  if (mg === null || mg === undefined) return '';
  if (mg >= 1000) return `${num(mg / 1000, 3)} g`;
  return `${num(mg, 1)} mg`;
};

const vol = (ul) => {
  if (ul === null || ul === undefined) return '';
  if (ul >= 1000) return `${num(ul / 1000, 3)} mL`;
  return `${num(ul, 1)} µL`;
};

const CELL_CATEGORY = {
  scheme: '反应式',
  tlc: 'TLC 板',
  h1: '¹H NMR',
  c13: '¹³C NMR',
  nmr_other: '其他核磁',
  nmr_raw: '原始数据 · FID / mnova',
  nmr_pdf: '谱图 PDF',
  hrms: 'HRMS',
  ir: 'IR',
  photo: '实验照片',
  other: '其他附件',
};

function conditionLine(exp) {
  const parts = [];
  if (exp.solvent) parts.push(exp.solvent);
  if (exp.concentration) parts.push(exp.concentration);
  if (exp.temperature) parts.push(exp.temperature);
  if (exp.duration) parts.push(exp.duration);
  if (exp.atmosphere) parts.push(exp.atmosphere);
  return parts.join('、');
}

function amount(r) {
  if (r.conc && r.mmol) return `${num((r.mmol / r.conc), 2)} mL`;
  if (r.density && r.mass_mg) return vol(r.mass_mg / r.density);
  if (r.mass_mg !== null && r.mass_mg !== undefined) return mass(r.mass_mg);
  if (r.volume_ul !== null && r.volume_ul !== undefined) return vol(r.volume_ul);
  return '';
}

function reagentTable(reagents, steps = []) {
  const rows = reagents.filter((r) => r.name || r.role);
  if (!rows.length) return '';

  const table = (list) => {
    const head = '| 组分 | 试剂 | MW / 浓度 | 当量 | mmol | 用量 | 说明 |\n|---|---|---:|---:|---:|---:|---|';
    const body = list
      .map((r) =>
        [
          r.role || '',
          r.name || '',
          r.conc ? `${num(r.conc, 2)} M` : num(r.mw, 2),
          num(r.eq, 2),
          num(r.mmol, 3),
          amount(r),
          (r.note || '').replace(/\|/g, '\\|'),
        ].join(' | ')
      )
      .map((line) => `| ${line} |`)
      .join('\n');
    return `${head}\n${body}`;
  };

  // 只有一步：跟以前一样，一张表
  const multi = steps.length > 1 || rows.some((r) => (Number(r.step) || 1) > 1);
  if (!multi) return table(rows);

  const groups = new Map();
  for (const r of rows) {
    const s = Math.max(1, Number(r.step) || 1);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(r);
  }
  const total = Math.max(steps.length, ...groups.keys());
  const out = [];
  for (let s = 1; s <= total; s++) {
    const st = steps[s - 1] || {};
    out.push(`**第 ${s} 步${st.label ? ` · ${st.label}` : ''}**`);
    if (st.condition) out.push(`> 条件：${st.condition}`);
    out.push('');
    const list = groups.get(s) || [];
    out.push(list.length ? table(list) : '_（本步没有投料行）_');
    out.push('');
    if (st.workup && s < total) {
      out.push(`> 之后：${st.workup}`);
      out.push('');
    }
  }
  return out.join('\n').trim();
}

function attachmentSection(attachments) {
  if (!attachments.length) return '';
  const order = Object.keys(CELL_CATEGORY);
  const groups = new Map();
  for (const a of attachments) {
    const k = a.category || 'other';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const lines = [];
  for (const k of order) {
    const list = groups.get(k);
    if (!list) continue;
    lines.push(`**${CELL_CATEGORY[k] || k}**`);
    for (const a of list) {
      lines.push(`- \`${a.original_name || a.filename}\`${a.is_dir ? '（文件夹）' : ''}${a.note ? ` — ${a.note}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function experimentToMarkdown(exp, { reagents = [], attachments = [], settings = {}, screenings = [] } = {}) {
  const L = [];
  const heading = settings.lab_heading || '方法学实验记录';
  const owner = [settings.owner_name, settings.group_name].filter(Boolean).join(' · ');

  L.push(`# ${exp.code} · ${exp.title || '（未命名实验）'}`);
  L.push('');
  const meta = [exp.date, exp.project && `课题：${exp.project}`, exp.rxn_type && `类型：${exp.rxn_type}`, `状态：${exp.status}`];
  L.push(`> ${meta.filter(Boolean).join('　|　')}`);
  if (owner) L.push(`> ${owner}`);
  L.push('');

  const block = (title, text) => {
    if (!text || !String(text).trim()) return;
    L.push(`## ${title}`);
    L.push('');
    L.push(String(text).trim());
    L.push('');
  };

  block('研究目的', exp.objective);
  if (exp.literature) block('文献依据', exp.literature);

  L.push('## 反应条件');
  L.push('');
  L.push(`- 溶剂 / 条件：${conditionLine(exp) || '—'}`);
  if (exp.base_mmol) L.push(`- 反应规模：${num(exp.base_mmol, 3)} mmol（以底物计）`);
  const stepCount = Math.max((exp.steps || []).length, ...reagents.map((r) => Number(r.step) || 1), 1);
  if (stepCount > 1) L.push(`- 步骤：${stepCount} 步（步骤之间做了后处理，属两步连开）`);
  L.push('');

  const rt = reagentTable(reagents, exp.steps || []);
  if (rt) {
    L.push('## 投料表');
    L.push('');
    L.push(rt);
    L.push('');
  }

  block('操作步骤', exp.procedure);
  block('后处理', exp.workup);

  L.push('## 结果');
  L.push('');
  const res = [];
  if (exp.product_name) res.push(`- 产物：${exp.product_name}`);
  if (exp.appearance) res.push(`- 性状：${exp.appearance}`);
  if (exp.product_mass !== null && exp.product_mass !== undefined) res.push(`- 产物质量：${num(exp.product_mass, 4)} g`);
  if (exp.product_mw && exp.base_mmol) {
    const theo = (exp.base_mmol * exp.product_mw) / 1000;
    res.push(`- 理论产量：${num(theo, 4)} g（按 ${num(exp.base_mmol, 3)} mmol 底物计）`);
  }
  if (exp.yield_pct !== null && exp.yield_pct !== undefined) res.push(`- 分离产率：${num(exp.yield_pct, 1)}%`);
  if (exp.dr_ee) res.push(`- 选择性：${exp.dr_ee}`);
  // 选择性是怎么测的：SI 里必须写清楚，不然没法复现
  const sel = [
    exp.sel_method,
    exp.sel_condition,
    exp.sel_rt ? `tR = ${exp.sel_rt}` : '',
  ]
    .filter(Boolean)
    .join('，');
  if (sel) res.push(`- 选择性测定：${sel}`);
  L.push(res.length ? res.join('\n') : '- —');
  L.push('');

  if (exp.tlc_note) {
    L.push('## TLC');
    L.push('');
    L.push(exp.tlc_note);
    L.push('');
  }

  block('表征数据', exp.characterization);
  block('现象与观察', exp.notes);
  block('结论', exp.conclusion);

  if (screenings.length) {
    L.push('## 条件筛选');
    L.push('');
    for (const s of screenings) L.push(`- ${s.title || '（未命名筛选）'}（${(s.entries || []).length} 组条件）`);
    L.push('');
  }

  const at = attachmentSection(attachments);
  if (at) {
    L.push('## 附件清单');
    L.push('');
    L.push(at);
  }

  L.push('---');
  L.push(`创建：${humanTime(exp.created_at)}　更新：${humanTime(exp.updated_at)}　记录人：${owner || '—'}　来源：${heading}`);
  return L.join('\n');
}

function screeningToMarkdown(s) {
  const vars = s.vars || [];
  const entries = s.entries || [];
  const L = [];
  L.push(`# ${s.title || '（未命名筛选）'}`);
  L.push('');
  if (s.note) {
    L.push(s.note.trim());
    L.push('');
  }
  const head = ['编号', ...vars, '产率 (%)', 'ee (%)', 'dr', '说明'];
  L.push(`| ${head.join(' | ')} |`);
  L.push(`|${head.map(() => '---').join('|')}|`);
  for (const e of entries) {
    const cells = [
      e.label || '',
      ...vars.map((v) => (e.values ? e.values[v] ?? '' : '')),
      num(e.yield_pct, 1),
      num(e.ee_pct, 1),
      e.dr || '',
      e.note || '',
    ].map((c) => String(c).replace(/\|/g, '\\|'));
    L.push(`| ${cells.join(' | ')} |`);
  }
  L.push('');
  return L.join('\n');
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function screeningToCsv(s) {
  const vars = s.vars || [];
  const entries = s.entries || [];
  const head = ['编号', ...vars, '产率(%)', 'ee(%)', 'dr', '说明'];
  const lines = [head.map(csvCell).join(',')];
  for (const e of entries) {
    const row = [
      e.label || '',
      ...vars.map((v) => (e.values ? e.values[v] ?? '' : '')),
      e.yield_pct ?? '',
      e.ee_pct ?? '',
      e.dr || '',
      e.note || '',
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = {
  experimentToMarkdown,
  screeningToMarkdown,
  screeningToCsv,
  CELL_CATEGORY,
};
