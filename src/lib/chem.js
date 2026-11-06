/** 化学结构的解析与绘制 —— 用 openchemlib（本地跑，不联网）。
 *  只在真正需要的时候才动态加载，所以首屏不变慢。
 */

import { indigoSvg } from './indigo.js';

let cached = null;

async function lib() {
  if (!cached) cached = await import('openchemlib');
  return cached;
}

/**
 * 结构式图优先交给 Indigo 画（见 lib/indigo.js：openchemlib 的自动排版在
 * 「环丁酮 + 磺酰胺 + 几个苄基」这种分子上会键交叉、甲氧基叠在一起）。
 * Indigo 拿不到（wasm 没拷过去 / 加载失败）就退回 openchemlib 那张，
 * 反正分子式、MW 一直是 openchemlib 算的，不受影响。
 */
async function bestSvg(smiles, mol) {
  if (smiles) {
    try {
      return await indigoSvg(smiles);
    } catch {
      /* 退回去：还得用 SMILES 重建一遍分子，直接拿 mol 画是原始坐标（歪的） */
      try {
        const chem = await lib();
        return chem.Molecule.fromSmiles(smiles).toSVG(460, 320, undefined, { autoCrop: true, autoCropMargin: 14 });
      } catch {
        /* 连 SMILES 都排不出来，就用传进来的分子 */
      }
    }
  }
  return mol.toSVG(460, 320, undefined, { autoCrop: true, autoCropMargin: 14 });
}

/** 看起来像 SMILES 吗（用来判断剪贴板里的纯文本要不要当结构式处理） */
export function looksLikeSmiles(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 400) return false;
  if (/[\u4e00-\u9fa5\s]/.test(s)) return false; // 有中文或空白就不是
  if (!/[A-Za-z]/.test(s)) return false;
  return /^[A-Za-z0-9@+()[\]{}=#$:/\\.\-*%]+$/.test(s);
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
    const out = {
      formula: f.formula,
      mw: Math.round(f.relativeWeight * 100) / 100,
      svg: '',
    };
    try {
      out.smiles = mol.toSmiles();
    } catch {
      /* 拿不到 SMILES 就退回按原坐标画 */
    }
    out.svg = await bestSvg(out.smiles, mol);
    return out;
  } catch {
    return null;
  }
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
    return {
      formula: f.formula,
      mw: Math.round(f.relativeWeight * 100) / 100,
      svg: await bestSvg(s, mol),
    };
  } catch {
    return null;
  }
}

/** 把 SVG 字符串包装成可以直接上传的 File */
export function svgToFile(svg, name = '结构式.svg') {
  return new File([svg], name, { type: 'image/svg+xml' });
}
