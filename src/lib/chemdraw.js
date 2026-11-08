/**
 * 让结构图更像 ChemDraw 的观感（只作用于**画板出图**，也就是 Indigo 渲的那张 SVG）。
 *
 * 差距在哪儿（实测）：
 * - **字体**：Indigo 把每个标签字都转成矢量字形（`<defs><g id="glyph-0-N">` + `<use>`），
 *   那套字形是衬线的（Times 味）；ChemDraw 的原子标签是 Arial / Helvetica 那种无衬线。
 *   Indigo 没有换字体的选项（`render-font-name` / `render-font-family` 都报 not defined），
 *   所以只能出图后把标签**换回真正的文字**（`<text>`）。
 * - **大小**：Indigo 的标签字高约 0.23 个键长（9.3px / 键 40px），ChemDraw 明显更大。
 *
 * 不认字形、也**不依赖 molfile 坐标**（Indigo 出图会整体平移 + 翻 y，硬算会跑偏）：
 * 一个 `<use>` 一个字符，「一组 use」= 一个标签，标签内容取 molfile 的 `M  SMT`；
 * 归属靠**字符数唯一匹配**，左右锚点靠**最近的键端点**（纯几何）。哪一步不踏实就原样返回。
 */

/** ChemDraw 那套：无衬线优先 */
const FONT = 'Helvetica, Arial, sans-serif';

/** 标签**字高** / 键长。Indigo 原本 0.233，0.32 用了一轮用户说还小，改成 0.40（≈字体 22px/键 40px） */
const LABEL_RATIO = 0.4;

/** 键长（px）：Ketcher 出图一根键 40px（就是 matrix 里的 a） */
const BOND_PX = 40;

/** Helvetica 的大写字高 ≈ 0.717 em（把「想要的字高」换算成 font-size） */
const CAP_RATIO = 0.717;

/** Helvetica 的字符宽度（em）。只用于给标签留够画布，估大一点没关系 */
const W = {
  ' ': 0.28, '0': 0.556, '1': 0.556, '2': 0.556, '3': 0.556, '4': 0.556, '5': 0.556, '6': 0.556, '7': 0.556, '8': 0.556, '9': 0.556,
  A: 0.667, B: 0.667, C: 0.722, D: 0.722, E: 0.667, F: 0.611, G: 0.778, H: 0.722, I: 0.278, J: 0.5, K: 0.667, L: 0.556,
  M: 0.833, N: 0.722, O: 0.778, P: 0.667, Q: 0.778, R: 0.722, S: 0.667, T: 0.611, U: 0.722, V: 0.667, W: 0.944, X: 0.667,
  Y: 0.667, Z: 0.611, a: 0.556, b: 0.556, c: 0.5, d: 0.556, e: 0.556, f: 0.278, g: 0.556, h: 0.556, i: 0.222, j: 0.222,
  k: 0.5, l: 0.222, m: 0.833, n: 0.556, o: 0.556, p: 0.556, q: 0.556, r: 0.333, s: 0.5, t: 0.278, u: 0.556, v: 0.5,
  w: 0.722, x: 0.5, y: 0.5, z: 0.5, '+': 0.584, '-': 0.333, '.': 0.278, '(': 0.333, ')': 0.333,
};

const num = (v) => String(+v.toFixed(6));
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const charW = (ch, em) => (W[ch] ?? 0.58) * em;

