'use strict';

/**
 * 结构式「文档设置」：一份 JSON（`data/style.json`）= 结构图怎么画的唯一真值。
 *
 * 为什么要有它：同一个「线粗 0.6 pt」以前散在三个地方各写一遍（`src/lib/indigo.js` 的常量、
 * `src/lib/chemdraw.js` 的字高比例和写死的 stroke、Ketcher 的 `setSettings`），
 * 于是出现过「按 /100 换算、实际是 /30，线粗多画了 3.4 倍」这种事故。
 * 现在只存三个**化学量**（键长 / 线粗 / 字号，单位 pt），其余由三处各自换算。
 *
 * 这里是**服务端**那份：读文件、字段白名单、范围夹紧、指纹、以及「这个参数画不画得出来」的体检。
 * 前端那份换算在 `src/lib/style.js`。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./db');

const STYLE_FILE = path.join(DATA_DIR, 'style.json');

/** ACS Document 1996 的三个化学量；原子颜色是我们自己的选择（ACS 原样是黑的） */
const STYLE_DEFAULTS = {
  name: 'ACS 1996（原子上色）',
  bondLength: 14.4, // pt
  bondThickness: 0.6, // pt
  labelSize: 10, // pt
  stereoBondWidth: 2, // pt
  font: 'Arial',
  atomColoring: true,
  aromaticStyle: 'kekule',
};

/** 白名单 + 范围：**不认识的键一律忽略**。上次 `render-bond-spacing` 就是被原样透传给渲染器、
 *  结果把整张图的尺度算乱了（不是报错，是安静地画歪），所以这里必须挡死。 */
const NUMBER_FIELDS = {
  bondLength: { min: 8, max: 24, label: '键长（pt）' },
  bondThickness: { min: 0.2, max: 2, label: '线粗（pt）' },
  labelSize: { min: 6, max: 14, label: '标签字号（pt）' },
  stereoBondWidth: { min: 0.5, max: 4, label: '立体键粗（pt）' },
};
const TEXT_FIELDS = { name: { max: 40 }, font: { max: 40 } };
const ENUM_FIELDS = { aromaticStyle: ['kekule', 'circle'] };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * 把任意输入收敛成一份合法样式：坏的丢掉、超范围的夹紧，并把「改了什么」写进 warnings。
 * @returns {{style: object, warnings: string[]}}
 */
function normalizeStyle(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const warnings = [];
  const style = { ...STYLE_DEFAULTS };

  for (const [k, rule] of Object.entries(NUMBER_FIELDS)) {
    if (!(k in input)) continue;
    const n = Number(input[k]);
    if (!Number.isFinite(n)) {
      warnings.push(`${rule.label} 不是数字，用默认值 ${STYLE_DEFAULTS[k]}`);
      continue;
    }
    const v = round(clamp(n, rule.min, rule.max), 3);
    if (v !== n) warnings.push(`${rule.label} 限制在 ${rule.min}–${rule.max}，已改成 ${v}`);
    style[k] = v;
  }

  for (const [k, rule] of Object.entries(TEXT_FIELDS)) {
    if (!(k in input)) continue;
    const s = String(input[k] == null ? '' : input[k]).trim().slice(0, rule.max);
    if (s) style[k] = s;
    else warnings.push(`${k} 不能空，用默认值`);
  }

  if ('atomColoring' in input) {
    // 「关」的几种写法都认；除此之外一律算开
    const off = [false, 0, '0', 'false', 'no', 'off'].includes(
      typeof input.atomColoring === 'string' ? input.atomColoring.trim().toLowerCase() : input.atomColoring
    );
    style.atomColoring = !off;
  }

  for (const [k, allowed] of Object.entries(ENUM_FIELDS)) {
    if (!(k in input)) continue;
    const s = String(input[k] || '');
    if (allowed.includes(s)) style[k] = s;
    else warnings.push(`${k} 只能是 ${allowed.join(' / ')}，用默认值`);
  }

  const known = new Set([...Object.keys(NUMBER_FIELDS), ...Object.keys(TEXT_FIELDS), ...Object.keys(ENUM_FIELDS), 'name', 'atomColoring']);
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length) warnings.push(`忽略了不认识的字段：${unknown.join('、')}`);

  return { style, warnings };
}

/** 文件 → 样式。文件不存在 / 坏了都不算错（用默认值），但会返回 note 让调用方知道 */
function readStyle() {
  let text = '';
  try {
    text = fs.readFileSync(STYLE_FILE, 'utf8');
  } catch {
    return { style: { ...STYLE_DEFAULTS }, warnings: [], exists: false };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      style: { ...STYLE_DEFAULTS },
      warnings: [`style.json 不是合法 JSON（${String(e.message).slice(0, 80)}），已用默认值`],
      exists: true,
    };
  }
  const out = normalizeStyle(parsed);
  return { ...out, exists: true };
}

