'use strict';

/**
 * 数据层。整本记录本 = 一个目录：
 *   data/eln.db        —— SQLite（结构化记录）
 *   data/attachments/  —— 原始文件（谱图、PDF、Bruker 文件夹…）
 * 备份时整个 data/ 目录拷走即可。
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.ELN_DATA_DIR
  ? path.resolve(process.env.ELN_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const COMPOUND_DIR = path.join(DATA_DIR, 'compounds');

fs.mkdirSync(ATTACH_DIR, { recursive: true });
fs.mkdirSync(COMPOUND_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'eln.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS experiments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,
  title          TEXT    NOT NULL DEFAULT '',
  date           TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT '进行中',
  project        TEXT    NOT NULL DEFAULT '',
  rxn_type       TEXT    NOT NULL DEFAULT '',
  literature     TEXT    NOT NULL DEFAULT '',
  objective      TEXT    NOT NULL DEFAULT '',

  solvent        TEXT    NOT NULL DEFAULT '',
  concentration  TEXT    NOT NULL DEFAULT '',
  temperature    TEXT    NOT NULL DEFAULT '',
  duration       TEXT    NOT NULL DEFAULT '',
  atmosphere     TEXT    NOT NULL DEFAULT '',
  workup         TEXT    NOT NULL DEFAULT '',
  procedure      TEXT    NOT NULL DEFAULT '',

  product_name   TEXT    NOT NULL DEFAULT '',
  appearance     TEXT    NOT NULL DEFAULT '',
  yield_pct      REAL,
  dr_ee          TEXT    NOT NULL DEFAULT '',
  characterization TEXT  NOT NULL DEFAULT '',
  notes          TEXT    NOT NULL DEFAULT '',
  conclusion     TEXT    NOT NULL DEFAULT '',

  base_mmol      REAL,
  operator       TEXT    NOT NULL DEFAULT '',
  ambient_temp   TEXT    NOT NULL DEFAULT '',
  ambient_humid  TEXT    NOT NULL DEFAULT '',
  product_mass   REAL,
  product_mw     REAL,
  tlc_note       TEXT    NOT NULL DEFAULT '',
  steps_json     TEXT    NOT NULL DEFAULT '[]',
  locked         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS reagents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  exp_id     INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  step       INTEGER NOT NULL DEFAULT 1,
  role       TEXT    NOT NULL DEFAULT '',
  name       TEXT    NOT NULL DEFAULT '',
  mw         REAL,
  conc       REAL,
  density    REAL,
  eq         REAL,
  mmol       REAL,
  mass_mg    REAL,
  volume_ul  REAL,
  note       TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reagents_exp ON reagents(exp_id);

CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  exp_id        INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  category      TEXT    NOT NULL DEFAULT 'other',
  filename      TEXT    NOT NULL,
  original_name TEXT    NOT NULL DEFAULT '',
  size          INTEGER NOT NULL DEFAULT 0,
  mime          TEXT    NOT NULL DEFAULT '',
  is_dir        INTEGER NOT NULL DEFAULT 0,
  note          TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attach_exp ON attachments(exp_id);

CREATE TABLE IF NOT EXISTS screenings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  exp_id     INTEGER REFERENCES experiments(id) ON DELETE SET NULL,
  title      TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  vars_json  TEXT    NOT NULL DEFAULT '[]',
  entries_json TEXT  NOT NULL DEFAULT '[]',
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  exp_id    INTEGER,
  kind      TEXT NOT NULL DEFAULT '',
  detail    TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL
);

/* 化合物库：自己做的底物 / 中间体 / 产物。
   一个化合物 = 编号 + 结构 + 表征 + TLC + 怎么做出来的；实验里可以直接引用。 */
