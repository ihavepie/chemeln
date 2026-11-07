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
 * 「放置角度」：把整张图转一下，让键尽量落在 0° / 30° / 60° / 90°… 这些「整角度」上
 * （ChemDraw 那种规规矩矩的摆法）。做法是算所有键的方向偏差、取一个旋转量抵消掉
 * （按键长加权；只看 0–30° 这一档，因为 30° 一格已经能覆盖六元环 60°、四元环 90°、三元环 120°）。
 */
export function alignToGrid(mol) {
  const n = mol.getAllAtoms();
  if (n < 2) return false;
  let sum = 0;
  let wsum = 0;
  for (let b = 0; b < mol.getAllBonds(); b++) {
    const a1 = mol.getBondAtom(0, b);
    const a2 = mol.getBondAtom(1, b);
    const dx = mol.getAtomX(a2) - mol.getAtomX(a1);
    const dy = mol.getAtomY(a2) - mol.getAtomY(a1);
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    let off = deg % 30;
    if (off > 15) off -= 30;
    if (off < -15) off += 30;
    sum += off * len;
    wsum += len;
  }
  if (!wsum) return false;
  const rot = (-sum / wsum) * (Math.PI / 180);
  if (Math.abs(rot) < 0.01) return false;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
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