function writeStyle(style) {
  fs.mkdirSync(path.dirname(STYLE_FILE), { recursive: true });
  // 先写临时文件再 rename：写一半断电也不会留下半截 JSON
  const tmp = `${STYLE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(style, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, STYLE_FILE);
}

/** 样式指纹：进缓存键用（反应式 / 卡片墙的缓存按它失效） */
function styleHash(style) {
  const s = style || readStyle().style;
  const key = [s.bondLength, s.bondThickness, s.labelSize, s.stereoBondWidth, s.font, s.atomColoring ? 1 : 0, s.aromaticStyle].join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * 体检：参数画得出来吗
 * ------------------------------------------------------------------ */

/** 体检用的基准结构（环丁酮 + 甲氧基 + 酰胺，带双键 / 杂原子，够触发字号和线宽两条） */
const PROBE_MOL = [
  '',
  '  ELN probe',
  '',
  '  9  9  0  0  0  0  0  0  0  0999 V2000',
  '    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    1.2990    0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    1.2990    2.2500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '    0.0000    3.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '   -1.2990    2.2500    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0',
  '   -1.2990    0.7500    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0',
  '    2.5981    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0',
  '   -2.5981    0.0000    0.0000 S   0  0  0  0  0  0  0  0  0  0  0  0',
  '    3.8971    0.7500    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
  '  1  2  1  0  0  0  0',
  '  2  3  1  0  0  0  0',
  '  3  4  1  0  0  0  0',
  '  4  5  1  0  0  0  0',
  '  5  1  1  0  0  0  0',
  '  1  6  1  0  0  0  0',
  '  2  7  2  0  0  0  0',
  '  6  8  1  0  0  0  0',
  '  7  9  1  0  0  0  0',
  'M  END',
].join('\n');

/**
 * 按一份样式试渲一次，检查「画出来是不是一张正常的图」。
 *
 * 判据（都是量出来的，不是看着办）：
 *  ① 出得了 SVG；
 *  ② viewBox 宽高比在 0.1–10 之间（尺度算乱时第一个崩的就是它：上次 594×309 → 3436×3967）；
 *  ③ stroke-width / 键长 ≈ 线粗/键长（±35%），这条能抓住「线宽换算错」；
 *  ④ 至少有一条键被画出来。
 *
 * 单项不过就整份拒绝——这个渲染器对坏参数不会报错，只会安静地画歪，所以只能自己量。
 */
async function checkStyle(style) {
  let Indigo;
  try {
    Indigo = (await import('indigo-ketcher')).default;
  } catch (e) {
    return { ok: true, skipped: `没有 Indigo，跳过体检（${String(e.message).slice(0, 60)}）` };
  }
  let M;
  try {
    M = await Indigo();
  } catch (e) {
    return { ok: true, skipped: `Indigo 起不来，跳过体检（${String(e.message).slice(0, 60)}）` };
  }
  const opts = new M.MapStringString();
  opts.set('render-output-format', 'svg');
  opts.set('render-coloring', style.atomColoring ? 'true' : 'false');
  // Indigo 的线宽参数是「/30 = 占键长的比例」，字号是「/100」——见 src/lib/style.js 的换算
  opts.set('render-bond-line-width', String(round((style.bondThickness / style.bondLength) * 30, 3)));
  opts.set('render-font-size-unit', 'px');
  opts.set('render-font-size', String(round((style.labelSize / style.bondLength) * 100, 2)));

  let svg = '';
  try {
    const raw = String(M.render(PROBE_MOL, opts) || '');
    svg = raw.includes('<svg') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  } catch (e) {
    return { ok: false, reason: `试渲失败：${String(e.message).slice(0, 80)}` };
  }
  if (!svg.includes('<svg')) return { ok: false, reason: '试渲没出图（参数画不出结构）' };

  const vb = (svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/) || []).slice(1).map(Number);
  if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return { ok: false, reason: '试渲的 viewBox 不对' };
  const ratio = vb[2] / vb[3];
  if (!(ratio > 0.1 && ratio < 10)) return { ok: false, reason: `试渲的宽高比不对（${ratio.toFixed(2)}），尺度算乱了` };

  /* Indigo 把键长归一成 **1**（路径坐标），所以 `stroke-width` 直接就是「占一根键的比例」：
     线宽参数 / 30 —— 实测 1.8 → 0.06、4.2 → 0.14、1.25 → 0.0416667。**别再拿 matrix 的
     缩放去除它**（那是 px/单位，除完会得到 0.04%，第一次就是拿这个当真、把好参数拒了）。 */
  const sw = Number((svg.match(/stroke-width="([\d.]+)"/) || [])[1] || 0);
  if (!(sw > 0)) return { ok: false, reason: '试渲里没有线宽' };
  const want = style.bondThickness / style.bondLength;
  const got = sw;
  if (Math.abs(got - want) > want * 0.35) {
    return { ok: false, reason: `线宽对不上：要 ${(want * 100).toFixed(2)}% 键长，画出来是 ${(got * 100).toFixed(2)}%` };
  }
  return { ok: true, hash: styleHash(style) };
}

/**
 * 样式变了就清反应式缓存（`scheme_cache` 里那张是按旧参数画好的，留着会一直显示旧图）。
 * 启动时和 PUT 之后各调一次；hash 没变就什么都不做。
 */
function syncSchemeCache(hash) {
  const { db, getSetting, setSetting } = require('./db');
  const key = 'style:hash';
  const prev = String(getSetting(key) || '');
  if (prev === hash) return false;
  try {
    db.exec('DELETE FROM scheme_cache');
  } catch {
    /* 还没有这张表 */
  }
  setSetting(key, hash);
  return true;
}

module.exports = {
  STYLE_FILE,
  STYLE_DEFAULTS,
  normalizeStyle,
  readStyle,
  writeStyle,
  styleHash,
  checkStyle,
  syncSchemeCache,
};