CREATE TABLE IF NOT EXISTS compounds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL DEFAULT '',
  name        TEXT    NOT NULL DEFAULT '',
  kind        TEXT    NOT NULL DEFAULT '底物',
  formula     TEXT    NOT NULL DEFAULT '',
  mw          REAL,
  appearance  TEXT    NOT NULL DEFAULT '',
  mp          TEXT    NOT NULL DEFAULT '',
  smiles      TEXT    NOT NULL DEFAULT '',
  nmr_h1      TEXT    NOT NULL DEFAULT '',
  nmr_c13     TEXT    NOT NULL DEFAULT '',
  nmr_other   TEXT    NOT NULL DEFAULT '',
  tlc_solvent TEXT    NOT NULL DEFAULT '',
  tlc_rf      TEXT    NOT NULL DEFAULT '',
  procedure   TEXT    NOT NULL DEFAULT '',
  notes       TEXT    NOT NULL DEFAULT '',
  standard_exp_id INTEGER,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compounds_code ON compounds(code);

CREATE TABLE IF NOT EXISTS compound_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  compound_id   INTEGER NOT NULL REFERENCES compounds(id) ON DELETE CASCADE,
  category      TEXT    NOT NULL DEFAULT 'other',
  filename      TEXT    NOT NULL,
  original_name TEXT    NOT NULL DEFAULT '',
  size          INTEGER NOT NULL DEFAULT 0,
  mime          TEXT    NOT NULL DEFAULT '',
  is_dir        INTEGER NOT NULL DEFAULT 0,
  note          TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compound_files ON compound_files(compound_id);

-- 分类：自己随手建的「文件夹」，实验和化合物都能挂一个
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL DEFAULT '',
  -- 实验和化合物各用各的分类：experiment / compound
  scope      TEXT    NOT NULL DEFAULT 'experiment',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
