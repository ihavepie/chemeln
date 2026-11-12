/**
 * 「一页汇报卡」：把一条反应收拾成**一张 A4**，专门发给导师看。
 *
 * 只放他关心的几样：反应式 / 条件 / 投料表（当量·用量）/ 产率·选择性 / TLC。
 * 不放进来的：记录簿抬头（编号日期温湿度那一块）、操作与现象、后处理、表征、讨论、
 * 附件列表 —— 那些是给自己看的，师门群里发一张纸就够。
 *
 * 为什么自己写一套 CSS、不复用全站样式：这张纸要「自成一体」，
 * 不跟着记录页的版式改动漂（`collectCss()` 里几千条规则，任何一个改动都可能把它挤到第二页）。
 */

/** A4 一张纸：内容居中、字号按打印尺度（Paper 在 96dpi 下 794px 宽 → 这里 body zoom 0.7498） */
const CARD_CSS = `
html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
body { zoom: 0.7498; font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; color: #1c1b19; }
.card {
  width: 210mm;
  min-height: 297mm;
  padding: 18mm 16mm 14mm;
  box-sizing: border-box;
  background: #fff;
}
.card-head { display: flex; align-items: baseline; gap: 10px; }
.card-title { font-family: "Iowan Old Style", Georgia, serif; font-size: 17px; line-height: 1.3; flex: 1 1 auto; }
.card-tag { font-family: "SF Mono", Menlo, monospace; font-size: 9.5px; letter-spacing: 0.06em; color: #8b877e; white-space: nowrap; }
.card-sub { margin-top: 3px; font-size: 11px; color: #6d6862; }

.card-scheme {
  margin: 12px 0 4px;
  padding: 6px 0;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 96px;
}
/* 反应式是这张纸的主角：按纸张宽度铺满（svg 自带宽高比，height:auto 不会变形） */
.card-scheme svg, .card-scheme img { width: 100%; height: auto; max-height: 120mm; object-fit: contain; }
.card-scheme .none { font-size: 11px; color: #b4b2aa; }

.card-cond {
  margin: 6px 0 12px;
  font-size: 12px;
  color: #3c3a35;
  line-height: 1.6;
}
.card-cond .k { font-family: "SF Mono", Menlo, monospace; font-size: 9px; color: #a09c93; margin-right: 5px; }
.card-cond .sep { color: #c9c6bd; margin: 0 7px; }

.card-h {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 9px;
  letter-spacing: 0.1em;
  color: #a09c93;
  margin: 14px 0 5px;
}

table.card-tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
table.card-tbl th {
  font-weight: 500;
  font-size: 9px;
  letter-spacing: 0.06em;
  color: #a09c93;
  text-align: left;
  padding: 0 6px 4px;
  border-bottom: 1px solid #ddd9d0;
  white-space: nowrap;
}
table.card-tbl td { padding: 3px 6px; border-bottom: 1px solid #f2f0ec; }
table.card-tbl td.n, table.card-tbl th.n { text-align: right; font-family: "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
table.card-tbl td.n { font-size: 11px; }
table.card-tbl td.role { color: #6d6862; font-size: 10.5px; }
table.card-tbl td.amt { font-weight: 600; }

.card-res { font-size: 12px; line-height: 1.7; color: #1c1b19; }
.card-res .k { font-family: "SF Mono", Menlo, monospace; font-size: 9px; color: #a09c93; margin-right: 5px; }
.card-res b { font-weight: 600; }

.card-tlc { display: flex; gap: 12px; align-items: flex-start; margin-top: 4px; }
.card-tlc .tlc-note { font-size: 11.5px; color: #3c3a35; line-height: 1.6; flex: 1 1 auto; }
.card-tlc .plates { display: flex; gap: 8px; flex: 0 0 auto; }
.card-tlc .plates img {
  height: 46mm;
  max-width: 60mm;
  object-fit: contain;
  border: 1px solid #eaeaea;
  border-radius: 2px;
}
.card-foot {
  margin-top: 16px;
  padding-top: 6px;
  border-top: 1px solid #f2f0ec;
  font-family: "SF Mono", Menlo, monospace;
  font-size: 8.5px;
  color: #b4b2aa;
  display: flex;
  justify-content: space-between;
}
`;

