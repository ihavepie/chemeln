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

const BOND_PX = 26; // 一根键的像素长度，整张图的尺度基准
const PAD = 16;

let cached = null;
async function chem() {
  if (!cached) cached = await import('openchemlib');
  return cached;
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
async function molSvg(smiles, id) {
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
 * 拼一张完整的反应式 SVG。
 * @param {object} p
 * @param {string[]} p.reactants 反应物 SMILES（两个底物就是两条）
 * @param {string} p.product     产物 SMILES
 * @param {string[]} p.above     箭头上方的几行字（试剂 / 催化剂）
 * @param {string[]} p.below     箭头下方的几行字（溶剂 / 温度 / 时间、放不下的试剂）
 */
/**
 * @param {object} o
 * @param {boolean} [o.background] 铺一层白底（存成附件 / 打印时要用）；
 *   直接贴在纸面上看（比如筛选表表头那张）就传 false，不然纸面会多出一块白方块。
 */
export async function composeSchemeSvg({ reactants = [], product = '', above = [], below = [], background = true } = {}) {
  const rs = [];
  for (let i = 0; i < reactants.length; i++) {
    if (!String(reactants[i] || '').trim()) continue;
    rs.push(await molSvg(reactants[i], `r${i}`));
  }
  const prod = product ? await molSvg(product, 'p') : null;
  if (!rs.length || !prod) throw new Error('至少要一个反应物和一个产物');

  const GAP = 14;          // 结构之间的一般间距
  const PLUS = 18;         // 加号的宽度
  const ARROW_MIN = 150;   // 箭头最短多长；实际长度会按上下最长那行字拉长（至少盖住所有条件再留点余量）
  // 箭头那块地方要放得下最长的那行字（13px 字，中文按全角估），否则字会压到反应物上
  const textW = (t) => [...String(t)].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 13 : 7.1), 0);
  const capAbove = above.filter((t) => String(t || '').trim());
  const capBelow = below.filter((t) => String(t || '').trim());
  const capW = Math.max(0, ...[...capAbove, ...capBelow].map(textW));
  const arrowLen = Math.max(ARROW_MIN, Math.round(capW) + 30); // 箭头要比最长的条件行再宽 30px
  const arrowW = arrowLen + 34;                                // 这块区域两头各留 17px，字不会贴到结构上
  const LINE_H = 18;
  const CAP_GAP = 15;      // 最近那行字离箭头多远
  const capTopH = capAbove.length ? capAbove.length * LINE_H + CAP_GAP : 0;
  const capBotH = capBelow.length ? capBelow.length * LINE_H + CAP_GAP : 0;

  const maxMolH = Math.max(...rs.map((r) => r.h), prod.h);
  const cy = PAD + capTopH + maxMolH / 2; // 所有结构都按这条中轴对齐
  const height = Math.round(cy + maxMolH / 2 + capBotH + PAD);

  // 横向排：反应物（+ 加号）→ 箭头 → 产物
  let x = PAD;
  const placed = [];
  rs.forEach((r, i) => {
    if (i) x += PLUS + GAP * 2;
    placed.push({ ...r, x, y: cy - r.h / 2 });
    x += r.w;
  });
  x += GAP * 2;
  const arrowZone = x;
  // 箭头画在这块地方的正中，字也居中在箭头上
  const arrowX1 = arrowZone + (arrowW - arrowLen) / 2;
  const arrowX2 = arrowX1 + arrowLen;
  x = arrowZone + arrowW + GAP * 2;
  const prodPos = { ...prod, x, y: cy - prod.h / 2 };
  x += prod.w + PAD;
  const width = Math.round(x);

  const molTag = (m) =>
    `<svg x="${Math.round(m.x)}" y="${Math.round(m.y)}" width="${m.w}" height="${m.h}" viewBox="${esc(m.vb)}" preserveAspectRatio="xMidYMid meet">${m.body}</svg>`;

  let pluses = '';
  let px = placed[0].x + placed[0].w;
  for (let i = 1; i < placed.length; i++) {
    const mid = (px + placed[i].x) / 2;
    pluses += `<text x="${Math.round(mid)}" y="${Math.round(cy + 7)}" text-anchor="middle" font-size="20" font-family="Helvetica, Arial, sans-serif" fill="#1b1a17">+</text>`;
    px = placed[i].x + placed[i].w;
  }

  const arrow =
    `<line x1="${Math.round(arrowX1)}" y1="${Math.round(cy)}" x2="${Math.round(arrowX2 - 9)}" y2="${Math.round(cy)}" stroke="#1b1a17" stroke-width="1.8"/>` +
    `<path d="M ${Math.round(arrowX2 - 10)} ${Math.round(cy - 5.5)} L ${Math.round(arrowX2)} ${Math.round(cy)} L ${Math.round(arrowX2 - 10)} ${Math.round(cy + 5.5)} Z" fill="#1b1a17"/>`;

  const capX = Math.round(arrowZone + arrowW / 2);
  // 下标 / 上标靠 tspan 的 dy 挪基线，字号小一号；挪完要挪回来，不然后面全跟着跑
  const SIZE = 13;
  const textTag = (line, y) => {
    // 每段字自己带着「相对上一段的基线偏移」走：正常 0、下标 +3、上标 -4。
    // 以前是「先记 pending 再还回去」写反了——下标没往下挪，后面的字反而被抬起来，
    // 整行看着上上下下地飘（用户截过图）。现在按「目标偏移 - 当前偏移」算 dy，不会攒错。
    let cur = 0;
    const spans = splitScript(line)
      .map((r) => {
        const want = r.kind === 'sub' ? 3 : r.kind === 'sup' ? -4 : 0;
        const dy = want - cur;
        cur = want;
        const dyAttr = dy ? ` dy="${dy}"` : '';
        const size = r.kind === 'n' ? '' : ` font-size="${Math.round(SIZE * 0.72)}"`;
        return `<tspan${dyAttr}${size}>${esc(r.t)}</tspan>`;
      })
      .join('');
    return `<text x="${capX}" y="${Math.round(y)}" text-anchor="middle" font-size="${SIZE}" font-family="Helvetica, Arial, sans-serif" fill="#1b1a17">${spans}</text>`;
  };
  let cap = '';
  capAbove.forEach((line, i) => {
    cap += textTag(line, cy - CAP_GAP - (capAbove.length - 1 - i) * LINE_H);
  });
  capBelow.forEach((line, i) => {
    cap += textTag(line, cy + CAP_GAP + 9 + i * LINE_H);
  });

  return (
    // `xmlns:xlink` 别省：带缩写的分子是 Indigo 画的，它用 `xlink:href="#glyph…"` 引字形，
    // 根节点没声明这个前缀，内联进 HTML 里看不出来（HTML 解析器容忍），但存成文件用 <img> 加载
    // 就是致命的 XML 错误——整张图空白（踩过）
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (background ? `<rect width="100%" height="100%" fill="#ffffff"/>` : '') +
    placed.map(molTag).join('') +
    pluses +
    arrow +
    molTag(prodPos) +
    cap +
    '</svg>'
  );
}