`);

// 老库补列
function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('experiments', 'operator', "operator TEXT NOT NULL DEFAULT ''");
ensureColumn('experiments', 'ambient_temp', "ambient_temp TEXT NOT NULL DEFAULT ''");
ensureColumn('experiments', 'ambient_humid', "ambient_humid TEXT NOT NULL DEFAULT ''");
ensureColumn('experiments', 'product_mass', 'product_mass REAL');
ensureColumn('experiments', 'product_mw', 'product_mw REAL');
ensureColumn('experiments', 'tlc_note', "tlc_note TEXT NOT NULL DEFAULT ''");
ensureColumn('experiments', 'steps_json', "steps_json TEXT NOT NULL DEFAULT '[]'");
// 粗产物 / 中间体这类「不计产率」：只记质量，不显示也不统计产率
ensureColumn('experiments', 'no_yield', 'no_yield INTEGER NOT NULL DEFAULT 0');
ensureColumn('reagents', 'conc', 'conc REAL');
ensureColumn('reagents', 'step', 'step INTEGER NOT NULL DEFAULT 1');
// 投料行可以指向化合物库里的化合物；实验产物也可以
ensureColumn('reagents', 'compound_id', 'compound_id INTEGER');
ensureColumn('experiments', 'product_compound_id', 'product_compound_id INTEGER');
// 平行组：重复 / 控制变量实验共用同一个 group_id，纸面左侧的书签就是它；
// 空串 = 没有平行实验（单条记录）
ensureColumn('experiments', 'group_id', "group_id TEXT NOT NULL DEFAULT ''");
// 画板里画出来的反应式本体（RXN），存着下次能接着改；图本身是 scheme 附件
ensureColumn('experiments', 'scheme_rxn', "scheme_rxn TEXT NOT NULL DEFAULT ''");
// 同一条反应式的 SMILES（`A.B>>C`）：RXN 用来还原画板版式，SMILES 用来认反应物 / 产物
ensureColumn('experiments', 'scheme_smiles', "scheme_smiles TEXT NOT NULL DEFAULT ''");
// 化合物的「标准实验」：当初在哪条实验里做出来的
ensureColumn('compounds', 'standard_exp_id', 'standard_exp_id INTEGER');
// 记录可以归到一个分类里（没归就是未分类）
ensureColumn('experiments', 'category_id', 'category_id INTEGER');
ensureColumn('compounds', 'category_id', 'category_id INTEGER');
// 手动排序：卡片墙里拖动后的位置（越小越靠前）
ensureColumn('experiments', 'sort_index', 'sort_index REAL');
ensureColumn('compounds', 'sort_index', 'sort_index REAL');
// 化合物挂在哪个课题下：只有关掉「跨课题共用」才写值，空串 = 本子里的公共库
ensureColumn('compounds', 'project', "project TEXT NOT NULL DEFAULT ''");
// CAS 号：从 PubChem 查出来顺手存着（`/api/lookup`），方便以后对试剂 / 查 ChemicalBook
ensureColumn('compounds', 'cas', "cas TEXT NOT NULL DEFAULT ''");

/* 改动留痕：events 原来只给实验用（exp_id），现在实验和化合物共用一张表。
   entity/entity_id 记录「改的是哪一条」，fields 是这次改到的字段名（JSON 数组，去重后给界面读）。 */
ensureColumn('events', 'entity', "entity TEXT NOT NULL DEFAULT 'experiment'");
ensureColumn('events', 'entity_id', 'entity_id INTEGER');
ensureColumn('events', 'fields', "fields TEXT NOT NULL DEFAULT ''");
// 改前 / 改后：[{f:'yield_pct', o:'71', n:'78'}]（长文本截断存，别把库撑大）
ensureColumn('events', 'changes', "changes TEXT NOT NULL DEFAULT ''");
db.exec("UPDATE events SET entity_id = exp_id WHERE entity_id IS NULL AND exp_id IS NOT NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity, entity_id, id)");

/* 回收站：删掉的东西不进黑洞。
   整条记录（含投料表 / 附件清单 / 相关链接）存成 JSON 快照，原表里的行真删；
   附件和化合物目录的文件留在盘上，等「彻底删除」时才真删。
   这样正常查询不用到处加 deleted 过滤，也不会漏掉某处让删掉的记录重新冒出来。 */
db.exec(`
CREATE TABLE IF NOT EXISTS trash (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT    NOT NULL DEFAULT 'experiment',
  entity_id INTEGER NOT NULL,
  label     TEXT    NOT NULL DEFAULT '',
  data      TEXT    NOT NULL DEFAULT '{}',
  at        TEXT    NOT NULL
);
`);

// 选择性是怎么测出来的（SI 里必写）；ee 另存一个数值，方便排序 / 统计 / 做表
ensureColumn('experiments', 'ee_pct', 'ee_pct REAL');
ensureColumn('experiments', 'sel_method', "sel_method TEXT NOT NULL DEFAULT ''");
ensureColumn('experiments', 'sel_condition', "sel_condition TEXT NOT NULL DEFAULT ''");
ensureColumn('experiments', 'sel_rt', "sel_rt TEXT NOT NULL DEFAULT ''");
// 化合物表征：HRMS / IR / 旋光（mp 原来就有）
ensureColumn('compounds', 'hrms', "hrms TEXT NOT NULL DEFAULT ''");
ensureColumn('compounds', 'ir', "ir TEXT NOT NULL DEFAULT ''");
ensureColumn('compounds', 'rotation', "rotation TEXT NOT NULL DEFAULT ''");
// 画板那版的 molfile（带真实坐标）：重新打开画板时喂给它，才不会又被重排一遍。
// 只存 SMILES 的话 Ketcher / Indigo 会按自己的算法重新摆一次，用户画的样子就没了。
ensureColumn('compounds', 'mol', "mol TEXT NOT NULL DEFAULT ''");

// 分类挂在课题下：'' = 共用（每个课题都看得到），否则只在该课题里出现。
// 老数据全是 ''，等于先都当共用，新建的分类才跟当前课题走。
ensureColumn('categories', 'project', "project TEXT NOT NULL DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS idx_categories_scope ON categories(scope, project, position)');

// 化合物编号唯一（空编号不算，老库允许留白）。
// 老库里如果已经撞号，唯一索引建不上——只提示，不能让服务起不来；写入时另有一道查重。
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_compounds_code_uq ON compounds(code) WHERE code <> ''");
} catch (e) {
  console.warn('[eln] 化合物编号有重复，唯一索引没建上（保存时仍会查重）：', e.message);
}

// 分类原来实验和化合物共用一套，拆成两套：按当前实际用途归位
{
  const hadScope = db.prepare('PRAGMA table_info(categories)').all().some((c) => c.name === 'scope');
  ensureColumn('categories', 'scope', "scope TEXT NOT NULL DEFAULT 'experiment'");
  if (!hadScope) {
    const now = new Date().toISOString();
    for (const g of db.prepare('SELECT id, name FROM categories').all()) {
      const usedByExp = db.prepare('SELECT COUNT(*) AS n FROM experiments WHERE category_id = ?').get(g.id).n;
      const usedByCmp = db.prepare('SELECT COUNT(*) AS n FROM compounds WHERE category_id = ?').get(g.id).n;
      if (usedByCmp && !usedByExp) {
        db.prepare("UPDATE categories SET scope = 'compound' WHERE id = ?").run(g.id);
      } else if (usedByCmp && usedByExp) {
        // 两边都在用：化合物这边复制一份，再把化合物挪过去
        const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM categories').get().p;
        const created = db
          .prepare("INSERT INTO categories(name, scope, position, created_at) VALUES (?, 'compound', ?, ?)")
          .run(g.name, pos, now);
        db.prepare('UPDATE compounds SET category_id = ? WHERE category_id = ?').run(created.lastInsertRowid, g.id);
      }
    }
  }
}

// 老库：按原来看到的样子给每行铺一次顺序，之后拖动才有意义
for (const [table, orderSql] of [
  ['experiments', 'date DESC, id DESC'],
  ['compounds', 'code COLLATE NOCASE, id'],
]) {
  const missing = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sort_index IS NULL`).get().n;
  if (!missing) continue;
  const rows = db.prepare(`SELECT id FROM ${table} ORDER BY ${orderSql}`).all();
  const upd = db.prepare(`UPDATE ${table} SET sort_index = ? WHERE id = ?`);
  rows.forEach((r, i) => upd.run(i, r.id));
}

