#!/usr/bin/env node
// backup.js — ELN 的「真」备份：WAL 库里真数据在 -wal 里，cp 主库会拷到一个空壳。
// 唯一可靠做法是 VACUUM INTO：由 SQLite 自己把所有页（含 WAL）写成一个自包含单文件。
//
//   node scripts/backup.js            # 备份一次
//   node scripts/backup.js --list     # 看已有快照
//   node scripts/backup.js --keep 14  # 保留份数（默认 7）
//
// 输出：.backups/<日期>/eln.db + attachments/ + compounds/
// 默认只写本地，不碰 OneDrive（上传 = 数据出机器）。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const BACKUPS = path.join(ROOT, '.backups');
const LIVE_DB = path.join(DATA, 'eln.db');

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const KEEP = Number(argOf('--keep', '7')) || 7;

const log = (...a) => console.log(...a);
const die = (m) => {
  console.error(`备份失败：${m}`);
  process.exit(1);
};

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function listSnapshots() {
  if (!fs.existsSync(BACKUPS)) return [];
  return fs
    .readdirSync(BACKUPS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}/.test(e.name))
    .map((e) => e.name)
    .sort();
}

function counts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const one = (sql) => {
      try {
        return db.prepare(sql).get().n;
      } catch {
        return -1;
      }
    };
    const integrity = db.prepare('PRAGMA integrity_check').get();
    return {
      experiments: one('SELECT count(*) AS n FROM experiments'),
      compounds: one('SELECT count(*) AS n FROM compounds'),
      attachments: one('SELECT count(*) AS n FROM attachments'),
      integrity: Object.values(integrity || {})[0],
    };
  } finally {
    db.close();
  }
}

if (argv.includes('--list')) {
  const snaps = listSnapshots();
  if (!snaps.length) {
    log('还没有快照。跑一次 node scripts/backup.js');
    process.exit(0);
  }
  log(`${snaps.length} 份快照（${BACKUPS}）：`);
  for (const s of snaps) {
    const db = path.join(BACKUPS, s, 'eln.db');
    if (!fs.existsSync(db)) {
      log(`  ${s}  （缺 eln.db）`);
      continue;
    }
    const c = counts(db);
    log(
      `  ${s}  ${human(fs.statSync(db).size).padStart(7)}  ` +
        `${c.experiments} 实验 / ${c.compounds} 化合物  ` +
        `附件 ${human(dirSize(path.join(BACKUPS, s, 'attachments')))}  ` +
        `完整性 ${c.integrity}`
    );
  }
  process.exit(0);
}

if (!fs.existsSync(LIVE_DB)) die(`找不到 ${LIVE_DB}`);

// 当天多次备份 → 用时分后缀，不覆盖
const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const day = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
let stamp = day;
if (fs.existsSync(path.join(BACKUPS, stamp, 'eln.db'))) {
  stamp = `${day}_${p2(now.getHours())}${p2(now.getMinutes())}`;
}

const outDir = path.join(BACKUPS, stamp);
fs.mkdirSync(outDir, { recursive: true });
const outDb = path.join(outDir, 'eln.db');

log(`源    ${LIVE_DB}`);
const live = counts(LIVE_DB);
log(`       ${live.experiments} 实验 / ${live.compounds} 化合物 / ${live.attachments} 附件`);

// VACUUM INTO：SQLite 自己把主库 + WAL 合并成一个自包含文件
let done = false;
for (const readOnly of [true, false]) {
  try {
    const db = new DatabaseSync(LIVE_DB, { readOnly });
    try {
      db.exec(`VACUUM INTO '${outDb.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    done = true;
    break;
  } catch (e) {
    if (readOnly) continue;
    die(String(e.message || e));
  }
}
if (!done) die('VACUUM INTO 没有执行成功');

// 附件与化合物文件（库里只存路径，文件在磁盘上）
for (const sub of ['attachments', 'compounds']) {
  const src = path.join(DATA, sub);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(outDir, sub), { recursive: true });
  }
}

// 立刻回读校验：备份能不能独立打开、记录数对不对
const got = counts(outDb);
log(`备份  ${outDb}`);
log(`       ${human(fs.statSync(outDb).size)} 单文件（自包含，不需要 -wal）`);
log(`       ${got.experiments} 实验 / ${got.compounds} 化合物 / ${got.attachments} 附件，完整性 ${got.integrity}`);

if (got.integrity !== 'ok') die(`快照完整性检查未通过：${got.integrity}`);
if (got.experiments !== live.experiments || got.compounds !== live.compounds) {
  die(`记录数对不上（源 ${live.experiments}/${live.compounds}，备份 ${got.experiments}/${got.compounds}）`);
}

// 轮转：只留最近 KEEP 份
const snaps = listSnapshots();
for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP))) {
  fs.rmSync(path.join(BACKUPS, old), { recursive: true, force: true });
  log(`清理  ${old}`);
}

log(`\n✓ 完成。现有 ${listSnapshots().length} 份快照，保留最近 ${KEEP} 份。`);
