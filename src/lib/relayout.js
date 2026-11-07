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