/** 一串 path 里的坐标取包络（只拿来量字形宽高） */
function pathBox(d) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of d.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)) {
    const x = +m[1];
    const y = +m[2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * @param {string} svg Indigo / Ketcher 出图（带 `matrix(...)` 的那套）
 * @param {string} mol 同一结构的 molfile（只取 `M  SMT` 的缩写文本，不用坐标）
 * @param {number} ratio 标签字高 / 键长
 * @returns {string} 换过标签的 SVG；拿不准时原样返回
 */
export function chemdrawLabels(svg, mol, ratio = LABEL_RATIO) {
  const src = String(svg || '');
  if (!src.includes('<svg') || !src.includes('<use')) return src;
  const mat = src.match(/transform="matrix\(([^)]+)\)"/);
  if (!mat) return src; // openchemlib 画的图不是这套结构
  const [, , , mD, mTx, mTy] = mat[1].split(',').map(Number);

  // ---- 1) 字形包围盒（量字宽、判下标）
  const glyphs = new Map();
  for (const g of src.matchAll(/<g id="(glyph-[^"]+)">\s*<path d="([^"]+)"/g)) {
    const box = pathBox(g[2]);
    glyphs.set(g[1], { w: Math.max(box.x1, 0.4), h: -box.y0 });
  }
  if (!glyphs.size) return src;

  // ---- 2) <use> 分组：同一条基线 + 横向相邻 = 一个标签
  const uses = [];
  for (const u of src.matchAll(/<use xlink:href="#([^"]+)" x="(-?[\d.]+)" y="(-?[\d.]+)"\/>/g)) {
    uses.push({ raw: u[0], id: u[1], x: +u[2], y: +u[3] });
  }
  if (!uses.length) return src;
  const groups = [];
  for (const it of uses) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(it.y - g.ys[0]) < 4 && it.x > g.maxX - 6 && it.x - g.maxX < 16) {
      g.items.push(it);
      g.maxX = Math.max(g.maxX, it.x);
      g.ys.push(it.y);
    } else {
      groups.push({ items: [it], maxX: it.x, ys: [it.y] });
    }
  }

  // ---- 3) 缩写文本（M  SMT）按**字符数**唯一匹配到各组
  const texts = [];
  for (const line of String(mol || '').split(/\r?\n/)) {
    const m = line.match(/^M  SMT\s+(\d+)\s+(.+)$/);
    if (m) texts.push(m[2].trim().replace(/\s+/g, ''));
  }
  if (!texts.length || groups.length !== texts.length) return src;
  const pairs = [];
  const taken = new Set();
  for (const g of groups) {
    const cands = [];
    for (let i = 0; i < texts.length; i++) if (!taken.has(i) && texts[i].length === g.items.length) cands.push(i);
    const distinct = [...new Set(cands.map((i) => texts[i]))];
    if (distinct.length !== 1) return src; // 长度撞车又不是同一个名 → 认不准，别动
    taken.add(cands[0]);
    pairs.push({ g, text: distinct[0] });
  }

  // ---- 4) 每组的锚：最近的键端点（纯几何）
  const ends = [];
  for (const m of src.matchAll(/d="M (-?[\d.]+) (-?[\d.]+) L (-?[\d.]+) (-?[\d.]+) "/g)) {
    ends.push([mTx + 40 * +m[1], mTy + mD * +m[2]], [mTx + 40 * +m[3], mTy + mD * +m[4]]);
  }
  if (!ends.length) return src;

  const capOld = Math.max(...[...glyphs.values()].map((x) => x.h), 1);
  const mainSize = Math.round((Math.max(ratio * BOND_PX, capOld) / CAP_RATIO) * 10) / 10;
  const capNew = mainSize * CAP_RATIO;
  const grow = Math.max(0, capNew - capOld); // 字变高多少（往哪边让）
  const subSize = Math.round(mainSize * 0.75 * 10) / 10;
  const subDrop = Math.max(1.4, mainSize * 0.2);

  let out = src;
  for (const { g, text } of pairs) {
    const first = g.items[0];
    const last = g.items[g.items.length - 1];
    const lastW = (glyphs.get(last.id) || { w: mainSize * 0.6 }).w;
    const bx0 = Math.min(...g.items.map((i) => i.x));
    const bx1 = Math.max(...g.items.map((i) => i.x)) + lastW;
    const by0 = Math.min(...g.ys) - capOld;
    const by1 = Math.max(...g.ys);

    // 锚点：离标签框中心最近的键端点
    const gcx = (bx0 + bx1) / 2;
    const gcy = (by0 + by1) / 2;
    let anchor = null;
    let bestD = Infinity;
    for (const e of ends) {
      const d = Math.hypot(e[0] - gcx, e[1] - gcy);
      if (d < bestD) {
        bestD = d;
        anchor = e;
      }
    }
    if (!anchor) return src;
    const right = bx0 > anchor[0]; // 标签在键端右边 → 左对齐，否则右对齐
    let y = first.y;
    if (first.y > anchor[1]) y += grow * 0.9; // 标签在键下方，往下让一点别顶到键

    // 下标：比本组基线低的就是下标。按「连续同基线」切段，每段一个 tspan，
    // dy 用「相对上一段」的增量（下标 +drop、回到正常 -drop），段与段各自闭合
    const baseY = g.ys[0];
    const chars = text.split('');
    const segs = [];
    for (let i = 0; i < chars.length; i++) {
      const isSub = g.ys[i] > baseY + 0.6;
      const last = segs[segs.length - 1];
      if (last && last.isSub === isSub) last.text += chars[i];
      else segs.push({ isSub, text: chars[i] });
    }
    let body = '';
    segs.forEach((seg, i) => {
      const t = escapeXml(seg.text);
      if (i === 0) {
        body += seg.isSub ? `<tspan dy="${num(subDrop)}" font-size="${subSize}">${t}</tspan>` : t;
        return;
      }
      const dy = seg.isSub ? subDrop : -subDrop;
      body += `<tspan dy="${num(dy)}" font-size="${seg.isSub ? subSize : mainSize}">${t}</tspan>`;
    });

    const x = right ? bx0 : bx1;
    const textEl =
      `<text x="${num(x)}" y="${num(y)}" font-family="${FONT}" font-size="${mainSize}" ` +
      `fill="#1a1a1a" text-anchor="${right ? 'start' : 'end'}">${body}</text>`;
    for (const it of g.items) out = out.replace(it.raw, '');
    out = out.replace('</svg>', `${textEl}\n</svg>`);
  }

  return fitCanvas(out, mainSize, subSize);
}

/** 重算画布：无衬线字比原来宽，标签会顶出去（不重算就被裁） */
function fitCanvas(svg, mainSize, subSize) {
  const mat = svg.match(/transform="matrix\(([^)]+)\)"/);
  const [, , , mD, mTx, mTy] = mat[1].split(',').map(Number);
  const pts = [];
  for (const m of svg.matchAll(/d="M (-?[\d.]+) (-?[\d.]+) L (-?[\d.]+) (-?[\d.]+) "/g)) {
    pts.push([mTx + 40 * +m[1], mTy + mD * +m[2]], [mTx + 40 * +m[3], mTy + mD * +m[4]]);
  }
  for (const m of svg.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*text-anchor="(\w+)">([\s\S]*?)<\/text>/g)) {
    const x = +m[1];
    const y = +m[2];
    const anchor = m[3];
    const chars = m[4].replace(/<[^>]+>/g, '');
    const w = [...chars].reduce((s, c) => s + charW(c, mainSize), 0) * (m[4].includes('tspan') ? 0.97 : 1);
    const x0 = anchor === 'start' ? x : x - w;
    pts.push([x0, y - mainSize * 0.78], [x0 + w, y + subSize * 0.3]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (!xs.length) return svg;
  const pad = 4;
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - x0;
  const h = Math.max(...ys) + pad - y0;
  return svg.replace(
    /<svg[^>]*>/,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="${num(x0)} ${num(y0)} ${num(w)} ${num(h)}">`,
  );
}
