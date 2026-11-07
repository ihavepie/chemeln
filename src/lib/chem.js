/**
 * 化学结构的解析与绘制 —— 用 openchemlib（本地跑，不联网）。
 * 只在真正需要的时候才动态加载，所以首屏不变慢。
 *
 * 唯一例外：**结构里带基团缩写**（ChemDraw 的 Ts / Boc / Ph 这些超原子）时，改用 Indigo 画
 * ——openchemlib 会把缩写展开画成全结构、标签丢掉（见 lib/indigo.js）。
 */

import { indigoSvg, indigoLayout, BOND_PX } from './indigo.js';
import { abbreviatedParts } from './abbrev.js';
import { relayoutMolecule, orientLandscape, canonicalOrientation } from './relayout.js';

let cached = null;

async function lib() {
  if (!cached) cached = await import('openchemlib');
  return cached;
}

/** 看起来像 SMILES 吗（用来判断剪贴板里的纯文本要不要当结构式处理） */
export function looksLikeSmiles(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 400) return false;
  if (/[\u4e00-\u9fa5\s]/.test(s)) return false; // 有中文或空白就不是
  if (!/[A-Za-z]/.test(s)) return false;
  return /^[A-Za-z0-9@+()[\]{}=#$:/\\.\-*%]+$/.test(s);
}

/** molfile 里有没有「基团缩写」：超原子 S-group 或原子别名 */
export function hasAbbrev(mol) {
  return /^M  (STY|SMT|ALS)\b/m.test(String(mol || ''));
}

/** 看起来像 molfile 吗（ChemDraw 的 Copy As → MOL/SDF） */
export function looksLikeMolfile(text) {
  const s = String(text || '');
  if (s.length < 40) return false;
  return /V2000|V3000/.test(s) && /M\s+END/.test(s);
}

/**
 * molfile → { formula, mw, svg, smiles }
 * **图要重排**：molfile 里存的是画的时候的坐标，从 ChemDraw / Ketcher 粘过来的
 * 常常是歪的（扁环、键交叉、原子挤在一起）。所以这里绕一圈 SMILES，
 * 让 openchemlib 自己算一遍干净的 2D 坐标再画（画不出来才退回原始坐标）。
 */
export async function analyzeMolfile(molfile) {
  const s = String(molfile || '');
  if (!looksLikeMolfile(s)) return null;
  let chem;
  try {
    chem = await lib();
  } catch {
    return null;
  }
  try {
    const mol = chem.Molecule.fromMolfile(s);
    const f = mol.getMolecularFormula();
    const raw = samePxScale(mol.toSVG(460, 320, undefined, { autoCrop: true, autoCropMargin: 14 }));
    const out = { formula: f.formula, mw: Math.round(f.relativeWeight * 100) / 100, svg: raw };
    // 带缩写：交给 Indigo 画（它认得超原子，Ts 就显示成 Ts）。
    // 这种 MOL 里没有「干净的 smiles」（抄出来是展开式），所以 out.smiles 留空，
    // ⋯ 里的「整理结构式（重排）」对它们不出现
    if (hasAbbrev(s)) {
      try {
        out.svg = await indigoSvg(s);
      } catch {
        /* Indigo 拿不到就退回下面 */
      }
    }
    // 没缩写：绕一圈 SMILES 重排一遍再画（裸 MOL 的坐标常常是歪的）。
    // 注意这里的 `svg` 一开始就有值，所以判断的是「要不要重排」，不能写成 if (!out.svg)
    if (!hasAbbrev(s)) {
      let smiles = '';
      try {
        smiles = mol.toSmiles();
      } catch {
        /* 连 SMILES 都抄不出来就保留原始坐标 */
      }
      if (smiles) {
        out.smiles = smiles;
        // 认得出基团缩写（Ts / CO2Et / Boc…）就让 Indigo 按缩写画；否则 openchemlib 重排着画
        const ab = await abbreviatedParts(smiles);
        if (ab?.svg) {
          out.svg = ab.svg;
        } else {
          try {
            const tidy = chem.Molecule.fromSmiles(smiles);
            await relayoutMolecule(chem, tidy); // 再交给 Indigo 排一遍，键角才规整
            orientLandscape(tidy); // 先摆平（竖着的到格子里会被压小）
            canonicalOrientation(chem, tidy); // 再挑最像 ChemDraw 的角度：羰基竖着、环走整角度
            out.svg = samePxScale(tidy.toSVG(460, 320, undefined, { autoCrop: true, autoCropMargin: 14 }));
          } catch {
            /* 排不出来就用原来的坐标 */
          }
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** openchemlib 出图固定 24 px/键；把宽高按 BOND_PX 放大，跟 Indigo 画的图同一个像素尺度 */
const OCL_BOND_PX = 24;
function samePxScale(svg) {
  const k = BOND_PX / OCL_BOND_PX;
  if (Math.abs(k - 1) < 0.01) return svg;
  return svg.replace(/<svg([^>]*?)\swidth="(\d+(?:\.\d+)?)(px)?"([^>]*?)\sheight="(\d+(?:\.\d+)?)(px)?"/,
    (m, a, w, _u1, b, h) => `<svg${a} width="${Math.round(Number(w) * k)}"${b} height="${Math.round(Number(h) * k)}"`);
}

/** 文本（SMILES 或 molfile）→ { formula, mw, svg } */
export async function analyzeStructureText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  // molfile 的前几行是标题 / 程序 / 注释，开头那个空行不能 trim 掉，否则整段错位
  if (looksLikeMolfile(raw)) return analyzeMolfile(raw);
  const s = raw.trim();
  if (looksLikeSmiles(s)) return analyzeSmiles(s);
  return null;
}

/** SMILES → { formula, mw, svg }；解析不了返回 null */
export async function analyzeSmiles(smiles) {
  const s = String(smiles || '').trim();
  if (!s) return null;
  let chem;
  try {
    chem = await lib();
  } catch {
    return null;
  }
  try {
    const mol = chem.Molecule.fromSmiles(s);
    const f = mol.getMolecularFormula();
    const ab = await abbreviatedParts(s);
    let svg = ab?.svg || '';
    if (!svg) {
      // 认不出缩写：openchemlib 自己排的键角常常歪，先让 Indigo 重排坐标再画（保持原来的观感）
      await relayoutMolecule(chem, mol);
      orientLandscape(mol);
      canonicalOrientation(chem, mol);
      svg = samePxScale(mol.toSVG(460, 320, undefined, { autoCrop: true, autoCropMargin: 14 }));
    }
    return {
      formula: f.formula,
      mw: Math.round(f.relativeWeight * 100) / 100,
      svg,
    };
  } catch {
    return null;
  }
}

/** SMILES → 规范写法（用来判断「画板里的这个分子」和「库里的那个化合物」是不是同一个） */
export async function canonicalSmiles(smiles) {
  const s = String(smiles || '').trim();
  if (!s) return '';
  try {
    const chem = await lib();
    return chem.Molecule.fromSmiles(s).toSmiles();
  } catch {
    return '';
  }
}

/** 把 SVG 字符串包装成可以直接上传的 File */
export function svgToFile(svg, name = '结构式.svg') {
  return new File([svg], name, { type: 'image/svg+xml' });
}
