/**
 * 「挑了哪几条记录」→ 筛选表的条目。
 *
 * 一条记录现在可以带一组条件（记录页的「条件组」：一次筛选批次里跑了 N 个条件、一起点的板）。
 * 挑记录进筛选表时，**有条件组的就按条件展开**——一行一个条件（`{exp_id, cond: i}`），
 * 没有条件组的仍是一条记录一行（`cond: null`）。这样筛选表认的是「单个条件」，
 * 而记录本里只需要一条（而不是每个条件一条记录）。
 */
import { api } from '../api.js';

export async function entriesFromPicked(ids) {
  const out = [];
  for (const id of ids) {
    const n = Number(id);
    if (!Number.isFinite(n)) continue;
    let conds = [];
    try {
      const e = await api.experiment(n);
      conds = Array.isArray(e?.conds) ? e.conds : [];
    } catch {
      conds = [];
    }
    if (conds.length) {
      conds.forEach((c, i) => out.push({ exp_id: n, cond: i, cells: {} }));
    } else {
      out.push({ exp_id: n, cond: null, cells: {} });
    }
  }
  return out;
}
