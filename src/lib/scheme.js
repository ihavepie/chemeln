/**
 * 按投料表拼一张反应式图（不经过画板）：反应物 —— 箭头（上下一共可以写几行字）—— 产物。
 * 惯例是「试剂 / 催化剂写箭头上方，溶剂、温度、时间写下方」，放不下的试剂也挪到下方。
 *
 * 为什么要自己拼：Ketcher 画板里没法用代码往箭头上写文字（它的文本对象没有开放接口），
 * 而 ChemDraw 的习惯就是「试剂、催化剂、溶剂、温度都堆在箭头横线上方」。所以这里用
 * openchemlib 出每个结构（跟全站结构式图同一套观感：杂原子彩色），自己画加号、箭头和那几行字，
 * 拼成一张 SVG。
 *
 * 尺度：`BOND_PX` 是「一根键多少像素」，所有分子按它统一缩放——不然小分子被放大、
 * 大分子被塞小，摆在一起键长不齐。字（箭头上的条件）比键小一号，看着才像 ChemDraw。
 */

import { relayoutMolecule, orientLandscape, canonicalOrientation } from './relayout.js';
import { indigoSvg, indigoSvgSized, splitSvgSized } from './indigo.js';
import { chemdrawLabels, chemdrawLabelsExact } from './chemdraw.js';
import { roleTone } from './reagent.js';

/** 组分 → 文字颜色，跟投料表「组分」那一列的配色一致（Sub 棕、Cat 紫、Base 蓝、Lig 绿…） */
const TONE_COLOR = {
  sub: '#7c3315',
  base: '#1f6c9f',
  cat: '#6b4d8f',
  lig: '#2f6b4f',
  sol: '#8d8b84',
  add: '#8a5f00',
  ox: '#9f2f2d',
  red: '#a8471f',
  plain: '#1b1a17',
};
const roleColor = (role) => (role ? TONE_COLOR[roleTone(role)] || '#1b1a17' : '#1b1a17');
/** 一行字可以是纯字符串，也可以是 [{ text, role }] 的分段（分段按组分上色） */
const lineParts = (line) => (Array.isArray(line) ? line.filter((p) => p && String(p.text || '').trim()) : String(line || '').trim() ? [{ text: String(line) }] : []);
const lineText = (line) => lineParts(line).map((p) => p.text).join(', ');

/**
 * 一行条件文字按「, 」折成几行（最多 maxLines），保留每段的角色 → 颜色不丢。
 * 为什么要折：箭头长度是按「最长那行字」算的，一行六十几个字符的试剂列表会把箭头撑到 500+ px，
 * 整张图标成 4:1、两边结构缩到角落里（`SJ-2-2` 实测 970×262、箭头 538 px 占 55% 宽）。
 */
