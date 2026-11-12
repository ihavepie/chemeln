'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const https = require('node:https');

const store = require('./db');
const qr = require('./qr');
const { experimentToMarkdown, screeningToMarkdown, screeningToCsv, CELL_CATEGORY } = require('./export');

const { db, DATA_DIR, ATTACH_DIR, COMPOUND_DIR, allSettings, getSetting, setSetting, nextCode, logEvent, logEdit, historyFor, variantKey } = store;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// 第三方静态资源（Ketcher 结构画板等）：不放进 public/，因为每次 build 都会清空它
const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
// 端口占用了会自动往后找（见 listen()），所以这里的 PORT 要能被改；
// 二维码 base 和 PDF 渲染地址都读它，不同步就会出现「码指 4780、服务其实在 4781」。
let PORT = Number(process.env.PORT || 4780);
// 默认只听本机；设置里打开「允许手机访问」后改用 0.0.0.0（重启生效）
const HOST = process.env.HOST || (getSetting('lan_access') === '1' ? '0.0.0.0' : '127.0.0.1');
const MAX_BODY = 320 * 1024 * 1024;

/* ---------------------------------------------------------------- utils */

const nowISO = () => new Date().toISOString();

function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

const ok = (res, payload = { ok: true }) => json(res, 200, payload);
const fail = (res, code, message) => json(res, code, { error: message });

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 解析失败');
  }
}

const str = (v, fallback = '') => (v === null || v === undefined ? fallback : String(v));
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 文件名保干净：去掉路径分隔符与控制字符，保留扩展名。 */
function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f]/g, '');
  const cleaned = base.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 120) || 'file';
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

function dirSizeSync(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.statSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(cur);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(path.join(cur, e));
    } else {
      total += st.size;
    }
  }
  return total;
}

/* ----------------------------------------------------------- experiment */

const EXP_COLUMNS = [
  'code', 'title', 'date', 'status', 'project', 'rxn_type', 'literature', 'objective',
  'solvent', 'concentration', 'temperature', 'duration', 'atmosphere', 'workup', 'procedure',
  'product_name', 'appearance', 'yield_pct', 'dr_ee', 'characterization', 'notes', 'conclusion',
  'base_mmol', 'operator', 'ambient_temp', 'ambient_humid', 'product_mass', 'product_mw', 'tlc_note',
  'ee_pct', 'sel_method', 'sel_condition', 'sel_rt',
  'steps_json', 'product_compound_id', 'category_id', 'group_id', 'scheme_rxn', 'scheme_smiles', 'lit_note',
  'no_yield', 'apparatus', 'light', 'kind',
];

const NUMERIC_COLUMNS = new Set([
  'yield_pct', 'base_mmol', 'product_mass', 'product_mw', 'product_compound_id', 'category_id', 'ee_pct',
  'no_yield',
]);

/** 反应步骤：一条记录里可以有多个阶段，阶段之间夹着后处理就是「两步连开」。 */
function normalizeSteps(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 24).map((s) => ({
    label: str(s && s.label).slice(0, 120),
    condition: str(s && s.condition).slice(0, 240),
    workup: str(s && s.workup).slice(0, 240),
    start: str(s && s.start).slice(0, 24),
    end: str(s && s.end).slice(0, 24),
    addition: str(s && s.addition).slice(0, 60),   // 这一步怎么加的（滴加/分批…）
    stir: str(s && s.stir).slice(0, 60),           // 这一步怎么搅的（500 rpm…）
  }));
}

function parseSteps(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return normalizeSteps(list) || [];
  } catch {
    return [];
  }
}

function normalizeExperiment(input) {
  const out = {};
  for (const key of EXP_COLUMNS) {
    if (!(key in input) && key !== 'steps_json') continue;
    if (key === 'steps_json') {
      const steps = normalizeSteps(input.steps);
      if (steps) out.steps_json = JSON.stringify(steps);
      else if (typeof input.steps_json === 'string') out.steps_json = input.steps_json;
      continue;
    }
    if (key === 'no_yield') {
      out.no_yield = Number(input.no_yield) === 1 ? 1 : 0;   // 0/1 开关，NOT NULL
      continue;
    }
    out[key] = NUMERIC_COLUMNS.has(key) ? numOrNull(input[key]) : str(input[key]);
  }
  // 产物关联的化合物已经删掉时，别让旧页面把这条悬空 id 又写回去
  if ('product_compound_id' in out) out.product_compound_id = liveCompoundId(out.product_compound_id);
  if ('category_id' in out) out.category_id = liveCategoryId(out.category_id, 'experiment', 'project' in out ? out.project : undefined);
  return out;
}

/** 分类还在不在（scope 对不上当 null）；给了 project 还要求它属于这个课题或是共用分类 */
function liveCategoryId(value, scope, project) {
  const id = numOrNull(value);
  if (id === null) return null;
  const row = db.prepare('SELECT scope, project FROM categories WHERE id = ?').get(id);
  if (!row) return null;
  if (scope && row.scope !== scope) return null;
  // 共用分类（project ''）什么课题的记录都能装；别的课题的分类不能挂过来，
  // 否则会出现「分类在 A、记录在 B」——B 里筛不到，卡片墙上也一个组都落不进
  if (project !== undefined && row.project && row.project !== project) return null;
  return id;
}

/** 化合物还在不在；已经删掉的引用一律当 null 处理 */
function liveCompoundId(value) {
  const id = numOrNull(value);
  if (id === null) return null;
  return db.prepare('SELECT 1 AS x FROM compounds WHERE id = ?').get(id) ? id : null;
}

/* 改动留痕：字段名 → 界面上的叫法（「改了 产率、表征数据」比「改了 yield_pct」好读） */
const EXP_FIELD_LABELS = {
  scheme_rxn: '反应式（画板）', scheme_smiles: '反应式（文本）', lit_note: '文献要点', title: '题目', date: '日期', status: '状态', operator: '实验人', ambient_temp: '环境温度',
  ambient_humid: '湿度', project: '课题', rxn_type: '反应类型', literature: '文献', objective: '实验目的',
  solvent: '溶剂', concentration: '浓度', temperature: '温度', duration: '时间', atmosphere: '气氛',
  apparatus: '装置 / 器皿', light: '光照 / 波长', kind: '记录类型',
  workup: '后处理', procedure: '操作步骤', product_name: '产物', appearance: '性状', yield_pct: '产率',
  dr_ee: '选择性', characterization: '表征数据', notes: '实验现象', conclusion: '结论',
  base_mmol: '反应规模', product_mass: '产物质量', product_mw: '产物分子量', tlc_note: 'TLC',
  category_id: '分类', product_compound_id: '产物挂库', code: '编号', steps_json: '步骤与条件',
  ee_pct: 'ee 数值', sel_method: '选择性测定方式', sel_condition: '手性柱与流动相', sel_rt: '保留时间',
  reagents: '投料表',
};

const CMP_FIELD_LABELS = {
  code: '编号', name: '名称', kind: '类型', formula: '分子式', mw: '分子量', cas: 'CAS', appearance: '性状',
  mp: '熔点', smiles: 'SMILES', nmr_h1: '¹H NMR', nmr_c13: '¹³C NMR', nmr_other: '其他核磁',
  hrms: 'HRMS', ir: 'IR', rotation: '旋光', tlc_solvent: '展开剂', tlc_rf: 'Rf', procedure: '合成与纯化', notes: '说明',
  category_id: '分类', project: '课题', standard_exp_id: '标准实验',
};

/** 给人看的值：太长就截断（列表里读着舒服） */
const shortVal = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  if (!s) return '';
  return s.length <= 80 ? s : `${s.slice(0, 60)}…（共 ${s.length} 字）`;
};

/** 真要能「恢复」，历史里得留**完整且原类型**的值（null 不能变成 ''），长文本上限 8000 字 */
const fullVal = (v) => {
  if (v === undefined) return null;
  if (typeof v === 'string') return v.length > 8000 ? v.slice(0, 8000) : v;
  return v;
};

/** 步骤与条件（steps_json）在历史里别甩一坨 JSON：写成 `1. HCl 4 M / 搅拌 12 h；2. …` */
function stepsText(raw) {
  let list = [];
  try {
    list = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
  } catch {
    return String(raw || '');
  }
  if (!Array.isArray(list) || !list.length) return '';
  return list
    .map((s, i) => {
      const bits = [str(s.label), str(s.condition), str(s.workup)].map((x) => x.trim()).filter(Boolean);
      return `${i + 1}. ${bits.join(' · ') || '（空）'}`;
    })
    .join('；');
}

/** 一行字概括整张投料表：`Pd(OPiv)2 10 mol% / CsOPiv 10 mol% / dioxane 2 mL`（历史里给人读） */
function reagentTableText(rows) {
  return (rows || [])
    .map((r) => {
      const name = str(r.name) || '（未命名）';
      const eq = eqLabel(r.eq);
      const mmol = numOrNull(r.mmol);
      const tail = mmol !== null ? `（${mmol} mmol）` : '';
      if (eq) return `${name} ${eq}${tail}`;
      const ul = numOrNull(r.volume_ul);
      if (ul) return `${name} ${ul >= 1000 ? `${Math.round((ul / 1000) * 100) / 100} mL` : `${Math.round(ul * 10) / 10} µL`}`;
      return `${name}${tail}`;
    })
    .join(' / ');
}

/**
 * 这次 PUT 改到了哪些字段，各自的改前 / 改后值。
 * 数字按字符串比，避免 71 与 "71" 算成两次改动。
 */
function changedFields(before, after, labels, opts = {}) {
  const out = [];

  for (const [k, v] of Object.entries(after)) {
    if (!(k in labels)) continue;
    // 溶剂现在是投料表里的一行：有 reagent 行时，老字段 `solvent` 的变化只是迁移噪音，不记
    if (k === 'solvent' && opts.hasSolventRow) continue;
    const a = before[k];
    const b = v;
    const same =
      a === null || a === undefined
        ? b === null || b === undefined || b === ''
        : b === null || b === undefined
          ? a === ''
          : String(a) === String(b);
    if (!same) {
      const show = k === 'steps_json' ? (x) => shortVal(stepsText(x)) : shortVal;
      out.push({ f: k, o: show(a), n: show(b), of: fullVal(a), nf: fullVal(b) });
    }
  }
  return out;
}

function normalizeReagents(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r, i) => ({
      position: i,
      step: Math.max(1, Math.min(24, Number(r.step) || 1)),
      compound_id: liveCompoundId(r.compound_id),
      role: str(r.role),
      name: str(r.name),
      mw: numOrNull(r.mw),
      conc: numOrNull(r.conc),
      density: numOrNull(r.density),
      // 当量允许写成 `10%`（摩尔百分数）：这种文本要原样留着，不能当 NaN 丢掉
      eq: /%\s*$/.test(String(r.eq ?? '')) ? String(r.eq).trim() : numOrNull(r.eq),
      mmol: numOrNull(r.mmol),
      mass_mg: numOrNull(r.mass_mg),
      volume_ul: numOrNull(r.volume_ul),
      note: str(r.note),
    }))
    .filter((r) => r.name || r.role || r.mw !== null || r.eq !== null);
}

/** 把这一版投料行登记到试剂库：名字进 reagent_lib（只补最新值），
 *  再往 reagent_uses 记一条「这条记录用过它」——删记录也不会把库里的条目删掉。 */
function touchReagentLib(expId, reagents, ts = nowISO()) {
  const upLib = db.prepare(
    `INSERT INTO reagent_lib(key, name, role, mw, conc, density, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       name = COALESCE(NULLIF(excluded.name, ''), reagent_lib.name),
       role = CASE WHEN reagent_lib.role = '' THEN excluded.role ELSE reagent_lib.role END,
       mw = COALESCE(excluded.mw, reagent_lib.mw),
       conc = COALESCE(excluded.conc, reagent_lib.conc),
       density = COALESCE(excluded.density, reagent_lib.density),
       updated_at = excluded.updated_at`
  );
  const upUse = db.prepare('INSERT OR IGNORE INTO reagent_uses(key, exp_id, at) VALUES (?,?,?)');
  // 「用法」标签：这次填的当量 / 用量跟以前的都不一样就多一颗，**只加不删**
  const upVar = db.prepare(
    `INSERT OR IGNORE INTO reagent_variant_uses(key, vkey, exp_id, eq, role, volume_ul, at)
     VALUES (?,?,?,?,?,?,?)`
  );
  const unchecked = [];
  for (const r of reagents) {
    const name = str(r.name).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    upLib.run(key, name, str(r.role), r.mw ?? null, r.conc ?? null, r.density ?? null, ts, ts);
    if (expId) upUse.run(key, expId, ts);
    const v = variantKey(r.role, r.eq, r.volume_ul);
    upVar.run(key, v.vkey, Number(expId) || 0, v.eq, v.role, v.ul, ts);
    // 这一行自己带了 MW 就不用查；没带的新名字交给后台核一次（见 queueReagentVerify）
    if (r.mw == null) unchecked.push(key);
  }
  if (unchecked.length) queueReagentVerify(unchecked);
}

