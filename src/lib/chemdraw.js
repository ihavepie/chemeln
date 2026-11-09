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
  const wrapGroup = (body, ax, ay, k) => `<g transform="translate(${num(ax)} ${num(ay)}) scale(${num(k)}) translate(${num(-ax)} ${num(-ay)})">${body}</g>`;
  // 一个标签的几个 <use> 在源文件里可能被换行/其它标签隔开：按首尾 raw 的位置整段包起来
  const wrapSpan = (svgText, grp, ax, ay, k) => {
    const firstRaw = grp.items[0].raw;
    const lastRaw = grp.items[grp.items.length - 1].raw;
    const i0 = svgText.indexOf(firstRaw);
    const i1 = svgText.indexOf(lastRaw, i0);
    if (i0 < 0 || i1 < 0) return svgText;
    const body = svgText.slice(i0, i1 + lastRaw.length);
    return svgText.slice(0, i0) + wrapGroup(body, ax, ay, k) + svgText.slice(i1 + lastRaw.length);
  };
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

  return normalizeScale(fitCanvas(out, mainSize, subSize), Math.abs(mA));
}

/**
 * 统一「显示尺度 + 线宽」：一个键固定 24px、线宽 0.06×键长。
 * 为什么必须在这里做：卡片是按图片的**原始 px 尺寸**显示的，新存的图如果 px 跟着
 * Indigo 的 bond（40/100…）走，卡片里就会大小不一、线宽也不一样（用户截过图）。
 * 和 scripts/normalize-style.py 是同一套规则，只不过这里是「存之前」就做好。
 */
function normalizeScale(svg, bond) {
  const vb = String(svg.match(/viewBox="([^"]+)"/)?.[1] || '').split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !bond) return svg;
  const ppu = 24 / bond;                       // 每用户单位多少 px
  let out = svg.replace(/<svg[^>]*>/, (tag) =>
    tag.replace(/width="[\d.]+(?:px)?"/, `width="${Math.round(vb[2] * ppu)}"`)
       .replace(/height="[\d.]+(?:px)?"/, `height="${Math.round(vb[3] * ppu)}"`));
  // Indigo 的 stroke-width 在 matrix 之前，所以要写成「0.06 个局部键长」
  out = out.replace(/stroke-width="[\d.]+"/g, 'stroke-width="0.06"');
  return out;
}

/** 去掉本函数以前加过的缩放层（重复调用要幂等，别叠倍率） */
function stripLabelWrappers(svg) {
  const open = /<g transform="translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+)\) translate\((-?[\d.]+) (-?[\d.]+)\)">/;
  let out = svg;
  for (;;) {
    const m = open.exec(out);
    if (!m) return out;
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0) {
      const o = out.indexOf('<g', i);
      const c = out.indexOf('</g>', i);
      if (c < 0) return out;
      if (o >= 0 && o < c) { depth += 1; i = o + 2; } else { depth -= 1; i = c + 4; }
    }
    out = out.slice(0, m.index) + out.slice(m.index + m[0].length, i - 4) + out.slice(i);
  }
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

/**
 * 兜底：`chemdrawLabels` 认不准（`M  SMT` 与字形组对不上）时，**不换文字、只放大**标签。
 *
 * 为什么需要：换文字那条路要么全对要么原样返回；一旦返回原样，新存的图就是 Indigo
 * 自带的小字（0.23 键长），在一面墙里和别的小图对不上——用户会直接看到「这张字小了」。
 * 这里退一步：保留 Indigo 的字形，只把它们按 `LABEL_RATIO` 放大（几何原样，不改化学）。
 *
 * 与 `src/../scripts/normalize-labels.py` 同一套思路：同一个标签的若干 `<use>` 一起缩放，
 * 缩放中心挑「放大后与键线留白最大」的那个点，单字原子标绕原子（键端）原地放大。
 */
