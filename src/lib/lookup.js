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

/**
 * NIST Chemistry WebBook：谱图（IR / MS）和热力学数据最全的免费站。
 * **只认 CAS 的 ID 形式**（`ID=C104870`，即 C + 去掉横线的 CAS）；没有 CAS 就用 Name= 查。
 */
export function nistUrl({ cas, name } = {}) {
  const c = (Array.isArray(cas) ? cas[0] : cas) || '';
  if (c) return `https://webbook.nist.gov/cgi/cbook.cgi?ID=C${c.replace(/-/g, '')}&Units=SI`;
  const n = String(name || '').trim();
  return n ? `https://webbook.nist.gov/cgi/cbook.cgi?Name=${encodeURIComponent(n)}&Units=SI` : '';
}

/** CAS Common Chemistry（免费）：给标准名 / 同义词 / CAS，按 CAS 或名称搜 */
export function casCommonUrl({ cas, name } = {}) {
  const key = (Array.isArray(cas) ? cas[0] : cas) || String(name || '').trim();
  return key ? `https://commonchemistry.cas.org/results?q=${encodeURIComponent(key)}` : '';
}

/** TCI（日本老牌试剂）：只认 CAS，能直接落到搜索结果页（实测 104-87-0 → 找到 2 个结果） */
export function tciUrl({ cas } = {}) {
  const key = (Array.isArray(cas) ? cas[0] : cas) || '';
  return key ? `https://www.tcichemicals.com/CN/zh/search/?text=${encodeURIComponent(key)}` : '';
}

/**
 * 化合物页「外部查询」那一列。每项自己说明**怎么把化合物变成一个地址**，
 * 缺需要的标识就返回 ''（前端据此不显示，不留死链）。
 *
 * **只收实测能用的**（2026-11 从这台机器逐个试过）：
 * - PubChem：CID / CAS / 名称 / SMILES 都能用；
 * - ChemicalBook：CAS → 名称，搜索结果里确实带出 CAS；
 * - TCI：CAS，浏览器里能落到结果页（curl 会 403，是它的反爬；所以**别只看 curl 的状态码**）。
 * - NIST：CAS → `ID=C<去横线>`，谱图 / 热力学；CAS Common Chemistry：按 CAS / 名称。
 * 没加的：ChemSpider（CloudFront 403）、Sigma-Aldrich（区域 Access Denied）、
 * SDBS / NMRShiftDB / Google Scholar（这台机器连不上）。
 * 想再加一个，先确认上面的 URL 在浏览器里真能查出东西。
 */
export const LOOKUP_SITES = [
  {
    key: 'pubchem',
    label: 'PubChem',
    hint: '名称 / CAS / 性质 / 谱图',
    url: (ids) => (ids.cid ? `https://pubchem.ncbi.nlm.nih.gov/compound/${ids.cid}` : pubchemUrl(ids)),
  },
  {
    key: 'chemicalbook',
    label: 'ChemicalBook',
    hint: '中文化合物资料 / 供应商',
    url: (ids) => chemicalBookUrl({ cas: ids.cas, name: ids.name }),
  },
  {
    key: 'nist',
    label: 'NIST',
    hint: 'IR / MS 谱图、热力学数据',
    url: (ids) => nistUrl({ cas: ids.cas, name: ids.name }),
  },
  {
    key: 'tci',
    label: 'TCI',
    hint: '试剂规格 / MSDS / 价格',
    url: (ids) => tciUrl({ cas: ids.cas }),
  },
  {
    key: 'cas',
    label: 'CAS',
    hint: '标准名 / 同义词 / CAS 号',
    url: (ids) => casCommonUrl({ cas: ids.cas, name: ids.name }),
  },
];

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
