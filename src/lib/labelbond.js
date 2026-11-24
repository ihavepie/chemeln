/**
 * Indigo 画的 SVG：给字母标签（HO / NH₂ / Ts…）让位时会把**紧挨标签那根键截短**
 * （实测 C–O 只画到 0.74 根键长，旁边的键是 1.00），而且线头离字只有 2px 左右。
 * 图一缩小看，那根键短一截、字又贴着线头，像是「挤在那里」。
 *
 * 这里不动布局、不动分子：只做三件事——
 *   ① 把明显偏短的键**朝标签那头补回来**（补到中位键长的 ~0.9）；
 *   ② 这颗标签（同一原子的几个字母）**一起往外挪**同样的距离，缝一点不少；
 *   ③ 挪出去的部分把 `viewBox` / `width` / `height` 撑开，别被裁掉。
 * 所以「画板里画什么样」出来的形状、比例都不变，只是那根键不再短一截。
 */

/** 一根键比中位数短这么多倍才算「被标签截过」。别设太高：芳香环里那条内线本来就
 *  比中位数短（实测 0.84），0.85 会把环也当成截过的键、把环画歪 */
const SHORT = 0.8;
/** 线头离标签多近才算「挨着标签」（按中位键长的倍数） */
const NEAR = 0.6;
/** 这个距离以内的字母跟着一起挪（同一个标签的两个字母要一起走） */
const GROUP = 0.85;
/** 补到中位键长的多少 */
const FILL = 0.9;
/** 标签比键**再多挪一点**（补键只是把长度补回来，缝不变；这里再把缝拉开一点）。
 *  小尺寸显示时 2px 的缝会糊成一处，看着就像字和键黏在一起 */
const GAP = 0.12;

const toNum = (s) => Number(s);
const round = (n, k = 1e4) => Math.round(n * k) / k;

function parseMatrix(s) {
  const m = String(s || '').match(/matrix\(\s*([^)]+)\)/);
  if (!m) return null;
  const v = m[1].split(',').map((x) => toNum(x.trim()));
  if (v.length !== 6 || v.some((n) => !Number.isFinite(n))) return null;
  return v;
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** 从 (x0,y0) 沿单位方向 (ux,uy) 走，多远会进到矩形 [x0r,y0r,x1r,y1r]；不进返回 Infinity */
function rayBox(x, y, ux, uy, r) {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes = [
    [x, ux, r[0], r[2]],
    [y, uy, r[1], r[3]],
  ];
  for (const [o, u, lo, hi] of axes) {
    if (Math.abs(u) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
      continue;
    }
    let t1 = (lo - o) / u;
    let t2 = (hi - o) / u;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return Infinity;
  }
  return tmin > 0 ? tmin : tmax > 0 ? 0 : Infinity;
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** 每个 glyph 的字形框（字形坐标里，用路径上的点近似） */
function glyphBoxes(svg) {
  const out = new Map();
  const cut = svg.indexOf('</defs>');
  const head = cut > 0 ? svg.slice(0, cut) : '';
  for (const m of head.matchAll(/<g id="(glyph-[\d-]+)">([\s\S]*?)<\/g>/g)) {
    const nums = [...m[2].matchAll(/-?\d+(?:\.\d+)?/g)].map((x) => toNum(x[0]));
    if (nums.length < 4) continue;
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    out.set(m[1], { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
  }
  return out;
}

function scan(svg, boxes) {
  const bonds = [];
  const bondRe =
    /<path\b[^>]*\bd="M\s*([-\d.]+)\s+([-\d.]+)\s+L\s*([-\d.]+)\s+([-\d.]+)\s*"[^>]*\btransform="([^"]+)"[^>]*\/>/g;
  for (const m of svg.matchAll(bondRe)) {
    const mat = parseMatrix(m[5]);
    if (!mat) continue;
    bonds.push({
      at: m.index,
      len: m[0].length,
      raw: m[0],
      x1: toNum(m[1]),
      y1: toNum(m[2]),
      x2: toNum(m[3]),
      y2: toNum(m[4]),
      mat,
    });
  }

  const labels = [];
  const useRe = /<use\b[^>]*\bxlink:href="#(glyph-[\d-]+)"[^>]*\bx="([-\d.]+)"[^>]*\by="([-\d.]+)"/g;
  for (const m of svg.matchAll(useRe)) {
    const box = boxes.get(m[1]);
    if (!box) continue;
    const head = svg.slice(Math.max(0, m.index - 700), m.index);
    const gs = [...head.matchAll(/translate\(\s*([-\d.]+)\s+([-\d.]+)\s*\)\s*scale\(\s*([-\d.]+)\s*\)/g)];
    if (!gs.length) continue;
    const g = gs[gs.length - 1];
    const A = toNum(g[1]), B = toNum(g[2]), S = toNum(g[3]);
    const X = toNum(m[2]), Y = toNum(m[3]);
    const p1 = [A + S * (X + box.x0 - A), B + S * (Y + box.y0 - B)];
    const p2 = [A + S * (X + box.x1 - A), B + S * (Y + box.y1 - B)];
    labels.push({
      at: m.index,
      len: m[0].length,
      raw: m[0],
      x: X,
      y: Y,
      S,
      pos: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2],
      dx: 0,
      dy: 0,
      rect: [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])],
    });
  }
  return { bonds, labels };
}