export function scaleGlyphLabels(svg, ratio = LABEL_RATIO) {
  const src = stripLabelWrappers(String(svg || ''));
  if (!src.includes('<svg') || !src.includes('xlink:href="#glyph')) return src;
  const mat = src.match(/transform="matrix\(([^)]+)\)"/);
  if (!mat) return src;
  const [mA, mB, , mD, mTx, mTy] = mat[1].split(',').map(Number);
  const bond = Math.hypot(mA, mB) || BOND_PX;   // 键长 = matrix 的缩放量（Ketcher 出图是 40）

  // 字形墨迹尺寸
  const glyphs = new Map();
  for (const g of src.matchAll(/<g id="(glyph-[^"]+)">([\s\S]*?)<\/g>/g)) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const p of g[2].matchAll(/d="([^"]+)"/g)) {
      const b = pathBox(p[1]);
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    if (Number.isFinite(x0)) glyphs.set(g[1], { w: x1 - x0, h: y1 - y0 });
  }
  if (!glyphs.size) return src;

  // 键段（用户坐标），用来算留白
  const segs = [];
  for (const m of src.matchAll(/d="M (-?[\d.]+) (-?[\d.]+) L (-?[\d.]+) (-?[\d.]+) "/g)) {
    segs.push([mTx + 40 * +m[1], mTy + mD * +m[2], mTx + 40 * +m[3], mTy + mD * +m[4]]);
  }

  // 分组：同基线 + 横向相邻
  const uses = [];
  for (const u of src.matchAll(/<use xlink:href="#([^"]+)" x="(-?[\d.]+)" y="(-?[\d.]+)"\/>/g)) {
    uses.push({ raw: u[0], id: u[1], x: +u[2], y: +u[3] });
  }
  const wrapGroup = (body, ax, ay, k) => `<g transform="translate(${num(ax)} ${num(ay)}) scale(${num(k)}) translate(${num(-ax)} ${num(-ay)})">${body}</g>`;
  // 一个标签的几个 <use> 在源文件里可能被换行/其它标签隔开：按首尾 raw 的位置整段包起来
  const wrapSpan = (svgText, grp, ax, ay, k) => {
    const firstRaw = grp.items[0].raw;
    const lastRaw = grp.items[grp.items.length - 1].raw;
    const i0 = svgText.indexOf(firstRaw);
    const i1 = svgText.indexOf(lastRaw, i0);
    if (i0 < 0 || i1 < 0) return svgText;
    const body = svgText.slice(i0, i1 + lastRaw.length);
    return svgText.slice(0, i0) + wrapGroup(body, ax, ay, k) + svgText.slice(i1 + lastRaw.length);
  };
  if (!uses.length) return src;
  const capMax = Math.max(...[...glyphs.values()].map((v) => v.h), 1);
  const groups = [];
  for (const it of uses) {
    const g = groups[groups.length - 1];
    const gap = g ? it.x - g.maxX : 0;
    // 字距 = 字宽 + 一点空隙，用字高做尺子（不同图的 px 尺度不一样，别写死数字）
    if (g && Math.abs(it.y - g.ys[0]) < capMax * 0.45 && gap > -capMax * 0.6 && gap < capMax * 1.2) {
      g.items.push(it);
      g.maxX = Math.max(g.maxX, it.x);
      g.ys.push(it.y);
    } else {
      groups.push({ items: [it], maxX: it.x, ys: [it.y] });
    }
  }

  const capOld = Math.max(...[...glyphs.values()].map((v) => v.h), 1);
  const K = ratio * bond / capOld;
  if (!(K > 1.02)) return src;

  // 点到矩形距离（判断标签会不会压到键线）
  const segBoxDist = ([ax, ay, bx, by], box) => {
    const [x0, y0, x1, y1] = box;
    const cl = (v, a, b) => Math.min(Math.max(v, a), b);
    // 采样 12 个点判断是否穿过（够用；精确求交对这里没有必要）
    let d = Infinity;
    for (let i = 0; i <= 12; i += 1) {
      const x = ax + ((bx - ax) * i) / 12;
      const y = ay + ((by - ay) * i) / 12;
      const dx = x - cl(x, x0, x1);
      const dy = y - cl(y, y0, y1);
      d = Math.min(d, Math.hypot(dx, dy));
    }
    return d;
  };

  let out = src;
  for (const g of groups) {
    const xs = g.items.map((i) => i.x);
    const bx0 = Math.min(...xs);
    const lastW = (glyphs.get(g.items[g.items.length - 1].id) || { w: capOld }).w;
    const bx1 = Math.max(...xs) + lastW;
    const by = g.ys[0];
    const cap = Math.max(...g.items.map((i) => (glyphs.get(i.id) || { h: capOld }).h));
    const by0 = by - cap;

    if (g.items.length === 1) {
      // 原子标：就地放大——中心取字母自己的中心（拿键端会偏，因为键端被截短过）
      out = wrapSpan(out, g, (bx0 + bx1) / 2, (by0 + by) / 2, K);
      continue;
    }

    // 多字标签：候选 9 点里挑留白最大的
    const cx = (bx0 + bx1) / 2;
    const cy = (by0 + by) / 2;
    const cands = [[bx0, by], [bx1, by], [cx, by], [bx0, cy], [bx1, cy], [cx, cy], [bx0, by0], [bx1, by0], [cx, by0]];
    let bestP = [cx, by];
    let bestClear = -Infinity;
    for (const [ax, ay] of cands) {
      const box = [
        Math.min(ax + (bx0 - ax) * K, ax), Math.min(ay + (by0 - ay) * K, ay),
        Math.max(ax + (bx1 - ax) * K, ax), Math.max(ay + (by - ay) * K, ay),
      ];
      let clear = Infinity;
      for (const s of segs) clear = Math.min(clear, segBoxDist(s, box));
      const near = Math.hypot(ax - cx, ay - cy);
      if (clear > bestClear + 1e-6 || (Math.abs(clear - bestClear) < 1e-6 && near < Math.hypot(bestP[0] - cx, bestP[1] - cy))) {
        bestClear = clear;
        bestP = [ax, ay];
      }
    }
    out = wrapSpan(out, g, bestP[0], bestP[1], K);
  }

  // 画布：键端 + 放大后的标签框都要装得下
  const pts = [];
  for (const m of out.matchAll(/d="M (-?[\d.]+) (-?[\d.]+) L (-?[\d.]+) (-?[\d.]+) "/g)) {
    pts.push([mTx + 40 * +m[1], mTy + mD * +m[2]], [mTx + 40 * +m[3], mTy + mD * +m[4]]);
  }
  for (const m of out.matchAll(/<g transform="translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+)\) translate\((-?[\d.]+) (-?[\d.]+)\)">([\s\S]*?)<\/g>/g)) {
    const k = +m[3];
    const ox = +m[1];
    const oy = +m[2];
    const cx0 = -(+m[4]);
    const cy0 = -(+m[5]);
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const u of m[6].matchAll(/x="(-?[\d.]+)" y="(-?[\d.]+)"/g)) {
      const x = +u[1];
      const y = +u[2];
      const gl = glyphs.get((m[6].match(/href="#([^"]+)"/) || [])[1]) || { w: capOld, h: capOld };
      x0 = Math.min(x0, x); x1 = Math.max(x1, x + gl.w);
      y0 = Math.min(y0, y - gl.h); y1 = Math.max(y1, y);
    }
    if (!Number.isFinite(x0)) continue;
    pts.push([ox + (x0 - cx0) * k, oy + (y0 - cy0) * k], [ox + (x1 - cx0) * k, oy + (y1 - cy0) * k]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (!xs.length) return out;
  const pad = Math.max(1.5, 0.05 * bond);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - x0;
  const h = Math.max(...ys) + pad - y0;
  const rebuilt = out.replace(
    /<svg[^>]*>/,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="${num(x0)} ${num(y0)} ${num(w)} ${num(h)}">`,
  );
  return normalizeScale(rebuilt, bond);
}
