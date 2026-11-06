/**
 * 常见基团缩写（Ts / Boc / CO2Et 这些）——**自动认出来、缩成一个标签**。
 *
 * 为什么要这套：openchemlib 画图不认缩写（会把整个基团展开画出来）；ChemDraw / Ketcher 画图时
 * 是把一段原子收进一个「超原子 S-group」里、只显示标签。所以我们自己把命中的片段收进
 * SUP S-group（写进 molfile 的 `M  STY / SAL / SMT`），再交给 Indigo 渲染——Indigo 认这个格式。
 *
 * 匹配用 openchemlib 的 `SSSearcher`（SMILES 里 `*` 代表「连到主体上的那个原子」）。
 * 表的顺序就是优先级：越靠前的越先匹配（Ts 要先于 Ph，否则对甲苯磺酰基会先被拆成 Ph）。
 */

import { indigoSvgSized } from './indigo.js';

/** [缩写, 片段 SMILES（`*` = 连接到主体）] */
export const ABBREV_GROUPS = [
  // ── 大基团先匹配（不然会被拆成 Ph / Me / Et 这些小块）
  ['Fmoc', '*C(=O)OCC1c2ccccc2-c2ccccc21'],
  ['TBDPS', '*[Si](c1ccccc1)(c1ccccc1)C([CH3])([CH3])[CH3]'],
  ['TBS', '*[Si]([CH3])([CH3])C([CH3])([CH3])[CH3]'],
  ['TMS', '*[Si]([CH3])([CH3])[CH3]'],
  ['TES', '*[Si]([CH2][CH3])([CH2][CH3])[CH2][CH3]'],
  ['Tf', '*S(=O)(=O)C(F)(F)F'],
  ['Ns', '*S(=O)(=O)c1ccc([N+](=O)[O-])cc1'],
  ['Ts', '*S(=O)(=O)c1ccc([CH3])cc1'],
  ['Ms', '*S(=O)(=O)[CH3]'],
  // ── 氨基甲酸酯 / 保护基
  ['Boc', '*C(=O)OC([CH3])([CH3])[CH3]'],
  ['Cbz', '*C(=O)O[CH2]c1ccccc1'],
  ['Alloc', '*C(=O)O[CH2]C=C'],
  ['Pmb', '*[CH2]c1ccc(OC)cc1'],
  ['Bpin', '*B1OC(C)(C)C(C)(C)O1'],
  // ── 酯 / 酰基
  ['CO2tBu', '*C(=O)OC([CH3])([CH3])[CH3]'],
  ['CO2Bn', '*C(=O)O[CH2]c1ccccc1'],
  ['CO2Et', '*C(=O)O[CH2][CH3]'],
  ['CO2Me', '*C(=O)O[CH3]'],
  ['CO2H', '*C(=O)O'],
  ['Piv', '*C(=O)C([CH3])([CH3])[CH3]'],
  ['Bz', '*C(=O)c1ccccc1'],
  ['Ac', '*C(=O)[CH3]'],
  // ── 烷基 / 芳基 / 其它
  ['Bn', '*[CH2]c1ccccc1'],
  // 「光秃秃的苯环」故意不缩成 Ph：不然所有芳基底物都只剩一个 Ph，图反倒看不出结构。
  // 作为保护基 / 磺酰基一部分的（Ts、Bz、Bn、Cbz、Fmoc）照缩，那是 ChemDraw 的老规矩。
  ['tBu', '*C([CH3])([CH3])[CH3]'],
  ['iPr', '*C([CH3])[CH3]'],
  ['nBu', '*[CH2][CH2][CH2][CH3]'],
  ['cHex', '*[CH]1CCCCC1'],
  ['cPr', '*[CH]1CC1'],
  ['Allyl', '*[CH2]C=C'],
  ['CF3', '*C(F)(F)F'],
  ['NO2', '*[N+](=O)[O-]'],
  ['CN', '*C#N'],
  ['OMe', '*O[CH3]'],
  ['OEt', '*O[CH2][CH3]'],
  ['SMe', '*S[CH3]'],
  ['NH2', '*[NH2]'],
];

let cached = null;
async function chem() {
  if (!cached) cached = await import('openchemlib');
  return cached;
}

/** 片段分子只建一次（一张图里几十个结构、每次都要跟四十来个片段比一遍，别反复 parse） */
const fragCache = new Map();
function fragment(lib, smiles) {
  let frag = fragCache.get(smiles);
  if (!frag) {
    frag = lib.Molecule.fromSmiles(smiles);
    frag.setFragment(true);
    fragCache.set(smiles, frag);
  }
  return frag;
}

