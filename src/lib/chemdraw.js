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
  const [mA, , , mD, mTx, mTy] = mat[1].split(',').map(Number);

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
  /* 分组不能靠「文件里的先后顺序」：Indigo 写 `<use>` 的顺序不一定是从左到右
     （实测「H3C」是 H、3、C 之外还夹着别的标签），顺序法会把一个标签拆成几个单字，
     后面按位置匹配就对不上、整张图退回衬线字形。改成：先按基线聚类成「行」，
     行内按 x 排序，再把间距够近的连成一个标签。 */
  const capEst = Math.max(...[...glyphs.values()].map((x) => x.h), 1);
  const lines = [];
  for (const u of uses) {
    const line = lines.find((L) => Math.abs(u.y - L.y) < capEst * 0.5);
    if (line) line.items.push(u);
    else lines.push({ y: u.y, items: [u] });
  }
  const groups = [];
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    for (const it of L.items) {
      const g = groups[groups.length - 1];
      if (g && g.line === L && it.x - g.maxX < capEst * 1.3 && it.x - g.maxX > -capEst * 0.8) {
        g.items.push(it);
        g.maxX = Math.max(g.maxX, it.x);
        g.ys.push(it.y);
      } else {
        groups.push({ items: [it], maxX: it.x, ys: [it.y], line: L });
      }
    }
  }

  // ---- 3) 缩写文本（M  SMT）按**位置**匹配到各组
  // 以前按「字符数唯一匹配」：结构里只要还有 N / O 这种普通原子标，组数就跟 SMT 条数对不上，
  // 整张图直接退回 Indigo 的衬线字形（用户看到的「这块文字跟别处不一样」）。现在改成：
  // 用 molfile 里 SAL 的附着原子坐标 + matrix 算出每个缩写该在哪，取最近的那一组。
  const molText = String(mol || '');
  const molLines = molText.split(/\r?\n/);
  const natoms = parseInt(String(molLines[3] || '').slice(0, 3), 10) || 0;
  const atomXY = (i) => {
    const parts = String(molLines[3 + i] || '').trim().split(/\s+/);
    return [parseFloat(parts[0]), parseFloat(parts[1])];
  };
  const salOf = new Map();     // SMT 编号 → 附着原子（1 起）
  const smts = [];
  for (const line of molLines) {
    let m = line.match(/^M  SAL\s+(\d+)\s+(\d+)/);
    if (m) salOf.set(+m[1], +m[2]);
    m = line.match(/^M  SMT\s+(\d+)\s+(.+)$/);
    if (m) smts.push({ n: +m[1], text: m[2].trim().replace(/\s+/g, '') });
  }
  if (!smts.length) return src;
  const capGuess = Math.max(...[...glyphs.values()].map((x) => x.h), 1);
  const boxes = groups.map((g) => {
    const first = g.items[0];
    const lastW = (glyphs.get(g.items[g.items.length - 1].id) || { w: capGuess * 0.6 }).w;
    const bx0 = Math.min(...g.items.map((i) => i.x));
    const bx1 = Math.max(...g.items.map((i) => i.x)) + lastW;
    const by0 = Math.min(...g.ys) - capGuess;
    const by1 = Math.max(...g.ys);
    return [bx0, by0, bx1, by1];
  });
  const pairs = [];
  const used = new Set();
  for (const s of smts) {
    const ai = salOf.get(s.n);
    if (!ai || ai > natoms) return src;
    const [ax, ay] = atomXY(ai);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return src;
    const px = mA * ax + mTx;
    const py = mD * ay + mTy;
    let best = -1;
    let bestD = Infinity;
    groups.forEach((g, i) => {
      if (used.has(i)) return;
      const [x0, y0, x1, y1] = boxes[i];
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const d = Math.hypot(cx - px, cy - py);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    // 离得太远就不是这个缩写（坐标对不上时宁可不换）
    if (best < 0 || bestD > Math.max(80, 2.2 * capGuess)) return src;
    used.add(best);
    pairs.push({ g: groups[best], text: s.text });
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
    // 一行里「基线低一点」的字当数字下标（字母永不当下标：「Bn」的 n 曾被压下去）
    const ordered = g.items
      .map((it, i) => ({ x: it.x, y: g.ys[i] ?? it.y }))
      .sort((p, q) => p.x - q.x);
    const chars = text.split('');
    const segs = [];
    for (let i = 0; i < chars.length; i++) {
      const isSub = /[0-9]/.test(chars[i]) && (ordered[i]?.y ?? baseY) > baseY + 0.6;
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
  // 还没换掉的字形标签（原子标：N / O / H3C…）也得算进画布，不然重算 viewBox 会把它裁掉
  for (const m of svg.matchAll(/<use xlink:href="#[^"]+" x="(-?[\d.]+)" y="(-?[\d.]+)"\/>/g)) {
    const x = +m[1];
    const y = +m[2];
    pts.push([x, y - mainSize * 0.78], [x + mainSize * 0.62, y + subSize * 0.3]);
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

/* ================================================================
   缩写标签的「精确换字」（给 `chemdrawLabels` 认不准时用）
   ----------------------------------------------------------------
   为什么需要它：`chemdrawLabels` 靠「字形组 + molfile 坐标」去配对，Indigo 渲染时会把
   整个图归一化（平移 / 翻 y / 缩放），我们反算不出稳定的映射；结构里再混进 N / O 这种
   普通原子标，配对就更容易失败，于是整张图退回 Indigo 自带的衬线字形——
   用户一眼就看出「这张的缩写文字跟别的不一样」。
   这里的办法不需要算映射：**一条缩写单独渲一张**，那张里只有它这一个多字标签，
   位置就是它在整图里的位置（坐标没变），拿这个位置回整图里把同一组的字形换成文字。
   ================================================================ */

/** 把**别的**缩写换成单字占位符 `X`、目标那条保持原样：这样图里只有它一个「多字标签」，
 *  按字符数就能认出来（同一个化合物里常有两个 OMe，全换成同一个 X 会留下两个三字标签，
 *  那就分不清了——所以只换别的，不换自己）。 */
function molWithOnlyText(mol, keep) {
  return String(mol)
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^M  SMT\s+(\d+)\s+(.+)$/);
      if (!m) return line;
      return Number(m[1]) === keep ? line : `M  SMT   ${m[1]} X`;
    })
    .join('\n');
}

/** 图里的键端点坐标（就是 molfile 的坐标，不随整图平移变） */
function bondEnds(svg) {
  const pts = [];
  for (const m of String(svg).matchAll(/d="M (-?[\d.]+) (-?[\d.]+) L (-?[\d.]+) (-?[\d.]+) "/g)) {
    pts.push([+m[1], +m[2]], [+m[3], +m[4]]);
  }
  return pts;
}

/** 把一张图里的字形 <use> 按「同一基线 + 横向相邻」聚成标签，返回 {items, box} */
function glyphGroups(svg) {
  const glyphs = new Map();
  for (const g of String(svg).matchAll(/<g id="(glyph-[^"]+)">\s*<path d="([^"]+)"/g)) {
    const box = pathBox(g[2]);
    glyphs.set(g[1], { w: Math.max(box.x1, 0.4), h: -box.y0, d: g[2].trim() });
  }
  const cap = Math.max(...[...glyphs.values()].map((x) => x.h), 1);
  const uses = [];
  for (const u of String(svg).matchAll(/<use xlink:href="#([^"]+)" x="(-?[\d.]+)" y="(-?[\d.]+)"\/>/g)) {
    uses.push({ raw: u[0], id: u[1], x: +u[2], y: +u[3] });
  }
  const lines = [];
  for (const u of uses) {
    const line = lines.find((L) => Math.abs(u.y - L.y) < cap * 0.5);
    if (line) line.items.push(u);
    else lines.push({ y: u.y, items: [u] });
  }
  const groups = [];
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    for (const it of L.items) {
      const g = groups[groups.length - 1];
      if (g && g.line === L && it.x - g.maxX < cap * 1.3 && it.x - g.maxX > -cap * 0.8) {
        g.items.push(it);
        g.maxX = Math.max(g.maxX, it.x);
        g.ys.push(it.y);
      } else {
        groups.push({ items: [it], maxX: it.x, ys: [it.y], line: L });
      }
    }
  }
  for (const g of groups) {
    const lastW = (glyphs.get(g.items[g.items.length - 1].id) || { w: cap * 0.6 }).w;
    const xs = g.items.map((i) => i.x);
    const bx0 = Math.min(...xs);
    const bx1 = Math.max(...xs) + lastW;
    const baseY = Math.max(...g.ys);
    g.box = { x0: bx0, x1: bx1, baseY, cap, w: bx1 - bx0 };
    // 每个字的轮廓数据：跟别的渲染里同名字符完全一样，可以用来认字
    g.paths = g.items.map((i) => glyphs.get(i.id)?.d || '');
  }
  return groups;
}

