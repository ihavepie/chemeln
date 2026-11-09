'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const os = require('node:os');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const https = require('node:https');

const store = require('./db');
const qr = require('./qr');
const { experimentToMarkdown, screeningToMarkdown, screeningToCsv, CELL_CATEGORY } = require('./export');

const { db, DATA_DIR, ATTACH_DIR, COMPOUND_DIR, allSettings, getSetting, setSetting, nextCode, logEvent, logEdit, historyFor } = store;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// 第三方静态资源（Ketcher 结构画板等）：不放进 public/，因为每次 build 都会清空它
const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
// 端口占用了会自动往后找（见 listen()），所以这里的 PORT 要能被改；
// 二维码 base 和 PDF 渲染地址都读它，不同步就会出现「码指 4780、服务其实在 4781」。
let PORT = Number(process.env.PORT || 4780);
const HOST = process.env.HOST || '127.0.0.1';
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
  'steps_json', 'product_compound_id', 'category_id', 'group_id', 'scheme_rxn', 'scheme_smiles',
  'no_yield', 'apparatus', 'light',
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
  scheme_rxn: '反应式（画板）', scheme_smiles: '反应式（文本）', title: '标题', date: '日期', status: '状态', operator: '实验人', ambient_temp: '环境温度',
  ambient_humid: '湿度', project: '课题', rxn_type: '类型', literature: '文献', objective: '实验目的',
  solvent: '溶剂', concentration: '浓度', temperature: '温度', duration: '时间', atmosphere: '气氛',
  apparatus: '装置 / 器皿', light: '光照 / 波长',
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

/** 存进历史的值：太长就截断，别让一条表征数据把留痕撑爆 */
const shortVal = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  if (!s) return '';
  return s.length <= 80 ? s : `${s.slice(0, 60)}…（共 ${s.length} 字）`;
};

/**
 * 这次 PUT 改到了哪些字段，各自的改前 / 改后值。
 * 数字按字符串比，避免 71 与 "71" 算成两次改动。
 */
function changedFields(before, after, labels) {
  const out = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in labels)) continue;
    const a = before[k];
    const b = v;
    const same =
      a === null || a === undefined
        ? b === null || b === undefined || b === ''
        : b === null || b === undefined
          ? a === ''
          : String(a) === String(b);
    if (!same) out.push({ f: k, o: shortVal(a), n: shortVal(b) });
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
      eq: numOrNull(r.eq),
      mmol: numOrNull(r.mmol),
      mass_mg: numOrNull(r.mass_mg),
      volume_ul: numOrNull(r.volume_ul),
      note: str(r.note),
    }))
    .filter((r) => r.name || r.role || r.mw !== null || r.eq !== null);
}