/** 把 S-group 写进 molfile 的 M  STY / SAL / SMT 段（贴着 M  END 前面插） */function withSgroups(molfile, groups) {
  const lines = molfile.split('\n');
  const end = lines.findIndex((l) => l.trim() === 'M  END');
  if (end < 0) return molfile;
  // 列宽照 ChemDraw 的写法：S-group 编号占 4 格，原子序号也占 4 格。
  // 编号写成 3 格 Indigo 会从错开一列的地方开始读类型，报「Unknown SGroup type = UP」（踩过）。
  const p3 = (n) => String(n).padStart(3);
  const p4 = (n) => String(n).padStart(4);
  const extra = ['M  STY' + p3(groups.length) + groups.map((_, i) => p4(i + 1) + ' SUP').join('')];
  groups.forEach((g, i) => {
    const idx = p4(i + 1);
    extra.push('M  SAL' + idx + p3(g.atoms.length) + g.atoms.map((a) => p4(a + 1)).join(''));
    extra.push('M  SMT' + idx + ' ' + g.label);
  });
  return [...lines.slice(0, end), ...extra, ...lines.slice(end)].join('\n');
}

/**
 * SMILES → 带缩写 S-group 的 molfile；没命中任何缩写就返回 null。
 * 规则：整个分子不能被缩写吃光（至少留 2 个原子），一个原子只归一个组。
 */
export async function abbreviateSmiles(smiles) {
  const s = String(smiles || '').trim();
  if (!s) return null;
  let chemLib;
  try {
    chemLib = await chem();
  } catch {
    return null;
  }
  let mol;
  try {
    mol = chemLib.Molecule.fromSmiles(s);
  } catch {
    return null;
  }
  const heavy = mol.getAllAtoms();
  if (heavy < 5) return null; // 小分子缩写没意义

  const used = new Set();
  const groups = [];
  for (const [label, fragSmiles] of ABBREV_GROUPS) {
    let frag;
    try {
      frag = fragment(chemLib, fragSmiles);
    } catch {
      continue;
    }
    const searcher = new chemLib.SSSearcher();
    searcher.setFragment(frag);
    searcher.setMolecule(mol);
    let count = 0;
    try {
      count = searcher.findFragmentInMolecule({ countMode: 'overlapping' });
    } catch {
      continue;
    }
    if (!count) continue;
    for (const map of searcher.getMatchList()) {
      // map[i] = 片段第 i 个原子对应的分子原子（`*` 是 -1，不参与）
      // **重原子邻居数必须相同**：SSSearcher 不认 `[CH3]` 里的氢数，
      // O-CH2-CH2-OH 会被 `*O[CH3]`（OMe）命中、标成 OMe（踩过）。
      // 我们的片段本来就是精确写法，多一个邻居就不是这个基团。
      // 第 0 位是通配原子（`*` 自己，会映射到主体上的那个原子），跳过
      const sameDegree = map.every(
        (mi, fi) => fi === 0 || mi < 0 || mol.getConnAtoms(mi) === frag.getConnAtoms(fi)
      );
      if (!sameDegree) continue;
      // map[0] 是通配原子（连到主体的那个），S-group 里只放片段自己的原子
      const atoms = map.slice(1).filter((i) => i >= 0);
      if (atoms.length < 1) continue;
      if (atoms.some((i) => used.has(i))) continue;
      if (used.size + atoms.length >= heavy) continue; // 别把整个分子都缩掉
      atoms.forEach((i) => used.add(i));
      groups.push({ label, atoms });
    }
  }
  if (!groups.length) return null;

  let molfile;
  try {
    molfile = mol.toMolfile();
  } catch {
    return null;
  }
  return { molfile: withSgroups(molfile, groups), labels: groups.map((g) => g.label) };
}

/**
 * SMILES → 一件「带缩写的结构图」：`{ svg, vb, body, w, h, labels }`；
 * 认不出缩写、或者 Indigo 那边出不来就返回 null（调用方自己退回 openchemlib）。
 * `bondPx` 只在拼反应式图时给（要跟别的结构键长一致），结构式格子直接用 svg 就行。
 */
export async function abbreviatedParts(smiles, bondPx = 26, padPx = 6) {
  let ab;
  try {
    ab = await abbreviateSmiles(smiles);
  } catch {
    return null;
  }
  if (!ab) return null;
  try {
    const p = await indigoSvgSized(ab.molfile, bondPx, padPx);
    return { ...p, labels: ab.labels };
  } catch {
    return null;
  }
}
