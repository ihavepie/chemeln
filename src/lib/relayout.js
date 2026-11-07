/**
 * 把 2D 坐标重排成规整的样子——**用 Indigo 的 layout，但只把坐标写回原来的分子**，
 * 化学信息（键级、立体、电荷、基团）全都还是 openchemlib 自己解析的那一份。
 *
 * 为什么要这一步：
 *  1. openchemlib 自己排的键角在螺环 / 并环 / 多取代的环上经常是歪的（几个底物挤成一团）；
 *  2. 它的 layout **带随机性**——同一个 SMILES 连续排两次，坐标可能不一样（实测过），
 *     所以「同一个化合物每次画出来长得不同」。
 * 只搬坐标不换引擎，观感（彩色杂原子、字体）就不会变。
 *
 * 搬之前要确认「原子数一致、每个位置的元素标签也一致」：序号对不上就别搬，
 * 宁可保持原样，也别把结构画变形。
 */
export async function relayoutMolecule(lib, mol) {
  try {
    const { indigoLayout } = await import('./indigo.js');
    const laid = await indigoLayout(mol.toMolfile());
    const lm = lib.Molecule.fromMolfile(laid);
    const n = mol.getAllAtoms();
    if (lm.getAllAtoms() !== n) return false;
    for (let i = 0; i < n; i++) if (lm.getAtomLabel(i) !== mol.getAtomLabel(i)) return false;
    for (let i = 0; i < n; i++) {
      mol.setAtomX(i, lm.getAtomX(i));
      mol.setAtomY(i, lm.getAtomY(i));
    }
    return true;
  } catch {
    return false;
  }
}

/** 分子坐标的包围盒 [x0, y0, x1, y1] */
export function boundsOf(mol) {
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
  return [x0, y0, x1, y1];
}

/**
 * 「摆正」：转整张图，挑一个最像 ChemDraw 的摆法。
 * 规则（按优先级）：
 *  1. **羰基（C=O）竖着**——用户点名要的，环酮画成 C=O 朝上/朝下，跟 ChemDraw 一个样；
 *  2. 环上的键尽量落在 0°/90° 或 30° 的整角度上（四元环成正方、六元环成规则六边形）；
 *  3. 横着比竖着好看（宽格子），竖着的图扣分。
 * 候选角度：每根键转到 12 个整角度所需的旋转量都试一遍，取分数最高的那个（几十根键，算得很快）。
 */
export function canonicalOrientation(lib, mol) {
  const n = mol.getAllAtoms();
  if (n < 2) return false;
  try {
    mol.ensureHelperArrays(lib.Molecule.cHelperCIP);
  } catch {
    return false;
  }
  const bonds = [];
  for (let b = 0; b < mol.getAllBonds(); b++) {
    const a1 = mol.getBondAtom(0, b);
    const a2 = mol.getBondAtom(1, b);
    const dx = mol.getAtomX(a2) - mol.getAtomX(a1);
    const dy = mol.getAtomY(a2) - mol.getAtomY(a1);
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    let carbonyl = false;
    try {
      carbonyl =
        mol.getBondOrder(b) === 2 &&
        ((mol.getAtomLabel(a1) === 'C' && mol.getAtomLabel(a2) === 'O') ||
          (mol.getAtomLabel(a1) === 'O' && mol.getAtomLabel(a2) === 'C'));
    } catch {
      /* 读不出键级就当普通键 */
    }
    let ring = false;
    try {
      ring = mol.isRingBond(b);
    } catch {
      /* 拿不到环标记就只按普通键算 */
    }
    bonds.push({ a1, deg, carbonyl, ring });
  }
  if (!bonds.length) return false;

  const mod = (v, m) => ((v % m) + m) % m;
  const near = (v, target, tol = 2.5) => Math.abs(((mod(v - target, 360) + 180) % 360) - 180) <= tol;

  // 候选：把任意一根键转到任意一个 30° 整角
  const cands = [];
  for (const bd of bonds) for (let k = 0; k < 12; k++) cands.push(mod(k * 30 - bd.deg, 360));

  let best = 0;
  let bestScore = -Infinity;
  for (const rot of cands) {
    let score = 0;
    for (const bd of bonds) {
      const a = mod(bd.deg + rot, 360);
      if (bd.carbonyl) {
        // 羰基：竖着最好（朝上再好一点），横着最差
        if (near(a, 90)) score += 130;
        else if (near(a, 270)) score += 120;
        else if (near(a, 0) || near(a, 180)) score -= 40;
        else score -= 10;
      }
      if (bd.ring) {
        if (near(a, 0) || near(a, 180) || near(a, 90) || near(a, 270)) score += 8;
        else if (near(a, 30) || near(a, 150) || near(a, 210) || near(a, 330)) score += 3;
      } else if (near(a, 0) || near(a, 180)) {
        score += 0.5;
      }
    }
    // 景观加成：横着比竖着好
    if (score > -Infinity) {
      const [x0, y0, x1, y1] = boundsOf(mol);
      const w = x1 - x0;
      const h = y1 - y0;
      const c = Math.cos((rot * Math.PI) / 180);
      const s = Math.sin((rot * Math.PI) / 180);
      const rw = Math.abs(w * c) + Math.abs(h * s);
      const rh = Math.abs(w * s) + Math.abs(h * c);
      if (rh > rw * 1.05) score -= 30;
    }
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = rot;
    }
  }
  if (Math.abs(best) < 0.01) return false;
  const cos = Math.cos((best * Math.PI) / 180);
  const sin = Math.sin((best * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const x = mol.getAtomX(i);
    const y = mol.getAtomY(i);
    mol.setAtomX(i, x * cos - y * sin);
    mol.setAtomY(i, x * sin + y * cos);
  }
  return true;
}

/**
 * 「放置角度」：竖着画（比宽还高）的结构转 90° 摆平。
 * 记录本里那些格子都是宽的，竖图会被压得很小；摆平之后才占满格子。
 * 只转坐标、不镜像，所以手性 / 顺反都还在（楔形键跟着一起转）。
 */
export function orientLandscape(mol) {
  const [x0, y0, x1, y1] = boundsOf(mol);
  const w = x1 - x0;
  const h = y1 - y0;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
  if (h <= w * 1.05) return false; // 本来就不算竖，别乱转
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    const x = mol.getAtomX(i);
    const y = mol.getAtomY(i);
    mol.setAtomX(i, y);
    mol.setAtomY(i, -x);
  }
  return true;
}