function insertReagents(expId, reagents) {
  touchReagentLib(expId, reagents);
  const stmt = db.prepare(
    `INSERT INTO reagents(exp_id, position, step, compound_id, role, name, mw, conc, density, eq, mmol, mass_mg, volume_ul, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const r of reagents) {
    stmt.run(
      expId, r.position, r.step, r.compound_id, r.role, r.name, r.mw, r.conc, r.density,
      r.eq, r.mmol, r.mass_mg, r.volume_ul, r.note
    );
  }
}

/** 组里比哪些字段：条件 + 规模（投料表单独按「角色+名字」比） */
const GROUP_VARS = [
  ['solvent', '溶剂'],
  ['concentration', '浓度'],
  ['temperature', '温度'],
  ['duration', '时长'],
  ['atmosphere', '气氛'],
  ['rxn_type', '类型'],
];

/**
 * 当量算不算「一样」：放大 / 称量取整常让当量差一点点（0.995 vs 1.0），
 * 差在 2%（且不超过 0.005）以内就当同一个条件，免得满屏「改：投料」。
 */
function eqSame(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a ?? '') === String(b ?? '');
  return Math.abs(x - y) <= Math.max(0.005, 0.02 * Math.max(Math.abs(x), Math.abs(y)));
}

/** 溶剂用量：浓度 + 规模能算出来（mL = mmol ÷ M），没有浓度就是 null */
function solventMlOf(row) {
  const mmol = Number(row.base_mmol);
  const m = /([0-9]*\.?[0-9]+)\s*M/.exec(String(row.concentration || ''));
  if (!Number.isFinite(mmol) || mmol <= 0 || !m) return null;
  const conc = Number(m[1]);
  if (!(conc > 0)) return null;
  return Math.round((mmol / conc) * 10) / 10;
}

/**
 * 这一条相对基准（组里最早那条）改了哪些东西。
 * 规模一变，浓度多半是被动跟着变的（放大时溶剂常常不是等比加），
 * 这种「顺带变了的浓度」不算改条件，否则纯放大也会被标成控制变量实验。
 */
function groupDiff(base, other) {
  const diffs = [];
  const scaleChanged = String(base.base_mmol ?? '') !== String(other.base_mmol ?? '');
  for (const [k, label] of GROUP_VARS) {
    if (k === 'concentration' && scaleChanged) continue;
    if (String(base[k] ?? '') !== String(other[k] ?? '')) diffs.push(label);
  }
  const key = (r) => `${r.role}|${r.name}`;
  const a = new Map((base.reagents || []).map((r) => [key(r), r]));
  const b = new Map((other.reagents || []).map((r) => [key(r), r]));
  const notes = [];
  for (const [k, r] of b) if (!a.has(k)) notes.push(`加 ${r.name || '（未命名）'}`);
  for (const [k, r] of a) if (!b.has(k)) notes.push(`去 ${r.name || '（未命名）'}`);
  for (const [k, rb] of b) {
    const ra = a.get(k);
    if (ra && !eqSame(ra.eq, rb.eq)) notes.push(`${rb.name || '（未命名）'} 当量`);
  }
  if (notes.length) diffs.push(`投料（${notes.slice(0, 3).join('，')}${notes.length > 3 ? ' 等' : ''}）`);
  return diffs;
}

/**
 * 一个平行组里的成员（含基准那条）。每条多带 `diffs`（跟基准比改了哪几项）和 `variant`：
 * 一点没改 = 「重复」，改一项 = 「改：溶剂」这种，改多项 = 「改 N 项」。
 * 书签、悬停预览、中栏卡片堆都靠这两个字段说明「它跟别人差在哪」。
 */
function groupMembers(groupId) {
  const rows = db.prepare('SELECT * FROM experiments WHERE group_id = ? ORDER BY id').all(groupId);
  if (!rows.length) return [];
  const reagentsOf = (expId) =>
    db.prepare('SELECT role, name, eq, mmol FROM reagents WHERE exp_id = ? ORDER BY position, id').all(expId);
  const base = rows[0];
  const baseReagents = reagentsOf(base.id);
  return rows.map((m) => {
    const reagents = m.id === base.id ? baseReagents : reagentsOf(m.id);
    const diffs = m.id === base.id ? [] : groupDiff({ ...base, reagents: baseReagents }, { ...m, reagents });
    const variant = m.id === base.id ? '基准' : diffs.length === 0 ? '重复' : diffs.length === 1 ? `改：${diffs[0]}` : `改 ${diffs.length} 项`;
    // 规模不算「控制变量」：条件一样、只是放大 / 缩小，仍然是重复实验。单独记一句提示
    const scaleNote =
      String(base.base_mmol ?? '') !== String(m.base_mmol ?? '') && m.base_mmol != null
        ? `${base.base_mmol ?? '—'} → ${m.base_mmol} mmol`
        : '';
    return {
      id: m.id,
      code: m.code,
      title: m.title,
      date: m.date,
      status: m.status,
      yield_pct: m.yield_pct,
      solvent: m.solvent,
      concentration: m.concentration,
      temperature: m.temperature,
      duration: m.duration,
      atmosphere: m.atmosphere,
      base_mmol: m.base_mmol,
      // 悬停卡要显示的内容都带上，前端按「显示哪些」的偏好挑着画
      product_name: m.product_name,
      product_mass: m.product_mass,
      product_mw: m.product_mw,
      ee_pct: m.ee_pct,
      dr_ee: m.dr_ee,
      sel_method: m.sel_method,
      sel_condition: m.sel_condition,
      conclusion: m.conclusion,
      notes: m.notes,
      substrates: reagents
        .filter((r) => r.role === '底物' && r.name)
        .map((r) => r.name)
        .join(' + '),
      diffs,
      variant,
      scaleNote,
      solvent_ml: solventMlOf(m),
    };
  });
}

function getExperiment(id) {
  const exp = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
  if (!exp) return null;
  exp.steps = parseSteps(exp.steps_json);
  exp.reagents = db.prepare('SELECT * FROM reagents WHERE exp_id = ? ORDER BY position, id').all(id);
  exp.attachments = db
    .prepare('SELECT * FROM attachments WHERE exp_id = ? ORDER BY category, id')
    .all(id);
  exp.screenings = db
    .prepare('SELECT * FROM screenings WHERE exp_id = ? ORDER BY id')
    .all(id)
    .map(parseScreening);
  // 平行组（重复 / 控制变量）：同一条记录旁边那几个「书签」，顺带算出每条相对基准差在哪
  exp.siblings = exp.group_id ? groupMembers(exp.group_id) : [];
  return exp;
}

function parseScreening(row) {
  if (!row) return null;
  let vars = [];
  let entries = [];
  try {
    vars = JSON.parse(row.vars_json || '[]');
  } catch {
    vars = [];
  }
  try {
    entries = JSON.parse(row.entries_json || '[]');
  } catch {
    entries = [];
  }
  return { ...row, vars, entries };
}

const SEARCH_FIELDS = [
  'e.code', 'e.title', 'e.project', 'e.rxn_type', 'e.objective', 'e.literature',
  'e.procedure', 'e.workup', 'e.characterization', 'e.notes', 'e.conclusion',
  'e.product_name', 'e.solvent', 'e.dr_ee',
];

function listExperiments(query) {
  const where = [];
  const params = [];

  if (query.q && String(query.q).trim()) {
    const like = `%${String(query.q).trim()}%`;
    const ors = SEARCH_FIELDS.map((f) => `${f} LIKE ?`);
    const orParams = SEARCH_FIELDS.map(() => like);
    ors.push('EXISTS (SELECT 1 FROM reagents r WHERE r.exp_id = e.id AND r.name LIKE ?)');
    orParams.push(like);
    where.push(`(${ors.join(' OR ')})`);
    params.push(...orParams);
  }
  if (query.project) {
    where.push('e.project = ?');
    params.push(String(query.project));
  }
  if (query.rxn_type) {
    where.push('e.rxn_type = ?');
    params.push(String(query.rxn_type));
  }
  if (query.status) {
    where.push('e.status = ?');
    params.push(String(query.status));
  }
  if (query.category === 'none') where.push('e.category_id IS NULL');
  else if (query.category) {
    where.push('e.category_id = ?');
    params.push(Number(query.category));
  }
  if (query.from) {
    where.push('e.date >= ?');
    params.push(String(query.from));
  }
  if (query.to) {
    where.push('e.date <= ?');
    params.push(String(query.to));
  }

  const sortMap = {
    newest: 'COALESCE(e.sort_index, 0), e.id DESC',
    oldest: 'e.date ASC, e.id ASC',
    yield: 'e.yield_pct DESC NULLS LAST, e.id DESC',
    updated: 'e.updated_at DESC',
  };
  const order = sortMap[query.sort] || sortMap.newest;

  const sql = `
    SELECT e.id, e.code, e.title, e.objective, e.date, e.status, e.project, e.rxn_type,
           e.yield_pct, e.dr_ee, e.ee_pct, e.updated_at, e.locked, e.category_id,
           e.product_name, e.product_mass, e.product_mw, e.base_mmol,
           e.solvent, e.concentration, e.temperature, e.duration, e.atmosphere,
           (SELECT name FROM categories c WHERE c.id = e.category_id) AS category_name,
           (SELECT COUNT(*) FROM attachments a WHERE a.exp_id = e.id) AS attach_count,
           (SELECT COUNT(*) FROM reagents r WHERE r.exp_id = e.id) AS reagent_count,
           -- 底物拓展表要的东西：底物名（投料表里 role=底物 那几行）和产物结构图
           (SELECT group_concat(r.name, ' + ') FROM reagents r
             WHERE r.exp_id = e.id AND r.role = '底物' AND trim(r.name) <> '') AS substrates,
           (SELECT f.id FROM compound_files f
             WHERE f.compound_id = e.product_compound_id AND f.category = 'structure'
             ORDER BY f.id LIMIT 1) AS product_structure_id,
           -- 平行组：中栏列表要把同组的几条叠成一张卡片；
           -- reagent_sig 是「角色:名字:当量:浓度:用量」串起来的签名，列表靠它判断这条是不是真重复。
           -- 浓度 / 用量也要进签名：溶剂只差体积（2 mL → 3 mL）、或者浓溶液改了 M 数，
           -- 光比当量是看不出来的（踩过：两条记录差在 dioxane 的量，列表却写「重复」）
           e.group_id, e.kind,
           (SELECT kind FROM exp_groups eg WHERE eg.id = e.group_id) AS group_kind,
           (SELECT title FROM exp_groups eg WHERE eg.id = e.group_id) AS group_title,
           (SELECT COUNT(*) FROM experiments g WHERE g.group_id = e.group_id AND e.group_id <> '') AS group_size,
           (SELECT group_concat(x.sig, '|') FROM (
              SELECT r.role || ':' || r.name || ':' || IFNULL(r.eq, '') || ':' || IFNULL(r.conc, '') || ':' || IFNULL(r.volume_ul, '') AS sig
                FROM reagents r WHERE r.exp_id = e.id ORDER BY r.position, r.id) x) AS reagent_sig,
           -- 卡片墙上的缩略图：优先反应式，其次顺手挑一张图片附件
           (SELECT a.id FROM attachments a
             WHERE a.exp_id = e.id
               AND (a.mime LIKE 'image/%'
                    OR lower(a.original_name) LIKE '%.png' OR lower(a.original_name) LIKE '%.jpg'
                    OR lower(a.original_name) LIKE '%.jpeg' OR lower(a.original_name) LIKE '%.webp'
                    OR lower(a.original_name) LIKE '%.gif' OR lower(a.original_name) LIKE '%.svg')
             ORDER BY (a.category = 'scheme') DESC, a.id
             LIMIT 1) AS preview_id
    FROM experiments e
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order}
    LIMIT 400`;

  const items = db.prepare(sql).all(...params);
  // 列表有硬上限（400），超了要让人知道「看不见」而不是悄悄截断
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM experiments e ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
    .get(...params).n;

  // 没传反应式的记录：缩略图退回到「产物 / 主要底物」的结构式。
  // （SQLite 的子查询 ORDER BY 里引用不到外层表的列，所以这一步单独查再贴回去）
  if (items.length) {
    const ids = items.map((it) => it.id);
    const picks = db
      .prepare(
        `SELECT r.exp_id,
                (SELECT f.id FROM compound_files f
                  WHERE f.compound_id = r.compound_id AND f.category = 'structure'
                  ORDER BY f.id LIMIT 1) AS file_id
           FROM reagents r JOIN experiments e ON e.id = r.exp_id
          WHERE r.compound_id IS NOT NULL
            AND r.exp_id IN (${ids.map(() => '?').join(',')})
          ORDER BY (r.compound_id = e.product_compound_id) DESC, COALESCE(r.eq, 0) DESC, r.position`
      )
      .all(...ids);
    const firstFile = new Map();
    for (const p of picks) {
      if (p.file_id && !firstFile.get(p.exp_id)) firstFile.set(p.exp_id, p.file_id);
    }
    for (const it of items) it.preview_cmp_file = firstFile.get(it.id) || null;
  }

  // total 是「符合筛选条件的总数」，items 可能被 LIMIT 400 截断
  return { items, total };
}

/**
 * 课题清单：库里有记录的去重课题 + 手动建过但还没写记录的（settings.projects_json）。
 * 两者合并，没记录的也算「存在」，否则新建完空课题切过去就找不到它了。
 * project 和 name 两个键都给：v1 只认 project，v2 用 name。
 */
function knownProjectNames() {
  try {
    const v = JSON.parse(getSetting('projects_json') || '[]');
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 每个课题（'' = 共用课题）里还没归分类的记录数。
 * 设置页的树要给「未分类」单独占一行——它是固定桶，不是真的分类，不能改名不能删。
 */
function uncategorizedCounts() {
  const map = new Map();
  const slot = (p) => {
    const k = p || '';
    if (!map.has(k)) map.set(k, { exp: 0, cmp: 0 });
    return map.get(k);
  };
  for (const r of db
    .prepare('SELECT project, COUNT(*) AS n FROM experiments WHERE category_id IS NULL GROUP BY project')
    .all()) {
    slot(r.project).exp = r.n;
  }
  for (const r of db
    .prepare('SELECT project, COUNT(*) AS n FROM compounds WHERE category_id IS NULL GROUP BY project')
    .all()) {
    slot(r.project).cmp = r.n;
  }
  return map;
}

function listProjects() {
  const rows = db
    .prepare(
      "SELECT project, COUNT(*) AS n FROM experiments WHERE project <> '' GROUP BY project ORDER BY n DESC, project"
    )
    .all();
  const seen = new Map(rows.map((r) => [r.project, r.n]));
  for (const name of knownProjectNames()) if (!seen.has(name)) seen.set(name, 0);
  const cmpRows = db
    .prepare("SELECT project, COUNT(*) AS n FROM compounds WHERE project <> '' GROUP BY project")
    .all();
  const cmpCount = new Map(cmpRows.map((r) => [r.project, r.n]));
  const uncat = uncategorizedCounts();
  return [...seen.entries()].map(([name, n]) => ({
    project: name, // 兼容 v1
    name,
    n,
    cmp: cmpCount.get(name) || 0,
    uncat_exp: uncat.get(name)?.exp || 0,
    uncat_cmp: uncat.get(name)?.cmp || 0,
    prefix: getSetting(`prefix:${name}`) || '',
    auto_prefix: derivedPrefix(name),   // 没手设前缀时实际会用的那个
  }));
}

/**
 * 课题名 → 自动前缀：ASCII 取字母数字（最多 3 位、大写），
 * 中文名取前两个字（「某课题」→「氨基」）。撞了后面加 2、3…
 */
function derivedPrefix(name) {
  const s = str(name).trim();
  if (!s) return 'EXP';
  const ascii = s.replace(/[^A-Za-z0-9]/g, '');
  const base = ascii ? ascii.toUpperCase().slice(0, 3) : [...s].slice(0, 2).join('');
  return base || 'EXP';
}

/**
 * 这个课题实际用的编号前缀：手设的（设置页的「编号前缀」）优先，
 * 没设就按课题名自动生成一个，并保证跟别的课题不重（重了就加 2/3…）。
 * **编号是按课题分开数的**（见 db.js 的 nextCode），所以每个课题都从 xxxx-0001 起。
 */
function projectPrefix(project) {
  const name = str(project).trim();
  const own = str(getSetting(`prefix:${name}`));
  if (own) return own;
  if (!name) return 'EXP';                     // 共用课题沿用 EXP
  const base = derivedPrefix(name);
  const used = new Set();
  for (const p of listProjects()) {
    if (p.name === name) continue;
    used.add((str(getSetting(`prefix:${p.name}`)) || derivedPrefix(p.name)).toUpperCase());
  }
  let cand = base;
  for (let i = 2; used.has(cand.toUpperCase()); i += 1) cand = `${base}${i}`;
  return cand;
}

/** 每个课题能覆盖的记录本信息：留空的项跟着全局走 */
const PROJECT_SETTING_KEYS = ['owner_name', 'group_name', 'label_base_url'];

/** 这个课题自己设了哪些（没设的空着不返回） */
function projectOverrides(project) {
  const out = {};
  if (!project) return out;
  for (const key of PROJECT_SETTING_KEYS) {
    const v = getSetting(`proj:${project}:${key}`);
    if (v) out[key] = v;
  }
  const prefix = getSetting(`prefix:${project}`);
  if (prefix) out.code_prefix = prefix;
  return out;
}

/** 全局设置 + 课题覆盖 = 这个课题实际用的设置；标题直接用课题名 */
function settingsFor(project) {
  const out = { ...allSettings(), ...projectOverrides(project) };
  if (project) out.lab_heading = project;
  return out;
}

/** query.project 有值就只统计这个课题；没值就是全本 */
function bootstrap(query = {}) {
  const project = String(query.project || '').trim();
  const settings = settingsFor(project);
  const onProject = project ? 'AND project = ?' : '';
  const onExp = project ? 'AND e.project = ?' : '';
  const pjArgs = project ? [project] : [];

  const projects = listProjects();
  const rxnTypes = db
    .prepare("SELECT rxn_type, COUNT(*) AS n FROM experiments WHERE rxn_type <> '' GROUP BY rxn_type ORDER BY n DESC")
    .all();
  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM experiments WHERE 1 = 1 ${onProject}) AS experiments,
              (SELECT COUNT(*) FROM attachments a JOIN experiments e ON e.id = a.exp_id WHERE 1 = 1 ${onExp}) AS attachments,
              (SELECT COUNT(*) FROM screenings s JOIN experiments e ON e.id = s.exp_id WHERE 1 = 1 ${onExp}) AS screenings`
    )
    .get(...pjArgs, ...pjArgs, ...pjArgs);
  // 侧栏那一项的计数现在是「平行组有几摞」，不是老手填筛选表的条数
  const groupTables = listGroupTables(project);
  const groupCount = groupTables.items.length + groupTables.auto.length;
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = db
    .prepare(`SELECT COUNT(*) AS n FROM experiments WHERE date LIKE ? ${onProject}`)
    .get(`${month}%`, ...pjArgs).n;
  // 产率统计：只算 0–100% 之内的（填错的 8321% 那种会把「平均」拉到离谱），
  // 平均之外再给一个中位数，异常条数单独报出来让用户自己去修数据。
  const yieldRows = db
    .prepare(`SELECT yield_pct FROM experiments WHERE yield_pct IS NOT NULL ${onProject}`)
    .all(...pjArgs)
    .map((r) => Number(r.yield_pct))
    .filter((v) => Number.isFinite(v));
  const goodYields = yieldRows.filter((v) => v >= 0 && v <= 100);
  const sortedYields = [...goodYields].sort((a, b) => a - b);
  const medianYield = sortedYields.length
    ? sortedYields.length % 2
      ? sortedYields[(sortedYields.length - 1) / 2]
      : (sortedYields[sortedYields.length / 2 - 1] + sortedYields[sortedYields.length / 2]) / 2
    : null;
  const withYield = {
    avg_yield: goodYields.length ? goodYields.reduce((a, b) => a + b, 0) / goodYields.length : null,
    n: goodYields.length,
  };
  const recent = db
    .prepare(`SELECT id, code, title, date, status, project FROM experiments WHERE 1 = 1 ${onProject} ORDER BY id DESC LIMIT 6`)
    .all(...pjArgs);
  const statusBreakdown = db
    .prepare(`SELECT status, COUNT(*) AS n FROM experiments WHERE 1 = 1 ${onProject} GROUP BY status ORDER BY n DESC`)
    .all(...pjArgs);

  // 自己记录本里用过的试剂 → 下次打名字就把 MW / 浓度带出来
  const seen = new Map();
  // 带上「组分」角色：下次打这个名字，除了 MW / 浓度，连它该当底物还是催化剂一起带出来
  for (const r of db
    .prepare("SELECT name, role, mw, conc, density FROM reagents WHERE name <> '' AND trim(role) <> '底物' ORDER BY id DESC")
    .all()) {
    const k = r.name.trim().toLowerCase();
    if (!k) continue;
    const prev = seen.get(k);
    if (!prev) {
      seen.set(k, { name: r.name.trim(), role: str(r.role), mw: r.mw, conc: r.conc, density: r.density });
      continue;
    }
    // 同名的老条目：只补它还空着的角色 / 数值，别把最新的这条盖掉
    if (!prev.role && str(r.role)) prev.role = str(r.role);
  }
  // 试剂库里核对过的 MW / 密度也带上：记录删了、或者那一行当时没填 MW，下次打这个名字也能自动带出来
  for (const l of db
    .prepare("SELECT key, name, role, mw, conc, density FROM reagent_lib WHERE trim(role) <> '底物'")
    .all()) {
    const prev = seen.get(l.key);
    if (!prev) {
      if (l.mw != null || l.density != null || l.conc != null) {
        seen.set(l.key, { name: l.name, role: str(l.role), mw: l.mw, conc: l.conc, density: l.density });
      }
      continue;
    }
    // 记录里存的是「一位小数」那种粗值（比如 P(Cy)3 的 280.4）时，用库里更细的换掉
    const coarseMw = (v) => v != null && Math.round(Number(v) * 100) % 10 === 0;
    if (prev.mw == null || (l.mw != null && coarseMw(prev.mw))) prev.mw = l.mw;
    if (prev.conc == null) prev.conc = l.conc;
    if (prev.density == null) prev.density = l.density;
    if (!prev.role) prev.role = str(l.role);
  }
  const reagentDict = [...seen.values()].slice(0, 600);

  // 化合物跟分类一样严格按课题走；「全部课题」不筛
  const cmpWhere = project ? 'c.project = ?' : '1 = 1';
  const cmpArgs = project ? [project] : [];

  const compoundDict = db
    .prepare(
      `SELECT c.id, c.code, c.name, c.mw, c.kind, c.formula,
              (SELECT f.id FROM compound_files f
                WHERE f.compound_id = c.id AND f.category = 'structure'
                ORDER BY f.id LIMIT 1) AS structure_id
         FROM compounds c
        WHERE (c.code <> '' OR c.name <> '') AND ${cmpWhere}
        ORDER BY c.code COLLATE NOCASE, c.id LIMIT 800`
    )
    .all(...cmpArgs);
  const compoundCount = db.prepare(`SELECT COUNT(*) AS n FROM compounds c WHERE ${cmpWhere}`).get(...cmpArgs).n;
  // 「共用课题」= project = ''：设置页那个组头要跟别的课题组一样显示条数/个数
  const sharedUncat = uncategorizedCounts().get('') || { exp: 0, cmp: 0 };
  const sharedCounts = {
    exp: db.prepare("SELECT COUNT(*) AS n FROM experiments WHERE project = ''").get().n,
    cmp: db.prepare("SELECT COUNT(*) AS n FROM compounds WHERE project = ''").get().n,
    uncatExp: sharedUncat.exp,
    uncatCmp: sharedUncat.cmp,
  };

  return {
    settings,
    // 全局那套（设置页在课题里编辑时，拿它当占位符）
    settingsGlobal: allSettings(),
    projectOverrides: projectOverrides(project),
    projects,
    currentProject: project,
    rxnTypes,
    totals: { ...totals, groups: groupCount },
    thisMonth,
    avgYield: withYield.avg_yield,
    yieldCount: withYield.n,
    yieldMedian: medianYield,
    yieldSuspect: yieldRows.length - goodYields.length,
    recent,
    statusBreakdown,
    categories: CELL_CATEGORY,
    recordCategories: listCategories('', project),
    trashCount: db.prepare('SELECT COUNT(*) AS n FROM trash').get().n,
    reagentDict,
    reagentCount: (() => {
      try { return db.prepare("SELECT COUNT(*) AS n FROM reagent_lib WHERE trim(role) <> '底物'").get().n || 0; } catch { return 0; }
    })(),
    compoundDict,
    compoundCount,
    compoundUnassigned: sharedCounts.cmp,
    sharedCounts,
    lanUrl: lanUrl(),
    lanAccess: HOST !== '127.0.0.1' && HOST !== 'localhost',
    syncLastAt: getSetting('sync_last_at') || '',
    canSync: fs.existsSync(path.join(__dirname, '..', 'scripts', 'sync-server.sh')),
    dataDir: DATA_DIR,
  };
}

/* ----------------------------------------------------------- attachments */

async function attachUpload(req, res, expId) {
  const exp = db.prepare('SELECT id, locked FROM experiments WHERE id = ?').get(expId);
  if (!exp) return fail(res, 404, '实验不存在');
  if (exp.locked) return fail(res, 423, '实验已锁定，先在页面里解锁');

  const r2 = new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] || '' },
    body: Readable.toWeb(req),
    duplex: 'half',
  });

  let form;
  try {
    form = await r2.formData();
  } catch {
    return fail(res, 400, '上传解析失败');
  }

  const category = str(form.get('category')) || 'other';
  const note = str(form.get('note'));
  const files = [];
  for (const value of form.getAll('file')) {
    if (value && typeof value === 'object' && typeof value.arrayBuffer === 'function') files.push(value);
  }
  if (!files.length) return fail(res, 400, '没有收到文件');

  const expDir = path.join(ATTACH_DIR, String(expId));
  await fsp.mkdir(expDir, { recursive: true });

  const created = [];
  for (const file of files) {
    const original = safeName(file.name || 'file');
    const idRow = db
      .prepare(
        `INSERT INTO attachments(exp_id, category, filename, original_name, size, mime, is_dir, note, created_at)
         VALUES (?,?,?,?,?,?,0,?,?)`
      )
      .run(expId, category, original, original, file.size || 0, file.type || '', note, nowISO());
    const attId = Number(idRow.lastInsertRowid);
    const target = uniquePath(expDir, `${attId}__${original}`);
    const buf = Buffer.from(await file.arrayBuffer());
    await fsp.writeFile(target, buf);
    const stored = path.basename(target);
    db.prepare('UPDATE attachments SET filename = ?, size = ? WHERE id = ?').run(stored, buf.length, attId);
    created.push(db.prepare('SELECT * FROM attachments WHERE id = ?').get(attId));
  }
  db.prepare('UPDATE experiments SET updated_at = ? WHERE id = ?').run(nowISO(), expId);
  logEvent('experiment', expId, 'attach', { detail: `上传 ${created.length} 个文件` });
  ok(res, { attachments: created });
}

async function attachFromPath(res, expId, body) {
  const exp = db.prepare('SELECT id, locked FROM experiments WHERE id = ?').get(expId);
  if (!exp) return fail(res, 404, '实验不存在');
  if (exp.locked) return fail(res, 423, '实验已锁定');

  const src = str(body.path).trim();
  if (!src) return fail(res, 400, '请填写路径');
  const abs = path.resolve(src.replace(/^~(?=\/|$)/, require('node:os').homedir()));
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return fail(res, 400, `路径不存在：${abs}`);
  }

  const category = str(body.category) || 'nmr_raw';
  const note = str(body.note);
  const expDir = path.join(ATTACH_DIR, String(expId));
  await fsp.mkdir(expDir, { recursive: true });

  const original = safeName(path.basename(abs));
  const isDir = st.isDirectory() ? 1 : 0;
  const idRow = db
    .prepare(
      `INSERT INTO attachments(exp_id, category, filename, original_name, size, mime, is_dir, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(expId, category, original, original, 0, '', isDir, note, nowISO());
  const attId = Number(idRow.lastInsertRowid);
  const target = uniquePath(expDir, `${attId}__${original}`);

  try {
    if (isDir) {
      await fsp.cp(abs, target, { recursive: true });
    } else {
      await fsp.copyFile(abs, target);
    }
  } catch (err) {
    db.prepare('DELETE FROM attachments WHERE id = ?').run(attId);
    return fail(res, 400, `复制失败：${err.message}`);
  }

  const size = isDir ? dirSizeSync(target) : (await fsp.stat(target)).size;
  db.prepare('UPDATE attachments SET filename = ?, size = ? WHERE id = ?').run(path.basename(target), size, attId);
  db.prepare('UPDATE experiments SET updated_at = ? WHERE id = ?').run(nowISO(), expId);
  logEvent('experiment', expId, 'attach', { detail: `${isDir ? '导入文件夹' : '导入文件'}：${abs}` });
  ok(res, { attachment: db.prepare('SELECT * FROM attachments WHERE id = ?').get(attId) });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
  '.dx': 'application/octet-stream',
  '.jdx': 'chemical/x-jcamp-dx',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function attachmentPath(att) {
  return path.join(ATTACH_DIR, String(att.exp_id), att.filename);
}

async function serveAttachment(req, res, attId, url) {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attId);
  if (!att) return fail(res, 404, '附件不存在');
  return streamStored(res, url, attachmentPath(att), att);
}

async function streamStored(res, url, target, att) {
  if (att.is_dir) {
    try {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      return json(res, 200, {
        is_dir: true,
        files: entries.slice(0, 400).map((d) => ({ name: d.name, dir: d.isDirectory() })),
      });
    } catch {
      return fail(res, 404, '文件已丢失');
    }
  }
  let st;
  try {
    st = await fsp.stat(target);
  } catch {
    return fail(res, 404, '文件已丢失');
  }
  const ext = path.extname(att.filename).toLowerCase();
  const mime = att.mime || MIME[ext] || 'application/octet-stream';
  const download = url.searchParams.get('download') === '1';
  res.writeHead(200, {
    'content-type': mime,
    'content-length': st.size,
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(att.original_name || att.filename)}`,
    'cache-control': 'private, max-age=60',
  });
  pipeFile(res, target);
}

/**
 * 发文件（附件 / 静态资源）。盘的读流不加 error 兜底的话，
 * 外置盘掉线或文件在 stat 之后被删，未捕获的 'error' 会把整个服务进程带走。
 */
function pipeFile(res, file) {
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end();
  });
  stream.pipe(res);
}


/* ------------------------------------------------------------ 化合物库 */

const COMPOUND_COLUMNS = [
  'code', 'name', 'kind', 'formula', 'mw', 'cas', 'appearance', 'mp', 'smiles', 'mol',
  'nmr_h1', 'nmr_c13', 'nmr_other', 'hrms', 'ir', 'rotation', 'tlc_solvent', 'tlc_rf', 'procedure', 'notes',
  'standard_exp_id', 'category_id', 'project',
];

function normalizeCompound(input) {
  const out = {};
  for (const key of COMPOUND_COLUMNS) {
    if (!(key in input)) continue;
    out[key] = key === 'mw' || key === 'standard_exp_id' ? numOrNull(input[key]) : str(input[key]);
  }
  if ('category_id' in out) {
    out.category_id = liveCategoryId(
      input.category_id,
      'compound',
      'project' in input ? str(input.project) : undefined
    );
  }
  return out;
}

/** 化合物编号查重：论文 / SI 里 2a、2b 撞号是致命的。空编号不算（老库允许留白）。 */
function compoundCodeOwner(code, exceptId = 0) {
  const c = str(code).trim();
  if (!c) return null;
  return (
    db.prepare('SELECT id, code, name FROM compounds WHERE code = ? AND id <> ?').get(c, Number(exceptId) || 0) || null
  );
}

/** 新建化合物没填编号时：给一个库里没用过的纯数字号（老库就是 12 这种写法） */
function nextCompoundCode() {
  let max = 0;
  for (const r of db.prepare("SELECT code FROM compounds WHERE code GLOB '[0-9]*'").all()) {
    const n = Number(r.code);
    if (Number.isInteger(n) && n > max) max = n;
  }
  let n = max + 1;
  while (db.prepare('SELECT 1 AS x FROM compounds WHERE code = ?').get(String(n))) n += 1;
  return String(n);
}

/** 从实验产物建化合物时用：撞号就往后面加 -2 / -3，别让 UNIQUE 把它卡死 */
function uniqueCompoundCode(base) {
  const b = str(base).trim() || nextCompoundCode();
  if (!compoundCodeOwner(b)) return b;
  let n = 2;
  while (compoundCodeOwner(`${b}-${n}`)) n += 1;
  return `${b}-${n}`;
}

/** 这个化合物在哪些实验里出现过（投料 / 产物） */
function compoundUsage(compoundId) {
  const asReagent = db
    .prepare(
      `SELECT DISTINCT e.id, e.code, e.title, e.date, e.status
         FROM experiments e JOIN reagents r ON r.exp_id = e.id
        WHERE r.compound_id = ? ORDER BY e.date DESC, e.id DESC`
    )
    .all(compoundId);
  const asProduct = db
    .prepare(
      `SELECT e.id, e.code, e.title, e.date, e.status
         FROM experiments e WHERE e.product_compound_id = ? ORDER BY e.date DESC, e.id DESC`
    )
    .all(compoundId);
  const map = new Map();
  for (const e of asReagent) map.set(e.id, { ...e, roles: ['投料'] });
  for (const e of asProduct) {
    if (!map.has(e.id)) map.set(e.id, { ...e, roles: [] });
    map.get(e.id).roles.push('产物');
  }
  return [...map.values()];
}

function getCompound(id) {
  const c = db.prepare('SELECT * FROM compounds WHERE id = ?').get(id);
  if (!c) return null;
  c.files = db.prepare('SELECT * FROM compound_files WHERE compound_id = ? ORDER BY id').all(id);
  c.usedIn = compoundUsage(id);
  c.standardExp = c.standard_exp_id
    ? db
        .prepare('SELECT id, code, title, date, status FROM experiments WHERE id = ?')
        .get(c.standard_exp_id) || null
    : null;
  return c;
}

/**
 * 「共用」现在不是一个开关，而是 project = '' 这个课题本身（界面里叫「共用课题」）。
 * 传了 project 就严格只看这个课题；没传（=「全部课题」）就不筛。
 */

function listCompounds(query) {
  const where = [];
  const params = [];
  // 严格按课题：没归课题的化合物属于「共用课题」，只在「全部课题」里出现
  if (query.project) {
    where.push('c.project = ?');
    params.push(String(query.project));
  }
  const q = str(query.q).trim();
  if (q) {
    const like = `%${q}%`;
    where.push('(c.code LIKE ? OR c.name LIKE ? OR c.formula LIKE ? OR c.notes LIKE ? OR c.nmr_h1 LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (query.kind) {
    where.push('c.kind = ?');
    params.push(str(query.kind));
  }
  if (query.category === 'none') where.push('c.category_id IS NULL');
  else if (query.category) {
    where.push('c.category_id = ?');
    params.push(Number(query.category));
  }
  const sql = `
    SELECT c.id, c.code, c.name, c.kind, c.formula, c.mw, c.tlc_rf, c.appearance, c.updated_at,
           c.standard_exp_id, c.category_id,
           -- smiles 一起回去：反应式 ↔ 投料表互认（按结构对化合物）要靠它，详情页那一路是另一条查询
           c.smiles,
           (SELECT name FROM categories g WHERE g.id = c.category_id) AS category_name,
           (SELECT code FROM experiments WHERE id = c.standard_exp_id) AS standard_code,
           (SELECT COUNT(*) FROM compound_files f WHERE f.compound_id = c.id) AS file_count,
           (SELECT f.id FROM compound_files f
             WHERE f.compound_id = c.id AND f.category = 'structure'
             ORDER BY f.id LIMIT 1) AS structure_id,
           (SELECT COUNT(*) FROM reagents r WHERE r.compound_id = c.id)
             + (SELECT COUNT(*) FROM experiments e WHERE e.product_compound_id = c.id) AS used_count
      FROM compounds c
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY COALESCE(c.sort_index, 0), c.code COLLATE NOCASE, c.id
     LIMIT 500`;
  const items = db.prepare(sql).all(...params);
  // 同实验列表：总数单独算，前端要提示「只显示前 500 个」
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM compounds c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
    .get(...params).n;
  return { items, total };
}

function compoundFilePath(f) {
  return path.join(COMPOUND_DIR, String(f.compound_id), f.filename);
}

async function readForm(req) {
  const r2 = new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] || '' },
    body: Readable.toWeb(req),
    duplex: 'half',
  });
  return r2.formData();
}

