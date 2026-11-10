/**
 * 缩写基团的键「看着短一截」的补法。
 *
 * 现象：画板（Ketcher）出图时，Indigo 会在缩写标签（Ph / OMe / CO2Me / Ts…）的文字前面留位，
 * 把那根键的键头截掉。实测（化合物 A，SMILES C1C(OC)(OC)CC1(C(=O)OC)C1=CC=CC=C1）：
 * 环键 40px，四条连标签的键全是 28.8px —— 正好 0.72 倍，四条一模一样（OMe 窄、CO2Me 宽，
 * 截掉的量却不跟着宽度变），说明截的是「标签字号」对应的固定量，跟键长无关。
 * 反推验证：字号 24px → 0.76、8px → 0.84；把附着原子往外挪 0.3 个键长 → 四条键回到 0.99 倍。
 *
 * 所以做法是把缩写基团的**附着原子在 2D 坐标里沿键方向往外挪** `k` 个键长。
 * 只动坐标、不动化学：连接关系、键级、电荷都没变，分子式 / 分子量照旧走 SMILES；
 * 以后拿这个 molfile 再进画板也照样能用，而且画板里看到的间距跟存档图一致。
 */

/** 往外挪多少（单位是「键长」）。0.3 正好把 Indigo 截掉的那一截补平。 */
export const ABBREV_SPREAD = 0.3;

/** 整条反应式（RXN）也照同一个规矩补：把里面每个 `$MOL` 块各自补一遍，再拼回去。
 *  画板「画反应式」走的是这条路，不补的话同一批化合物在反应式里键会显短。 */
export function spreadRxnAbbrevBonds(rxn, k = ABBREV_SPREAD) {
  const src = String(rxn || '');
  if (!src || !/^\$MOL\s*$/m.test(src)) return spreadAbbrevBonds(src, k);
  const head = [];
  const blocks = [];
  let cur = null;
  for (const line of src.split(/\r?\n/)) {
    if (/^\$MOL\s*$/.test(line)) {
      if (cur) blocks.push(cur);
      cur = [];
      continue;
    }
    if (cur) cur.push(line);
    else head.push(line);
  }
  if (cur) blocks.push(cur);
  const out = [head.join('\n')];
  for (const b of blocks) out.push('$MOL', spreadAbbrevBonds(b.join('\n'), k));
  return out.join('\n');
}

/** 已经挪过的就不要再挪（挪两遍会变成 1.6 倍键长，越存越长） */
const ALREADY_SPREAD = 1.15;

/** V2000 定宽写回：x / y 各占 10 格（4 位小数），剩下的列原样抄 */
function putAtom(line, x, y) {
  return x.toFixed(4).padStart(10) + y.toFixed(4).padStart(10) + line.slice(20);
}

/**
 * @param {string} mol molfile 文本
 * @param {number} k 外移量（键长倍数）
 * @returns {string} 新的 molfile；不是 V2000 或没有缩写基团时原样返回
 */