// 状态用词改成 进行中 / 已完成 / 部分完成 / 失败 / 重复
db.exec("UPDATE experiments SET status = '已完成' WHERE status = '成功'");
db.exec("UPDATE experiments SET status = '部分完成' WHERE status = '部分成功'");

const DEFAULT_SETTINGS = {
  code_prefix: 'EXP',
  lab_heading: '方法学实验记录',
  owner_name: '',
  group_name: '',
  // 瓶子标签上二维码指向哪里；留空就自动用本机局域网地址
  label_base_url: '',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

function allSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    // seq:/prefix:/proj: 是计数器与课题级覆盖，projects_json 是课题清单，都不算「设置」
    if (row.key.startsWith('seq:') || row.key.startsWith('prefix:') || row.key.startsWith('proj:') || row.key === 'projects_json') continue;
    out[row.key] = row.value;
  }
  return out;
}

function initSettings() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (getSetting(k) === undefined) setSetting(k, v);
  }
}

/** 这个课题里已经用到的最大编号（`<前缀>-<数字>` 里那个数字） */
function maxCodeNumber(prefix, project) {
  const re = new RegExp(`^${String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  let max = 0;
  for (const r of db.prepare('SELECT code FROM experiments WHERE project = ?').all(project)) {
    const m = re.exec(String(r.code ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * 取一个这个课题下还没用过的实验编号——**编号按课题分开数**：
 * 每次都从「这个课题里同前缀的最大号 + 1」开始，所以每个课题都从 xxxx-0001 起，
 * 互不干扰，删掉最新那条时号也会收回来（不再一路往上涨）。
 */
function nextCode(prefix, project = '') {
  let n = maxCodeNumber(prefix, project);
  // 跳过已被占用的号（手工改过编号、或两个课题恰好用了同一个前缀）。
  // 不再补零：新编号就是 `前缀-1`、`前缀-2` 这样，老记录里的 `EXP-0021` 保持原样。
  for (;;) {
    n += 1;
    const code = `${prefix}-${n}`;
    if (!db.prepare('SELECT 1 AS x FROM experiments WHERE code = ?').get(code)) break;
  }
  return `${prefix}-${n}`;
}

/**
 * 记一条改动留痕。
 * @param entity 'experiment' | 'compound'
 * @param kind   create / edit / attach / lock / unlock / duplicate / trash / restore / purge
 * @param detail 给人看的一句话（增删附件、锁定之类）
 * @param fields 改到的字段名数组（只有 kind='edit' 才有）
 */
function logEvent(entity, entityId, kind, { detail = '', fields = [], changes = [] } = {}) {
  db.prepare(
    'INSERT INTO events(exp_id, entity, entity_id, kind, detail, fields, changes, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    entity === 'experiment' ? entityId ?? null : null,
    entity,
    entityId ?? null,
    kind,
    detail || '',
    fields.length ? JSON.stringify(fields) : '',
    changes.length ? JSON.stringify(changes) : '',
    new Date().toISOString()
  );
}

/** 连续编辑合并成一条：同一个 5 分钟窗口里改的东西算一次，不然历史会被自动保存刷成几百行 */
const EDIT_MERGE_MS = 5 * 60 * 1000;

/**
 * 记一次「改了记录」。changes = [{ f: 字段名, o: 改前, n: 改后 }]
 * 同一个 5 分钟窗口里对同一个字段的连续改动，保留最初的改前值、刷新改后值
 * ——「71 → 78 → 80」最终显示成「71 → 80」，这才是这次编辑真正变动了多少。
 */
function logEdit(entity, entityId, changes) {
  if (!changes.length) return;
  const fields = [...new Set(changes.map((c) => c.f))];
  const last = db
    .prepare(
      "SELECT id, fields, changes, at FROM events WHERE entity = ? AND entity_id = ? AND kind = 'edit' ORDER BY id DESC LIMIT 1"
    )
    .get(entity, entityId);
  const now = Date.now();
  if (last && now - new Date(last.at).getTime() < EDIT_MERGE_MS) {
    let prevFields = [];
    let prevChanges = [];
    try {
      prevFields = JSON.parse(last.fields || '[]');
      prevChanges = JSON.parse(last.changes || '[]');
    } catch {
      prevFields = [];
      prevChanges = [];
    }
    const merged = [...prevChanges];
    for (const c of changes) {
      const hit = merged.find((x) => x.f === c.f);
      if (hit) hit.n = c.n;
      else merged.push(c);
    }
    db.prepare('UPDATE events SET fields = ?, changes = ?, at = ? WHERE id = ?').run(
      JSON.stringify([...new Set([...prevFields, ...fields])]),
      JSON.stringify(merged),
      new Date(now).toISOString(),
      last.id
    );
    return;
  }
  logEvent(entity, entityId, 'edit', { fields, changes });
}

/** 一条记录的改动历史（新到旧） */
function historyFor(entity, entityId, limit = 200) {
  return db
    .prepare('SELECT id, kind, detail, fields, changes, at FROM events WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT ?')
    .all(entity, entityId, Number(limit) || 200);
}

// 「分类与化合物跨课题共用」这个开关已去掉：分类与化合物都严格按课题走，
// project = '' 就是「共用课题」本身（在「全部课题」里新建的记录落进去）。
// 顺手清掉老的两个键，免得设置里还留着没人读的值。
db.prepare("DELETE FROM settings WHERE key IN ('shared_mode', 'compound_shared')").run();

initSettings();

module.exports = {
  db,
  DATA_DIR,
  ATTACH_DIR,
  COMPOUND_DIR,
  getSetting,
  setSetting,
  allSettings,
  nextCode,
  logEvent,
  logEdit,
  historyFor,
  DEFAULT_SETTINGS,
};