export function reportCardCss() {
  return CARD_CSS;
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const numText = (v, digits = 2) => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toFixed(digits).replace(/\.?0+$/, '');
};

/**
 * @param {object} d
 *  code / date / title / subtitle
 *  schemeSvg      反应式（内联 SVG 字符串，可为空）
 *  conds          [{ k:'反应温度', v:'110 ℃' }, …]（空值自动略过）
 *  rows           [{ role, name, mw, eq, mmol, amount }]（投料表；变量行由调用方剔除）
 *  result         { name, appearance, yieldText, selText, drText }（都可空）
 *  tlc            { note, plates: [src, …] }
 */
export function buildReportCard(d) {
  const conds = (d.conds || []).filter((c) => String(c.v || '').trim());
  const rows = d.rows || [];
  const r = d.result || {};
  const tlc = d.tlc || {};

  const head = `
    <div class="card-head">
      <div class="card-title">${esc(d.title || '反应记录')}</div>
      <div class="card-tag">${esc([d.code, d.date].filter(Boolean).join(' · '))}</div>
    </div>
    ${d.subtitle ? `<div class="card-sub">${esc(d.subtitle)}</div>` : ''}`;

  const scheme = d.schemeSvg
    ? `<div class="card-scheme">${d.schemeSvg}</div>`
    : `<div class="card-scheme"><span class="none">（这条记录还没有画反应式）</span></div>`;

  const cond = conds.length
    ? `<div class="card-cond">${conds
        .map((c) => `${c.k ? `<span class="k">${esc(c.k)}</span>` : ''}${esc(c.v)}`)
        .join('<span class="sep">·</span>')}</div>`
    : '';

  const rowsHtml = rows.length
    ? `<div class="card-h">投料（按 ${esc(numText(d.base, 3) || '—')} mmol 规模）</div>
       <table class="card-tbl">
         <thead><tr>
           <th>组分</th><th>试剂</th><th class="n">MW</th><th class="n">当量</th>
           <th class="n">mmol</th><th class="n">用量</th>
         </tr></thead>
         <tbody>${rows
           .map(
             (x) => `<tr>
               <td class="role">${esc(x.role || '')}</td>
               <td>${esc(x.name || '')}</td>
               <td class="n">${esc(x.mw == null || x.mw === '' ? '—' : numText(x.mw, 2))}</td>
               <td class="n">${esc(x.eqText || x.eq || '—')}</td>
               <td class="n">${esc(x.mmol == null || x.mmol === '' ? '—' : numText(x.mmol, 3))}</td>
               <td class="n amt">${esc(x.amount || '—')}</td>
             </tr>`
           )
           .join('')}</tbody>
       </table>`
    : '';

  const resBits = [
    r.name ? `<span class="k">产物</span><b>${esc(r.name)}</b>${r.appearance ? `（${esc(r.appearance)}）` : ''}` : '',
    r.yieldText ? `<span class="k">产率</span><b>${esc(r.yieldText)}</b>` : '',
    r.selText ? `<span class="k">选择性</span>${esc(r.selText)}` : '',
    r.drText ? `<span class="k">dr / ee</span>${esc(r.drText)}` : '',
  ].filter(Boolean);
  const res = resBits.length ? `<div class="card-h">结果</div><div class="card-res">${resBits.join('<span class="sep">·</span>')}</div>` : '';

  const plates = (tlc.plates || []).slice(0, 3);
  const tlcHtml =
    tlc.note || plates.length
      ? `<div class="card-h">TLC</div>
         <div class="card-tlc">
           <div class="tlc-note">${esc(tlc.note || '')}</div>
           ${plates.length ? `<div class="plates">${plates.map((p) => `<img src="${esc(p)}" alt="">`).join('')}</div>` : ''}
         </div>`
      : '';

  const foot = `<div class="card-foot"><span>${esc(d.code || '')}</span><span>${esc(d.date || '')}</span></div>`;

  return `<div class="pdf-page card">${head}${scheme}${cond}${rowsHtml}${res}${tlcHtml}${foot}</div>`;
}