export function spreadAbbrevBonds(mol, k = ABBREV_SPREAD) {
  const src = String(mol || '');
  if (!src) return src;
  const lines = src.split(/\r?\n/);
  // 计数行：正常是第 4 行（0 起算 3）；V3000 的块结构不一样，不碰
  let countAt = lines.findIndex((l, i) => i > 0 && /^\s*\d+\s+\d+/.test(l) && /V2000|V3000/.test(l));
  if (countAt < 0) countAt = 3;
  const counts = lines[countAt] || '';
  if (/V3000/.test(counts)) return src;
  const na = parseInt(counts.slice(0, 3), 10);
  const nb = parseInt(counts.slice(3, 6), 10);
  if (!(na > 0) || !(nb > 0)) return src;
  const atomAt = countAt + 1;
  const bondAt = atomAt + na;
  if (lines.length < bondAt + nb) return src;

  const atoms = [];
  for (let i = 0; i < na; i++) {
    const l = lines[atomAt + i] || '';
    atoms.push({ x: parseFloat(l.slice(0, 10)), y: parseFloat(l.slice(10, 20)) });
  }
  const bonds = [];
  for (let i = 0; i < nb; i++) {
    const l = lines[bondAt + i] || '';
    bonds.push([parseInt(l.slice(0, 3), 10), parseInt(l.slice(3, 6), 10)]);
  }

  // 缩写基团 = S-group（M  SAL 给出成员、M  SAP 给出附着原子）。
  // 注意 Ketcher 只给**部分**组写 SAP（实测 Ph / CO2Me 有、两个 OMe 没有），
  // 所以缺 SAP 时用「组内原子连到组外的那根键」倒推附着原子。
  const groups = new Map(); // sss -> { atoms:Set, attach:number[] }
  for (const line of lines) {
    let m = line.match(/^M  SAL\s+(\d+)\s+(\d+)(.*)$/);
    if (m) {
      const n = parseInt(m[2], 10);
      const ids = m[3].trim().split(/\s+/).filter(Boolean).slice(0, n).map(Number);
      groups.set(parseInt(m[1], 10), { atoms: new Set(ids), attach: [] });
      continue;
    }
    m = line.match(/^M  SAP\s+(\d+)\s+(\d+)(.*)$/);
    if (m) {
      const n = parseInt(m[2], 10);
      const ids = m[3].trim().split(/\s+/).filter(Boolean).slice(0, n).map(Number);
      const g = groups.get(parseInt(m[1], 10));
      if (g) g.attach.push(...ids.filter((id) => g.atoms.has(id)));
    }
  }
  // 原子别名（M  ALS）也是标签，但它是单原子、没有组成员
  const aliasAtoms = new Set();
  for (const line of lines) {
    const m = line.match(/^M  ALS\s+(\d+)\s+(\d+)/);
    if (m) aliasAtoms.add(parseInt(m[2], 10) || parseInt(m[1], 10));
  }
  if (!groups.size && !aliasAtoms.size) return src;

  /** 某个原子「连到组外」的邻居（附件原子应当只有 1 个） */
  const outsideNeighbors = (a, members) =>
    bonds.filter(([i, j]) => i === a || j === a).map(([i, j]) => (i === a ? j : i)).filter((b) => !members.has(b));

  const targets = []; // [atomId, members]
  for (const g of groups.values()) {
    if (!g.atoms.size) continue;
    const attach = g.attach.length ? g.attach.filter((a) => outsideNeighbors(a, g.atoms).length === 1) : [];
    if (attach.length) {
      for (const a of attach) targets.push([a, g.atoms]);
      continue;
    }
    // 没 SAP：组里恰好只有一个原子连到组外，就是它
    const cross = [...g.atoms].filter((a) => outsideNeighbors(a, g.atoms).length > 0);
    if (cross.length === 1 && outsideNeighbors(cross[0], g.atoms).length === 1) targets.push([cross[0], g.atoms]);
  }
  for (const a of aliasAtoms) {
    const members = new Set([a]);
    if (outsideNeighbors(a, members).length === 1) targets.push([a, members]);
  }

  const moved = new Set();
  for (const [a, members] of targets) {
    const p = atoms[a - 1];
    if (!p) continue;
    const outside = outsideNeighbors(a, members);
    if (outside.length !== 1) continue;
    const q = atoms[outside[0] - 1];
    if (!q) continue;
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    const d = Math.hypot(dx, dy);
    if (!(d > 0.2) || d > ALREADY_SPREAD) continue; // 已经挪过的别再挪
    const len = d + k;
    p.x = q.x + (dx / d) * len;
    p.y = q.y + (dy / d) * len;
    moved.add(a);
  }
  if (!moved.size) return src;

  for (const a of moved) {
    lines[atomAt + a - 1] = putAtom(lines[atomAt + a - 1], atoms[a - 1].x, atoms[a - 1].y);
  }
  return lines.join('\n');
}