async function compoundUpload(req, res, compoundId) {
  if (!db.prepare('SELECT 1 AS x FROM compounds WHERE id = ?').get(compoundId)) {
    return fail(res, 404, '化合物不存在');
  }
  let form;
  try {
    form = await readForm(req);
  } catch {
    return fail(res, 400, '上传解析失败');
  }
  const category = str(form.get('category')) || 'other';
  const note = str(form.get('note'));
  const files = [];
  for (const value of form.getAll('file')) {
    if (value && typeof value === 'object' && typeof value.arrayBuffer === 'function') files.push(value);
  }
  if (!files.length) return fail(res, 400, '没有收到文件');

  const dir = path.join(COMPOUND_DIR, String(compoundId));
  await fsp.mkdir(dir, { recursive: true });
  const created = [];
  for (const file of files) {
    const original = safeName(file.name || 'file');
    const row = db
      .prepare(
        `INSERT INTO compound_files(compound_id, category, filename, original_name, size, mime, is_dir, note, created_at)
         VALUES (?,?,?,?,?,?,0,?,?)`
      )
      .run(compoundId, category, original, original, file.size || 0, file.type || '', note, nowISO());
    const id = Number(row.lastInsertRowid);
    const target = uniquePath(dir, `${id}__${original}`);
    const buf = Buffer.from(await file.arrayBuffer());
    await fsp.writeFile(target, buf);
    db.prepare('UPDATE compound_files SET filename = ?, size = ? WHERE id = ?').run(
      path.basename(target), buf.length, id
    );
    created.push(db.prepare('SELECT * FROM compound_files WHERE id = ?').get(id));
  }
  db.prepare('UPDATE compounds SET updated_at = ? WHERE id = ?').run(nowISO(), compoundId);
  ok(res, { files: created });
}

async function compoundFromPath(res, compoundId, body) {
  if (!db.prepare('SELECT 1 AS x FROM compounds WHERE id = ?').get(compoundId)) {
    return fail(res, 404, '化合物不存在');
  }
  const src = str(body.path).trim();
  if (!src) return fail(res, 400, '请填写路径');
  const abs = path.resolve(src.replace(/^~(?=\/|$)/, os.homedir()));
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return fail(res, 400, `路径不存在：${abs}`);
  }
  const category = str(body.category) || 'nmr_raw';
  const dir = path.join(COMPOUND_DIR, String(compoundId));
  await fsp.mkdir(dir, { recursive: true });
  const original = safeName(path.basename(abs));
  const isDir = st.isDirectory() ? 1 : 0;
  const row = db
    .prepare(
      `INSERT INTO compound_files(compound_id, category, filename, original_name, size, mime, is_dir, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(compoundId, category, original, original, 0, '', isDir, str(body.note), nowISO());
  const id = Number(row.lastInsertRowid);
  const target = uniquePath(dir, `${id}__${original}`);
  try {
    if (isDir) await fsp.cp(abs, target, { recursive: true });
    else await fsp.copyFile(abs, target);
  } catch (err) {
    db.prepare('DELETE FROM compound_files WHERE id = ?').run(id);
    return fail(res, 400, `复制失败：${err.message}`);
  }
  const size = isDir ? dirSizeSync(target) : (await fsp.stat(target)).size;
  db.prepare('UPDATE compound_files SET filename = ?, size = ? WHERE id = ?').run(path.basename(target), size, id);
  db.prepare('UPDATE compounds SET updated_at = ? WHERE id = ?').run(nowISO(), compoundId);
  ok(res, { file: db.prepare('SELECT * FROM compound_files WHERE id = ?').get(id) });
}

/** 本机局域网地址：二维码标签默认指向它，手机在同一网段才扫得开 */
function lanUrl() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return `http://${ni.address}:${PORT}`;
    }
  }
  return `http://127.0.0.1:${PORT}`;
}

/**
 * 二维码里那个 base 地址，优先级：URL 参数 > 环境变量 > 设置页 > 局域网地址。
 * 环境变量是给「部署到服务器」用的——数据是从本机同步上去的（本机是主库），
 * 同步会覆盖设置页里的值，靠 ELN_LABEL_BASE_URL 才不会被冲掉。
 */
function labelBase(baseOverride, project = '') {
  const base =
    str(baseOverride) ||
    str(process.env.ELN_LABEL_BASE_URL) ||
    settingsFor(str(project)).label_base_url ||
    lanUrl();
  return base.replace(/\/+$/, '');
}

/** 实验的二维码：扫开是手机上的只读记录页 */
function experimentLabelUrl(id, baseOverride, project = '') {
  return `${labelBase(baseOverride, project)}/#/e/${id}`;
}

function compoundLabelUrl(id, baseOverride, project = '') {
  return `${labelBase(baseOverride, project)}/#/c/${id}`;
}

/** 从一条实验的产物创建化合物（可按分类把谱图/结构图一起搬过来） */
function compoundFromExperiment(expId, { copyFiles = true } = {}) {
  const exp = getExperiment(expId);
  if (!exp) return null;

  const char = str(exp.characterization);
  const lines = char.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const pick = (re) => lines.filter((l) => re.test(l)).join('\n');
  const h1 = pick(/^¹?H\s*NMR|^1H\s*NMR/i);
  const c13 = pick(/^¹³?C\s*NMR|^13C\s*NMR/i);
  const rest = lines.filter((l) => !/^¹?H\s*NMR|^1H\s*NMR|^¹³?C\s*NMR|^13C\s*NMR/i.test(l)).join('\n');

  const ts = nowISO();
  // 产物挂库时跟着那条记录的课题走
  const projectValue = str(exp.project);
  const row = db
    .prepare(
      `INSERT INTO compounds(code, name, kind, formula, mw, appearance, mp, smiles,
         nmr_h1, nmr_c13, nmr_other, tlc_solvent, tlc_rf, procedure, notes, standard_exp_id, project, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      uniqueCompoundCode(exp.code), str(exp.product_name) || `${exp.code} 产物`, '产物', '', numOrNull(exp.product_mw),
      str(exp.appearance), '', '', h1, c13, rest, str(exp.tlc_note), '', str(exp.procedure), '', exp.id, projectValue, ts, ts
    );
  const id = Number(row.lastInsertRowid);
  db.prepare('UPDATE experiments SET product_compound_id = ?, updated_at = ? WHERE id = ?').run(id, ts, expId);

  if (copyFiles) {
    const dir = path.join(COMPOUND_DIR, String(id));
    fs.mkdirSync(dir, { recursive: true });
    const wanted = new Set(['scheme', 'h1', 'c13', 'nmr_other', 'nmr_raw', 'nmr_pdf', 'tlc']);
    for (const a of exp.attachments) {
      if (!wanted.has(a.category)) continue;
      const category = a.category === 'scheme' ? 'structure' : a.category;
      const newRow = db
        .prepare(
          `INSERT INTO compound_files(compound_id, category, filename, original_name, size, mime, is_dir, note, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(id, category, a.filename, a.original_name, a.size, a.mime, a.is_dir, a.note, ts);
      const fileId = Number(newRow.lastInsertRowid);
      const target = uniquePath(dir, `${fileId}__${a.original_name || a.filename}`);
      const srcPath = attachmentPath(a);
      try {
        if (a.is_dir) fs.cpSync(srcPath, target, { recursive: true });
        else fs.copyFileSync(srcPath, target);
        db.prepare('UPDATE compound_files SET filename = ? WHERE id = ?').run(path.basename(target), fileId);
      } catch {
        db.prepare('DELETE FROM compound_files WHERE id = ?').run(fileId);
      }
    }
  }
  return getCompound(id);
}

/* -------------------------------------------------------------- routing */

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(seg.slice(1));
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$'
  );
  routes.push({ method, regex, keys, handler });
};

/* 拖动诊断：前端每拖一次发几行现场过来，落到 data/drag-debug.log（不进 git，data/ 整体备份时就带走了）。
   真实浏览器里拖不动、而合成事件测起来又「一切正常」时，靠这几行才能看出卡在哪一步。 */
route('POST', '/api/debug/drag', async (req, res) => {
  const body = await readJson(req);
  const line = `${new Date().toISOString()} ${JSON.stringify(body)}\n`;
  try {
    const file = path.join(DATA_DIR, 'drag-debug.log');
    let keep = '';
    try {
      keep = String(await fsp.readFile(file, 'utf8')).split('\n').slice(-400).join('\n');
    } catch {
      keep = '';
    }
    await fsp.writeFile(file, `${keep}${line}`, 'utf8');
  } catch {
    /* 写不进去就算了，绝不能因为诊断日志影响拖动 */
  }
  ok(res, { ok: true });
});

/* --- bootstrap & settings --- */
route('GET', '/api/bootstrap', async (req, res, params, url) =>
  ok(res, bootstrap({ project: url.searchParams.get('project') || '' }))
);

/* 课题：清单 / 新建（可带编号前缀）/ 删掉空课题 */
route('GET', '/api/projects', async (req, res) => ok(res, { items: listProjects() }));

route('POST', '/api/projects', async (req, res) => {
  const body = await readJson(req);
  const name = str(body.name).trim();
  if (!name) return fail(res, 400, '课题名不能空');
  const names = knownProjectNames();
  if (!names.includes(name)) {
    names.push(name);
    setSetting('projects_json', JSON.stringify(names));
  }
  // 前缀留空 = 用全局的 code_prefix（空值不落盘，免得留一堆空键）
  if ('prefix' in body) {
    const prefix = str(body.prefix).trim();
    if (prefix) setSetting(`prefix:${name}`, prefix);
    else db.prepare('DELETE FROM settings WHERE key = ?').run(`prefix:${name}`);
  }
  ok(res, { items: listProjects() });
});

/**
 * 课题改名：记录、化合物、课题清单、编号前缀、课题级设置一次全改掉，
 * 否则改名后记录还挂在旧名字上，等于凭空多出一个课题。
 * 返回 { ok: true } 或 { error }（由调用方转成 HTTP 错误）。
 */
function renameProject(oldName, rawNewName) {
  const newName = str(rawNewName).trim();
  if (!newName) return { error: [400, '新名字不能空'] };
  if (newName === oldName) return { ok: true, name: newName };

  const exists =
    knownProjectNames().includes(newName) ||
    !!db.prepare('SELECT 1 AS x FROM experiments WHERE project = ? LIMIT 1').get(newName);
  if (exists) return { error: [409, `已经有个课题叫「${newName}」了，换个名字`] };

  const hasOld =
    knownProjectNames().includes(oldName) ||
    !!db.prepare('SELECT 1 AS x FROM experiments WHERE project = ? LIMIT 1').get(oldName) ||
    !!db.prepare('SELECT 1 AS x FROM compounds WHERE project = ? LIMIT 1').get(oldName);
  if (!hasOld) return { error: [404, '没有这个课题'] };

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE experiments SET project = ?, updated_at = ? WHERE project = ?').run(newName, nowISO(), oldName);
    db.prepare('UPDATE compounds SET project = ? WHERE project = ?').run(newName, oldName);
    // 分类也要跟着搬：不搬的话 listCategories 按新名筛不到它们，
    // 挂在这些分类下的记录在卡片墙里会一个组都落不进（等于看不见）
    db.prepare('UPDATE categories SET project = ? WHERE project = ?').run(newName, oldName);
    setSetting(
      'projects_json',
      JSON.stringify([...new Set(knownProjectNames().map((x) => (x === oldName ? newName : x)))])
    );

    const prefix = getSetting(`prefix:${oldName}`);
    db.prepare('DELETE FROM settings WHERE key = ?').run(`prefix:${oldName}`);
    if (prefix) setSetting(`prefix:${newName}`, prefix);

    const rows = db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(`proj:${oldName}:%`);
    db.prepare('DELETE FROM settings WHERE key LIKE ?').run(`proj:${oldName}:%`);
    for (const row of rows) {
      setSetting(`proj:${newName}:${row.key.slice(`proj:${oldName}:`.length)}`, row.value);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, name: newName };
}

/* 一次性迁移：以前课题的「标题」是单独存的覆盖值，现在课题名就是标题，
   把用户已经填过的标题当成课题名搬过去（撞名就留着不动，别丢数据） */
(function migrateProjectTitles() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'proj:%:lab_heading'").all();
  for (const row of rows) {
    const m = /^proj:(.+):lab_heading$/.exec(row.key);
    if (!m) continue;
    const oldName = m[1];
    const title = String(row.value || '').trim();
    if (!title || title === oldName) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(row.key);
      continue;
    }
    const r = renameProject(oldName, title);
    if (!r.error) db.prepare('DELETE FROM settings WHERE key = ?').run(`proj:${r.name}:lab_heading`);
  }
})();

route('PUT', '/api/projects/:name', async (req, res, params) => {
  const oldName = decodeURIComponent(params.name);
  const body = await readJson(req);
  const r = renameProject(oldName, body.name);
  if (r.error) return fail(res, r.error[0], r.error[1]);
  ok(res, { items: listProjects(), name: r.name });
});

route('DELETE', '/api/projects/:name', async (req, res, params, url) => {
  const name = decodeURIComponent(params.name);
  const n = db.prepare('SELECT COUNT(*) AS n FROM experiments WHERE project = ?').get(name).n;
  const cmp = db.prepare('SELECT COUNT(*) AS n FROM compounds WHERE project = ?').get(name).n;
  const cats = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE project = ?').get(name).n;
  // 化合物和分类也要数：只数实验的话，删掉一个只有化合物/分类的课题，
  // 它们就变成「有 project 值但课题清单里没有」的孤儿，只能在「全部课题」里看到
  const withRecords = String(url.searchParams.get('withRecords') || '') === '1';
  if ((n || cmp || cats) && !withRecords) {
    const bits = [];
    if (n) bits.push(`${n} 条记录`);
    if (cmp) bits.push(`${cmp} 个化合物`);
    if (cats) bits.push(`${cats} 个分类`);
    return fail(res, 409, `还有 ${bits.join('、')}在这个课题里；要连它们一起删就再确认一次`);
  }
  let goneExp = 0;
  let goneCmp = 0;
  if (withRecords) {
    // 锁着的记录先拦下来：半删一半会让人以为「没删掉」
    const locked = db.prepare('SELECT COUNT(*) AS n FROM experiments WHERE project = ? AND locked = 1').get(name).n;
    if (locked) return fail(res, 423, `有 ${locked} 条实验被锁定，先在记录页解锁再连记录删课题`);
    // 记录 / 化合物走软删除（进回收站，文件留到「彻底删除」才真删）
    for (const r of db.prepare('SELECT id FROM experiments WHERE project = ?').all(name)) {
      if (trashExperiment(r.id)) goneExp += 1;
    }
    for (const r of db.prepare('SELECT id FROM compounds WHERE project = ?').all(name)) {
      if (trashCompound(r.id)) goneCmp += 1;
    }
    db.prepare('DELETE FROM categories WHERE project = ?').run(name);
  }
  setSetting('projects_json', JSON.stringify(knownProjectNames().filter((x) => x !== name)));
  // 课题自己的前缀和覆盖设置一起清掉，免得同名重建时又冒出来
  db.prepare('DELETE FROM settings WHERE key = ? OR key LIKE ?').run(`prefix:${name}`, `proj:${name}:%`);
  ok(res, { items: listProjects(), deleted: { experiments: goneExp, compounds: goneCmp } });
});

route('PUT', '/api/settings', async (req, res) => {
  const body = await readJson(req);
  // 带 project = 改这个课题自己的那套；不带的永远改全局
  let project = str(body.project).trim();
  let renamedTo = '';

  // 课题里「标题」就是课题名：改了标题 = 改这个课题的名字（记录一起搬）
  if (project && 'lab_heading' in body) {
    const want = str(body.lab_heading).trim();
    if (want && want !== project) {
      const r = renameProject(project, want);
      if (r.error) return fail(res, r.error[0], r.error[1]);
      renamedTo = r.name;
      project = r.name;
    }
  }

  // 手机/局域网访问是全局开关（跟课题无关）
  if ('lan_access' in body) setSetting('lan_access', body.lan_access ? '1' : '0');
  if ('auto_sync' in body) {
    setSetting('auto_sync', body.auto_sync ? '1' : '0');
    if (typeof scheduleAutoSync === 'function') scheduleAutoSync();
  }
  for (const key of ['code_prefix', 'lab_heading', 'owner_name', 'group_name', 'label_base_url']) {
    if (!(key in body)) continue;
    const value = str(body[key]);
    if (!project || (key === 'lab_heading' && project)) {
      if (key === 'lab_heading' && project) continue;
      setSetting(key, value);
      continue;
    }
    const storeKey = key === 'code_prefix' ? `prefix:${project}` : `proj:${project}:${key}`;
    if (value) setSetting(storeKey, value);
    else db.prepare('DELETE FROM settings WHERE key = ?').run(storeKey); // 清空 = 回到全局
  }
  ok(res, {
    settings: settingsFor(project),
    global: allSettings(),
    overrides: projectOverrides(project),
    project,
    renamedTo,
  });
});


/* --- 分类（自己建的文件夹；实验、化合物各一套，互不相干） --- */
const CATEGORY_SCOPES = new Set(['experiment', 'compound']);

/**
 * 分类清单。project 给了就只算「共用 + 该课题」的那些，计数也只数该课题里的记录
 * （否则在课题 A 里看到共用分类写着「12 条」，其实是整本的数，会误导）。
 */
/** 分类挂在哪个课题下（'' = 共用课题）；没给分类 / 分类不存在就是 null */
function projectOfCategory(categoryId) {
  if (categoryId === null || categoryId === undefined || categoryId === '') return null;
  const row = db.prepare('SELECT project FROM categories WHERE id = ?').get(Number(categoryId));
  return row ? row.project || '' : null;
}

function listCategories(scope, project = '') {
  // 严格按课题：传了 project 就只要这个课题下的（project = '' 是「共用课题」本身）；
  // 「全部课题」（不传）则全给，卡片墙要靠它把各课题的分类都列出来。
  const scoped = !!project;
  const where = [];
  const args = [];
  const onProject = scoped ? ' AND e.project = ?' : '';
  const onProjectC = scoped ? ' AND c.project = ?' : '';
  if (scoped) args.push(project, project);
  if (CATEGORY_SCOPES.has(scope)) {
    where.push('g.scope = ?');
    args.push(scope);
  }
  if (scoped) {
    where.push('g.project = ?');
    args.push(project);
  }
  return db
    .prepare(
      `SELECT g.id, g.name, g.scope, g.project, g.position,
              (SELECT COUNT(*) FROM experiments e WHERE e.category_id = g.id${onProject}) AS exp_count,
              (SELECT COUNT(*) FROM compounds c WHERE c.category_id = g.id${onProjectC}) AS cmp_count,
              -- 这分类里的记录现在分属哪些课题：换课题前要讲清楚会带走谁的记录
              (SELECT group_concat(DISTINCT e.project) FROM experiments e
                WHERE e.category_id = g.id AND e.project <> '') AS exp_projects
         FROM categories g
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY g.position, g.id`
    )
    .all(...args);
}

route('GET', '/api/categories', async (req, res, params, url) =>
  ok(res, {
    items: listCategories(url.searchParams.get('scope'), url.searchParams.get('project') || ''),
  })
);

route('POST', '/api/categories', async (req, res) => {
  const body = await readJson(req);
  const name = str(body.name).trim().slice(0, 40);
  const scope = CATEGORY_SCOPES.has(str(body.scope)) ? str(body.scope) : 'experiment';
  // 分类跟着当前课题走；传空 = 共用
  const project = str(body.project).trim();
  if (!name) return fail(res, 400, '分类要有个名字');
  if (
    db.prepare('SELECT 1 AS x FROM categories WHERE name = ? AND scope = ? AND project = ?').get(name, scope, project)
  ) {
    return fail(res, 409, '这边已经有同名分类了');
  }
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM categories').get().p;
  db.prepare('INSERT INTO categories(name, scope, project, position, created_at) VALUES (?,?,?,?,?)').run(
    name,
    scope,
    project,
    pos,
    nowISO()
  );
  ok(res, { items: listCategories(scope, project) });
});

