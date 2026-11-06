/**
 * 从 OCR 出来的字里认展开剂 / Rf。
 * TLC 板照片上的字多半是铅笔手写，Vision 常常把 EA 认成 IA、PE 认成 RE，
 * 所以先按「常见展开剂」词典做一遍 edit-distance 1 的纠错，再拼成人习惯的写法。
 */

/** 常见展开剂（含中文名），键就是写进记录本时用的简称 */
const SOLVENTS = {
  PE: ['PE', '石油醚', 'PET', 'HEXANE', '正己烷', 'HEX'],
  EA: ['EA', 'ETOAC', '乙酸乙酯', 'ETHYL ACETATE'],
  DCM: ['DCM', '二氯甲烷', 'CH2CL2', 'CH2Cl2'],
  MeOH: ['MEOH', '甲醇'],
  Et2O: ['ET2O', '乙醚', 'ETHER', 'DIETHYL ETHER'],
  THF: ['THF', '四氢呋喃'],
  ACN: ['ACN', '乙腈', 'MECN'],
  Acetone: ['ACETONE', '丙酮'],
  CHCl3: ['CHCL3', '氯仿', 'CHLOROFORM'],
  DCE: ['DCE', '二氯乙烷'],
  Toluene: ['TOLUENE', '甲苯', 'TOL'],
  EtOH: ['ETOH', '乙醇'],
};

function lev(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

/** 把一个词归到标准简称；认不出来返回 ''（短缩写允许 1 个字符的 OCR 误差） */
function fixSolventWord(word) {
  const up = String(word || '').trim().toUpperCase();
  if (!up) return '';
  for (const [key, names] of Object.entries(SOLVENTS)) {
    if (names.some((n) => String(n).toUpperCase() === up)) return key;
  }
  // 两三个字母的缩写（PE / EA）正是手写最容易认错的，所以这里不拦短词，只按长度差筛一遍再用 edit distance
  if (up.length < 2 || up.length > 8) return '';
  let best = '';
  let bestD = 9;
  for (const [key, names] of Object.entries(SOLVENTS)) {
    for (const n of names) {
      const nu = String(n).toUpperCase();
      if (Math.abs(nu.length - up.length) > 1) continue;
      const dd = lev(up, nu);
      if (dd < bestD) {
        bestD = dd;
        best = key;
      }
    }
  }
  return bestD <= 1 ? best : '';
}

/** 一行字 → `PE:EA = 5:1`；认不出返回 '' */
export function guessSolvent(text) {
  // 手写里的破折号、等号、全角冒号都当分隔符
  const t = String(text || '')
    .replace(/\s+/g, '')
    .replace(/[—–－＝=]/g, '-')
    .replace(/[／/·]/g, ':');
  const m = /([A-Za-z\u4e00-\u9fa5]{1,8})[-:：]([A-Za-z\u4e00-\u9fa5]{1,8})[-:：](\d+(?:\.\d+)?)[-:：](\d+(?:\.\d+)?)/.exec(
    t
  );
  if (!m) return '';
  const a = fixSolventWord(m[1]);
  const b = fixSolventWord(m[2]);
  if (!a || !b) return '';
  return `${a}:${b} = ${m[3]}:${m[4]}`;
}

/** 一行字 → Rf 数值；没有返回 '' */
export function guessRf(text) {
  const m = /Rf\s*[=＝:：]?\s*(0?\.\d{1,2}|1\.0+|0(?![\d.]))/i.exec(String(text || ''));
  return m ? m[1].replace(/^\./, '0.') : '';
}

/** 从若干行里汇总：只有一个候选时才自动填，多个就让用户点 */
export function summarize(lines) {
  const sols = [...new Set(lines.map((l) => guessSolvent(l.text)).filter(Boolean))];
  const rfs = [...new Set(lines.map((l) => guessRf(l.text)).filter(Boolean))];
  return { sols, rfs };
}