/**
 * @param {string} svg Indigo 出的 SVG（单张结构）
 * @returns {string} 把「贴着字母标签的短键」补长、标签一起外移的 SVG（认不出格式就原样返回）
 */
export function spreadLabelBonds(svg) {
  const src = String(svg || '');
  if (!src.includes('<svg') || !src.includes('xlink:href="#glyph')) return src;
  const boxes = glyphBoxes(src);
  if (!boxes.size) return src;
  const { bonds, labels } = scan(src, boxes);
  if (bonds.length < 3 || !labels.length) return src;

  const px = bonds.map((b) => {
    const p1 = apply(b.mat, b.x1, b.y1);
    const p2 = apply(b.mat, b.x2, b.y2);
    return { b, p1, p2, L: Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) };
  });
  const med = median(px.map((o) => o.L));
  if (!med) return src;

  const edits = [];
  const moved = new Set();
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;

  for (const o of px) {
    if (o.L >= med * SHORT) continue;
    // 哪一头贴着标签？取离标签中心最近的那头
    let end = null;
    let best = Infinity;
    for (const [tag, p] of [['p1', o.p1], ['p2', o.p2]]) {
      for (const l of labels) {
        const d = Math.hypot(l.pos[0] - p[0], l.pos[1] - p[1]);
        if (d < best) {
          best = d;
          end = tag;
        }
      }
    }
    if (!end || best > med * NEAR) continue;

    const from = end === 'p1' ? o.p2 : o.p1;
    const to = end === 'p1' ? o.p1 : o.p2;
    const dl = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    const ux = (to[0] - from[0]) / dl;
    const uy = (to[1] - from[1]) / dl;
    // 这颗标签（可能两个字母）的外框：把挨得近的几个合起来
    const near = labels.filter((l) => Math.hypot(l.pos[0] - to[0], l.pos[1] - to[1]) <= med * GROUP);
    const box = near.length
      ? near.reduce(
          (a, l) => [
            Math.min(a[0], l.rect[0]),
            Math.min(a[1], l.rect[1]),
            Math.max(a[2], l.rect[2]),
            Math.max(a[3], l.rect[3]),
          ],
          [Infinity, Infinity, -Infinity, -Infinity]
        )
      : null;
    if (!box) continue;

    const gapPx = med * GAP;                 // 字和线之间要留的缝
    // (ux, uy) 是「从键的这头指向标签那头」，所以往外退就是 **加**，写反了会把框往里挪、
    // 算出「没有空间」直接跳过（踩过：标签动了、键一点没补）
    const enterAt = (shift) =>
      rayBox(from[0], from[1], ux, uy, [
        Math.min(box[0] + shift * ux, box[2] + shift * ux) - gapPx,
        Math.min(box[1] + shift * uy, box[3] + shift * uy) - gapPx,
        Math.max(box[0] + shift * ux, box[2] + shift * ux) + gapPx,
        Math.max(box[1] + shift * uy, box[3] + shift * uy) + gapPx,
      ]);
    // 标签该退多远：至少留出 gapPx 的缝；要是不够让键补到 FILL 根键长，就再多退一点。
    // （只退 gapPx 的话，键会被「缝」吃掉，长度还是短 —— 上一版就是这样没效果）
    // 退多少：正好抵掉「键比 FILL 短的那截」，再额外留半条缝；退太多标签会跟键脱开
    const shift = Math.max(gapPx, med * FILL - o.L + gapPx * 0.5);
    const tEnter = enterAt(shift);
    const target = Number.isFinite(tEnter) ? Math.min(med * FILL, tEnter) : med * FILL;
    const add = Math.max(0, target - o.L);
    if (add < 1) continue;

    // ① 键补长（换回原子坐标系再拼 d）
    const nx = to[0] + ux * add;
    const ny = to[1] + uy * add;
    const m = o.b.mat;
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) continue;
    const ax = ((nx - m[4]) * m[3] - (ny - m[5]) * m[2]) / det;
    const ay = ((ny - m[5]) * m[0] - (nx - m[4]) * m[1]) / det;
    const f = (n) => String(round(n, 1e6));
    const newD =
      end === 'p1'
        ? `M ${f(ax)} ${f(ay)} L ${f(o.b.x2)} ${f(o.b.y2)} `
        : `M ${f(o.b.x1)} ${f(o.b.y1)} L ${f(ax)} ${f(ay)} `;
    edits.push({ at: o.b.at, len: o.b.len, txt: o.b.raw.replace(/d="[^"]+"/, `d="${newD}"`) });

    // ② 这颗标签一起往外挪（use 的 x/y 在 scale 之前，要除以 S）
    for (const l of labels) {
      if (moved.has(l.at)) continue;
      if (Math.hypot(l.pos[0] - to[0], l.pos[1] - to[1]) > med * GROUP) continue;
      // 标签往外退 `shift`（键补长以后缝不会变成 0）
      const dx = ux * shift;
      const dy = uy * shift;
      l.dx += dx;
      l.dy += dy;
      moved.add(l.at);
      left = Math.max(left, dx < 0 ? -dx : 0);
      right = Math.max(right, dx > 0 ? dx : 0);
      top = Math.max(top, dy < 0 ? -dy : 0);
      bottom = Math.max(bottom, dy > 0 ? dy : 0);
    }
  }

  // ④ 一个字上有两个字母（HO / NH / Cl…）时，Indigo 把它们排得很紧，
  //    缩到卡片大小会糊成一团：按左右顺序各推开一点（横排文字，只动 x）
  const used = new Set();
  for (const a of labels) {
    if (used.has(a.at)) continue;
    const group = labels.filter(
      (b) => Math.abs(b.pos[1] - a.pos[1]) < med * 0.35 && Math.abs(b.pos[0] - a.pos[0]) < med * 0.45
    );
    if (group.length < 2) continue;
    group.sort((x, y) => x.pos[0] - y.pos[0]);
    const step = med * 0.09;
    group.forEach((g, i) => {
      if (used.has(g.at)) return;
      used.add(g.at);
      const dx = (i - (group.length - 1) / 2) * step;
      if (!dx) return;
      g.dx += dx;                       // 记在标签上，最后和「往外退」一起写成一条 edit
      g.pos[0] += dx;
      left = Math.max(left, dx < 0 ? -dx : 0);
      right = Math.max(right, dx > 0 ? dx : 0);
    });
  }

  for (const l of labels) {
    if (!l.dx && !l.dy) continue;
    edits.push({
      at: l.at,
      len: l.len,
      txt: l.raw
        .replace(/\bx="[-\d.]+"/, `x="${round(l.x + (l.dx || 0) / l.S)}"`)
        .replace(/\by="[-\d.]+"/, `y="${round(l.y + (l.dy || 0) / l.S)}"`),
    });
  }

  if (!edits.length) return src;
  let out = src;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.txt + out.slice(e.at + e.len);

  // ③ 挪出去的标签别被画布裁掉：viewBox 和 width/height 一起撑开。
  //    四边再各留 3% 的白，字才不会顶在画布边上（缩到卡片大小时顶边看着也像「挤」）
  const vb = out.match(/viewBox="([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"/);
  if (vb) {
    const pad = Math.max(3, Math.min(toNum(vb[3]), toNum(vb[4])) * 0.03);
    left += pad;
    right += pad;
    top += pad;
    bottom += pad;
  }
  if (vb && (left || right || top || bottom)) {
    const x = toNum(vb[1]);
    const y = toNum(vb[2]);
    const w = toNum(vb[3]);
    const h = toNum(vb[4]);
    out = out.replace(
      vb[0],
      `viewBox="${round(x - left)} ${round(y - top)} ${round(w + left + right)} ${round(h + top + bottom)}"`
    );
    out = out.replace(
      /<svg([^>]*?)\swidth="(\d+(?:\.\d+)?)(px)?"([^>]*?)\sheight="(\d+(?:\.\d+)?)(px)?"/,
      (mm, a, w0, _u, b, h0) =>
        `<svg${a} width="${Math.round(toNum(w0) + left + right)}"${b} height="${Math.round(toNum(h0) + top + bottom)}"`
    );
  }
  return out;
}
