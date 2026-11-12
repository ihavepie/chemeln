/**
 * 「这条平行实验相对基准改了什么」——列表里能拿到的字段自己比一遍。
 * 从 `ExpListPane.vue` 里搬出来的：桌面中栏的「组员行」和手机端 `MobileHome` 都要用同一套规则，
 * 两边各写一份迟早会长歪（一处改了标签、另一处忘了）。
 * 输入是列表接口的 item（`reagent_sig` / `solvent` / `temperature` … 都在里面）。
 */
import { eqLabel } from './reagent.js';

/** 列表里能拿到的条件字段：跟基准比一下，看这条是重复还是改了变量。
 *  `rxn_type`（表头那格的化学类型）不算——它是给这条记录贴的标签，不是变量，
 *  改它不该让整摞看起来「改了条件」；卡片上另外把标签显示出来。 */
const LIST_VARS = [
  ['solvent', '溶剂'],
  ['concentration', '浓度'],
  ['temperature', '温度'],
  ['duration', '时长'],
  ['atmosphere', '气氛'],
];
/** 记录类型（试反应 / 条件筛选…）。反应类型单独做成一颗胶囊（`.tag.is-rxn`），不再挤在这段文字里 */
const rxnDesc = (m) => String(m.kind || '').trim();
const rxnType = (m) => String(m.rxn_type || '').trim();

/** 当量差在 2%（且 ≤0.005）以内算同一个条件——放大/取整常让当量差一点点 */
function eqSame(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a ?? '') === String(b ?? '');
  return Math.abs(x - y) <= Math.max(0.005, 0.02 * Math.max(Math.abs(x), Math.abs(y)));
}

function listDiff(base, m) {
  const diffs = [];
  const parse = (sig) =>
    Object.fromEntries(
      String(sig || '')
        .split('|')
        .filter(Boolean)
        .map((one) => {
          // 角色:名字:当量:浓度:用量（后两段是后加的，老签名没有就是空）
          const [role, name, eq, conc, ul] = one.split(':');
          return [`${role}:${name}`, { role, name, eq, conc, ul }];
        })
    );
  const a = parse(base.reagent_sig);
  const b = parse(m.reagent_sig);
  // 溶剂现在就是投料表里 role=溶剂 的一行：有那一行就只看投料表，
  // 不再额外冒一颗「溶剂」——否则「加 DCM / 去 THF」把溶剂讲了两遍
  const solInTable = [...Object.keys(a), ...Object.keys(b)].some((k) => k.startsWith('溶剂:'));
  // 规模变了，浓度多半是被动跟着变的（放大时溶剂不一定等比加）——不算改条件
  const scaleChanged = String(base.base_mmol ?? '') !== String(m.base_mmol ?? '');
  for (const [k, label] of LIST_VARS) {
    if (k === 'concentration' && scaleChanged) continue;
    if (k === 'solvent' && solInTable) continue;
    const a = String(base[k] ?? '').trim();
    const b = String(m[k] ?? '').trim();
    if (a === b) continue;
    // 写「旧 → 新」，别只丢一个字段名——光看「温度」不知道改成了多少
    diffs.push(`${label} ${a || '—'} → ${b || '—'}`);
  }
  // 基准那条的投料表要是压根没填（老记录只剩空行 / 只有溶剂），拿它比会把整张表都标成「加」——
  // 那不是改动，跳过；用户要的只是「改动部分」。
  const baseFilled = Object.values(a).some((r) => String(r.role || '') !== '溶剂' && String(r.name || '').trim());
  const baseSub = String(base.substrates || '').trim();
  if (baseSub && baseSub !== String(m.substrates || '').trim()) diffs.push('底物');
  // 投料表：签名一样就跳过；不一样就点出「加 / 去 / 当量」哪种变化
  if (baseFilled && String(base.reagent_sig || '') !== String(m.reagent_sig || '')) {
    const nm = (r) => r.name || '（未命名）';
    const eqTxt = (v) => eqLabel(v) || '—';
    // 一条一条列，不要再折成「投料（加 X，去 Y 等）」——这里最想看的就是试剂到底动没动。
    // 但「一进一出、角色相同」（配体换配体、碱换碱、溶剂换溶剂）要合成一条
    // 「旧 → 新」，否则两颗粒子（加 RuPhos / 去 P(Cy)3）说的是同一件事。
    const added = Object.entries(b).filter(([k]) => !a[k]);
    const removed = Object.entries(a).filter(([k]) => !b[k]);
    const usedAdd = new Set();
    const usedDel = new Set();
    for (const [kb, rb] of added) {
      const hit = removed.find(([ka, ra]) => !usedDel.has(ka) && String(ra.role || '') === String(rb.role || ''));
      if (!hit) continue;
      const [ka, ra] = hit;
      usedAdd.add(kb);
      usedDel.add(ka);
      const eqA = String(ra.eq ?? '').trim();
      const eqB = String(rb.eq ?? '').trim();
      const sameEq = eqSame(eqA, eqB) || (!eqA && !eqB);
      diffs.push(sameEq ? `${nm(ra)} → ${nm(rb)}` : `${nm(ra)} ${eqTxt(eqA)} → ${nm(rb)} ${eqTxt(eqB)}`);
    }
    for (const [k, r] of added) if (!usedAdd.has(k)) diffs.push(`加 ${nm(r)}${r.eq ? ` ${eqTxt(r.eq)}` : ''}`);
    for (const [k, r] of removed) if (!usedDel.has(k)) diffs.push(`去 ${nm(r)}`);
    const volTxt = (v) => {
      const n = Number(String(v ?? '').trim());
      if (!Number.isFinite(n) || n <= 0) return '—';
      return n >= 1000 ? `${Math.round((n / 1000) * 100) / 100} mL` : `${Math.round(n * 10) / 10} µL`;
    };
    for (const [k, rb] of Object.entries(b)) {
      const ra = a[k];
      if (!ra) continue;
      // 溶剂只认用量（体积），别的行只认当量和浓度
      if (rb.role === '溶剂') {
        if (String(ra.ul ?? '') !== String(rb.ul ?? '')) diffs.push(`${nm(rb)} ${volTxt(ra.ul)} → ${volTxt(rb.ul)}`);
        continue;
      }
      if (!eqSame(ra.eq, rb.eq)) diffs.push(`${nm(rb)} ${eqTxt(ra.eq)} → ${eqTxt(rb.eq)}`);
      const ca = Number(String(ra.conc ?? '').trim());
      const cb = Number(String(rb.conc ?? '').trim());
      if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) {
        diffs.push(`${nm(rb)} ${ca} M → ${cb} M`);
      }
    }
  }
  return diffs;
}


export { listDiff };