route('PUT', '/api/categories/:id', async (req, res, params) => {
  const id = Number(params.id);
  if (!db.prepare('SELECT 1 AS x FROM categories WHERE id = ?').get(id)) return fail(res, 404, '分类不存在');
  const body = await readJson(req);
  const row = db.prepare('SELECT name, scope, project FROM categories WHERE id = ?').get(id);
  // 「改为实验 / 改为化合物」：分类的 scope 变了，可记录还是指这个 id，
  // 会变成「实验分类里查不到它、实验却还挂着它」——所以只有空分类才准改类型。
  if ('scope' in body && CATEGORY_SCOPES.has(str(body.scope)) && str(body.scope) !== row.scope) {
    const next = str(body.scope);
    const used =
      db.prepare('SELECT COUNT(*) AS n FROM experiments WHERE category_id = ?').get(id).n +
      db.prepare('SELECT COUNT(*) AS n FROM compounds WHERE category_id = ?').get(id).n;
    if (used) {
      return fail(res, 409, `该分类下还有 ${used} 条记录，只能改空分类的类型；请先把这些记录移到别的分类`);
    }
    if (
      db
        .prepare('SELECT 1 AS x FROM categories WHERE name = ? AND scope = ? AND project = ? AND id <> ?')
        .get(row.name, next, row.project, id)
    ) {
      return fail(res, 409, '那边已经有同名分类了');
    }
    db.prepare('UPDATE categories SET scope = ? WHERE id = ?').run(next, id);
    ok(res, { items: listCategories(next, row.project) });
    return;
  }

  // 换课题：分类搬走，里面的记录跟着搬（否则分类在 A、记录留在 B，B 里既筛不到也看不出问题）。
  // 搬到「共用」不动记录 —— 共用分类可以装任何课题的记录。
  if ('project' in body && str(body.project).trim() !== row.project) {
    const nextProject = str(body.project).trim();
    if (
      nextProject &&
      db
        .prepare('SELECT 1 AS x FROM categories WHERE name = ? AND scope = ? AND project = ? AND id <> ?')
        .get(row.name, row.scope, nextProject, id)
    ) {
      return fail(res, 409, `「${nextProject}」里已经有同名分类了`);
    }
    const exps = db.prepare('SELECT COUNT(*) AS n FROM experiments WHERE category_id = ?').get(id).n;
    const cmps = db.prepare('SELECT COUNT(*) AS n FROM compounds WHERE category_id = ?').get(id).n;
    const fromProjects = db
      .prepare("SELECT DISTINCT project FROM experiments WHERE category_id = ? AND project <> ''")
      .all(id)
      .map((r) => r.project);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE categories SET project = ? WHERE id = ?').run(nextProject, id);
      let movedExp = 0;
      let movedCmp = 0;
      if (nextProject) {
        movedExp = db.prepare('UPDATE experiments SET project = ? WHERE category_id = ?').run(nextProject, id).changes;
        movedCmp = db.prepare('UPDATE compounds SET project = ? WHERE category_id = ?').run(nextProject, id).changes;
      }
      db.exec('COMMIT');
      return ok(res, {
        items: listCategories(row.scope, nextProject),
        moved: { experiments: movedExp, compounds: movedCmp, fromProjects },
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  if ('name' in body) {
    const name = str(body.name).trim().slice(0, 40);
    if (!name) return fail(res, 400, '分类要有个名字');
    const dup = db
      .prepare('SELECT id FROM categories WHERE name = ? AND scope = ? AND project = ? AND id <> ?')
      .get(name, row.scope, row.project, id);
    if (dup) return fail(res, 409, '这边已经有同名分类了');
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
  }
  if ('position' in body) {
    db.prepare('UPDATE categories SET position = ? WHERE id = ?').run(Number(body.position) || 0, id);
  }
  ok(res, { items: listCategories(row.scope, row.project) });
});

route('DELETE', '/api/categories/:id', async (req, res, params) => {
  const id = Number(params.id);
  const gone = db.prepare('SELECT scope, project FROM categories WHERE id = ?').get(id);
  if (!gone) return fail(res, 404, '分类不存在');
  // 三次写要一起成：解绑实验、解绑化合物、删分类，中途失败不能留下半截
  db.exec('BEGIN');
  try {
    // 分类删掉，记录本身不动，只是变回「未分类」
    db.prepare('UPDATE experiments SET category_id = NULL WHERE category_id = ?').run(id);
    db.prepare('UPDATE compounds SET category_id = NULL WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  ok(res, { items: listCategories(gone.scope, gone.project) });
});

/* --- 化合物库 --- */
route('GET', '/api/compounds', async (req, res, params, url) => {
  const q = Object.fromEntries(url.searchParams.entries());
  const { items, total } = listCompounds(q);
  ok(res, { items, total });
});

route('POST', '/api/compounds', async (req, res) => {
  const body = await readJson(req);
  const data = normalizeCompound(body);
  // 没填编号就自动给一个：留空编号的化合物在库里是找不到的（老库里已有两条空编号）
  if (!str(data.code).trim()) data.code = nextCompoundCode();
  const taken = compoundCodeOwner(data.code);
  if (taken) {
    return fail(res, 409, `编号 ${str(data.code).trim()} 已经用在「${taken.name || '未命名化合物'}」上了，换一个`);
  }
  const ts = nowISO();
  // 指定了分类就以分类所在的课题为准，跟实验一个规矩
  const catProject = projectOfCategory(data.category_id);
  const values = COMPOUND_COLUMNS.map((k) => {
    if (k === 'kind') return data.kind || '底物';
    // 归到当前课题（「全部课题」下新建的落进「共用课题」，即 project = ''）
    if (k === 'project') return catProject !== null ? catProject : str(body.project).trim();
    if (k === 'mw' || k === 'category_id') return data[k] ?? null;
    return data[k] ?? '';
  });
  const row = db
    .prepare(
      `INSERT INTO compounds(${COMPOUND_COLUMNS.join(',')}, created_at, updated_at)
       VALUES (${COMPOUND_COLUMNS.map(() => '?').join(',')}, ?, ?)`
    )
    .run(...values, ts, ts);
  db.prepare('UPDATE compounds SET sort_index = ? WHERE id = ?').run(topSortIndex('compounds'), row.lastInsertRowid);
  logEvent('compound', Number(row.lastInsertRowid), 'create', { detail: data.code || data.name || '新化合物' });
  ok(res, { compound: getCompound(Number(row.lastInsertRowid)) });
});

route('POST', '/api/compounds/from-experiment', async (req, res) => {
  const body = await readJson(req);
  const expId = Number(body.exp_id);
  if (!expId) return fail(res, 400, '缺少 exp_id');
  const compound = compoundFromExperiment(expId, { copyFiles: body.copy_files !== false });
  if (!compound) return fail(res, 404, '实验不存在');
  ok(res, { compound });
});

route('GET', '/api/compounds/:id', async (req, res, params) => {
  const compound = getCompound(Number(params.id));
  if (!compound) return fail(res, 404, '化合物不存在');
  ok(res, { compound });
});

/**
 * 反应式里要「怎么画的就怎么显示」：底物 / 产物是带基团缩写（S-group / 原子别名）画的时，
 * 把库里存的那份 molfile 交给前端，让它走 Indigo 出图，Ts / Bn / Ph 这些标签就留着了。
 * 没缩写的返回空串——前端拿不到就还按 SMILES 画（那套排版更好看，别为了一致去用 molfile）。
 */
route('GET', '/api/compounds/:id/abbrev-mol', async (req, res, params) => {
  const row = db.prepare('SELECT mol FROM compounds WHERE id = ?').get(Number(params.id));
  if (!row) return fail(res, 404, '化合物不存在');
  const mol = String(row.mol || '');
  const hasAbbrev = /M {1,3}(STY|ALS|SMT)/.test(mol);
  ok(res, { mol: hasAbbrev ? mol : '' });
});

route('POST', '/api/compounds/:id/move', async (req, res, params) => {
  const id = Number(params.id);
  const row = db.prepare('SELECT id FROM compounds WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '化合物不存在');
  const body = await readJson(req);
  const categoryId = liveCategoryId(body.category_id, 'compound');
  const beforeId = numOrNull(body.before_id);
  const sib = db
    .prepare(
      `SELECT id, COALESCE(sort_index, 0) AS si FROM compounds
        WHERE id <> ? AND ${categoryId === null ? 'category_id IS NULL' : 'category_id = ?'}
        ORDER BY COALESCE(sort_index, 0), code COLLATE NOCASE, id`
    )
    .all(...(categoryId === null ? [id] : [id, categoryId]));
  let at = sib.length;
  if (beforeId !== null) {
    const j = sib.findIndex((r) => r.id === beforeId);
    if (j >= 0) at = j;
  }
  const prev = at > 0 ? sib[at - 1].si : null;
  const next = at < sib.length ? sib[at].si : null;
  const si =
    prev !== null && next !== null ? (prev + next) / 2 : prev !== null ? prev + 1 : next !== null ? next - 1 : 0;
  // 同实验：拖进别的课题的分类，化合物也跟着改课题
  if (categoryId !== null) {
    const catProject = db.prepare('SELECT project FROM categories WHERE id = ?').get(categoryId)?.project;
    if (catProject !== undefined) {
      const now = db.prepare('SELECT project FROM compounds WHERE id = ?').get(id).project || '';
      if (now !== catProject) db.prepare('UPDATE compounds SET project = ? WHERE id = ?').run(catProject, id);
    }
  }
  db.prepare('UPDATE compounds SET category_id = ?, sort_index = ?, updated_at = ? WHERE id = ?').run(
    categoryId,
    si,
    nowISO(),
    id
  );
  ok(res, { compound: getCompound(id) });
});

route('PUT', '/api/compounds/:id', async (req, res, params) => {
  const id = Number(params.id);
  if (!db.prepare('SELECT 1 AS x FROM compounds WHERE id = ?').get(id)) {
    return fail(res, 404, '化合物不存在');
  }
  const body = await readJson(req);
  const data = normalizeCompound(body);
  // 编号可以留空（新建时服务端会给号），但**不能把已有的号清掉**：
  // 清掉之后这条化合物在库里、卡片墙和二维码上就只剩「(未命名)」，找不回来（踩过）
  if ('code' in data && !str(data.code).trim()) {
    const old = db.prepare('SELECT code FROM compounds WHERE id = ?').get(id);
    if (str(old?.code).trim()) return fail(res, 400, '编号不能清空：要换号就直接改成新的编号');
  }
  if ('code' in data) {
    const taken = compoundCodeOwner(data.code, id);
    if (taken) {
      return fail(res, 409, `编号 ${str(data.code).trim()} 已经用在「${taken.name || '未命名化合物'}」上了，换一个`);
    }
  }
  const keys = Object.keys(data);
  if (!keys.length) return ok(res, { compound: getCompound(id) });
  const before = db.prepare('SELECT * FROM compounds WHERE id = ?').get(id);
  db.prepare(
    `UPDATE compounds SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
  ).run(...keys.map((k) => data[k]), nowISO(), id);
  logEdit('compound', id, changedFields(before, data, CMP_FIELD_LABELS));
  // 结构 / SMILES 变了，画过这个化合物的那些记录页反应式缓存就过期了（不然会一直显示旧结构）
  if (('mol' in data || 'smiles' in data) && (data.mol !== before.mol || data.smiles !== before.smiles)) {
    dropSchemeCacheForCompound(id);
  }
  ok(res, { compound: getCompound(id) });
});

/** 把引用这个化合物的记录的反应式缓存清掉（底物行 + 产物） */
function dropSchemeCacheForCompound(compoundId) {
  const ids = new Set();
  for (const r of db.prepare('SELECT DISTINCT exp_id FROM reagents WHERE compound_id = ?').all(compoundId)) {
    ids.add(Number(r.exp_id));
  }
  for (const r of db.prepare('SELECT id FROM experiments WHERE product_compound_id = ?').all(compoundId)) {
    ids.add(Number(r.id));
  }
  for (const x of ids) db.prepare('DELETE FROM scheme_cache WHERE exp_id = ?').run(x);
}

/** 软删除一个化合物（结构图 / 谱图文件留到「彻底删除」）。删课题（连记录）也走这一条 */
function trashCompound(id) {
  const row = db.prepare('SELECT * FROM compounds WHERE id = ?').get(id);
  if (!row) return null;
  pushToTrash('compound', id, `${row.code || '（未编号）'}${row.name ? ` · ${row.name}` : ''}`, {
    compound: row,
    files: db.prepare('SELECT * FROM compound_files WHERE compound_id = ? ORDER BY id').all(id),
    reagentRows: db.prepare('SELECT id FROM reagents WHERE compound_id = ?').all(id).map((r) => r.id),
    productRows: db.prepare('SELECT id FROM experiments WHERE product_compound_id = ?').all(id).map((r) => r.id),
  });
  db.prepare('UPDATE reagents SET compound_id = NULL WHERE compound_id = ?').run(id);
  db.prepare('UPDATE experiments SET product_compound_id = NULL WHERE product_compound_id = ?').run(id);
  db.prepare('DELETE FROM compounds WHERE id = ?').run(id); // 文件行跟外键级联删掉
  logEvent('compound', id, 'trash', { detail: `移到回收站：${row.code || '（未编号）'}` });
  return row;
}

route('DELETE', '/api/compounds/:id', async (req, res, params) => {
  const id = Number(params.id);
  const row = db.prepare('SELECT * FROM compounds WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '化合物不存在');
  trashCompound(id);
  ok(res, {});
});

route('POST', '/api/compounds/:id/files', async (req, res, params) => {
  await compoundUpload(req, res, Number(params.id));
});

route('POST', '/api/compounds/:id/files/path', async (req, res, params) => {
  const body = await readJson(req);
  await compoundFromPath(res, Number(params.id), body);
});

route('GET', '/api/experiments/:id/qr.svg', async (req, res, params, url) => {
  const id = Number(params.id);
  const e = db.prepare('SELECT id, project FROM experiments WHERE id = ?').get(id);
  if (!e) return fail(res, 404, '实验不存在');
  const target = experimentLabelUrl(id, url.searchParams.get('base'), e.project);
  const unit = Math.min(20, Math.max(2, Number(url.searchParams.get('unit')) || 6));
  let svg;
  try {
    svg = qr.toSvg(target, { unit });
  } catch (err) {
    return fail(res, 400, err.message);
  }
  res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
  res.end(svg);
});

route('GET', '/api/compounds/:id/qr.svg', async (req, res, params, url) => {
  const id = Number(params.id);
  const c = db.prepare('SELECT id, project FROM compounds WHERE id = ?').get(id);
  if (!c) return fail(res, 404, '化合物不存在');
  const target = compoundLabelUrl(id, url.searchParams.get('base'), c.project);
  const unit = Math.min(20, Math.max(2, Number(url.searchParams.get('unit')) || 6));
  let svg;
  try {
    svg = qr.toSvg(target, { unit });
  } catch (e) {
    return fail(res, 400, e.message);
  }
  res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(svg);
});

route('GET', '/api/compound-files/:id', async (req, res, params, url) => {
  const f = db.prepare('SELECT * FROM compound_files WHERE id = ?').get(Number(params.id));
  if (!f) return fail(res, 404, '文件不存在');
  return streamStored(res, url, compoundFilePath(f), f);
});

route('PUT', '/api/compound-files/:id', async (req, res, params) => {
  const f = db.prepare('SELECT * FROM compound_files WHERE id = ?').get(Number(params.id));
  if (!f) return fail(res, 404, '文件不存在');
  const body = await readJson(req);
  const sets = [];
  const values = [];
  if ('category' in body) {
    sets.push('category = ?');
    values.push(str(body.category) || 'other');
  }
  if ('note' in body) {
    sets.push('note = ?');
    values.push(str(body.note));
  }
  if (!sets.length) return fail(res, 400, '没有要改的字段');
  db.prepare(`UPDATE compound_files SET ${sets.join(', ')} WHERE id = ?`).run(...values, f.id);
  db.prepare('UPDATE compounds SET updated_at = ? WHERE id = ?').run(nowISO(), f.compound_id);
  ok(res, { file: db.prepare('SELECT * FROM compound_files WHERE id = ?').get(f.id) });
});

route('DELETE', '/api/compound-files/:id', async (req, res, params) => {
  const f = db.prepare('SELECT * FROM compound_files WHERE id = ?').get(Number(params.id));
  if (!f) return fail(res, 404, '文件不存在');
  await fsp.rm(compoundFilePath(f), { recursive: true, force: true }).catch(() => {});
  db.prepare('DELETE FROM compound_files WHERE id = ?').run(f.id);
  ok(res, {});
});

/* --- experiments --- */
route('GET', '/api/experiments', async (req, res, params, url) => {
  const q = Object.fromEntries(url.searchParams.entries());
  const { items, total } = listExperiments(q);
  annotateGroupDiff(items);
  ok(res, { items, total });
});

/**
 * 组内成员「相对基准改了什么」——卡片上就靠这一行看出差异：
 *   · 什么都没改 = 重复
 *   · 改一项     = 筛条件里的一个点
 *   · 改多项     = 如实写「改 温度＋配体」
 * 比较的是条件和投料（等量/名字），不比质量、产率这些结果字段。
 */
const DIFF_FIELDS = [
  ['temperature', '温度'],
  ['solvent', '溶剂'],
  ['duration', '时间'],
  ['atmosphere', '气氛'],
  ['addition', '加料'],
];

/** 投料表签名：role+名字 → 当量（同名同角色只算一项，方便判断「只是改了当量」） */
function reagentMap(expId) {
  const out = new Map();
  for (const r of db
    .prepare("SELECT role, name, IFNULL(eq,'') AS eq FROM reagents WHERE exp_id = ? AND trim(name) <> '' ORDER BY role, name")
    .all(expId)) {
    out.set(`${r.role}:${r.name}`, String(r.eq));
  }
  return out;
}

/** 溶剂现在就是投料表里 role=溶剂 的一行，`experiments.solvent` 是老字段：
 *  有投料行时一律以投料行为准——不然老字段和投料行各说一遍，
 *  会冒出「溶剂 空」这种假差异（记录里 THF 一直没动也会被标成改了溶剂）。 */
const mapHasSolventRow = (m) => [...m.keys()].some((k) => k.startsWith('溶剂:'));

/** 当量写成人看的那种：不到 1 的折百分数带单位（0.1 → 10 mol%），其余一位小数（1 → 1.0 eq）。
 *  跟前端 `lib/reagent.js` 的 `eqLabel()` 一套，两边的文字才对得上。 */
function eqLabel(v) {
  const t = str(v).trim();
  if (!t) return '';
  const x = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
  if (!Number.isFinite(x) || x <= 0) return '';
  if (x < 1) return `${Math.round(x * 10000) / 100} mol%`;
  return `${x.toFixed(1)} eq`;
}

/** 一条记录相对基准改了什么：条件字段 + 投料表（加减试剂 / 改当量）。返回 ['温度 -40 °C', 'LDA 1.2 eq'] */
function diffItems(baseRow, baseMap, row, map) {
  const out = [];
  const solventInTable = mapHasSolventRow(baseMap) || mapHasSolventRow(map);
  for (const [key, label] of DIFF_FIELDS) {
    if (key === 'solvent' && solventInTable) continue;
    const a = str(baseRow[key]).trim();
    const b = str(row[key]).trim();
    if (a === b) continue;
    out.push(key === 'solvent' && !b ? '无溶剂' : `${label} ${b || '空'}`);
  }
  // 基准那条的投料表要是没填（老记录只剩溶剂行），拿它比会把整张表都标成「+X」——
  // 那不是改动，跳过投料部分，只比条件字段。
  if ([...baseMap.keys()].some((k) => !k.startsWith('溶剂:'))) {
    for (const [key, eq] of map) {
      const [role, name] = key.split(':');
      if (!baseMap.has(key)) out.push(`${role} +${name}${eq ? ` ${eqLabel(eq)}` : ''}`);
      else if (String(baseMap.get(key)) !== String(eq)) out.push(`${name} ${eqLabel(eq) || '—'}`);
    }
    for (const [key] of baseMap) if (!map.has(key)) out.push(`去掉 ${key.split(':')[1]}`);
  }
  // 规模单独算一项：投料表没填全的基准（老记录）跟本条比，唯一能看出来的改动就是用量
  const aMol = baseRow.base_mmol ?? null;
  const bMol = row.base_mmol ?? null;
  if (bMol != null && String(aMol ?? '') !== String(bMol)) out.push(`用量 ${bMol} mmol`);
  return out;
}

function annotateGroupDiff(items) {
  const groups = new Map();
  for (const it of items) {
    const gid = it.group_id || '';
    if (!gid || !(it.group_size > 1)) continue;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(it);
  }
  for (const [, members] of groups) {
    const ids = members.map((m) => m.id);
    const rows = db
      .prepare(`SELECT id, temperature, solvent, duration, atmosphere, addition FROM experiments WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const base = members.find((m) => String(m.variant || '').includes('基准')) || members[0];
    const baseRow = byId.get(base.id) || {};
    const baseMap = reagentMap(base.id);
    for (const m of members) {
      if (m.id === base.id) {
        m.group_diff = '基准';
        continue;
      }
      const row = byId.get(m.id) || {};
      const diffs = diffItems(baseRow, baseMap, row, reagentMap(m.id));
      // 一项就是「筛条件的那个点」；改多了也如实写，但卡片上只留前两项 + 总数，免得撑爆一行
      m.group_diff = diffs.length
        ? diffs.length > 2
          ? `改 ${diffs.slice(0, 2).join('、')} 等 ${diffs.length} 项`
          : `改 ${diffs.join('、')}`
        : '重复';
      m.group_diff_count = diffs.length;
    }
  }
}

/** 下一个排在最前面的 sort_index */
function topSortIndex(table) {
  return db.prepare(`SELECT COALESCE(MIN(sort_index), 0) - 1 AS v FROM ${table}`).get().v;
}

route('POST', '/api/experiments', async (req, res) => {
  const body = await readJson(req);
  const data = normalizeExperiment(body);
  // 分类的归属和记录一起走：指定了分类就以分类所在的课题为准
  // （在「全部课题」里点某个课题的空分类「＋」新建，记录也跟着进那个课题）
  const catProject = projectOfCategory(data.category_id);
  if (catProject !== null) data.project = catProject;
  // 编号前缀：显式传的最优先，其次这个课题自己的前缀，最后才是全局的
  const projectName = str(data.project).trim();
  const prefix = str(body.prefix) || projectPrefix(projectName);
  let code = str(body.code).trim() || nextCode(prefix, projectName);
  if (db.prepare('SELECT 1 AS x FROM experiments WHERE code = ?').get(code)) {
    code = nextCode(prefix, projectName);
  }
  const ts = nowISO();

  const values = EXP_COLUMNS.map((k) => {
    if (k === 'code') return code;
    if (k === 'date') return data.date || new Date().toISOString().slice(0, 10);
    if (k === 'status') return data.status || '进行中';
    if (k === 'operator') return data.operator || settingsFor(projectName).owner_name || '';
    if (k === 'steps_json') return data.steps_json ?? '[]';
    if (k === 'no_yield') return Number(data.no_yield) === 1 ? 1 : 0;   // NOT NULL 的 0/1 开关
    if (NUMERIC_COLUMNS.has(k)) return data[k] ?? null;
    return data[k] ?? '';
  });

  const row = db
    .prepare(
      `INSERT INTO experiments(${EXP_COLUMNS.join(',')}, locked, created_at, updated_at)
       VALUES (${EXP_COLUMNS.map(() => '?').join(',')}, 0, ?, ?)`
    )
    .run(...values, ts, ts);
  const id = Number(row.lastInsertRowid);
  // 新记录排在该分类最前面
  db.prepare('UPDATE experiments SET sort_index = ? WHERE id = ?').run(topSortIndex('experiments'), id);
  insertReagents(id, normalizeReagents(body.reagents));
  logEvent('experiment', id, 'create', { detail: code });
  ok(res, { experiment: getExperiment(id) });
});

route('GET', '/api/experiments/:id', async (req, res, params) => {
  const exp = getExperiment(Number(params.id));
  if (!exp) return fail(res, 404, '实验不存在');
  exp.scheme_cache = readSchemeCache(exp.id); // 有就带上，前端首帧直接把图贴出来
  ok(res, { experiment: exp });
});

/** 反应式缓存：`{ sig, svg }`，没有就 null */
function readSchemeCache(id) {
  const row = db.prepare('SELECT sig, svg FROM scheme_cache WHERE exp_id = ?').get(id);
  return row ? { sig: row.sig, svg: row.svg } : null;
}

/**
 * 记录页把按投料表画好的那张内联 SVG 存回来：数据没变（sig 一样）时下次打开直接显示，
 * 省掉重画那一两秒的空白。只当缓存用，删掉也不影响记录本身。
 */
route('PUT', '/api/experiments/:id/scheme-cache', async (req, res, params) => {
  const id = Number(params.id);
  const row = db.prepare('SELECT id FROM experiments WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '实验不存在');
  const body = await readJson(req);
  const sig = String(body.sig || '').slice(0, 600);
  const svg = String(body.svg || '').slice(0, 400000);
  if (!sig || !svg) return fail(res, 400, '缺少 sig / svg');
  db.prepare(
    `INSERT INTO scheme_cache (exp_id, sig, svg, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(exp_id) DO UPDATE SET sig = excluded.sig, svg = excluded.svg, at = excluded.at`
  ).run(id, sig, svg, nowISO());
  ok(res, { ok: true });
});

/**
 * 卡片被拖到某个位置：换分类，并插到 before_id 前面（before_id 为空 = 放到最后）
 * sort_index 取两侧邻居的中点，只写这一行，不动别人。
 */
route('POST', '/api/experiments/:id/move', async (req, res, params) => {
  const id = Number(params.id);
  const row = db.prepare('SELECT id FROM experiments WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '实验不存在');
  const body = await readJson(req);
  const categoryId = liveCategoryId(body.category_id, 'experiment');
  const beforeId = numOrNull(body.before_id);
  const sib = db
    .prepare(
      `SELECT id, COALESCE(sort_index, 0) AS si FROM experiments
        WHERE id <> ? AND ${categoryId === null ? 'category_id IS NULL' : 'category_id = ?'}
        ORDER BY COALESCE(sort_index, 0), date DESC, id DESC`
    )
    .all(...(categoryId === null ? [id] : [id, categoryId]));
  let at = sib.length;
  if (beforeId !== null) {
    const j = sib.findIndex((r) => r.id === beforeId);
    if (j >= 0) at = j;
  }
  const prev = at > 0 ? sib[at - 1].si : null;
  const next = at < sib.length ? sib[at].si : null;
  const si =
    prev !== null && next !== null ? (prev + next) / 2 : prev !== null ? prev + 1 : next !== null ? next - 1 : 0;
  // 分类跟着课题走：拖进别的课题的分类里，这条记录也跟着改课题（否则它在原课题里筛不到、看着像丢了）
  const catProject =
    categoryId === null ? null : db.prepare('SELECT project FROM categories WHERE id = ?').get(categoryId)?.project ?? null;
  if (catProject !== null && catProject !== undefined) {
    const now = db.prepare('SELECT project FROM experiments WHERE id = ?').get(id).project || '';
    if (now !== catProject) db.prepare('UPDATE experiments SET project = ? WHERE id = ?').run(catProject, id);
  }
  db.prepare('UPDATE experiments SET category_id = ?, sort_index = ?, updated_at = ? WHERE id = ?').run(
    categoryId,
    si,
    nowISO(),
    id
  );
  ok(res, { experiment: getExperiment(id) });
});

route('PUT', '/api/experiments/:id', async (req, res, params) => {
  const id = Number(params.id);
  const exp = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
  if (!exp) return fail(res, 404, '实验不存在');
  if (exp.locked) return fail(res, 423, '实验已锁定，解锁后才能修改');

  const body = await readJson(req);
  const data = normalizeExperiment(body);
  const hasSolventRow =
    Array.isArray(body.reagents) &&
    body.reagents.some((r) => str(r.role).trim() === '溶剂' && str(r.name).trim());
  const changed = changedFields(exp, data, EXP_FIELD_LABELS, { hasSolventRow });
  const sets = Object.keys(data).map((k) => `${k} = ?`);
  const values = Object.values(data);

  if (body.code !== undefined) {
    const code = str(body.code).trim();
    if (code && code !== db.prepare('SELECT code FROM experiments WHERE id = ?').get(id).code) {
      const clash = db.prepare('SELECT 1 AS x FROM experiments WHERE code = ? AND id <> ?').get(code, id);
      if (clash) return fail(res, 409, `编号 ${code} 已被占用`);
      sets.push('code = ?');
      values.push(code);
    }
  }

  sets.push('updated_at = ?');
  values.push(nowISO());
  // 记录本身和投料表要一起成/败：投料表是「全删再重建」，中途出错会把表清空
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE experiments SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);

    // 「课题」是平行组的属性：同一轮实验改一条就整组跟着走，
    // 否则组里的重复 / 控制变量会散在两个课题下，统计和汇总表都对不上
    if (data.project !== undefined && exp.group_id && data.project !== exp.project) {
      db.prepare('UPDATE experiments SET project = ?, updated_at = ? WHERE group_id = ?').run(
        data.project,
        nowISO(),
        exp.group_id
      );
      // 分类也是挂在课题下的：换课题后原来那个分类不再合法，顺手清掉（别留悬空引用）
      db.prepare(
        `UPDATE experiments SET category_id = NULL
          WHERE group_id = ? AND category_id IS NOT NULL
            AND category_id IN (SELECT id FROM categories WHERE project <> '' AND project <> ?)`
      ).run(exp.group_id, data.project);
    }

    if (Array.isArray(body.reagents)) {
      // 防呆：本来有好几行带名字的投料，这次整张表突然一行名字都没有——多半是页面没加载完
      // / 旧标签页的自动保存（踩过：一条记录被这样清成两行空行）。拦下来，别动数据。
      const namedStored = db
        .prepare("SELECT COUNT(*) AS c FROM reagents WHERE exp_id = ? AND trim(name) <> '' AND trim(role) <> '溶剂'")
        .get(id).c;
      const namedIn = normalizeReagents(body.reagents).filter(
        (r) => str(r.name).trim() && str(r.role).trim() !== '溶剂'
      ).length;
      if (namedStored >= 2 && namedIn === 0) {
        db.exec('ROLLBACK');
        return fail(
          res,
          409,
          `投料表这次一行带名字的都没有（原来有 ${namedStored} 行），像是页面没加载完——已拦下，记录没动。真要清空请一行一行删。`
        );
      }
      const before = JSON.stringify(
        db.prepare('SELECT role, name, mw, conc, density, eq, mmol, mass_mg, volume_ul, note, step FROM reagents WHERE exp_id = ? ORDER BY position').all(id)
      );
      db.prepare('DELETE FROM reagents WHERE exp_id = ?').run(id);
      insertReagents(id, normalizeReagents(body.reagents));
      const after = JSON.stringify(
        db.prepare('SELECT role, name, mw, conc, density, eq, mmol, mass_mg, volume_ul, note, step FROM reagents WHERE exp_id = ? ORDER BY position').all(id)
      );
      if (before !== after) {
        // 以前这里只记「6 行 → 2 行」——真丢表的时候根本看不出丢了什么（踩过）。
        // 现在把两边的表都写进历史：o/n 是给人读的一行字，of/nf 是完整数据（「恢复」用它）
        const rowsOf = (json) => JSON.parse(json);
        changed.push({
          f: 'reagents',
          o: shortVal(reagentTableText(rowsOf(before))),
          n: shortVal(reagentTableText(rowsOf(after))),
          of: fullVal(before),
          nf: fullVal(after),
        });
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  logEdit('experiment', id, changed);
  ok(res, { experiment: getExperiment(id) });
});

/** 软删除一条实验：整条记录（投料表 / 附件清单 / 被断开的引用）拍成快照进回收站，
    表里的行真删、附件文件留在盘上等「彻底删除」。删课题（连记录）也走这一条。 */
function trashExperiment(id) {
  const row = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
  if (!row) return null;
  pushToTrash('experiment', id, `${row.code}${row.title ? ` · ${row.title}` : ''}`, {
    experiment: row,
    reagents: db.prepare('SELECT * FROM reagents WHERE exp_id = ? ORDER BY position').all(id),
    attachments: db.prepare('SELECT * FROM attachments WHERE exp_id = ? ORDER BY id').all(id),
    screenings: db.prepare('SELECT id FROM screenings WHERE exp_id = ?').all(id).map((r) => r.id),
    standards: db.prepare('SELECT id FROM compounds WHERE standard_exp_id = ?').all(id).map((r) => r.id),
  });
  db.prepare('UPDATE screenings SET exp_id = NULL WHERE exp_id = ?').run(id);
  db.prepare('UPDATE compounds SET standard_exp_id = NULL WHERE standard_exp_id = ?').run(id);
  db.prepare('DELETE FROM experiments WHERE id = ?').run(id); // 投料行 / 附件行跟外键级联删掉
  logEvent('experiment', id, 'trash', { detail: `移到回收站：${row.code}` });
  return row;
}

route('DELETE', '/api/experiments/:id', async (req, res, params) => {
  const id = Number(params.id);
  const row = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '实验不存在');
  if (row.locked) return fail(res, 423, '实验已锁定，解锁后才能删除');
  trashExperiment(id);
  ok(res, {});
});

route('POST', '/api/experiments/:id/lock', async (req, res, params) => {
  const id = Number(params.id);
  const body = await readJson(req);
  const locked = body.locked ? 1 : 0;
  db.prepare('UPDATE experiments SET locked = ?, updated_at = ? WHERE id = ?').run(locked, nowISO(), id);
  logEvent('experiment', id, locked ? 'lock' : 'unlock', { detail: locked ? '锁定，之后只读' : '解锁' });
  const exp = getExperiment(id);
  if (!exp) return fail(res, 404, '实验不存在');
  ok(res, { experiment: exp });
});

route('POST', '/api/experiments/:id/duplicate', async (req, res, params) => {
  const src = getExperiment(Number(params.id));
  if (!src) return fail(res, 404, '实验不存在');
  const prefix = projectPrefix(src.project);
  const ts = nowISO();
  const data = {};
  for (const key of EXP_COLUMNS) if (key !== 'code') data[key] = src[key];
  // 复制出来的是「这条要再跑一次」：条件、投料、操作留着，但上一条的结果必须清掉，
  // 否则一打开记录就写着上次的产率 / 表征，很容易被当成这次的结果。
  Object.assign(data, {
    yield_pct: null,
    product_mass: null,
    dr_ee: '',
    ee_pct: null,
    sel_method: '',
    sel_condition: '',
    sel_rt: '',
    appearance: '',
    characterization: '',
    notes: '',
    conclusion: '',
  });
  const row = db
    .prepare(
      `INSERT INTO experiments(${EXP_COLUMNS.join(',')}, locked, created_at, updated_at)
       VALUES (${EXP_COLUMNS.map(() => '?').join(',')}, 0, ?, ?)`
    )
    .run(
      nextCode(prefix, str(src.project)),
      // 连点两次复制不会叠出「（重复）（重复）」
      `${(data.title || '未命名').replace(/（重复）$/, '')}（重复）`,
      new Date().toISOString().slice(0, 10),
      '进行中',
      ...EXP_COLUMNS.slice(4).map((k) => data[k] ?? null),
      ts,
      ts
    );
  const id = Number(row.lastInsertRowid);
  insertReagents(id, src.reagents);
  logEvent('experiment', id, 'duplicate', { detail: `复制自 ${src.code}` });
  ok(res, { experiment: getExperiment(id) });
});

/**
 * 新建一条「平行实验」：同一条实验再做一次（重复实验），或者只换一个变量（控制变量实验）。
 * 条件 / 投料 / 操作步骤 / 反应式图片带过来，上一条的结果全清空——但标题不加「（重复）」，
 * 因为平行实验本来就是同一轮；新记录跟源记录进同一个平行组（group_id），
 * 纸面左侧那排书签显示的就是这一组。
 */
route('POST', '/api/experiments/:id/parallel', async (req, res, params) => {
  const src = getExperiment(Number(params.id));
  if (!src) return fail(res, 404, '实验不存在');
  if (src.locked) return fail(res, 423, '实验已锁定');
  const body = await readJson(req);
  const prefix = projectPrefix(src.project);
  const ts = nowISO();

  const data = {};
  for (const key of EXP_COLUMNS) if (key !== 'code' && key !== 'group_id') data[key] = src[key];
  Object.assign(data, {
    date: new Date().toISOString().slice(0, 10),
    status: '进行中',
    yield_pct: null,
    product_mass: null,
    appearance: '',
    dr_ee: '',
    ee_pct: null,
    sel_method: '',
    sel_condition: '',
    sel_rt: '',
    characterization: '',
    notes: '',
    conclusion: '',
    tlc_note: '',
  });

  // 源记录还没有组号时，这一条顺手把源记录也拉进同一个组（第一次点「＋」的那一刻成组）
  const groupId = src.group_id || `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  db.exec('BEGIN');
  let id;
  try {
    const row = db
      .prepare(
        `INSERT INTO experiments(${EXP_COLUMNS.join(',')}, locked, created_at, updated_at)
         VALUES (${EXP_COLUMNS.map(() => '?').join(',')}, 0, ?, ?)`
      )
      .run(
        nextCode(prefix, str(src.project)),
        data.title,
        data.date,
        data.status,
        ...EXP_COLUMNS.slice(4).map((k) => (k === 'group_id' ? groupId : data[k] ?? null)),
        ts,
        ts
      );
    id = Number(row.lastInsertRowid);
    insertReagents(id, src.reagents);
    // 排序位置跟着源记录走：不然新建的平行会掉进 sort_index 的 0 号桶，跑到列表另一头去
    db.prepare('UPDATE experiments SET sort_index = ? WHERE id = ?').run(src.sort_index ?? null, id);
    if (!src.group_id) db.prepare('UPDATE experiments SET group_id = ? WHERE id = ?').run(groupId, src.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // 反应式（结构图）带过来：平行实验是同一个反应，纸上不该缺图。TLC / 谱图不抄（每次都不一样）
  if (body.copy_scheme !== false) {
    const dir = path.join(ATTACH_DIR, String(id));
    fs.mkdirSync(dir, { recursive: true });
    const ins = db.prepare(
      `INSERT INTO attachments(exp_id, category, filename, original_name, size, mime, is_dir, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    for (const a of src.attachments.filter((x) => x.category === 'scheme')) {
      const r = ins.run(id, a.category, a.filename, a.original_name, a.size, a.mime, a.is_dir, a.note, ts);
      const fileId = Number(r.lastInsertRowid);
      // original_name 可能本身就带 `行号__` 前缀（从路径导入的那种），别叠两层
      const baseName = String(a.original_name || a.filename).replace(/^\d+__/, '');
      const target = uniquePath(dir, `${fileId}__${baseName}`);
      try {
        const srcPath = attachmentPath(a);
        if (a.is_dir) fs.cpSync(srcPath, target, { recursive: true });
        else fs.copyFileSync(srcPath, target);
        db.prepare('UPDATE attachments SET filename = ? WHERE id = ?').run(path.basename(target), fileId);
      } catch {
        db.prepare('DELETE FROM attachments WHERE id = ?').run(fileId);
      }
    }
  }

  logEvent('experiment', id, 'parallel', { detail: `平行实验，源自 ${src.code}` });
  ok(res, { experiment: getExperiment(id) });
});

route('POST', '/api/experiments/:id/attachments', async (req, res, params) => {
  await attachUpload(req, res, Number(params.id));
});

route('POST', '/api/experiments/:id/attachments/path', async (req, res, params) => {
  const body = await readJson(req);
  await attachFromPath(res, Number(params.id), body);
});

route('PUT', '/api/attachments/:id', async (req, res, params) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(params.id));
  if (!att) return fail(res, 404, '附件不存在');
  const exp = db.prepare('SELECT locked FROM experiments WHERE id = ?').get(att.exp_id);
  if (exp && exp.locked) return fail(res, 423, '实验已锁定');
  const body = await readJson(req);
  const fields = [];
  const values = [];
  if ('category' in body) {
    fields.push('category = ?');
    values.push(str(body.category) || 'other');
  }
  if ('note' in body) {
    fields.push('note = ?');
    values.push(str(body.note));
  }
  if (!fields.length) return fail(res, 400, '没有要改的字段');
  db.prepare(`UPDATE attachments SET ${fields.join(', ')} WHERE id = ?`).run(...values, att.id);
  db.prepare('UPDATE experiments SET updated_at = ? WHERE id = ?').run(nowISO(), att.exp_id);
  ok(res, { attachment: db.prepare('SELECT * FROM attachments WHERE id = ?').get(att.id) });
});

route('DELETE', '/api/attachments/:id', async (req, res, params) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(params.id));
  if (!att) return fail(res, 404, '附件不存在');
  const exp = db.prepare('SELECT locked FROM experiments WHERE id = ?').get(att.exp_id);
  if (exp && exp.locked) return fail(res, 423, '实验已锁定');
  await fsp.rm(attachmentPath(att), { recursive: true, force: true }).catch(() => {});
  db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
  ok(res, {});
});

route('GET', '/api/files/:id', async (req, res, params, url) => {
  await serveAttachment(req, res, Number(params.id), url);
});

/* --- exports --- */
route('GET', '/api/experiments/:id/export.md', async (req, res, params, url) => {
  const exp = getExperiment(Number(params.id));
  if (!exp) return fail(res, 404, '实验不存在');
  const md = experimentToMarkdown(exp, {
    reagents: exp.reagents,
    attachments: exp.attachments,
    settings: settingsFor(str(exp.project)),
    screenings: exp.screenings,
  });
  sendText(res, 200, md, 'text/markdown; charset=utf-8', `attachment; filename*=UTF-8''${encodeURIComponent(exp.code)}.md`);
});

route('GET', '/api/export/notebook.md', async (req, res, params, url) => {
  const project = (url.searchParams.get('project') || '').trim();
  const exps = project
    ? db.prepare('SELECT * FROM experiments WHERE project = ? ORDER BY date, id').all(project)
    : db.prepare('SELECT * FROM experiments ORDER BY date, id').all();
  const settings = settingsFor(project);
  const heading = settings.lab_heading || '实验记录本';
  const parts = [`# ${heading}`, '', `导出时间：${nowISO()}　共 ${exps.length} 条`, '', '---', ''];
  for (const e of exps) {
    const full = getExperiment(e.id);
    parts.push(
      experimentToMarkdown(full, {
        reagents: full.reagents,
        attachments: full.attachments,
        settings,
        screenings: full.screenings,
      })
    );
    parts.push('', '<<<');
    parts.push('');
  }
  const filename = project ? `实验记录本-${project}.md` : '实验记录本.md';
  sendText(res, 200, parts.join('\n'), 'text/markdown; charset=utf-8', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
});

/* --- 平行组：条件对照表用 ---
   一摞（同 group_id 且 ≥2 条）连每条的投料表一起给出来，
   前端拿第一条当基准，一行一个条件项、一列一条实验，谁改了哪儿一眼能看出来。 */
/**
 * 条件对照表的原料：手动平行组（同 group_id、≥2 条）+ 自动匹配（散记录按「底物 + 产物」归堆）。
 * 抽成函数是为了 bootstrap 里那个侧栏计数也能用同一份逻辑，不要在两处各写一遍。
 */
function listGroupTables(project) {
  const where = project ? 'AND e.project = ?' : '';
  const args = project ? [project] : [];
  const heads = db
    .prepare(
      `SELECT e.group_id AS id, COUNT(*) AS n, MIN(e.id) AS first_id
         FROM experiments e
        WHERE trim(e.group_id) <> '' ${where}
        GROUP BY e.group_id
       HAVING COUNT(*) > 1
        ORDER BY MAX(e.id) DESC`
    )
    .all(...args);

  const memberSql = `SELECT e.id, e.code, e.title, e.date, e.status, e.kind, e.project,
                            e.yield_pct, e.dr_ee, e.ee_pct, e.no_yield,
                            e.solvent, e.concentration, e.temperature, e.duration,
                            e.atmosphere, e.addition, e.product_name, e.product_mass,
                            e.base_mmol, e.group_id,
                            (SELECT group_concat(r.name, ' + ') FROM reagents r
                              WHERE r.exp_id = e.id AND r.role = '底物' AND trim(r.name) <> '') AS substrates
                       FROM experiments e
                      WHERE e.group_id = ?
                      ORDER BY e.id`;
  const reagentSql = "SELECT role, name, eq, mmol FROM reagents WHERE exp_id = ? AND trim(name) <> '' ORDER BY position, id";
  const eg = db.prepare('SELECT kind, title FROM exp_groups WHERE id = ?');

  const mapOf = (m) => new Map((m.reagents || []).map((r) => [`${r.role}:${r.name}`, r.eq == null ? '' : String(r.eq)]));
  /** 每条记录算出「相对基准改了什么」；整摞只有重复 / 全是原料的，不进条件筛选 */
  const annotate = (members) => {
    const base = members[0];
    const baseMap = mapOf(base);
    for (const m of members) {
      m.changes = m.id === base.id ? [] : diffItems(base, baseMap, m, mapOf(m));
      m.changed = m.changes.length;
    }
    return members;
  };
  const worthShowing = (members) =>
    members.some((m) => m.changed > 0) && members.some((m) => str(m.kind) !== '原料');

  const items = heads
    .map((h) => {
      const members = annotate(
        db.prepare(memberSql).all(h.id).map((m) => ({
          ...m,
          reagents: db.prepare(reagentSql).all(m.id),
        }))
      );
      const meta = eg.get(h.id) || {};
      return { id: h.id, kind: meta.kind || '', title: meta.title || '', count: members.length, members };
    })
    .filter((g) => worthShowing(g.members));

  /* 自动匹配：不在任何 ≥2 条组里的记录（含 group_id 空、以及只剩一条的孤儿），
     底物集合 + 产物一样就算一摞。没有这一步，只有手动点过「＋」的才进对照表。 */
  const grouped = new Set(heads.map((h) => h.id));
  const loose = db
    .prepare(
      `SELECT id, group_id, code, date, status, kind, yield_pct, dr_ee, ee_pct, no_yield, solvent, temperature,
              duration, atmosphere, addition, product_name, project
         FROM experiments e
        WHERE 1 = 1 ${where}
        ORDER BY id`
    )
    .all(...args)
    // 原料那类记录不是「同一条件下换条件」的实验，别自动匹配进条件筛选表
    .filter((m) => !grouped.has(m.group_id) && str(m.kind) !== '原料');

  const sigOf = (m) => {
    const subs = db
      .prepare("SELECT name FROM reagents WHERE exp_id = ? AND role = '底物' AND trim(name) <> '' ORDER BY name")
      .all(m.id)
      .map((r) => r.name.trim().toLowerCase());
    if (!subs.length) return '';
    const prod = str(m.product_name).trim().toLowerCase();
    return prod ? `${subs.join(' + ')}|→|${prod}` : subs.join(' + ');
  };

  const looseFull = loose.map((m) => ({ ...m, reagents: db.prepare(reagentSql).all(m.id) }));
  const buckets = new Map();
  for (const m of looseFull) {
    const sig = sigOf(m);
    if (!sig) continue;
    if (!buckets.has(sig)) buckets.set(sig, []);
    buckets.get(sig).push(m);
  }
  const auto = [...buckets.entries()]
    .filter(([, ms]) => ms.length > 1)
    .map(([sig, ms]) => ({ sig, members: annotate(ms) }))
    .filter(({ members }) => worthShowing(members))
    .map(({ sig, members }) => ({
      id: `auto:${sig}`,
      kind: 'auto',
      title: '',
      subject: members[0].reagents.find((r) => r.role === '底物')?.name || sig,
      count: members.length,
      members,
    }))
    .sort((a, b) => b.count - a.count);

  return { items, auto };
}

route('GET', '/api/groups', async (req, res, params, url) => {
  const q = Object.fromEntries(url.searchParams.entries());
  const { items, auto } = listGroupTables(str(q.project));
  ok(res, { items, auto, total: items.length });
});

/* 把自动匹配出来的一堆「收成」正式的平行组：从此它们有 group_id，走手动组那一套 */
route('POST', '/api/groups/adopt', async (req, res) => {
  const body = await readJson(req);
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isFinite(n));
  if (ids.length < 2) return fail(res, 400, '至少要两条才能成一组');
  const groupId = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const ts = nowISO();
  db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE experiments SET group_id = ?, updated_at = ? WHERE id = ?');
    for (const id of ids) upd.run(groupId, ts, id);
    db.prepare(
      `INSERT INTO exp_groups(id, kind, title, created_at, updated_at) VALUES (?, 'screen', ?, ?, ?)`
    ).run(groupId, str(body.title), ts, ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  ok(res, { group_id: groupId, count: ids.length });
});

/* --- screenings --- */
/** 一张筛选表该落在哪个课题：先看第一条实验属于谁（没有就落共用课题） */
function projectOfEntry(ids) {
  const first = (Array.isArray(ids) ? ids : []).map(Number).find((n) => Number.isFinite(n) && n > 0);
  if (!first) return '';
  return str(db.prepare('SELECT project FROM experiments WHERE id = ?').get(first)?.project);
}

route('GET', '/api/screenings', async (req, res, params, url) => {
  // 条件筛选跟实验一样按课题分：传了 project 就只给这个课题的表
  const project = str(Object.fromEntries(url.searchParams.entries()).project);
  const rows = db
    .prepare(`SELECT * FROM screenings ${project ? 'WHERE project = ?' : ''} ORDER BY id DESC`)
    .all(...(project ? [project] : []))
    .map(parseScreening);
  ok(res, {
    items: rows.map((s) => ({
      id: s.id,
      title: s.title,
      exp_id: s.exp_id,
      updated_at: s.updated_at,
      varCount: s.vars.length,
      entryCount: s.entries.length,
      best: s.entries.reduce((m, e) => (e.yield_pct > m ? e.yield_pct : m), 0),
    })),
  });
});

route('POST', '/api/screenings', async (req, res) => {
  const body = await readJson(req);
  const ts = nowISO();
  const row = db
    .prepare(
      `INSERT INTO screenings(exp_id, title, note, vars_json, entries_json, project, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      numOrNull(body.exp_id),
      str(body.title) || '未命名条件筛选',
      str(body.note),
      JSON.stringify(Array.isArray(body.vars) ? body.vars : []),
      JSON.stringify(
        (Array.isArray(body.exp_ids) ? body.exp_ids : [])
          .map(Number)
          .filter((n) => Number.isFinite(n))
          .map((id) => ({ exp_id: id, cells: {} }))
      ),
      // 表归属哪个课题：优先用调用方给的当前课题，没给就按第一条实验的课题
      str(body.project) || projectOfEntry(body.exp_ids),
      ts,
      ts
    );
  ok(res, { screening: parseScreening(db.prepare('SELECT * FROM screenings WHERE id = ?').get(Number(row.lastInsertRowid))) });
});

route('GET', '/api/screenings/:id', async (req, res, params) => {
  const s = parseScreening(db.prepare('SELECT * FROM screenings WHERE id = ?').get(Number(params.id)));
  if (!s) return fail(res, 404, '筛选表不存在');
  // 表里只存「选了哪些实验 + 每格手填的文本」；编号 / 条件 / 产率这些一直读记录本身，不会跟记录脱节
  const one = db.prepare(`SELECT e.id, e.code, e.title, e.date, e.status, e.kind, e.yield_pct, e.dr_ee, e.ee_pct,
                                 e.no_yield, e.solvent, e.temperature, e.duration, e.atmosphere, e.addition,
                                 e.product_name, e.product_mass, e.base_mmol,
                                 e.notes, e.conclusion, e.appearance, e.tlc_note,
                                 (SELECT group_concat(r.name, ' + ') FROM reagents r
                                   WHERE r.exp_id = e.id AND r.role = '底物' AND trim(r.name) <> '') AS substrates
                            FROM experiments e WHERE e.id = ?`);
  // 带上 compound_id：筛选表要按结构画「标准条件」的反应式，光有名字匹配不到（同名/错字就废了）
  const reagents = db.prepare(
    "SELECT role, name, eq, compound_id FROM reagents WHERE exp_id = ? AND trim(name) <> '' ORDER BY position, id"
  );
  const rows = s.entries.map((e) => {
    const exp = one.get(Number(e.exp_id));
    return {
      exp_id: Number(e.exp_id),
      cells: e.cells || {},
      exp: exp ? { ...exp, reagents: reagents.all(exp.id) } : null,
    };
  });
  ok(res, { screening: s, rows });
});

route('PUT', '/api/screenings/:id', async (req, res, params) => {
  const id = Number(params.id);
  if (!db.prepare('SELECT 1 AS x FROM screenings WHERE id = ?').get(id)) return fail(res, 404, '筛选表不存在');
  const body = await readJson(req);
  const fields = [];
  const values = [];
  if ('title' in body) {
    fields.push('title = ?');
    values.push(str(body.title));
  }
  if ('note' in body) {
    fields.push('note = ?');
    values.push(str(body.note));
  }
  if ('exp_id' in body) {
    fields.push('exp_id = ?');
    values.push(numOrNull(body.exp_id));
  }
  if ('vars' in body) {
    fields.push('vars_json = ?');
    values.push(JSON.stringify(Array.isArray(body.vars) ? body.vars : []));
  }
  if ('entries' in body) {
    fields.push('entries_json = ?');
    values.push(JSON.stringify(Array.isArray(body.entries) ? body.entries : []));
  }
  fields.push('updated_at = ?');
  values.push(nowISO());
  db.prepare(`UPDATE screenings SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  ok(res, { screening: parseScreening(db.prepare('SELECT * FROM screenings WHERE id = ?').get(id)) });
});

route('DELETE', '/api/screenings/:id', async (req, res, params) => {
  db.prepare('DELETE FROM screenings WHERE id = ?').run(Number(params.id));
  ok(res, {});
});

route('GET', '/api/screenings/:id/export.csv', async (req, res, params) => {
  const s = parseScreening(db.prepare('SELECT * FROM screenings WHERE id = ?').get(Number(params.id)));
  if (!s) return fail(res, 404, '筛选表不存在');
  sendText(res, 200, screeningToCsv(s), 'text/csv; charset=utf-8', `attachment; filename*=UTF-8''${encodeURIComponent((s.title || '筛选表') + '.csv')}`);
});

route('GET', '/api/screenings/:id/export.md', async (req, res, params) => {
  const s = parseScreening(db.prepare('SELECT * FROM screenings WHERE id = ?').get(Number(params.id)));
  if (!s) return fail(res, 404, '筛选表不存在');
  sendText(res, 200, screeningToMarkdown(s), 'text/markdown; charset=utf-8');
});

/* --- 回收站 + 改动历史 --- */

/** 往回收站里放一条（删记录 / 删化合物都走这里） */
function pushToTrash(entity, entityId, label, data) {
  db.prepare('INSERT INTO trash(entity, entity_id, label, data, at) VALUES (?, ?, ?, ?, ?)').run(
    entity,
    entityId,
    label || '',
    JSON.stringify(data || {}),
    nowISO()
  );
}

const HISTORY_KIND_TEXT = {
  create: '新建',
  lock: '锁定',
  unlock: '解锁',
  duplicate: '复制',
  trash: '移到回收站',
  restore: '从回收站恢复',
  purge: '彻底删除',
};

/** 一行历史 → 一句人话 */
function historyLine(row) {
  if (row.kind === 'edit') {
    let fields = [];
    try {
      fields = JSON.parse(row.fields || '[]');
    } catch {
      fields = [];
    }
    const labels = fields.map((f) => EXP_FIELD_LABELS[f] || CMP_FIELD_LABELS[f] || f);
    if (!labels.length) return '改了点内容';
    const head = labels.slice(0, 6).join('、');
    return `改了 ${head}${labels.length > 6 ? ` 等 ${labels.length} 项` : ''}`;
  }
  return row.detail || HISTORY_KIND_TEXT[row.kind] || row.kind;
}

route('GET', '/api/history/:entity/:id', async (req, res, params) => {
  const entity = params.entity === 'compound' ? 'compound' : 'experiment';
  const items = historyFor(entity, Number(params.id)).map((r) => {
    let raw = [];
    try {
      raw = JSON.parse(r.changes || '[]');
    } catch {
      raw = [];
    }
    return {
      id: r.id,
      kind: r.kind,
      at: r.at,
      text: historyLine(r),
      changes: raw.map((c) => ({
        f: c.f,
        label: EXP_FIELD_LABELS[c.f] || CMP_FIELD_LABELS[c.f] || c.f,
        from: c.o || '',
        to: c.n || '',
        // 能「恢复」的才算：编号不恢复（唯一性 / 引用都会乱）
        can:
          c.f !== 'code' &&
          (c.f === 'reagents'
            ? typeof c.of === 'string' && c.of.startsWith('[')   // 老历史只记了「6 行」，没法恢复
            : c.f in EXP_FIELD_LABELS || c.f in CMP_FIELD_LABELS),
      })),
    };
  });
  ok(res, { items });
});

/**
 * 把某个历史条目里的字段改回「改之前」的值——历史不只是看的，要能回溯。
 * body: { event: 事件 id, field?: 字段名 }（不给 field 就把这条里所有能恢复的字段一起改回去）
 */
route('POST', '/api/history/:entity/:id/restore', async (req, res, params) => {
  const entity = params.entity === 'compound' ? 'compound' : 'experiment';
  const id = Number(params.id);
  const body = await readJson(req);
  const ev = db
    .prepare('SELECT * FROM events WHERE id = ? AND entity = ? AND entity_id = ?')
    .get(Number(body.event), entity, id);
  if (!ev) return fail(res, 404, '找不到这条历史');
  const table = entity === 'experiment' ? 'experiments' : 'compounds';
  const labels = entity === 'experiment' ? EXP_FIELD_LABELS : CMP_FIELD_LABELS;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return fail(res, 404, entity === 'experiment' ? '实验不存在' : '化合物不存在');
  if (entity === 'experiment' && row.locked) return fail(res, 423, '记录已锁定，解锁后才能改');

  let raw = [];
  try {
    raw = JSON.parse(ev.changes || '[]');
  } catch {
    raw = [];
  }
  const want = (body.field ? raw.filter((c) => c.f === body.field) : raw).filter(
    (c) => c.f !== 'code' && (c.f === 'reagents' || c.f in labels)
  );
  if (!want.length) return fail(res, 400, '这条历史里没有能恢复的字段');

  const done = [];
  db.exec('BEGIN');
  try {
    for (const c of want) {
      // 投料表：整张表按历史里那份覆盖（只有当时真存了完整数据才恢复）
      if (c.f === 'reagents') {
        if (entity !== 'experiment') continue;
        let rows = null;
        try {
          rows = JSON.parse(c.of ?? 'null');
        } catch {
          rows = null;
        }
        if (!Array.isArray(rows)) continue;
        const before = db
          .prepare('SELECT role, name, mw, conc, density, eq, mmol, mass_mg, volume_ul, note, step FROM reagents WHERE exp_id = ? ORDER BY position')
          .all(id);
        db.prepare('DELETE FROM reagents WHERE exp_id = ?').run(id);
        insertReagents(id, normalizeReagents(rows));
        done.push({
          f: 'reagents',
          o: shortVal(reagentTableText(before)),
          n: shortVal(reagentTableText(rows)),
          of: fullVal(JSON.stringify(before)),
          nf: fullVal(JSON.stringify(rows)),
        });
        continue;
      }
      const old = c.of !== undefined ? c.of : (c.o ?? null);
      const before = row[c.f];
      if (String(before ?? '') === String(old ?? '')) continue;
      const numeric = ['base_mmol', 'yield_pct', 'product_mass', 'product_mw', 'ee_pct', 'category_id', 'product_compound_id', 'standard_exp_id'].includes(c.f);
      db.prepare(`UPDATE ${table} SET ${c.f} = ?, updated_at = ? WHERE id = ?`).run(
        numeric ? numOrNull(old) : str(old),
        nowISO(),
        id
      );
      done.push({ f: c.f, o: shortVal(before), n: shortVal(old), of: fullVal(before), nf: fullVal(old) });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (!done.length) return fail(res, 400, '这些字段现在已经是那个值了');
  logEvent(entity, id, 'restore-history', {
    detail: `按 ${new Date(ev.at).toLocaleString('zh-CN')} 那次改动之前的值恢复了：${done.map((d) => labels[d.f] || d.f).join('、')}`,
    fields: done.map((d) => d.f),
    changes: done,
  });
  ok(res, entity === 'experiment' ? { experiment: getExperiment(id) } : { compound: getCompound(id) });
});

route('GET', '/api/trash', async (req, res) => {
  const items = db
    .prepare('SELECT id, entity, entity_id, label, at, length(data) AS size FROM trash ORDER BY id DESC')
    .all()
    .map((r) => ({ ...r, entityName: r.entity === 'compound' ? '化合物' : '实验' }));
  ok(res, { items });
});

route('POST', '/api/trash/:id/restore', async (req, res, params) => {
  const t = db.prepare('SELECT * FROM trash WHERE id = ?').get(Number(params.id));
  if (!t) return fail(res, 404, '回收站里没有这条');
  let data = {};
  try {
    data = JSON.parse(t.data || '{}');
  } catch {
    return fail(res, 500, '这条的快照坏了，没法恢复');
  }

  if (t.entity === 'experiment') {
    const e = data.experiment;
    if (!e) return fail(res, 500, '快照里没有记录本体，没法恢复');
    if (db.prepare('SELECT 1 AS x FROM experiments WHERE id = ?').get(t.entity_id)) {
      return fail(res, 409, '这个内部编号已经被新记录占用了（数据不会丢，但没法原地恢复）');
    }
    // 编号是唯一的：原来的号若已经被别人用掉，就自动加个后缀，别把恢复卡死
    let code = e.code;
    if (db.prepare('SELECT 1 AS x FROM experiments WHERE code = ?').get(code)) {
      let n = 1;
      while (db.prepare('SELECT 1 AS x FROM experiments WHERE code = ?').get(`${e.code}-恢复${n > 1 ? n : ''}`)) n += 1;
      code = `${e.code}-恢复${n > 1 ? n : ''}`;
    }
    // 老快照里可能没有后来加的列（新字段都走 ensureColumn）。缺的列不能写 NULL：
    // sel_method 这些是 NOT NULL DEFAULT ''，显式 NULL 会报错，这条就永远恢复不了。
    const cols = [...EXP_COLUMNS, 'locked'].filter((k) => k in e);
    const values = cols.map((k) => (k === 'code' ? code : e[k] ?? null));
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO experiments(id, ${cols.join(',')}, created_at, updated_at)
         VALUES (?, ${cols.map(() => '?').join(',')}, ?, ?)`
      ).run(t.entity_id, ...values, e.created_at || nowISO(), nowISO());
      insertReagents(t.entity_id, data.reagents || []);
      const insAtt = db.prepare(
        `INSERT INTO attachments(id, exp_id, category, filename, original_name, size, mime, is_dir, note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      for (const a of data.attachments || []) {
        insAtt.run(a.id, t.entity_id, a.category, a.filename, a.original_name, a.size, a.mime, a.is_dir, a.note, a.created_at);
      }
      for (const sid of data.screenings || []) db.prepare('UPDATE screenings SET exp_id = ? WHERE id = ?').run(t.entity_id, sid);
      for (const cid of data.standards || []) db.prepare('UPDATE compounds SET standard_exp_id = ? WHERE id = ?').run(t.entity_id, cid);
      db.prepare('DELETE FROM trash WHERE id = ?').run(t.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    logEvent('experiment', t.entity_id, 'restore', { detail: `从回收站恢复：${code}` });
    return ok(res, { entity: 'experiment', id: t.entity_id, code });
  }

  // compound
  const c = data.compound;
  if (!c) return fail(res, 500, '快照里没有化合物本体，没法恢复');
  if (db.prepare('SELECT 1 AS x FROM compounds WHERE id = ?').get(t.entity_id)) {
    return fail(res, 409, '这个内部编号已经被新化合物占用了');
  }
  let code = c.code;
  if (code && compoundCodeOwner(code)) {
    let n = 1;
    while (compoundCodeOwner(`${c.code}-恢复${n > 1 ? n : ''}`)) n += 1;
    code = `${c.code}-恢复${n > 1 ? n : ''}`;
  }
  // 同实验：快照缺的列不写，交给建表默认值，别撞 NOT NULL
  const cols = COMPOUND_COLUMNS.filter((k) => k in c);
  const values = cols.map((k) => (k === 'code' ? code : c[k] ?? null));
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO compounds(id, ${cols.join(',')}, created_at, updated_at)
       VALUES (?, ${cols.map(() => '?').join(',')}, ?, ?)`
    ).run(t.entity_id, ...values, c.created_at || nowISO(), nowISO());
    const insFile = db.prepare(
      `INSERT INTO compound_files(id, compound_id, category, filename, original_name, size, mime, is_dir, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    for (const f of data.files || []) {
      insFile.run(f.id, t.entity_id, f.category, f.filename, f.original_name, f.size, f.mime, f.is_dir, f.note, f.created_at);
    }
    for (const rid of data.reagentRows || []) db.prepare('UPDATE reagents SET compound_id = ? WHERE id = ?').run(t.entity_id, rid);
    for (const eid of data.productRows || []) db.prepare('UPDATE experiments SET product_compound_id = ? WHERE id = ?').run(t.entity_id, eid);
    db.prepare('DELETE FROM trash WHERE id = ?').run(t.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  logEvent('compound', t.entity_id, 'restore', { detail: `从回收站恢复：${code || '（未编号）'}` });
  ok(res, { entity: 'compound', id: t.entity_id, code });
});

/** 彻底删除一条：这才真删附件文件 */
async function purgeTrashRow(t) {
  let data = {};
  try {
    data = JSON.parse(t.data || '{}');
  } catch {
    data = {};
  }
  if (t.entity === 'experiment') {
    for (const a of data.attachments || []) {
      await fsp.rm(attachmentPath(a), { recursive: true, force: true }).catch(() => {});
    }
    await fsp.rm(path.join(ATTACH_DIR, String(t.entity_id)), { recursive: true, force: true }).catch(() => {});
    db.prepare('DELETE FROM scheme_cache WHERE exp_id = ?').run(Number(t.entity_id));
  } else {
    await fsp.rm(path.join(COMPOUND_DIR, String(t.entity_id)), { recursive: true, force: true }).catch(() => {});
  }
  db.prepare('DELETE FROM trash WHERE id = ?').run(t.id);
  logEvent(t.entity, t.entity_id, 'purge', { detail: `彻底删除：${t.label || ''}` });
}

route('DELETE', '/api/trash/:id', async (req, res, params) => {
  const t = db.prepare('SELECT * FROM trash WHERE id = ?').get(Number(params.id));
  if (!t) return fail(res, 404, '回收站里没有这条');
  await purgeTrashRow(t);
  ok(res, {});
});

route('DELETE', '/api/trash', async (req, res) => {
  const rows = db.prepare('SELECT * FROM trash ORDER BY id').all();
  for (const t of rows) await purgeTrashRow(t);
  ok(res, { count: rows.length });
});

/* --- backup --- */
route('GET', '/api/backup', async (req, res) => {
  // 让 SQLite 把 WAL 落盘，然后打包整个 data 目录
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('ELN-backup-' + new Date().toISOString().slice(0, 10) + '.zip')}`,
  });
  await zipDirectory(DATA_DIR, res);
});

/* ------------------------------------------------------------ static fs */

function sendText(res, code, text, type, disposition) {
  const buf = Buffer.from(text, 'utf8');
  const headers = { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store' };
  if (disposition) headers['content-disposition'] = disposition;
  res.writeHead(code, headers);
  res.end(buf);
}

/** /vendor/* → vendor/*（第三方静态资源：结构画板 JSME 等；目录没有就 404，
    前端会提示去跑 scripts/fetch-sketcher.sh） */
function serveVendor(req, res, url) {
  const rel = decodeURIComponent(url.pathname).replace(/^\/vendor\//, '');
  const root = VENDOR_DIR;
  const full = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(root)) return fail(res, 403, 'forbidden');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, '画板资源没找到（跑一次 sh scripts/fetch-sketcher.sh）');
    const ext = path.extname(full).toLowerCase();
    // 带哈希名的产物（assets/xxx-<hash>.js、wasm/indigo-*.wasm）内容不会再变，
    // 让浏览器一直缓存——Ketcher 那个包 29 MB + 11 MB WASM，每次重下太慢。
    const hashed = /\/assets\/|\/wasm\//.test(`/${rel}`);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    pipeFile(res, full);
  });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 回退
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, buf) => {
        if (e2) return fail(res, 500, 'index.html 缺失');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(buf);
      });
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
    });
    pipeFile(res, full);
  });
}

/* ------------------------------------------------------------ 打印成 PDF */

/**
 * 用 macOS 自带的 WebKit（跟 Safari 同一个引擎）把页面渲成 A4 PDF：
 * 前端把两页 DOM 序列化 + 全部 CSS 发过来，服务端存成临时网页、用 swift 渲染、合并成多页 PDF。
 * 渲染器第一次用时才编译，编好缓存在 .cache/print-render。
 */
// 原生小工具的编译缓存：本机放仓库里的 .cache/；服务器上 /opt/eln 是只读的，放到临时目录
const CACHE_DIR =
  process.env.ELN_CACHE_DIR ||
  (process.platform === 'darwin' ? path.join(__dirname, '..', '.cache') : path.join(os.tmpdir(), 'eln-native'));
const PRINT_TOKENS = new Map(); // token -> 临时目录，只在校验/清理期间存在
let printRendererPromise = null;

function ensurePrintRenderer() {
  if (printRendererPromise) return printRendererPromise;
  printRendererPromise = (async () => {
    const bin = path.join(CACHE_DIR, 'print-render');
    if (fs.existsSync(bin)) return bin;
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await new Promise((resolve, reject) => {
      const p = spawn(
        'swiftc',
        ['-O', '-module-cache-path', path.join(CACHE_DIR, 'clang'), path.join(__dirname, 'print.swift'), '-o', bin],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let err = '';
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('error', () => reject(new Error('这台机器没有 swiftc，没法自己生成 PDF，请用「系统打印」')));
      p.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`PDF 渲染器编译失败：${err.trim().slice(0, 300)}`))
      );
    });
    return bin;
  })().catch((e) => {
    printRendererPromise = null; // 失败了下次还可以再试
    throw e;
  });
  return printRendererPromise;
}

let shotRendererPromise = null;
function ensureShotRenderer() {
  if (shotRendererPromise) return shotRendererPromise;
  shotRendererPromise = (async () => {
    const bin = path.join(CACHE_DIR, 'shot-render');
    if (fs.existsSync(bin)) return bin;
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await new Promise((resolve, reject) => {
      const p = spawn('swiftc', ['-O', '-module-cache-path', path.join(CACHE_DIR, 'clang'),
        path.join(__dirname, 'shot.swift'), '-o', bin], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('error', () => reject(new Error('这台机器没有 swiftc，导不了长图')));
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`长图渲染器编译失败：${err.trim().slice(0, 300)}`))));
    });
    return bin;
  })().catch((e) => {
    shotRendererPromise = null;
    throw e;
  });
  return shotRendererPromise;
}

/* ---------------------------------------------------------------- 本地 OCR */

let ocrRendererPromise = null;

/** 编译 server/ocr.swift → .cache/ocr（只编一次）；没 swiftc 就报错，前端会提示手动填 */
function ensureOcrRenderer() {
  if (ocrRendererPromise) return ocrRendererPromise;
  ocrRendererPromise = (async () => {
    const bin = path.join(CACHE_DIR, 'ocr');
    if (fs.existsSync(bin)) return bin;
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await new Promise((resolve, reject) => {
      const p = spawn(
        'swiftc',
        ['-O', '-module-cache-path', path.join(CACHE_DIR, 'clang'), path.join(__dirname, 'ocr.swift'), '-o', bin],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let err = '';
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('error', () => reject(new Error('这台机器没有 swiftc，读不了图里的字')));
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`OCR 编译失败：${err.trim().slice(0, 300)}`))));
    });
    return bin;
  })().catch((e) => {
    ocrRendererPromise = null;
    throw e;
  });
  return ocrRendererPromise;
}

/** 跑一次 OCR，返回 [{text, conf, x, y}] */
function runOcr(bin, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('识别超时（30 秒）'));
    }, 30000);
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `识别失败（退出码 ${code}）`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('识别结果读不出来'));
      }
    });
  });
}

/** 把某个文件行（化合物文件 / 实验附件）解析成磁盘绝对路径 */
function resolveFileOnDisk(scope, id) {
  if (scope === 'attachment') {
    // 实验附件按实验分子目录：data/attachments/<exp_id>/<filename>
    const row = db.prepare('SELECT exp_id, filename FROM attachments WHERE id = ?').get(Number(id));
    if (!row) return null;
    return path.join(ATTACH_DIR, String(row.exp_id), row.filename);
  }
  // 化合物文件：data/compounds/<compound_id>/<filename>
  const row = db.prepare('SELECT compound_id, filename FROM compound_files WHERE id = ?').get(Number(id));
  if (!row) return null;
  return path.join(COMPOUND_DIR, String(row.compound_id), row.filename);
}

route('POST', '/api/ocr', async (req, res) => {
  const body = await readJson(req);
  const scope = str(body.scope) === 'attachment' ? 'attachment' : 'compound';
  const file = resolveFileOnDisk(scope, body.file_id);
  if (!file) throw new HttpError(404, '找不到这个文件');
  const ext = path.extname(file).toLowerCase();
  if (!/^\.(png|jpe?g|webp|gif|tiff?|bmp|heic)$/.test(ext)) throw new HttpError(400, '这个文件不是图片，读不了');
  if (!fs.existsSync(file)) throw new HttpError(404, '磁盘上找不到这张图');
  const bin = await ensureOcrRenderer();
  const lines = await runOcr(bin, file);
  ok(res, { lines, text: lines.map((l) => l.text).join('\n') });
});

function runPrint(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('生成 PDF 超时（180 秒）'));
    }, 180000);
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`生成 PDF 失败：${err.split('\n').filter((l) => l && !l.includes('could not create directory')).slice(-2).join(' ') || `退出码 ${code}`}`));
    });
  });
}

const pageDoc = (fragment, css) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${fragment}</body></html>`;

/* 渲染期间临时页面要能被 WebKit 通过 http 取到（图片是 /api/... 同源路径） */
route('GET', '/api/print/page/:token/:idx', async (req, res, params) => {
  const dir = PRINT_TOKENS.get(params.token);
  const idx = Number(params.idx);
  if (!dir || !Number.isInteger(idx)) return fail(res, 404, '打印页已过期');
  const file = path.join(dir, `page${idx}.html`);
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    fail(res, 404, '打印页不存在');
  }
});

route('POST', '/api/print/pdf', async (req, res) => {
  const body = await readJson(req);
  const pages = Array.isArray(body.pages) ? body.pages.slice(0, 40).map(String).filter(Boolean) : [];
  if (!pages.length) return fail(res, 400, '没有要打印的内容');

  const token = crypto.randomUUID();
  const dir = path.join(os.tmpdir(), `eln-print-${token}`);
  PRINT_TOKENS.set(token, dir);

  try {
    await fsp.mkdir(dir, { recursive: true });
    const urls = [];
    for (let i = 0; i < pages.length; i++) {
      await fsp.writeFile(path.join(dir, `page${i + 1}.html`), pageDoc(pages[i], String(body.css || '')), 'utf8');
      urls.push(`http://127.0.0.1:${PORT}/api/print/page/${token}/${i + 1}`);
    }

    const bin = await ensurePrintRenderer();
    const out = path.join(dir, 'out.pdf');
    await runPrint(bin, [out, '595.28', '841.89', ...urls]);

    const data = await fsp.readFile(out);
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': data.length,
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(str(body.filename) || 'export.pdf')}`,
    });
    res.end(data);
  } catch (e) {
    fail(res, 500, e.message || 'PDF 生成失败');
  } finally {
    PRINT_TOKENS.delete(token);
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** 整页长图：把记录页（不分页、不裁切）整张截下来，像截屏但保留原始清晰度 */
route('POST', '/api/snapshot/png', async (req, res) => {
  const body = await readJson(req);
  const html = str(body.html);
  if (!html || html.length > 8_000_000) return fail(res, 400, '没有可导出的内容');
  const width = Math.min(2000, Math.max(480, Number(body.width) || 794));

  const token = crypto.randomUUID();
  const dir = path.join(os.tmpdir(), `eln-shot-${token}`);
  PRINT_TOKENS.set(token, dir);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'page1.html'), pageDoc(html, str(body.css)), 'utf8');
    const url = `http://127.0.0.1:${PORT}/api/print/page/${token}/1`;
    const bin = await ensureShotRenderer();
    const out = path.join(dir, 'out.png');
    await runPrint(bin, [out, String(width), url]);
    const data = await fsp.readFile(out);
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': data.length,
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(str(body.filename) || '记录.png')}`,
    });
    res.end(data);
  } catch (e) {
    fail(res, 500, e.message || '长图生成失败');
  } finally {
    PRINT_TOKENS.delete(token);
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/* 自己写一个「不压缩」的 zip：Linux/Windows 上没有 ditto，也不一定有 zip 命令，
   这里用 Node 直接拼 zip 结构（store 方式），文件名一律按 UTF-8 + bit 11 写。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zipStore(entryDir, rootName) {
  const parts = [];      // 本地文件头 + 数据
  const central = [];
  let offset = 0;
  const files = [];
  const walk = async (dir, prefix) => {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const name = `${prefix}${ent.name}`;
      if (ent.isDirectory()) {
        await walk(full, `${name}/`);
        files.push({ name: `${name}/`, data: Buffer.alloc(0), dir: true });
      } else {
        files.push({ name, data: await fsp.readFile(full) });
      }
    }
  };
  await walk(entryDir, `${rootName}/`);

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const flags = 0x0800;                     // bit 11：文件名是 UTF-8
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);               // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);                // store
    local.writeUInt32LE(0, 10);               // time/date 留 0
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, f.data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(f.dir ? 0x10 : 0, 38);  // 外部属性：目录
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + f.data.length;
  }

  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

/**
 * 给 zip 里中文文件名补上「UTF-8 名字」标志位（bit 11）。
 * macOS 的 zip / ditto 都把名字按 UTF-8 写进去却不置位，Windows 的解压工具就会按
 * cp437 解成乱码。这里扫一遍中央目录，名字是非 ASCII 又恰好是合法 UTF-8 的，就把标志位补上。
 */
function fixZipUtf8Names(buf) {
  const out = Buffer.from(buf);
  // 从尾部找 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = out.length - 22; i >= 0 && i > out.length - 70000; i -= 1) {
    if (out.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = out.readUInt16LE(eocd + 10);
  let p = out.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= out.length; n += 1) {
    if (out.readUInt32LE(p) !== 0x02014b50) break;
    const flagPos = p + 8;
    const nameLen = out.readUInt16LE(p + 28);
    const name = out.subarray(p + 46, p + 46 + nameLen);
    const localAt = out.readUInt32LE(p + 42);
    const ascii = name.every((c) => c < 0x80);
    if (!ascii && !(out.readUInt16LE(flagPos) & 0x800)) {
      const text = name.toString('utf8');
      // 解回来再编码一致 = 真的是合法 UTF-8，才敢改标志位
      if (Buffer.from(text, 'utf8').equals(name)) {
        out.writeUInt16LE(out.readUInt16LE(flagPos) | 0x800, flagPos);
        if (localAt + 8 <= out.length) {
          out.writeUInt16LE(out.readUInt16LE(localAt + 6) | 0x800, localAt + 6);
        }
      }
    }
    p += 46 + nameLen + out.readUInt16LE(p + 30) + out.readUInt16LE(p + 32);
  }
  return out;
}

/**
 * 导出「打包」：一个 zip，里面是
 *   记录.html —— 自包含网页（CSS 内嵌、图片内联），双击就能看
 *   附件/      —— 原始文件（谱图、谱图原始数据、TLC 照片……一份不少）
 *   数据.json  —— 这条记录的原始数据（想二次处理/迁移时用）
 * 用系统自带的 zip 打，不引依赖。
 */
route('POST', '/api/export/bundle', async (req, res) => {
  const body = await readJson(req);
  const html = str(body.html);
  const id = Number(body.expId);
  const exp = id ? getExperiment(id) : null;
  if (!html || !exp) return fail(res, 400, '没有可导出的内容');

  const name = safeName(str(body.filename) || `${exp.code || '记录'}`).replace(/\.zip$/i, '');
  let dir;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'eln-bundle-'));
    const root = path.join(dir, name);
    await fsp.mkdir(path.join(root, '附件'), { recursive: true });
    await fsp.writeFile(path.join(root, '记录.html'), html, 'utf8');
    await fsp.writeFile(path.join(root, '数据.json'), JSON.stringify(exp, null, 2), 'utf8');
    for (const a of exp.attachments || []) {
      const src = path.join(ATTACH_DIR, String(exp.id), a.filename);
      try {
        const dest = path.join(root, '附件', safeName(a.original_name || a.filename));
        await fsp.copyFile(src, dest);
      } catch {
        /* 文件不在了就跳过，别让整包失败 */
      }
    }
    const zipPath = path.join(dir, `${name}.zip`);
    // 优先 ditto（macOS）；没有就用 zip 命令；都没有（或都失败）就用内置的 store 打包。
    // 目标只有一个：中文文件名在每个解压工具里都不乱码（UTF-8 标志位）。
    let data = null;
    for (const cmd of ['ditto', 'zip']) {
      const args = cmd === 'ditto'
        ? ['-c', '-k', '--keepParent', root, zipPath]
        : ['-r', '-q', zipPath, name];
      try {
        await new Promise((resolve, reject) => {
          const p = spawn(cmd, args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
          p.stderr.on('data', () => {});
          p.on('error', reject);
          p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        });
        data = fixZipUtf8Names(await fsp.readFile(zipPath));
        break;
      } catch {
        data = null;
      }
    }
    if (!data) data = await zipStore(root, name);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': data.length,
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`,
    });
    res.end(data);
  } catch (e) {
    fail(res, 500, e.message || '打包失败');
  } finally {
    if (dir) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/* ------------------------------------------------- 本机 → 服务器 单向同步 */

/**
 * 为什么放在服务里而不是 launchd/cron：macOS 的后台任务访问不了外置卷
 * （/Volumes/...），实测 launchd 起来就 EX_CONFIG。而本机服务是用户在终端里启动的，
 * 权限和 Finder 里双击时一样，能正常读 data/、跑 ssh。
 * 服务器那份没有这个脚本 → 直接 501，避免误会。
 */
const SYNC_SCRIPT = path.join(__dirname, '..', 'scripts', 'sync-server.sh');
let syncRunning = false;

route('POST', '/api/sync/server', async (req, res) => {
  if (!fs.existsSync(SYNC_SCRIPT)) {
    return fail(res, 501, '这台机器不是主库（没有同步脚本）');
  }
  if (syncRunning) return fail(res, 409, '上一次同步还没结束');
  syncRunning = true;
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn('/bin/bash', [SYNC_SCRIPT], {
        cwd: path.dirname(SYNC_SCRIPT),
        env: { ...process.env, PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      const timer = setTimeout(() => {
        p.kill('SIGKILL');
        reject(new Error('同步超时（10 分钟）'));
      }, 600_000);
      p.stdout.on('data', (d) => (log += String(d)));
      p.stderr.on('data', (d) => (log += String(d)));
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(log);
        else reject(new Error(log.trim().split('\n').slice(-3).join(' ') || `退出码 ${code}`));
      });
    });
    setSetting('sync_last_at', nowISO());
    ok(res, { log: out.slice(-4000), at: nowISO() });
  } catch (e) {
    fail(res, 500, e.message || '同步失败');
  } finally {
    syncRunning = false;
  }
});

/** 自动同步：服务开着的时候按间隔跑（没开服务就不跑，这是本机应用的正常状态） */
let autoSyncTimer = null;
function scheduleAutoSync() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
  if (getSetting('auto_sync') !== '1' || !fs.existsSync(SYNC_SCRIPT)) return;
  autoSyncTimer = setInterval(async () => {
    if (syncRunning) return;
    syncRunning = true;
    try {
      await new Promise((resolve, reject) => {
        const p = spawn('/bin/bash', [SYNC_SCRIPT], { cwd: path.dirname(SYNC_SCRIPT), stdio: 'ignore' });
        p.on('error', reject);
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`退出码 ${code}`))));
      });
      setSetting('sync_last_at', nowISO());
      console.log('  自动同步      →  已推送到服务器');
    } catch (e) {
      console.log('  自动同步      →  失败：' + (e.message || e));
    } finally {
      syncRunning = false;
    }
  }, 6 * 3600 * 1000);          // 每 6 小时；同步脚本自己会做一致性快照
}

/* ------------------------------------- 结构信息查询（PubChem；联网 + 本地缓存） */

/**
 * 画完/粘完一个结构，想知道「这是什么」：查 PubChem 的 PUG REST（免费、无需 key）。
 * 按 SMILES（其次 InChIKey、名称）换 CID，再取 IUPAC 名 / 分子式 / 分子量 / 同义词里的 CAS。
 * 结果按查询键缓存在 `.cache/lookup/`（30 天），断网或 PubChem 抽风时用旧缓存顶上。
 * **ChemicalBook 没有公开接口**（而且抓页面会被反爬拦），所以那边只给前端一个跳转链接，
 * 不在这里抓。
 */
const PUBCHEM = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const LOOKUP_DIR = path.join(__dirname, '..', '.cache', 'lookup');
const LOOKUP_TTL = 30 * 24 * 3600 * 1000;
const CAS_RX = /^\d{2,7}-\d{2}-\d$/;

/** CAS 号有校验位（最后一位 = 前面数字从右往左加权 1,2,3… 求和 mod 10）：
    光靠正则会把供应商货号（2231932-21-1 这种）当成 CAS，实测踩过。 */
function casValid(cas) {
  const s = String(cas || '').trim();
  if (!CAS_RX.test(s)) return false;
  // CAS_RX 没有分组，直接按「前段-中段-校验位」拆
  const [head, mid, check] = s.split('-');
  const digits = (head + mid).split('').reverse();
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (i + 1);
  return sum % 10 === Number(check);
}

const UA = 'ELN-local/1.0 (personal notebook)';

/**
 * 本机的系统代理（macOS「网络」里配的 HTTP/HTTPS 代理，Clash 之类）。
 * **Node 自己不认系统代理**：wikidata.org 直连被挡时 curl 一秒就回来、程序却一路超时
 * （实测踩过），所以这里自己把代理读出来手搭 CONNECT 隧道。
 */
let proxyCache;
function systemProxy() {
  if (proxyCache !== undefined) return proxyCache;
  proxyCache = null;
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (env) {
    try {
      const u = new URL(env);
      if (u.hostname) {
        proxyCache = {
          host: u.hostname,
          port: Number(u.port) || 8080,
          auth: u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` : '',
        };
        return proxyCache;
      }
    } catch {
      /* 环境变量写坏了就当没有 */
    }
  }
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 });
    // scutil 的格式是一行一个「键 : 值」，用正则拼容易在模板字符串的转义上翻车，
    // 直接按「冒号前那截等于键」找
    const pick = (key) => {
      for (const line of out.split('\n')) {
        const k = line.indexOf(':');
        if (k > 0 && line.slice(0, k).trim() === key) return line.slice(k + 1).trim();
      }
      return '';
    };
    if (pick('HTTPSEnable') === '1' && pick('HTTPSProxy')) {
      proxyCache = { host: pick('HTTPSProxy'), port: Number(pick('HTTPSPort')) || 8080, auth: '' };
    } else if (pick('HTTPEnable') === '1' && pick('HTTPProxy')) {
      proxyCache = { host: pick('HTTPProxy'), port: Number(pick('HTTPPort')) || 8080, auth: '' };
    }
  } catch {
    /* 没有 scutil（非 macOS）就直连 */
  }
  return proxyCache;
}

/** 哪些主机要走代理：跑过一遍就记住，省得每次先等直连超时 */
const PROXY_HOSTS = new Map();

function readJsonResponse(r, resolve, reject, kill) {
  let buf = '';
  r.setEncoding('utf8');
  r.on('data', (c) => {
    buf += c;
    if (buf.length > 4e6) kill(new Error('上游响应太大'));
  });
  r.on('end', () => {
    if (r.statusCode === 404) return resolve(null);
    if (r.statusCode !== 200) return reject(new Error(`上游返回 ${r.statusCode}`));
    try {
      resolve(JSON.parse(buf));
    } catch {
      reject(new Error('上游返回的不是 JSON'));
    }
  });
}

/** 直连取 JSON：404 当「查不到」返回 null，其它非 200 抛错 */
function getDirect(target, ms = 12000) {
  return new Promise((resolve, reject) => {
    const lib = target.startsWith('https:') ? https : http;
    const req = lib.get(
      target,
      { headers: { 'user-agent': UA, accept: 'application/json' }, timeout: ms },
      (r) => readJsonResponse(r, resolve, reject, (e) => req.destroy(e))
    );
    req.on('timeout', () => req.destroy(new Error('查询超时')));
    req.on('error', reject);
  });
}

/** 走系统代理（https 用 CONNECT 隧道） */
function getViaProxy(target, proxy, ms = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const port = Number(u.port) || (u.protocol === 'http:' ? 80 : 443);
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${u.hostname}:${port}`,
      timeout: ms,
      headers: { host: `${u.hostname}:${port}`, ...(proxy.auth ? { 'proxy-authorization': proxy.auth } : {}) },
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('代理连接超时')));
    connectReq.on('error', reject);
    connectReq.on('connect', (r, socket) => {
      if (r.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`代理拒绝（${r.statusCode}）`));
      }
      const req = https.request(
        {
          socket,
          agent: false,
          servername: u.hostname,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          timeout: ms,
          headers: { host: u.host, 'user-agent': UA, accept: 'application/json' },
        },
        (res) => readJsonResponse(res, resolve, reject, (e) => req.destroy(e))
      );
      req.on('timeout', () => req.destroy(new Error('查询超时')));
      req.on('error', reject);
      req.end();
    });
    connectReq.end();
  });
}

/** 取 JSON：有系统代理就先走代理（跟浏览器一致），不通再直连；这台主机怎么走记住 */
async function fetchJson(target, ms = 12000) {
  let host = '';
  try {
    host = new URL(target).hostname;
  } catch {
    throw new Error('地址不对');
  }
  const proxy = systemProxy();
  const viaProxy = !!proxy && PROXY_HOSTS.get(host) !== 'direct';
  let lastErr = null;
  if (viaProxy) {
    try {
      const out = await getViaProxy(target, proxy, ms);
      PROXY_HOSTS.set(host, 'proxy');
      return out;
    } catch (e) {
      lastErr = e;
      PROXY_HOSTS.set(host, 'direct');   // 代理不认这台主机，后面都直连
    }
  }
  try {
    return await getDirect(target, ms);
  } catch (e) {
    throw lastErr || e;
  }
}

const pubchemCids = async (kind, value) => {
  const path = kind === 'smiles' ? 'smiles' : kind === 'inchikey' ? 'inchikey' : 'name';
  const data = await fetchJson(`${PUBCHEM}/compound/${path}/${encodeURIComponent(value)}/cids/JSON`);
  const list = data && data.IdentifierList && data.IdentifierList.CID;
  return Array.isArray(list) ? list : [];
};

/** 一次完整查询；查不到返回 { found:false } */
async function pubchemLookup(kind, value) {
  const cids = await pubchemCids(kind, value);
  if (!cids.length) return { found: false, query: value };
  const cid = cids[0];
  // 三个请求互不依赖，一起发：不然一次查询要串行等 3 秒（用户会问「快吗」）
  const [table, syn, props] = await Promise.all([
    fetchJson(`${PUBCHEM}/compound/cid/${cid}/property/IUPACName,MolecularFormula,MolecularWeight,InChIKey/JSON`),
    fetchJson(`${PUBCHEM}/compound/cid/${cid}/synonyms/JSON`).catch(() => null),
    pubchemProps(cid),
  ]);
  const p = (table && table.PropertyTable && table.PropertyTable.Properties && table.PropertyTable.Properties[0]) || {};
  const list = (syn && syn.InformationList && syn.InformationList.Information && syn.InformationList.Information[0] &&
    syn.InformationList.Information[0].Synonym) || [];
  // 校验位能挡掉「长得像 CAS 的供应商货号」；按登记号从小到大排，最小的一般就是母体的 CAS
  const cas = list
    .map(String)
    .filter(casValid)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .slice(0, 3);
  return {
    found: true,
    query: value,
    cid,
    name: str(p.IUPACName),
    formula: str(p.MolecularFormula),
    mw: p.MolecularWeight ? String(p.MolecularWeight) : '',
    inchikey: str(p.InChIKey),
    cas,
    props,
    url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
    others: cids.slice(1, 4),
  };
}

/** PubChem 的「实验性质」那一节：熔点 / 沸点 / 密度 / 闪点 / 性状 / 溶解度
    （PUG REST 的 property 接口没有这些，只能走 pug_view，一次取一整节，约 78 KB） */
const PUG_VIEW = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound';

function collectHeadings(sec, wanted, out) {
  const head = str(sec.TOCHeading).trim();
  if (wanted.has(head)) {
    for (const info of sec.Information || []) {
      for (const m of (info.Value && info.Value.StringWithMarkup) || []) {
        if (m && m.String) out[head].push(String(m.String).trim());
      }
      const num = info.Value && info.Value.Number;
      if (num != null) out[head].push(String(num));
    }
  }
  for (const child of sec.Section || []) collectHeadings(child, wanted, out);
}

/**
 * 优先挑带 ℃ 的那条（化学习惯），没有就第一条，然后把「(NTP, 1992)」「at 760 mmHg」「- Denser than water…」
 * 这些出处 / 补充说明砍掉——否则一行物性会拖成两屏。max 控制长度。
 */
function pickProp(list, max = 40, stripAt = true) {
  const arr = (list || []).map((x) => String(x).trim()).filter(Boolean);
  if (!arr.length) return '';
  let v = arr.find((x) => /°C|℃/.test(x)) || arr[0];
  v = v
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+[-–]\s.*$/, '')   // 只砍「空格-空格」这种补充说明，别把 needle-like 砍断
    .replace(/\s*;.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 「1.4 at 20 °C/4 °C」这种测定条件，数字后面那截去掉（溶解度例外，那是它的意思）
  if (stripAt) v = v.replace(/\s+at\s+[\d.].*$/i, '').trim();
  if (!v) v = arr[0];
  return v.length > max ? `${v.slice(0, max - 1).trim()}…` : v;
}

async function pubchemProps(cid) {
  const wanted = new Set(['Melting Point', 'Boiling Point', 'Density', 'Flash Point', 'Color/Form', 'Physical Description', 'Solubility']);
  const got = {};
  for (const k of wanted) got[k] = [];
  try {
    const data = await fetchJson(`${PUG_VIEW}/${cid}/JSON?heading=Experimental+Properties`, 15000);
    for (const sec of (data && data.Record && data.Record.Section) || []) collectHeadings(sec, wanted, got);
  } catch {
    return {}; // 这一节没有就只拿到名称 / CAS，不算失败
  }
  return {
    mp: pickProp(got['Melting Point']),
    bp: pickProp(got['Boiling Point']),
    density: pickProp(got.Density, 28),
    flash: pickProp(got['Flash Point']),
    // 性状常常是一整句，留长一点（表单那一格是整行）
    appearance: pickProp(got['Color/Form'].length ? got['Color/Form'] : got['Physical Description'], 80, false),
    solubility: pickProp(got.Solubility, 60, false),
  };
}

/** 缓存：同一个结构别每次都去敲 PubChem */
function lookupCachePath(kind, value) {
  const h = crypto.createHash('sha1').update(`${kind}:${value}`).digest('hex');
  return path.join(LOOKUP_DIR, `${h}.json`);
}

/* --- 名字查不到时的第二、第三个来源（都是免费公开接口，不需要 key） ---------------
   OPSIN：系统命名 / IUPAC 名 → SMILES。拿到 SMILES 就能在**本地**算出分子式和 MW
          （前端 lib/chem.js，openchemlib），所以这里只回 SMILES 不算重量。
   Wikidata：中文名也能搜（PubChem 只认英文 / CAS），P274 分子式、P2067 分子量。 */
const OPSIN = 'https://www.ebi.ac.uk/opsin/ws';

async function opsinLookup(name) {
  const r = await fetchJson(`${OPSIN}/${encodeURIComponent(name)}.json`, 6000);
  if (!r || str(r.status) !== 'SUCCESS' || !str(r.smiles)) return null;
  return {
    found: true,
    source: 'opsin',
    query: name,
    name,
    smiles: str(r.smiles),
    inchikey: str(r.stdinchikey),
    formula: '',
    mw: '',
    cas: [],
    props: {},
    url: `${OPSIN}/${encodeURIComponent(name)}.json`,
  };
}

/** 给「可能很慢的备用源」套一个总超时：宁可查不到，也别让录数据等十几秒 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function wikidataLookup(name) {
  // 用 CirrusSearch 的 `haswbstatement:P274` 直接把「有分子式属性」的条目筛出来，
  // 这样中文名也能命中，而且不会像 wbsearchentities 那样返回一堆同名的非化学条目。
  const hit = await fetchJson(
    'https://www.wikidata.org/w/api.php?action=query&list=search&srnamespace=0&srlimit=3&format=json' +
      `&srsearch=${encodeURIComponent(`${name} haswbstatement:P274`)}`,
    8000
  ).catch(() => null);
  const ids = ((hit && hit.query && hit.query.search) || []).map((x) => str(x.title)).filter((t) => /^Q\d+$/.test(t)).slice(0, 2);
  if (!ids.length) return null;
  // 候选条目**一起取**：串着取两个实体就要 5 秒，中文名一查用户就以为卡死了
  const ents = await Promise.all(
    ids.map((id) => fetchJson(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, 10000).catch(() => null))
  );
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const ent = ents[i] && ents[i].entities && ents[i].entities[id];
    const claims = ent && ent.claims;
    if (!claims) continue;
    // Wikidata 的分子式常带下标字符（C₇H₆O），统一成普通数字再给前端
    const formula = str((claims.P274 || [])[0]?.mainsnak?.datavalue?.value)
      .replace(/[₀-₉]/g, (c) => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(c)));
    const amount = (claims.P2067 || [])[0]?.mainsnak?.datavalue?.value?.amount;
    const mw = amount == null ? '' : String(Math.round(Number(amount) * 1000) / 1000);
    if (!formula && !mw) continue;
    const label = (ent.labels && ((ent.labels.zh && ent.labels.zh.value) || (ent.labels.en && ent.labels.en.value))) || name;
    return {
      found: true,
      source: 'wikidata',
      query: name,
      name: str(label),
      formula,
      mw,
      cas: [],
      props: {},
      url: `https://www.wikidata.org/wiki/${id}`,
    };
  }
  return null;
}

/** 查一次名字 / 结构的主流程：PubChem →（按名字时）OPSIN → Wikidata，结果按查询键缓存 30 天。
 *  `/api/lookup`、试剂库的「核对」、新试剂进库时的自动核对，共用这一份，别再各写一遍。
 *  force = 不信缓存，重查一遍（手动「核对」用）。
 *  返回 { info, cached, stale, netErr }：info 为 null = 一个源都没答上来（基本就是断网）。 */
async function lookupInfo(kind, value, { force = false } = {}) {
  const file = lookupCachePath(kind, value);
  let stale = null;
  if (!force) {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (raw && raw.info) {
        if (Date.now() - (raw.at || 0) < LOOKUP_TTL) return { info: raw.info, cached: true };
        stale = raw.info;
      }
    } catch {
      /* 没缓存 */
    }
  }
  let info = null;
  let netErr = null;
  try {
    info = await pubchemLookup(kind, value);
  } catch (e) {
    netErr = e;   // PubChem 不通就先记下，后面还有别的源可以试
  }
  // PubChem 没有 → 再问 OPSIN（系统命名）和 Wikidata（中文名）；都是按名字查才有意义
  if ((!info || !info.found) && kind === 'name') {
    for (const [source, budget] of [[opsinLookup, 7000], [wikidataLookup, 10000]]) {
      try {
        const alt = await withTimeout(source(value), budget);
        if (alt) { info = alt; break; }
      } catch {
        /* 这个源不通就跳过，不影响别的源 */
      }
    }
  }
  if (!info) return { info: null, stale, netErr };
  if (!info.found && stale) return { info: stale, cached: true, stale: true };
  try {
    await fsp.mkdir(LOOKUP_DIR, { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ at: Date.now(), info }), 'utf8');
  } catch {
    /* 缓存写不进去也不要紧 */
  }
  return { info, cached: false };
}

route('GET', '/api/lookup', async (req, res, params, url) => {
  const smiles = str(url.searchParams.get('smiles')).trim();
  const inchikey = str(url.searchParams.get('inchikey')).trim();
  const q = str(url.searchParams.get('q')).trim();
  const kind = smiles ? 'smiles' : inchikey ? 'inchikey' : q ? 'name' : '';
  const value = smiles || inchikey || q;
  if (!kind) throw new HttpError(400, '要带 smiles / inchikey / q 其中一个');
  if (value.length > 800) throw new HttpError(400, '查询内容太长');

  const got = await lookupInfo(kind, value);
  if (!got.info) throw new HttpError(502, `查不到（${(got.netErr && got.netErr.message) || '网络不通'}）`);
  ok(res, {
    ...got.info,
    ...(got.cached ? { cached: true } : {}),
    ...(got.stale ? { stale: true } : {}),
  });
});

/* --- 试剂库：**输入过的**试剂都登记在 reagent_lib 里（删了记录也留着） ----------
   两个计数：
     used = 历史上引用过它的记录数（reagent_uses，只增不减）
     live = 现在还有几条记录在用（reagents 里现存的，按课题筛）
   底物不进试剂库（那是化合物库的事）。 */
// 密度只有对「按体积量」的组分有意义（跟 src/lib/reagent.js 的 VOLUME_ROLES 保持一致）
const DENSITY_ROLES = new Set(['溶剂', '添加剂', '试剂']);

function reagentLibRows(project, kw) {
  const projectArgs = project ? [project] : [];
  const lib = db
    .prepare(
      `SELECT l.key, l.name, l.role, l.mw, l.conc, l.density, l.updated_at, l.checked_at, l.check_state,
              (SELECT COUNT(*) FROM reagent_uses u WHERE u.key = l.key) AS used,
              (SELECT COUNT(DISTINCT r.exp_id) FROM reagents r JOIN experiments e ON e.id = r.exp_id
                WHERE lower(trim(r.name)) = l.key ${project ? 'AND e.project = ?' : ''}) AS live,
              (SELECT MAX(e.date) FROM reagents r JOIN experiments e ON e.id = r.exp_id
                WHERE lower(trim(r.name)) = l.key ${project ? 'AND e.project = ?' : ''}) AS last_at,
              (SELECT e.code FROM reagents r JOIN experiments e ON e.id = r.exp_id
                WHERE lower(trim(r.name)) = l.key ${project ? 'AND e.project = ?' : ''} ORDER BY r.id DESC LIMIT 1) AS last_code
         FROM reagent_lib l
        WHERE trim(l.role) <> '底物'
        ORDER BY live DESC, used DESC, l.name COLLATE NOCASE`
    )
    .all(...(project ? [...projectArgs, ...projectArgs, ...projectArgs] : []));

  // 同一个试剂用过的「用法」标签（当量 / 组分，溶剂是用量）→ 一个试剂一条，标签挂在它下面。
  // 读 reagent_variant_uses：保存时**只加不删**，所以记录后来改了当量、甚至删了，旧的标签也还在。
  const varRows = db
    .prepare('SELECT key, vkey, eq, role, volume_ul AS ul, exp_id FROM reagent_variant_uses ORDER BY at')
    .all();
  const expMeta = new Map(
    db.prepare('SELECT id, date, code FROM experiments').all().map((e) => [e.id, { date: str(e.date), code: str(e.code) }])
  );
  const variantsByKey = new Map();
  for (const u of varRows) {
    let m = variantsByKey.get(u.key);
    if (!m) variantsByKey.set(u.key, (m = new Map()));
    let v = m.get(u.vkey);
    if (!v) m.set(u.vkey, (v = { vkey: u.vkey, eq: str(u.eq), role: str(u.role), ul: numOrNull(u.ul), exps: new Set(), lastAt: '', lastCode: '' }));
    if (u.exp_id) v.exps.add(u.exp_id);
    const meta = expMeta.get(u.exp_id);
    if (meta && meta.date >= v.lastAt) {
      v.lastAt = meta.date;
      v.lastCode = meta.code;
    }
  }
  const variantsOf = (key) =>
    [...(variantsByKey.get(key) || new Map()).values()]
      .map((v) => ({ vkey: v.vkey, eq: v.eq, role: v.role, ul: v.ul, n: v.exps.size, lastAt: v.lastAt, lastCode: v.lastCode }))
      .sort((x, y) => y.n - x.n || String(y.lastAt).localeCompare(String(x.lastAt)))
      .slice(0, 8);

  const k = str(kw).trim().toLowerCase();
  return lib
    .filter((it) => !k || it.name.toLowerCase().includes(k) || str(it.role).includes(k))
    .map((it) => {
      const density = it.density != null && it.density >= 0.3 && it.density <= 3.5 ? it.density : null;
      const mw = it.mw;
      return {
        key: it.key,
        name: it.name,
        role: it.role,
        mw,
        conc: it.conc,
        density,
        used: it.used,
        live: it.live,
        lastAt: it.last_at || '',
        lastCode: it.last_code || '',
        // 这个试剂用过的所有「当量 / 组分」组合，用得最多的排前面；defaultEq 给「从试剂库选」用
        variants: variantsOf(it.key),
        defaultEq: (variantsOf(it.key)[0] || {}).eq ?? null,
        defaultUl: (variantsOf(it.key)[0] || {}).ul ?? null,
        // checkedAt 空 = 还没联网核过；miss = 核了，三个库都没有（下次别再自动去敲）
        checkedAt: it.checked_at || '',
        checkState: it.check_state || '',
        per_mmol_g: mw ? Math.round((mw / 1000) * 10000) / 10000 : null,
        // 「1 mmol ≈ 多少 µL」只对按体积量的组分有意义（溶剂 / 添加剂 / 普通试剂）；
        // 配体 / 碱 / 催化剂多是固体，按 g 称，别给它折 µL（RuPhos 被折成 363 µL）
        per_mmol_ul:
          mw && density && DENSITY_ROLES.has(str(it.role).trim())
            ? Math.round((mw / density) * 10) / 10
            : null,
      };
    });
}

route('GET', '/api/reagents', async (req, res, params, url) => {
  const q = Object.fromEntries(url.searchParams.entries());
  const items = reagentLibRows(str(q.project), str(q.q));
  ok(res, { items, total: items.length });
});

/* --- 核对：拿名字重查 PubChem → OPSIN → Wikidata，查到的 MW / 密度写回试剂库 -------
   三种触发：
     ① 新名字进库（touchReagentLib）→ 后台自动核一次，不阻塞保存；
     ② 试剂库行尾的「核对」→ 单条，force 重查（不信缓存）；
     ③ 试剂库顶上的「全部核对」→ 一批一批地喂 verify-all，前端好显示进度。
   查不到的也记 checked_at + 'miss'，不然每次保存都会再去敲一遍网。 */

/** SMILES → 分子量。服务端本来零依赖，能借到 openchemlib 就算一下（OPSIN 只回 SMILES，
 *  拿不到库就留空，绝不因为算重量把核对判失败）。 */
let oclLib = null;
let oclTried = false;
function mwFromSmiles(smiles) {
  try {
    if (!oclTried) {
      oclTried = true;
      oclLib = require(path.join(__dirname, '..', 'node_modules', 'openchemlib', 'dist', 'openchemlib.debug.js'));
    }
    if (!oclLib) return null;
    const f = oclLib.Molecule.fromSmiles(String(smiles)).getMolecularFormula();
    const w = Number(f && f.relativeWeight);
    return Number.isFinite(w) && w > 0 ? Math.round(w * 100) / 100 : null;
  } catch {
    return null;
  }
}

/** 常见元素的原子量（够覆盖有机实验室见到的；表里没有的元素就放弃，宁可空着也别算错） */
// 标准原子量（IUPAC，多留几位再四舍五入）——少留一位会把 P(Cy)3 算成 280.44 这种
const ATOMIC_WEIGHT = {
  H: 1.00794, B: 10.811, C: 12.0107, N: 14.0067, O: 15.9994, F: 18.9984032, Na: 22.98977,
  Mg: 24.305, Al: 26.981538, Si: 28.0855, P: 30.973762, S: 32.065, Cl: 35.453, K: 39.0983,
  Li: 6.941, Be: 9.012182, Ti: 47.867, Cr: 51.9961, Mn: 54.938045, Fe: 55.845, Co: 58.933195,
  Ni: 58.6934, Cu: 63.546, Zn: 65.38, Ge: 72.64, As: 74.9216, Se: 78.96, Br: 79.904,
  Rb: 85.4678, Sr: 87.62, Mo: 95.94, Ru: 101.07, Rh: 102.9055, Pd: 106.42, Ag: 107.8682,
  Cd: 112.411, In: 114.818, Sn: 118.71, Sb: 121.76, Cs: 132.9054519, Ba: 137.327,
  Pt: 195.084, Au: 196.966569, Hg: 200.59, Tl: 204.3833, Pb: 207.2, Bi: 208.9804,
  I: 126.90447,
};

/** 分子式 → 分子量。Wikidata 的 P2067 偶尔不准（实测 DCM 写成 83.95，其实是 84.93），
 *  有分子式就自己按原子量算一遍更靠得住；带电荷 / 结晶水记号的解析不了就返回 null。 */
function mwFromFormula(formula) {
  const f = str(formula).replace(/\s+/g, '');
  if (!f || /[^A-Za-z0-9]/.test(f)) return null;
  const rx = /([A-Z][a-z]?)(\d*)/g;
  let total = 0;
  let used = 0;
  let m;
  while ((m = rx.exec(f))) {
    const w = ATOMIC_WEIGHT[m[1]];
    if (w == null) return null;
    total += w * (m[2] ? Number(m[2]) : 1);
    used += m[0].length;
  }
  if (!used || used !== f.length || !(total > 0)) return null;
  return Math.round(total * 100) / 100;
}

/** 核对一个试剂（key 或名字都行）。返回 { ok, state: 'ok'|'miss'|'error', mw, density, … } */
async function verifyReagent(name, opts = {}) {
  const raw = str(name).trim();
  const key = raw.toLowerCase();
  if (!key) return { name: raw, ok: false, state: 'error', reason: '空名字' };
  const row = db.prepare('SELECT name, mw, density, manual FROM reagent_lib WHERE key = ?').get(key);
  // 用户手填过的字段（MW / 密度）不再被联网结果覆盖
  const manual = new Set(String((row && row.manual) || '').split(',').map((x) => x.trim()).filter(Boolean));
  const label = (row && row.name) || raw;
  let info = null;
  let netErr = null;
  try {
    const got = await lookupInfo('name', label, opts);
    info = got.info;
    netErr = got.netErr;
  } catch (e) {
    netErr = e;
  }
  if (!info) {
    // 一个源都没答上（多半是断网）：不算核过，留着下次再试
    return { name: label, ok: false, state: 'error', reason: (netErr && netErr.message) || '网络不通' };
  }
  const found = !!info.found;
  let mw = found ? numOrNull(info.mw) : null;
  const prevMw = numOrNull(row && row.mw);
  if (found && info.formula) {
    const calc = mwFromFormula(info.formula);
    if (calc != null) mw = calc;      // 分子式算出来的比某些源给的数字可信
  }
  if (mw == null && found && info.smiles) mw = mwFromSmiles(info.smiles);
  let density = null;
  if (found && info.props && info.props.density) {
    const d = Number(String(info.props.density).replace(/[^\d.]/g, ''));
    if (Number.isFinite(d) && d >= 0.3 && d <= 3.5) density = d;
  }
  const ts = nowISO();
  // 旧值只有「一位小数」的精度（280.4 → 界面显示成 280.40）时，用算出来更细的替换；
  // 手填的两位小数（280.43）不动，空值就补上
  const coarse = prevMw === null || Math.round(prevMw * 100) % 10 === 0;
  db.prepare(
    `UPDATE reagent_lib SET mw = COALESCE(?, mw), density = COALESCE(?, density),
            checked_at = ?, check_state = ?, updated_at = ? WHERE key = ?`
  ).run(
    !manual.has('mw') && mw != null && coarse ? mw : null,
    manual.has('density') ? null : density,
    ts,
    found ? 'ok' : 'miss',
    ts,
    key
  );
  return {
    name: label,
    key,
    ok: found,
    state: found ? 'ok' : 'miss',
    source: info.source || 'pubchem',
    mw,
    formula: info.formula || '',
    density,
    smiles: info.smiles || '',
  };
}

/* 新试剂进库时的后台核对：串行、一次一个、离线连败就停手（别在断网时反复等超时） */
const autoVerifyQueue = [];
const autoVerifySeen = new Set();
let autoVerifyBusy = false;
let autoVerifyFails = 0;

function queueReagentVerify(keys) {
  if (process.env.ELN_AUTO_VERIFY === '0') return;
  const list = [...new Set((keys || []).map((k) => str(k).trim().toLowerCase()).filter(Boolean))]
    .filter((k) => !autoVerifySeen.has(k) && !autoVerifyQueue.includes(k));
  if (!list.length) return;
  // 只核「MW 还空着、而且没核过」的；已经有人填过数字的不动
  const rows = db
    .prepare(
      `SELECT key FROM reagent_lib
        WHERE checked_at IS NULL AND mw IS NULL AND trim(role) <> '底物'
          AND key IN (${list.map(() => '?').join(',')})`
    )
    .all(...list);
  for (const r of rows) {
    autoVerifySeen.add(r.key);
    autoVerifyQueue.push(r.key);
  }
  if (autoVerifyQueue.length) setTimeout(drainReagentVerify, 400);
}

async function drainReagentVerify() {
  if (autoVerifyBusy) return;
  autoVerifyBusy = true;
  try {
    while (autoVerifyQueue.length && autoVerifyFails < 3) {
      const key = autoVerifyQueue.shift();
      try {
        const r = await verifyReagent(key);
        autoVerifyFails = r.state === 'error' ? autoVerifyFails + 1 : 0;
        if (r.state !== 'error') console.log(`[eln] 自动核对 ${r.name} → ${r.state}${r.mw ? ' MW ' + r.mw : ''}`);
      } catch {
        autoVerifyFails += 1;
      }
    }
  } finally {
    autoVerifyBusy = false;
  }
}

route('POST', '/api/reagents/verify', async (req, res) => {
  const body = await readJson(req);
  const name = str(body.name).trim();
  if (!name) throw new HttpError(400, '要带 name');
  ok(res, await verifyReagent(name, { force: !!body.force }));
});

/* 自定义「检索站点」：用户自己加的化学数据库，试剂库里「查无」时一起列出来。
   url 模板里用 {name} / {cas} 占位（只做跳转，不替用户抓页面——各家页面结构不同，
   硬解析迟早会坏；要抓特定字段得给解析规则，那是另一步）。 */
const DEFAULT_LOOKUP_SITES = [];
function lookupSites() {
  try {
    const raw = JSON.parse(getSetting('lookup_sites') || '[]');
    return Array.isArray(raw) ? raw.filter((x) => x && x.label && x.url).slice(0, 20) : [];
  } catch {
    return DEFAULT_LOOKUP_SITES;
  }
}

route('GET', '/api/lookup-sites', async (req, res) => ok(res, { items: lookupSites() }));

route('PUT', '/api/lookup-sites', async (req, res) => {
  const body = await readJson(req);
  const list = Array.isArray(body.items) ? body.items : [];
  const clean = [];
  for (const it of list) {
    const label = str(it && it.label).trim().slice(0, 24);
    const url = str(it && it.url).trim().slice(0, 400);
    if (!label || !url) continue;
    if (!/^https?:\/\//i.test(url)) throw new HttpError(400, `「${label}」的网址要是 http(s) 开头`);
    clean.push({ label, url });
    if (clean.length >= 20) break;
  }
  setSetting('lookup_sites', JSON.stringify(clean));
  ok(res, { items: clean });
});

/* 试剂库条目：改名 / 删除。
   库条目是从投料行汇总出来的，所以：
     · 改名 = 把所有记录里这个试剂名**一起改掉**（只改库不带记录的话，下次保存又长回旧名字）；
     · 删除 = 只删库条目（连同用法标签和「用过」计数）；还有记录在用的，下次保存会重新长出来，
       所以把 live 一起返回，界面据此提示。 */
route('PATCH', '/api/reagents/:key', async (req, res, params) => {
  const key = decodeURIComponent(String(params.key || '')).trim().toLowerCase();
  const body = await readJson(req);
  if (!key) throw new HttpError(400, '要带 key');
  const lib = db.prepare('SELECT * FROM reagent_lib WHERE key = ?').get(key);
  if (!lib) return fail(res, 404, '试剂库里没有这一条');

  // 手填 MW / 密度（只改这几个字段，不动名字）：填过就标记成 manual，
  // 以后「核对 / 自动核对」都不会再把它覆盖掉
  const hasMarks = body.mw !== undefined || body.density !== undefined || body.conc !== undefined;
  if (hasMarks) {
    const marks = new Set(String(lib.manual || '').split(',').map((x) => x.trim()).filter(Boolean));
    const mw = body.mw === undefined ? lib.mw : numOrNull(body.mw);
    const density = body.density === undefined ? lib.density : numOrNull(body.density);
    const conc = body.conc === undefined ? lib.conc : numOrNull(body.conc);
    if (body.mw !== undefined) marks.add('mw');
    if (body.density !== undefined) marks.add('density');
    // 手改过的值顺手写回所有还在用这个名字的投料行（记录页那边也跟着变）
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE reagent_lib SET mw = ?, density = ?, conc = ?, manual = ?, updated_at = ? WHERE key = ?').run(
        mw, density, conc, [...marks].join(','), nowISO(), key
      );
      db.prepare('UPDATE reagents SET mw = COALESCE(?, mw), density = COALESCE(?, density) WHERE lower(trim(name)) = ?').run(
        mw, density, key
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return ok(res, { key, mw, density, manual: [...marks].join(',') });
  }

  const name = str(body.name).trim();
  if (!name) throw new HttpError(400, '名字不能为空');
  const nextKey = name.toLowerCase();
  const ts = nowISO();
  // 改记录里的名字（同一事务里做完，别出现「库改了记录没改」）
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE reagents SET name = ? WHERE lower(trim(name)) = ?").run(name, key);
    db.prepare('DELETE FROM reagent_lib WHERE key = ?').run(nextKey);
    db.prepare('UPDATE reagent_lib SET key = ?, name = ?, updated_at = ? WHERE key = ?').run(nextKey, name, ts, key);
    db.prepare('UPDATE OR REPLACE reagent_uses SET key = ? WHERE key = ?').run(nextKey, key);
    db.prepare('UPDATE OR REPLACE reagent_variant_uses SET key = ? WHERE key = ?').run(nextKey, key);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  ok(res, { key: nextKey, name });
});

route('DELETE', '/api/reagents/:key', async (req, res, params) => {
  const key = decodeURIComponent(String(params.key || '')).trim().toLowerCase();
  if (!key) throw new HttpError(400, '要带 key');
  const live = db
    .prepare(
      `SELECT COUNT(DISTINCT r.exp_id) AS c FROM reagents r WHERE lower(trim(r.name)) = ?`
    )
    .get(key).c;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM reagent_lib WHERE key = ?').run(key);
    db.prepare('DELETE FROM reagent_uses WHERE key = ?').run(key);
    db.prepare('DELETE FROM reagent_variant_uses WHERE key = ?').run(key);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  ok(res, { removed: true, live });
});

/* 删掉一颗「用法」标签（填错过的那种）：只删标签，不动任何记录。
   下次这条记录再保存时它会重新长回来——标签本来就是「填过就记一笔」。 */
route('POST', '/api/reagents/variant-remove', async (req, res) => {
  const body = await readJson(req);
  const name = str(body.name || body.key).trim().toLowerCase();
  const vkey = str(body.vkey);
  if (!name || !vkey) throw new HttpError(400, '要带 name 和 vkey');
  const info = db.prepare('DELETE FROM reagent_variant_uses WHERE key = ? AND vkey = ?').run(name, vkey);
  ok(res, { removed: Number(info.changes) || 0 });
});

/* 全部核对：一次最多 20 个（默认 8），前端一轮一轮地调，好显示「核对了几个 / 还剩几个」。
   不传 names 就由服务端挑「还没核过、MW 空着」的条目，按用过的次数从多到少。 */
route('POST', '/api/reagents/verify-all', async (req, res) => {
  const body = await readJson(req);
  const limit = Math.min(Math.max(Number(body.limit) || 8, 1), 20);
  let names = Array.isArray(body.names) ? body.names.map((x) => str(x).trim()).filter(Boolean) : [];
  let remaining = 0;
  if (!names.length) {
    names = db
      .prepare(
        `SELECT l.name FROM reagent_lib l
          WHERE trim(l.role) <> '底物' AND l.mw IS NULL AND l.checked_at IS NULL
          ORDER BY (SELECT COUNT(*) FROM reagent_uses u WHERE u.key = l.key) DESC, l.name COLLATE NOCASE
          LIMIT ?`
      )
      .all(limit)
      .map((r) => r.name);
  } else {
    names = names.slice(0, limit);
  }
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor++];
      try {
        results.push(await verifyReagent(name, { force: !!body.force }));
      } catch (e) {
        results.push({ name, ok: false, state: 'error', reason: e.message || '核对失败' });
      }
    }
  };
  // 同时打 3 个源已经是 PubChem 能容忍的上限，再多容易被限流
  await Promise.all([worker(), worker(), worker()]);
  const count = (where) => db.prepare(`SELECT COUNT(*) AS n FROM reagent_lib WHERE trim(role) <> '底物' AND ${where}`).get().n;
  remaining = count('mw IS NULL AND checked_at IS NULL');
  ok(res, {
    results,
    remaining,
    checked: count("checked_at IS NOT NULL AND checked_at <> ''"),
    total: count('1 = 1'),
  });
});