function insertReagents(expId, reagents) {
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
    SELECT e.id, e.code, e.title, e.date, e.status, e.project, e.rxn_type,
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
           -- reagent_sig 是「角色:名字:当量」串起来的签名，列表靠它判断这条是不是真重复
           e.group_id,
           (SELECT COUNT(*) FROM experiments g WHERE g.group_id = e.group_id AND e.group_id <> '') AS group_size,
           (SELECT group_concat(x.sig, '|') FROM (
              SELECT r.role || ':' || r.name || ':' || IFNULL(r.eq, '') AS sig
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
 * 中文名取前两个字（「氨基环丁酮类」→「氨基」）。撞了后面加 2、3…
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
  for (const r of db
    .prepare("SELECT name, mw, conc, density FROM reagents WHERE name <> '' ORDER BY id DESC")
    .all()) {
    const k = r.name.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.set(k, { name: r.name.trim(), mw: r.mw, conc: r.conc, density: r.density });
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
    totals,
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
    compoundDict,
    compoundCount,
    compoundUnassigned: sharedCounts.cmp,
    sharedCounts,
    lanUrl: lanUrl(),
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

route('DELETE', '/api/projects/:name', async (req, res, params) => {
  const name = decodeURIComponent(params.name);
  const n = db.prepare('SELECT COUNT(*) AS n FROM experiments WHERE project = ?').get(name).n;
  const cmp = db.prepare('SELECT COUNT(*) AS n FROM compounds WHERE project = ?').get(name).n;
  const cats = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE project = ?').get(name).n;
  // 化合物和分类也要数：只数实验的话，删掉一个只有化合物/分类的课题，
  // 它们就变成「有 project 值但课题清单里没有」的孤儿，只能在「全部课题」里看到
  if (n || cmp || cats) {
    const bits = [];
    if (n) bits.push(`${n} 条记录`);
    if (cmp) bits.push(`${cmp} 个化合物`);
    if (cats) bits.push(`${cats} 个分类`);
    return fail(res, 409, `还有 ${bits.join('、')}在这个课题里，先处理掉再删`);
  }
  setSetting('projects_json', JSON.stringify(knownProjectNames().filter((x) => x !== name)));
  // 课题自己的前缀和覆盖设置一起清掉，免得同名重建时又冒出来
  db.prepare('DELETE FROM settings WHERE key = ? OR key LIKE ?').run(`prefix:${name}`, `proj:${name}:%`);
  ok(res, { items: listProjects() });
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
  ok(res, { compound: getCompound(id) });
});

route('DELETE', '/api/compounds/:id', async (req, res, params) => {
  const id = Number(params.id);
  const row = db.prepare('SELECT * FROM compounds WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '化合物不存在');
  // 跟实验一样走回收站：结构图 / 谱图文件留在盘上，「彻底删除」时才真删
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
  ok(res, { items, total });
});

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
  ok(res, { experiment: exp });
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
  const changed = changedFields(exp, data, EXP_FIELD_LABELS);
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
      const before = JSON.stringify(
        db.prepare('SELECT role, name, mw, conc, density, eq, mmol, mass_mg, volume_ul, note, step FROM reagents WHERE exp_id = ? ORDER BY position').all(id)
      );
      db.prepare('DELETE FROM reagents WHERE exp_id = ?').run(id);
      insertReagents(id, normalizeReagents(body.reagents));
      const after = JSON.stringify(
        db.prepare('SELECT role, name, mw, conc, density, eq, mmol, mass_mg, volume_ul, note, step FROM reagents WHERE exp_id = ? ORDER BY position').all(id)
      );
      if (before !== after) {
        const n = (s) => JSON.parse(s).length;
        changed.push({ f: 'reagents', o: `${n(before)} 行`, n: `${n(after)} 行` });
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

route('DELETE', '/api/experiments/:id', async (req, res, params) => {
  const id = Number(params.id);
  const row = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '实验不存在');
  if (row.locked) return fail(res, 423, '实验已锁定，解锁后才能删除');
  // 软删除：整条记录（含投料表 / 附件清单 / 被断开的引用）先拍成快照放进回收站，
  // 表里的行真删（查询就不用到处加过滤），附件文件留在盘上，等「彻底删除」再真删。
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

/* --- screenings --- */
route('GET', '/api/screenings', async (req, res) => {
  const rows = db.prepare('SELECT * FROM screenings ORDER BY id DESC').all().map(parseScreening);
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
      `INSERT INTO screenings(exp_id, title, note, vars_json, entries_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      numOrNull(body.exp_id),
      str(body.title) || '未命名条件筛选',
      str(body.note),
      JSON.stringify(Array.isArray(body.vars) ? body.vars.map(String) : ['催化剂', '溶剂', '温度']),
      JSON.stringify([]),
      ts,
      ts
    );
  ok(res, { screening: parseScreening(db.prepare('SELECT * FROM screenings WHERE id = ?').get(Number(row.lastInsertRowid))) });
});

route('GET', '/api/screenings/:id', async (req, res, params) => {
  const s = parseScreening(db.prepare('SELECT * FROM screenings WHERE id = ?').get(Number(params.id)));
  if (!s) return fail(res, 404, '筛选表不存在');
  ok(res, { screening: s });
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
    values.push(JSON.stringify(Array.isArray(body.vars) ? body.vars.map(String) : []));
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
        label: EXP_FIELD_LABELS[c.f] || CMP_FIELD_LABELS[c.f] || c.f,
        from: c.o || '',
        to: c.n || '',
      })),
    };
  });
  ok(res, { items });
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
const CACHE_DIR = path.join(__dirname, '..', '.cache');
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

/** 取 JSON（不引第三方库）：404 当「查不到」返回 null，其它非 200 抛错 */
function fetchJson(target, ms = 12000) {
  return new Promise((resolve, reject) => {
    const lib = target.startsWith('https:') ? https : http;
    const req = lib.get(
      target,
      { headers: { 'user-agent': 'ELN-local/1.0 (personal notebook)', accept: 'application/json' }, timeout: ms },
      (r) => {
        let buf = '';
        r.setEncoding('utf8');
        r.on('data', (c) => {
          buf += c;
          if (buf.length > 4e6) req.destroy(new Error('上游响应太大'));
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
    );
    req.on('timeout', () => req.destroy(new Error('查询超时')));
    req.on('error', reject);
  });
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

route('GET', '/api/lookup', async (req, res, params, url) => {
  const smiles = str(url.searchParams.get('smiles')).trim();
  const inchikey = str(url.searchParams.get('inchikey')).trim();
  const q = str(url.searchParams.get('q')).trim();
  const kind = smiles ? 'smiles' : inchikey ? 'inchikey' : q ? 'name' : '';
  const value = smiles || inchikey || q;
  if (!kind) throw new HttpError(400, '要带 smiles / inchikey / q 其中一个');
  if (value.length > 800) throw new HttpError(400, '查询内容太长');

  const file = lookupCachePath(kind, value);
  let stale = null;
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (raw && raw.info) {
      if (Date.now() - (raw.at || 0) < LOOKUP_TTL) return ok(res, { ...raw.info, cached: true });
      stale = raw.info;
    }
  } catch {
    /* 没缓存 */
  }

  let info;
  try {
    info = await pubchemLookup(kind, value);
  } catch (e) {
    // 断网 / 超时：有旧结果就给旧的，没有就明说
    if (stale) return ok(res, { ...stale, cached: true, stale: true });
    throw new HttpError(502, `查不到（${e.message || '网络不通'}）`);
  }
  if (!info.found && stale) return ok(res, { ...stale, cached: true, stale: true });
  try {
    await fsp.mkdir(LOOKUP_DIR, { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ at: Date.now(), info }), 'utf8');
  } catch {
    /* 缓存写不进去也不要紧 */
  }
  ok(res, info);
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

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
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
      const { exec } = require('node:child_process');
      exec(`open "${url}"`);
    }
  });
}

// 后台先把 PDF 渲染器编译好（第一次生成 PDF 就不用等编译）
ensurePrintRenderer()
  .then(() => console.log('  打印渲染器      →  就绪（自己生成 A4 PDF）'))
  .catch((e) => console.log('  打印渲染器      →  不可用，只能用系统打印：' + e.message));

listen(PORT);
