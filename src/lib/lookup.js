import { api } from '../api.js';

/**
 * 结构信息查询（PubChem，服务端代查 + 本地缓存）。
 * 断网 / 查不到都只是「没有额外信息」，不能让画结构、存记录这些主流程挂掉，
 * 所以这里一律吞异常、返回 null。
 */
const memo = new Map();

/** SMILES → { found, name, cas[], formula, mw, cid, url, inchikey } 或 null */
export async function structureInfo(smiles) {
  const key = String(smiles || '').trim();
  if (!key) return null;
  if (memo.has(key)) return memo.get(key);
  let info = null;
  try {
    const res = await api.lookup({ smiles: key });
    info = res && res.found ? res : { found: false };
  } catch {
    info = null;
  }
  memo.set(key, info);
  return info;
}

/** 按名称查（给「这个试剂是什么」用） */
export async function nameInfo(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  try {
    const res = await api.lookup({ q: key });
    return res && res.found ? res : null;
  } catch {
    return null;
  }
}

/**
 * PubChem：有 CID 就直接进化合物页，没有就拿 CAS / 名称 / SMILES 去搜。
 * 这样链接**不用等这次会话查过**也一直有用（刷新、别人接手都一样）。
 */
export function pubchemUrl({ cid, cas, name, smiles } = {}) {
  if (cid) return `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;
  const key = (Array.isArray(cas) ? cas[0] : cas) || name || smiles;
  return key ? `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(key)}` : '';
}

/** ChemicalBook 没有公开接口，只能带 CAS（没有就用名称）跳过去搜 */
export function chemicalBookUrl(info) {
  const key = (info && info.cas && info.cas[0]) || (info && info.name);
  return key ? `https://www.chemicalbook.com/Search_EN.aspx?keyword=${encodeURIComponent(key)}` : '';
}

/** 一行摘要：名称 · CAS 50-78-2 · C9H8O4 · 180.16 */
export function describeInfo(info) {
  if (!info || !info.found) return '';
  const bits = [];
  if (info.name) bits.push(info.name);
  if (info.cas && info.cas.length) bits.push(`CAS ${info.cas[0]}`);
  if (info.formula) bits.push(info.formula);
  if (info.mw) bits.push(info.mw);
  return bits.join(' · ');
}

/** 物性一行：熔点 / 密度 / 沸点（PubChem「实验性质」那一节，有才列） */
export function describeProps(info) {
  const pr = (info && info.props) || {};
  const bits = [];
  if (pr.mp) bits.push(`熔点 ${pr.mp}`);
  if (pr.density) bits.push(`密度 ${pr.density}`);
  if (pr.bp) bits.push(`沸点 ${pr.bp}`);
  return bits.join(' · ');
}