/* --------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
      if (url.pathname.startsWith('/vendor/')) return serveVendor(req, res, url);
      return serveStatic(req, res, url);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      await r.handler(req, res, params, url);
      return;
    }
    fail(res, 404, `未知接口 ${req.method} ${url.pathname}`);
  } catch (err) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {}
      return;
    }
    const code = err instanceof HttpError ? err.code : 500;
    if (code === 500) console.error('[eln]', err);
    fail(res, code, err.message || '服务器错误');
  }
});

/* 备份用：无依赖的 zip 打包（store 模式，不压缩） */
async function zipDirectory(dir, res) {
  const files = [];
  const walk = async (cur, prefix) => {
    const entries = await fsp.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const name = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, name);
      else files.push({ full, name, size: (await fsp.stat(full)).size });
    }
  };
  await walk(dir, '');

  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const f of files) {
    const data = await fsp.readFile(f.full);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    res.write(local);
    res.write(nameBuf);
    res.write(data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  res.write(cenBuf);
  res.end(end);
}

/**
 * 每天自动备份一次（用户：「历史记录千万要做好，就是能回溯」）。
 * 用的是 scripts/backup.js 那一套（`VACUUM INTO` + 拷附件），写进 `.backups/<日期>/`，留 7 份。
 * 只在「本机装的那套」上跑：`ELN_DATA_DIR` 指到别处（云端演示站）时数据目录不是这个仓库，
 * 备份脚本对不上地方；那种环境用 `ELN_AUTO_BACKUP=0` 或者本来就有自己的重置策略。
 */
const AUTO_BACKUP = process.env.ELN_AUTO_BACKUP !== '0' && !process.env.ELN_DATA_DIR;
const BACKUP_DIR = path.join(__dirname, '..', '.backups');
// 默认 20 小时一次（一天一次，留 4 小时余量——不是精确 24h，开关机也能落上）；ELN_AUTO_BACKUP_HOURS 可调
const AUTO_BACKUP_EVERY_MS =
  Math.max(0.01, Number(process.env.ELN_AUTO_BACKUP_HOURS || 20)) * 60 * 60 * 1000;

function lastBackupTime() {
  try {
    const dirs = fs
      .readdirSync(BACKUP_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const db = path.join(BACKUP_DIR, d.name, 'eln.db');
        try {
          return fs.statSync(db).mtimeMs;
        } catch {
          return 0;
        }
      })
      .filter(Boolean);
    return dirs.length ? Math.max(...dirs) : 0;
  } catch {
    return 0;
  }
}