/**
 * molfile → 已经把缩写换成无衬线 `<text>` 的 SVG；认不准时返回 ''（调用方自己退回）。
 * 只在「结构里有缩写（M  SMT）」时才有意义。
 */
export async function chemdrawLabelsExact(mol, indigoSvg, ratio = LABEL_RATIO) {
  const lines = String(mol || '').split(/\r?\n/);
  const smts = [];
  for (const line of lines) {
    const m = line.match(/^M  SMT\s+(\d+)\s+(.+)$/);
    if (m) smts.push({ n: +m[1], text: m[2].trim().replace(/\s+/g, '') });
  }
  if (!smts.length) return '';

  // ① 一条一条单独渲，拿到每个缩写在图里的位置
  const spots = [];
  for (const s of smts) {
    let one = '';
    try {
      one = await indigoSvg(molWithOnlyText(mol, s.n));
    } catch (e) {
      return '';
    }
    // 只留一条缩写后，长度等于它字数的那一组就是它；万一还撞上同样长的原子标（H3C 之类），
    // 宁可这一个不换，也别换错
    const all = glyphGroups(one);
    const cands = all.filter((g) => g.items.length === s.text.length);
    if (cands.length !== 1) return '';
    const box = cands[0].box;
    // 锚点 = 离标签最近的键端点：键端点坐标就是 molfile 坐标，**每张渲染里都一样**，
    // 而标签自身的坐标会随整图归一化平移（这张图别的标签被换成了 X，宽度变了，整图就挪了）
    let anchor = null;
    let ad = Infinity;
    for (const e of bondEnds(one)) {
      const d = Math.hypot(e[0] - (box.x0 + box.x1) / 2, e[1] - box.baseY);
      if (d < ad) {
        ad = d;
        anchor = e;
      }
    }
    if (!anchor) return '';
    spots.push({ text: s.text, box, anchor, offset: [(box.x0 + box.x1) / 2 - anchor[0], box.baseY - anchor[1]], paths: cands[0].paths });
  }

  // ② 整图再来一张，把位置对得上的那几组字形换成文字
  let base = '';
  try {
    base = await indigoSvg(mol);
  } catch (e) {
    return '';
  }
  const groups = glyphGroups(base);
  const pairs = [];
  const used = new Set();
  for (const sp of spots) {
    let best = -1;
    let bestD = Infinity;
    // ① 先按字形轮廓认：同一个字符在不同渲染里的 path 逐字相同，跟整图怎么平移无关
    const byPath = groups.findIndex((g, i) => {
      if (used.has(i)) return false;
      const a = g.paths || [];
      const b = sp.paths || [];
      if (a.length !== b.length || !a.length || a.join('|') !== b.join('|')) return false;
      return true;
    });
    if (byPath >= 0) {
      used.add(byPath);
      pairs.push({ g: groups[byPath], text: sp.text });
      continue;
    }
    groups.forEach((g, i) => {
      if (used.has(i)) return;
      // 单条渲染时别的缩写换成了长占位符，标签整体宽度会变、中心会平移；
      // 但**基线 y 一定不变**，所以先按 y 卡，再按 x 最近（宽松一点）
      if (g.items.length !== sp.text.length) return;   // 字符数得对上（过滤掉 H3C 这类原子标）
      // 预期位置 = 锚点（两张渲染里一致）+ 单条渲染里量到的相对偏移
      const wantX = sp.anchor[0] + sp.offset[0];
      const wantY = sp.anchor[1] + sp.offset[1];
      const d = Math.hypot((g.box.x0 + g.box.x1) / 2 - wantX, g.box.baseY - wantY);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0 || bestD > sp.box.cap * 1.5) return '';
    used.add(best);
    pairs.push({ g: groups[best], text: sp.text });
  }

  // ③ 换字：字号按 Indigo 的字形高度换算成同一视觉高度，下标只认数字
  const capOld = Math.max(...groups.map((g) => g.box.cap), 1);
  const mainSize = Math.round((capOld / CAP_RATIO) * 10) / 10;
  const subSize = Math.round(mainSize * 0.75 * 10) / 10;
  const subDrop = Math.max(1.4, mainSize * 0.2);
  let out = base;
  for (const { g, text } of pairs) {
    for (const it of g.items) out = out.replace(it.raw, '');
    const ordered = g.items.map((it, i) => ({ x: it.x, y: g.ys[i] ?? it.y })).sort((p, q) => p.x - q.x);
    const baseY = ordered[0]?.y ?? g.box.baseY;
    const chars = text.split('');
    const segs = [];
    for (let i = 0; i < chars.length; i++) {
      const isSub = /[0-9]/.test(chars[i]) && (ordered[i]?.y ?? baseY) > baseY + capOld * 0.12;
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
    const textEl =
      `<text x="${num(g.box.x0)}" y="${num(baseY)}" font-family="${FONT}" font-size="${mainSize}" ` +
      `fill="#1a1a1a" text-anchor="start">${body}</text>`;
    out = out.replace('</svg>', `${textEl}\n</svg>`);
  }

  // ④ 画布重新量一遍（无衬线字比原来的宽/高），然后再归到统一尺度
  const mat = out.match(/transform="matrix\(([^)]+)\)"/);
  if (!mat) return '';
  const [mA] = mat[1].split(',').map(Number);
  return normalizeScale(fitCanvas(scaleTo(out, mA), mainSize, subSize), Math.abs(mA));
}

/** 把 matrix 的 x 缩放当「一根键多少单位」，统一成 24px/键的显示尺度（跟 normalizeScale 配套） */
function scaleTo(svg, mA) {
  return svg; // normalizeScale 已经按 viewBox 处理；这里留一层，避免 mA 为 0 时崩
}