function wrapPhrases(line, maxW, measure, maxLines = 2) {
  const parts = lineParts(line);
  const phrases = [];
  for (const p of parts) {
    for (const seg of String(p.text || '').split(/\s*,\s*/)) {
      if (seg.trim()) phrases.push({ text: seg.trim(), role: p.role });
    }
  }
  if (phrases.length <= 1) return [lineParts(line)];
  const lines = [];
  let cur = [];
  const w = (arr) => measure(arr.map((x) => x.text).join(', '));
  for (const ph of phrases) {
    const next = [...cur, ph];
    // 折行数到顶以后，剩下的都并进最后一行（宁可长一点，也不要变成三行大字块）
    if (cur.length && w(next) > maxW && lines.length < maxLines - 1) {
      lines.push(cur);
      cur = [ph];
    } else {
      cur = next;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

const BOND_PX = 30; // 一根键的像素长度，整张图的尺度基准（26 → 30：结构在反应式里别显小）
const PAD = 12;

let cached = null;
async function chem() {
  if (!cached) cached = await import('openchemlib');
  return cached;
}

/** 提前把 openchemlib（1 MB）+ Indigo（11 MB WASM）拉下来：记录页一打开就调，
 *  省得第一次画反应式时干等（会白一下） */
export async function preloadSchemeLib() {
  const { preloadIndigo } = await import('./indigo.js');
  await Promise.all([chem().catch(() => null), preloadIndigo()]);
}

/**
 * 一行字拆成「正常 / 下标 / 上标」几段：
 *  - 字母或右括号后面的数字当下标（Pd(PPh3)4 → Pd(PPh₃)₄，H2O → H₂O），
 *    空格开头的数字不动（0.05 eq、12 h、-78 °C、4:1 这些都不是化学计量数）；
 *  - 字母 / 右括号后面、紧跟空白或结尾的 +/- 当上标（Na+）；
 *  - 想强制就当手写 `_{3}` / `^{2}`。
 */
function splitScript(text) {
  const s = String(text || '');
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ t: buf, kind: 'n' });
      buf = '';
    }
  };
  // 注意别把「·」算进来：CuSO4·5H2O 里的 5 是结晶水的系数，得占正常字号
  const isAlnumTail = (ch) => /[A-Za-z)\]]/.test(ch || '');
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('_{', i) || s.startsWith('^{', i)) {
      const end = s.indexOf('}', i + 2);
      if (end > 0) {
        flush();
        out.push({ t: s.slice(i + 2, end), kind: s[i] === '_' ? 'sub' : 'sup' });
        i = end;
        continue;
      }
    }
    const ch = s[i];
    if (/[0-9]/.test(ch) && isAlnumTail(s[i - 1])) {
      flush();
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      out.push({ t: s.slice(i, j), kind: 'sub' });
      i = j - 1;
      continue;
    }
    if (
      (ch === '+' || ch === '-') &&
      isAlnumTail(s[i - 1]) &&
      (i + 1 >= s.length || /[\s,，;；)\]]/.test(s[i + 1]))
    ) {
      flush();
      out.push({ t: ch, kind: 'sup' });
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

const esc = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 一个分子 → 一张小 SVG（内容紧凑裁边、键长≈BOND_PX） */
/* 化合物库里存的那份 molfile（只带缩写的才拉）：按它出图，Ts / Bn / Ph 这些手画上去的标签就留着了 */
// 键带上 `ver`（化合物的 updated_at）：在画板里改过结构以后要重新拉，不然这张图一直是旧的。
// **空结果不缓存**：第一次问的时候结构还没画好，缓存住空串就再也补不回来了。
const abbrevMolCache = new Map();   // `id|ver` → molfile
async function abbrevMol(compoundId, ver = '') {
  const id = Number(compoundId);
  if (!id) return '';
  const key = `${id}|${ver}`;
  if (abbrevMolCache.has(key)) return abbrevMolCache.get(key);
  let mol = '';
  try {
    const res = await fetch(`/api/compounds/${id}/abbrev-mol`);
    if (res.ok) mol = String((await res.json()).mol || '');
  } catch {
    mol = '';
  }
  if (mol) abbrevMolCache.set(key, mol);
  return mol;
}

async function molSvg(smiles, id, molfile = '') {
  // 有「怎么画的」那份 molfile 就照它画（Indigo 保留 S-group 标签，坐标也照抄）
  if (molfile) {
    try {
      const p = await indigoSvgSized(molfile, BOND_PX, 6);
      if (p && p.w > 0 && p.h > 0) {
        // 缩写标签换成真正的无衬线字，跟化合物卡片（`chemdraw.js` 那套）一个字体 ——
        // 不然同一个 Ts 在卡片是 Helvetica、在反应式里是 Indigo 的衬线小字。
        // 换字会改字宽 → 画布必须重新量，所以再拆一次。
        // **判成功要看「字形变少了」而不是「一个都不剩」**：O / N 这类元素符号本来就该留着
        // 是 Indigo 字形（它们有颜色），拿「没有 glyph」当条件会把整条转换白扔掉（踩过）。
        try {
          const glyphs = (s) => (String(s).match(/href="#[^"]*glyph/g) || []).length;
          // exact 版（每条缩写单独渲一张、按字形轮廓认位置）才靠谱；老版按 molfile 坐标投影
          // 配位置，两套坐标系不同，基本配不上、会原样返回（所以这边先 exact、再退回老版）。
          let conv = await chemdrawLabelsExact(molfile, indigoSvg).catch(() => '');
          if (!conv || !conv.includes('<svg')) conv = chemdrawLabels(p.svg, molfile);
          if (conv && conv.includes('<svg') && glyphs(conv) < glyphs(p.svg)) {
            const q = splitSvgSized(conv, BOND_PX, 6);
            if (q.w > 0 && q.h > 0) return { w: q.w, h: q.h, body: q.body, vb: q.vb };
          }
        } catch {
          /* 换字失败就用 Indigo 原图 */
        }
        return { w: p.w, h: p.h, body: p.body, vb: p.vb };
      }
    } catch {
      /* Indigo 出不来就退回下面按 SMILES 画 */
    }
  }
  const lib = await chem();
  const mol = lib.Molecule.fromSmiles(smiles);
  // 先让 Indigo 把坐标重排一遍（openchemlib 自己的键角常常是歪的），再按新坐标算 bbox
  await relayoutMolecule(lib, mol);
  orientLandscape(mol);
  canonicalOrientation(lib, mol);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    const x = mol.getAtomX(i);
    const y = mol.getAtomY(i);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const bw = Math.max(0.6, x1 - x0);
  const bh = Math.max(0.6, y1 - y0);
  // 请求尺寸只影响内部渲染精度；真正占多大由下面按「键长 = BOND_PX」反推
  const svg = mol.toSVG(Math.round((bw + 3) * BOND_PX), Math.round((bh + 3) * BOND_PX), id, {
    autoCrop: true,
    autoCropMargin: 6,
  });
  const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1] || '';
  // 分子坐标里一根键≈1，所以「键长 BOND_PX 像素」= 宽高各给 bbox*BOND_PX；
  // 里面 viewBox 的形状和它差不多，缩放就≈1，键长才是齐的
  const EDGE = 10;
  return {
    w: Math.round(bw * BOND_PX + EDGE * 2),
    h: Math.round(bh * BOND_PX + EDGE * 2),
    body: svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, ''),
    vb,
  };
}