function maybeAutoBackup() {
  if (!AUTO_BACKUP) return;
  if (Date.now() - lastBackupTime() < AUTO_BACKUP_EVERY_MS) return;
  const script = path.join(__dirname, '..', 'scripts', 'backup.js');
  if (!fs.existsSync(script)) return;
  try {
    const { spawn } = require('node:child_process');
    // 后台跑，别让启动/请求等它；输出丢弃（失败了下一次还会再试）
    spawn(process.execPath, [script], { detached: true, stdio: 'ignore' }).unref();
    console.log('  自动备份        → 正在写 .backups/（每天一次，留 7 份）');
  } catch {
    /* 备份失败不影响服务 */
  }
}

function scheduleAutoBackup() {
  if (!AUTO_BACKUP) return;
  setTimeout(maybeAutoBackup, 8000);          // 起来 8 秒后再动手，别跟首屏抢 IO
  setInterval(maybeAutoBackup, 3 * 60 * 60 * 1000).unref();
}

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  // 另外在 Tailscale 网卡地址上也听一份（100.64.0.0/10）：
  // 手机浏览器的安全 DNS(DoH) 会绕过 MagicDNS，解析不了 *.ts.net 域名；
  // 直接用 100.x 的 IP + 端口就没这个问题，而这个地址只有 tailnet 内能访问。
  // 用 tailscale 自己报的地址，别靠网段猜：局域网的 100.x 也可能落进 100.64/10
  let tailnetIp = '';
  try {
    tailnetIp = String(require('node:child_process')
      .execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 3000 })
      .split('\n')[0] || '').trim();
  } catch {
    tailnetIp = '';
  }
  if (!/^100\.\d+\.\d+\.\d+$/.test(tailnetIp)) tailnetIp = '';
  if (tailnetIp) {
    const extra = http.createServer(server.listeners('request')[0]);
    extra.listen(port, tailnetIp, () => {
      console.log('  手机（tailnet）  →  http://' + tailnetIp + ':' + port + '/   ← 不走域名解析，浏览器都能开');
    });
  }

  server.listen(port, HOST, () => {
    // 真起在哪个端口就记哪个：二维码 base 和 PDF 渲染地址都读 PORT
    PORT = port;
    const url = `http://${HOST}:${port}`;
    console.log('');
    console.log('  方法学实验记录  →  ' + url);
    console.log('  数据目录        →  ' + DATA_DIR);
    console.log('');
    console.log('  关闭窗口或 Ctrl+C 停止。');
    console.log('');
    if (process.env.ELN_OPEN === '1') {
      // 三个平台各自的开浏览器方式（Windows 是 start，Linux 是 xdg-open）
      const { exec } = require('node:child_process');
      const cmd =
        process.platform === 'darwin' ? `open "${url}"`
        : process.platform === 'win32' ? `start "" "${url}"`
        : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });
}

// 联网查询走哪个口：没代理就是直连（这一行平时用不着关心，查不到东西时有用）
{
  const px = systemProxy();
  console.log(`  联网查询        → ${px ? `系统代理 ${px.host}:${px.port}` : '直连'}`);
}

// 后台先把 PDF 渲染器编译好（第一次生成 PDF 就不用等编译）
ensurePrintRenderer()
  .then(() => console.log('  打印渲染器      →  就绪（自己生成 A4 PDF）'))
  .catch((e) => console.log('  打印渲染器      →  不可用，只能用系统打印：' + e.message));

scheduleAutoBackup();
scheduleAutoSync();
listen(PORT);
