'use strict';

/**
 * 纯函数层：**只做值的清洗，不碰数据库、不碰请求**。
 * 从 `server/index.js` 里搬出来的原因有两个：
 *   ① 这里每一条都是「写进库之前最后一道闸」，写歪了数据就脏了，得能单独测（`test/normalize.test.js`）；
 *   ② `index.js` 里 83 条路由挤在一个文件，把不需要上下文的逻辑分出来读起来才快。
 *
 * 约定：**不认识的一律给安全的空值**，绝不抛异常（老数据 / 手改过的 JSON 都会进这里）。
 */

const str = (v, fallback = '') => (v === null || v === undefined ? fallback : String(v));

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 文件名保干净：去掉路径分隔符与控制字符，保留扩展名。 */
function safeName(name) {
  const base = require('node:path')
    .basename(String(name || 'file'))
    .replace(/[\u0000-\u001f]/g, '');
  const cleaned = base.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 120) || 'file';
}

/* ---------------- 条件组（`conds_json`）---------------- */

/** 条件组里每条条件的「变量取值」：`{L:'XPhos', T:'−40 °C'}`（键短、值短，别塞大段文字） */
function normalizeCondVars(obj, maxLen = 120) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 6)) {
    const key = str(k).slice(0, 8);
    const val = str(v).slice(0, maxLen);
    if (key && val) out[key] = val;
  }
  return out;
}

/** `conds_json` → 数组（坏数据当空） */
function parseConds(text) {
  try {
    const list = JSON.parse(String(text || '[]'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * 一次筛选里最多 60 个候选，每个的字段各自截断；
 * 产率夹到 0–100 并留一位小数（`null` = 没填，**不是 0**）。
 * 最后把「什么都没填」的候选滤掉——空行不该占一个 Entry。
 */
function normalizeConds(list) {
  if (!Array.isArray(list)) return null;
  return list
    .slice(0, 60)
    .map((c) => {
      const o = c && typeof c === 'object' ? c : {};
      const y = numOrNull(o.yield_pct);
      return {
        label: str(o.label).slice(0, 200), // 「−40 °C」「LDA 1.2 eq」「DCM 代替 THF」
        mass: str(o.mass).slice(0, 40), // 这个候选称到的质量 / g（产率由它算）
        yield_pct: y === null ? null : Math.max(0, Math.min(100, Math.round(y * 10) / 10)),
        sel: str(o.sel).slice(0, 60), // 「94:6」「99% ee」这种，手填
        note: str(o.note).slice(0, 200),
        vars: normalizeCondVars(o.vars), // 每个变量的取值（L / T / t…）
        varEq: normalizeCondVars(o.varEq, 24), // 这个候选用自己的当量（空 = 用投料表的标准当量）
      };
    })
    .filter(
      (c) =>
        c.label ||
        c.mass ||
        c.yield_pct !== null ||
        c.sel ||
        c.note ||
        Object.keys(c.vars).length ||
        Object.keys(c.varEq).length
    );
}

/* ---------------- 字段变量（`field_vars_json`）---------------- */

const FIELD_VARS = new Set(['temperature', 'duration', 'atmosphere', 'concentration']);
const FIELD_VAR_LABEL = { temperature: 'T', duration: 't', atmosphere: 'atm', concentration: 'M' };

function normalizeFieldVars(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const one of list.slice(0, 6)) {
    const key = str(one && typeof one === 'object' ? one.key : one);
    if (!FIELD_VARS.has(key) || out.some((x) => x.key === key)) continue;
    const label = str(one && one.label).slice(0, 8) || FIELD_VAR_LABEL[key] || key;
    out.push({ key, label });
  }
  return out;
}

function parseFieldVars(text) {
  try {
    const list = JSON.parse(String(text || '[]'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

module.exports = {
  str,
  numOrNull,
  safeName,
  normalizeCondVars,
  parseConds,
  normalizeConds,
  FIELD_VARS,
  FIELD_VAR_LABEL,
  normalizeFieldVars,
  parseFieldVars,
};