/**
 * 拼一张完整的反应式 SVG。**支持多段**（两步反应：A →(条件1) B →(条件2) C）：
 * 每段自己有反应物 / 产物 / 箭头上下那几行字；上一段的产物要是正好是这一段的底物
 * （同一个化合物），只画一次、当中间那道桥。
 * @param {object[]} o.stages 每段 `{reactants, reactantIds, reactantVers, product, productId, productVer, productLabel, above, below}`
 * @param {boolean} [o.background] 铺一层白底（存成附件 / 打印时要用）；
 *   直接贴在纸面上看（比如筛选表表头那张）就传 false，不然纸面会多出一块白方块。
 */
export async function composeChainSvg({ stages = [], background = true } = {}) {
  const GAP = 12;          // 结构之间的一般间距
  const PLUS = 18;         // 加号的宽度
  const ARROW_MIN = 110;   // 箭头最短多长；实际长度按上下最长那行字来（够写条件就行，别拉太长）
  const MAX_ARROW = 320;   // 但别让一行长字把箭头拉到 500+：折行后还超长就截在这里
  const CAP_SIZE = 15;     // 箭头上下的条件字号（跟结构式里的原子标签差不多大）
  const MAX_LINE_W = 250;  // 条件先折行（单行最多 ~250px，最多 2 行），再拿折完最宽的那行算箭头长度
  const LINE_H = 20;
  const CAP_GAP = 12;      // 最近那行字离箭头多远
  // 字号按实测校准过：15px 的 Helvetica 混排大约 0.47×字号 / 西文字符，中文按全角 1.0×
  const textW = (t) => [...String(t)].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? CAP_SIZE : CAP_SIZE * 0.47), 0);

  // ① 每个结构先出图（同一张图里同一个化合物只出一种，两步共用的中间体不会画两遍）
  const drawn = new Map();
  const draw = async (smiles, id, ver) => {
    const key = id ? `i${id}:${ver || ''}` : `s${smiles}`;
    if (!drawn.has(key)) {
      const mol = id ? await abbrevMol(id, ver) : '';
      drawn.set(key, await molSvg(smiles, key, mol));
    }
    return drawn.get(key);
  };
  const caps = (list) =>
    (list || [])
      .filter((t) => lineText(t).trim())
      .flatMap((l) => wrapPhrases(l, MAX_LINE_W, textW))
      .filter((l) => lineText(l).trim());

  // ② 排成一串节点：结构 / 加号 / 箭头 / 产物名
  const nodes = [];
  let prevKey = ''; // 上一段的产物：下一段里跟它同一个的底物不再画一次
  for (let si = 0; si < stages.length; si++) {
    const st = stages[si] || {};
    const above = caps(st.above);
    const below = caps(st.below);
    const capW = Math.max(0, ...[...above, ...below].map((t) => textW(lineText(t))));
    // 画出来那根线比 arrowLen 短（两头留白 / 箭头尖用掉了约 37px），所以这里补回来
    const arrowLen = Math.min(MAX_ARROW, Math.max(ARROW_MIN, Math.round(capW) + 30));

    const rs = [];
    const list = st.reactants || [];
    for (let i = 0; i < list.length; i++) {
      const smi = String(list[i] || '').trim();
      if (!smi) continue;
      const id = st.reactantIds && st.reactantIds[i] ? Number(st.reactantIds[i]) : null;
      const key = id ? `i${id}` : `s${smi}`;
      if (si > 0 && key === prevKey) continue; // 就是上一段的产物：已经画在上一根箭头右边了
      rs.push(await draw(smi, id, (st.reactantVers && st.reactantVers[i]) || ''));
    }
    const pSmi = String(st.product || '').trim();
    const pId = st.productId ? Number(st.productId) : null;
    const prod = pSmi ? await draw(pSmi, pId, st.productVer || '') : null;
    prevKey = pSmi ? (pId ? `i${pId}` : `s${pSmi}`) : '';

    rs.forEach((r, i) => {
      if (i) nodes.push({ kind: 'plus', w: PLUS });
      nodes.push({ kind: 'mol', mol: r, w: r.w });
    });
    nodes.push({
      kind: 'arrow',
      w: arrowLen + 26, // 这块区域两头各留 13px，字不会贴到结构上
      len: arrowLen,
      above,
      below,
      capTopH: above.length ? above.length * LINE_H + CAP_GAP : 0,
      capBotH: below.length ? below.length * LINE_H + CAP_GAP : 0,
    });
    const pLabel = String(st.productLabel || '').trim();
    if (prod) nodes.push({ kind: 'mol', mol: prod, w: prod.w });
    else if (pLabel) {
      const PROD_SIZE = 15;
      nodes.push({
        kind: 'label',
        text: pLabel,
        w: [...pLabel].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? PROD_SIZE : PROD_SIZE * 0.55), 0),
      });
    }
  }
  const mols = nodes.filter((n) => n.kind === 'mol');
  const arrows = nodes.filter((n) => n.kind === 'arrow');
  if (!mols.length) throw new Error('至少要一个反应物');

  // ③ 纵向：所有结构共一条中轴，箭头上下那几行字按各自的行数往上 / 往下长
  const maxMolH = Math.max(...mols.map((m) => m.mol.h));
  const capTopMax = arrows.length ? Math.max(...arrows.map((a) => a.capTopH)) : 0;
  const capBotMax = arrows.length ? Math.max(...arrows.map((a) => a.capBotH)) : 0;
  const cy = PAD + capTopMax + maxMolH / 2;
  const height = Math.round(cy + maxMolH / 2 + capBotMax + PAD);

  // ④ 横向：从左到右依次排（加号两边只留半个 GAP，免得「+」离结构太远）
  let x = PAD;
  nodes.forEach((n, i) => {
    if (i) x += nodes[i - 1].kind === 'plus' || n.kind === 'plus' ? GAP * 0.5 : GAP;
    n.x = x;
    x += n.w;
  });
  const width = Math.round(x + PAD);

  // 条件文字：每段字自己带着「相对上一段的基线偏移」走（正常 0、下标 +3、上标 -4）
  const SIZE = CAP_SIZE;
  let cap = '';
  const textTag = (line, capX, y) => {
    let cur = 0;
    const spans = [];
    const parts = lineParts(line);
    parts.forEach((part, pi) => {
      const fill = roleColor(part.role);
      const text = pi ? `, ${part.text}` : part.text; // 段与段之间用西文逗号（跟「Name (20 mol%)」的括号配套）
      for (const r of splitScript(text)) {
        const want = r.kind === 'sub' ? 3 : r.kind === 'sup' ? -4 : 0;
        const dy = want - cur;
        cur = want;
        const dyAttr = dy ? ` dy="${dy}"` : '';
        const size = r.kind === 'n' ? '' : ` font-size="${Math.round(SIZE * 0.72)}"`;
        const colorAttr = fill === '#1b1a17' ? '' : ` fill="${fill}"`;
        spans.push(`<tspan${dyAttr}${size}${colorAttr}>${esc(r.t)}</tspan>`);
      }
    });
    return `<text x="${Math.round(capX)}" y="${Math.round(y)}" text-anchor="middle" font-size="${SIZE}" font-family="Helvetica, Arial, sans-serif" fill="#1b1a17">${spans.join('')}</text>`;
  };
  // 产物名（没有产物结构时写在箭头右边）用衬线斜体，跟 ChemDraw 里手写字标的样式接近
  const PROD_FONT = "'Times New Roman', Times, 'Songti SC', serif";

  let body = '';
  let pluses = '';
  for (const n of nodes) {
    if (n.kind === 'mol') {
      const m = n.mol;
      body += `<svg x="${Math.round(n.x)}" y="${Math.round(cy - m.h / 2)}" width="${m.w}" height="${m.h}" viewBox="${esc(m.vb)}" preserveAspectRatio="xMidYMid meet">${m.body}</svg>`;
    } else if (n.kind === 'plus') {
      pluses += `<text x="${Math.round(n.x + n.w / 2)}" y="${Math.round(cy + 7)}" text-anchor="middle" font-size="20" font-family="Helvetica, Arial, sans-serif" fill="#1b1a17">+</text>`;
    } else if (n.kind === 'label') {
      body += `<text x="${Math.round(n.x)}" y="${Math.round(cy + 5)}" font-size="15" font-family="${PROD_FONT}" font-style="italic" fill="#1b1a17">${esc(n.text)}</text>`;
    } else if (n.kind === 'arrow') {
      const x1 = n.x + (n.w - n.len) / 2;
      const x2 = x1 + n.len;
      const capX = n.x + n.w / 2;
      body +=
        `<line x1="${Math.round(x1)}" y1="${Math.round(cy)}" x2="${Math.round(x2 - 9)}" y2="${Math.round(cy)}" stroke="#1b1a17" stroke-width="1.8"/>` +
        `<path d="M ${Math.round(x2 - 10)} ${Math.round(cy - 5.5)} L ${Math.round(x2)} ${Math.round(cy)} L ${Math.round(x2 - 10)} ${Math.round(cy + 5.5)} Z" fill="#1b1a17"/>`;
      n.above.forEach((line, i) => {
        cap += textTag(line, capX, cy - CAP_GAP - (n.above.length - 1 - i) * LINE_H);
      });
      n.below.forEach((line, i) => {
        cap += textTag(line, capX, cy + CAP_GAP + 9 + i * LINE_H);
      });
    }
  }

  return (
    // `xmlns:xlink` 别省：带缩写的分子是 Indigo 画的，它用 `xlink:href="#glyph…"` 引字形，
    // 根节点没声明这个前缀，内联进 HTML 里看不出来（HTML 解析器容忍），但存成文件用 <img> 加载
    // 就是致命的 XML 错误——整张图空白（踩过）
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (background ? `<rect width="100%" height="100%" fill="#ffffff"/>` : '') +
    body +
    pluses +
    cap +
    '</svg>'
  );
}

/** 单段的（绝大多数地方还是只画一根箭头）：包一层就行 */
export async function composeSchemeSvg(opts = {}) {
  return composeChainSvg({ stages: [opts], background: opts.background !== false });
}
