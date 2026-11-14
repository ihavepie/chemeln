import { variations } from './sctfields.js';

/**
 * 排版板（自由画布）：把记录里的东西摆到一张 A4 上。
 *
 * **坐标一律用 0.1mm 的整数**（A4 = 2100 × 2970），屏幕和 PDF 用**同一套 mm 单位**画，
 * 所以「屏幕上什么样，导出来就什么样」——这是这一版最重要的约定，别再改回百分比。
 * 屏幕上用 CSS `zoom` 把整张纸缩到可视区里（见 BoardView.vue），纸里的字号/间距全按 mm / pt 写。
 */

export const PAGE = {
  a4p: { w: 2100, h: 2970, label: 'A4 竖' },
  a4l: { w: 2970, h: 2100, label: 'A4 横' },
};

/** 1 个画布单位 = 0.1mm */
export const MM_PER_PX = 25.4 / 96;
export const mm = (u) => `${(u / 10).toFixed(2)}mm`;

/**
 * 屏幕上 1px 等于多少**画布单位**（1 单位 = 0.1mm）：1px = `MM_PER_PX` 毫米，再除以 zoom。
 * **别写成 `1/(MM_PER_PX*0.1*zoom)`** —— 那是 37.8/zoom，比真值大 14 倍，拖一下整块就飞（踩过）。
 * 抽成纯函数是为了能单测：这个数错了，拖拽 / 摆块 / 量高度全都跟着错。
 */
export const unitsPerPx = (zoom = 1) => MM_PER_PX / 0.1 / (zoom || 1);
/** 反过来：一个画布单位 = 多少屏幕 px（导出 / 量尺寸用） */
export const pxPerUnit = (zoom = 1) => 0.1 * (1 / MM_PER_PX) * (zoom || 1);
/** 靠边 / 水平居中吸附的半径：4.5mm */
export const SNAP = 45;

/**
 * 把 x 吸到「贴左边 / 水平居中 / 贴右边」里最近的那个。
 * 返回 `{ x, line }`：`line` 是参考线该画在哪儿（null = 不画）。
 * 只吸这三个位置——块跟块之间的对齐交给肉眼，不然拖动会一直「粘」在别的块上。
 */
export function snapX(x, w, pageW, snap = SNAP) {
  const mid = Math.round(pageW / 2);
  const targets = [
    [0, 0],
    [Math.round((pageW - w) / 2), mid],
    [pageW - w, pageW],
  ];
  for (const [at, line] of targets) if (Math.abs(x - at) <= snap) return { x: at, line };
  return { x, line: null };
}

/** 缩到比这还窄就没法看 */
export const MIN_W = 240;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const uid = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 能让抽屉往里放的「块」 */
export const BLOCKS = [
  { key: 'title', label: '编号', w: 1200 },
  { key: 'react', label: '反应式', w: 1300 },
  { key: 'conds', label: '条件', w: 1400 },
  { key: 'reagents', label: '投料', w: 1500 },
  { key: 'result', label: '结果', w: 1300 },
  { key: 'verdict', label: 'TLC 判断', w: 1400 },
  { key: 'compare', label: '对比表', w: 1700 },
  { key: 'concl', label: '结论', w: 1600 },
  { key: 'notes', label: '结论', w: 1400 },
];

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const num = (v, d = 2) => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(d))) : '';
};

/** 当量文案（跟 lib/reagent.js 的 eqLabel 一个口径，但这里不引它，免得把化学库拖进画布） */
const eqText = (r) => {
  const eq = Number(r && r.eq);
  if (!Number.isFinite(eq) || eq <= 0) return '';
  return eq < 1 ? `${num(eq * 100, 0)} mol%` : `${num(eq, 2)} eq`;
};

/** 用量：有体积给体积，有质量给质量 */
const amtText = (r) => {
  if (!r) return '';
  if (Number.isFinite(Number(r.volume_ul)) && r.volume_ul != null) {
    const v = Number(r.volume_ul);
    return v >= 1000 ? `${num(v / 1000, 2)} mL` : `${num(v, 0)} µL`;
  }
  if (Number.isFinite(Number(r.mass_mg)) && r.mass_mg != null) {
    const m = Number(r.mass_mg);
    return m >= 1000 ? `${num(m / 1000, 3)} g` : `${num(m, 1)} mg`;
  }
  return '';
};

const solventOf = (exp) =>
  String((exp.reagents || []).find((r) => r.role === '溶剂' && r.name)?.name || exp.solvent || '').trim();

const kv = (pairs) =>
  pairs
    .filter(([, v]) => String(v || '').trim())
    .map(([k, v]) => `<span class="k">${k}</span>${esc(v)}`)
    .join('<span class="sep">·</span>');

/**
 * 一条记录里的某个「块」→ HTML 字符串。
 * 屏幕（v-html）和 PDF（boardHtml）都走这一个函数，所以两边永远一样。
 */
export function blockHtml(kind, exp) {
  if (!exp) return '<div class="bd-ph">（记录还没读到）</div>';
  switch (kind) {
    case 'react':
      return `<img src="/api/experiments/${exp.id}/scheme.svg" alt="">`;

    case 'title': {
      const head = [exp.code, exp.title].filter(Boolean).join(' · ');
      const sub = [exp.date, exp.kind, exp.status].filter(Boolean).join(' · ');
      return `<div class="bd-h1">${esc(head)}</div>${sub ? `<div class="bd-sub">${esc(sub)}</div>` : ''}`;
    }

    case 'conds': {
      const line = [
        solventOf(exp),
        exp.temperature,
        exp.duration,
        exp.atmosphere,
        exp.apparatus,
        exp.light,
        exp.base_mmol != null ? `${num(exp.base_mmol, 3)} mmol` : '',
      ]
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .join(' · ');
      return `<div class="bd-kv">${kv([['条件', line]])}</div>`;
    }

    case 'reagents': {
      const rows = (exp.reagents || []).filter((r) => String(r.name || '').trim());
      if (!rows.length) return '<div class="bd-ph">（投料表是空的）</div>';
      const body = rows
        .map(
          (r) =>
            `<tr><td class="role">${esc(r.role)}</td><td>${esc(r.name)}</td>` +
            `<td class="n">${esc(eqText(r))}</td><td class="n amt">${esc(amtText(r))}</td></tr>`
        )
        .join('');
      return (
        '<table class="bd-tb"><thead><tr><th>组分</th><th>试剂</th><th class="n">当量</th><th class="n">用量</th></tr></thead>' +
        `<tbody>${body}</tbody></table>`
      );
    }

    case 'result': {
      const sel = String(exp.dr_ee || '').trim() || (exp.ee_pct != null ? `${num(exp.ee_pct, 1)}% ee` : '');
      const yld = Number(exp.no_yield) === 1 ? '不计' : exp.yield_pct != null ? `${num(exp.yield_pct, 1)}%` : '';
      const mass = exp.product_mass != null ? `${num(exp.product_mass, 4)} g` : '';
      const html = kv([
        ['产物', exp.product_name],
        ['产率', yld],
        ['选择性', sel],
        ['质量', mass],
      ]);
      return html ? `<div class="bd-kv">${html}</div>` : '<div class="bd-ph">（还没有结果）</div>';
    }

    case 'verdict': {
      // 小反应筛条件时先看板子：一条记录一行「TLC 判断 + 展开剂/Rf」，几条摞起来就是一张筛选总结
      const t = String(exp.tlc_verdict || '').trim();
      const note = String(exp.tlc_note || '').trim();
      const html = kv([
        ['TLC 判断', t],
        ['展开剂 / Rf', note],
      ]);
      return html ? `<div class="bd-kv">${html}</div>` : '<div class="bd-ph">（还没填 TLC 判断）</div>';
    }

    case 'notes': {
      const t = String(exp.conclusion || exp.notes || '').trim();
      return t ? `<div class="bd-text">${esc(t)}</div>` : '<div class="bd-ph">（没写结论）</div>';
    }

    default:
      return '';
  }
}

/**
 * 「对比表」：把挑中的几条记录排成一张小表 —— 板子这边是用来「对比 + 下结论」的，
 * 表格比一堆散块更直接：编号 / 相对基准改了什么 / TLC 判断 / 产率。
 * `ctx.get(id)` 拿记录（BoardView 的 expCache）。
 */
function compareHtml(it, ctx) {
  const get = (ctx && ctx.get) || (() => null);
  const rows = (it.refs || []).map(get).filter(Boolean);
  if (rows.length < 2) return '<div class="bd-ph">（对比表至少要两条记录）</div>';
  const base = rows[0];
  const cols = it.cols && it.cols.length ? it.cols : ['variation', 'verdict', 'yield'];
  const yld = (e) => (Number(e.no_yield) === 1 ? '不计' : e.yield_pct != null ? `${num(e.yield_pct, 1)}%` : '待测');
  const cell = (e, col) => {
    if (col === 'variation') {
      if (e.id === base.id) return '基准';
      const v = variations(base, e);
      if (!v.length) return '重复';
      // 拿两条不相干的反应来比时会列出十几项，表里只留前三项
      return v.length > 3 ? `${v.slice(0, 3).join(' · ')} 等 ${v.length} 项` : v.join(' · ');
    }
    if (col === 'verdict') return String(e.tlc_verdict || '').trim() || '—';
    if (col === 'yield') return yld(e);
    if (col === 'conds') return [solventOf(e), e.temperature, e.duration].filter(Boolean).join(' · ');
    return String(e[col] || '');
  };
  const head = cols
    .map((c) => `<th>${c === 'variation' ? '改了什么' : c === 'verdict' ? 'TLC 判断' : c === 'yield' ? '产率' : c === 'conds' ? '条件' : esc(c)}</th>`)
    .join('');
  const body = rows
    .map((e) => `<tr><td class="mono">${esc(e.code || '')}</td>${cols.map((c) => `<td>${esc(cell(e, c))}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="bd-tb bd-cmp"><thead><tr><th>编号</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * 画布上能画的形状：箭头（左右）/ 方框（带圆角）。
 * 颜色只给这几档——板子最后要打印 / 贴进汇报，颜色一多就不像实验记录里的示意图了。
 */
export const SHAPE_COLORS = [
  { key: 'ink', label: '墨', v: '#1c1b19' },
  { key: 'accent', label: '强调', v: '#a8471f' },
  { key: 'grey', label: '灰', v: '#8d8b84' },
  { key: 'green', label: '绿', v: '#2f7d4f' },
  { key: 'blue', label: '蓝', v: '#2b6cb0' },
  { key: 'red', label: '红', v: '#b4362c' },
];

/** 一块素材 → HTML（图注统一挂在最下面） */
export function itemHtml(it, exp, ctx) {
  if (!it) return '';
  const cap = String(it.caption || '').trim() ? `<div class="bd-cap">${esc(it.caption)}</div>` : '';
  if (it.type === 'tlc') return `<img src="/api/files/${it.ref}" alt="">${cap}`;
  // 形状：箭头 / 方框。尺寸走外面那层 `.bd-item` 的 mm 宽高，这里铺满 + 一个颜色变量。
  if (it.type === 'shape') {
    const color = it.color || SHAPE_COLORS[0].v;
    const thick = it.thick ? ' is-thick' : '';
    if (it.shape === 'box') return `<div class="bd-shape bd-box${thick}" style="--sc:${esc(color)}"></div>${cap}`;
    const dir = it.dir === 'left' ? 'is-l' : 'is-r';
    return `<div class="bd-shape bd-arrow ${dir}${thick}" style="--sc:${esc(color)}"><i class="ln"></i><i class="hd"></i></div>${cap}`;
  }
  if (it.type === 'text') return `<div class="bd-text">${esc(it.text)}</div>${cap}`;
  // scheme 是老数据（现在统一成 block: react）
  const kind = it.type === 'scheme' ? 'react' : it.block;
  // 「结论」块：自带小标题的文字块，跟普通「文字」区分开（板上才是下结论的地方）
  if (kind === 'concl') {
    return `<div class="bd-h2">结论</div><div class="bd-text">${esc(it.text || '双击写结论')}</div>${cap}`;
  }
  if (kind === 'compare') return compareHtml(it, ctx) + cap;
  return blockHtml(kind, exp) + cap;
}

/** 导 PDF：一张固定尺寸的白纸 + 绝对定位的素材（单位 mm，跟屏幕上完全一致） */
export function boardHtml(items, page = PAGE.a4p, expOf = () => null, ctx = null) {
  const blocks = (items || [])
    .filter((it) => it && it.type)
    .map(
      (it) =>
        `<div class="bd-item" style="left:${(it.x / 10).toFixed(2)}mm;top:${(it.y / 10).toFixed(2)}mm;width:${(it.w / 10).toFixed(2)}mm${
          it.type === 'shape' ? `;height:${((it.h || 400) / 10).toFixed(2)}mm` : ''
        }">` +
        `${itemHtml(it, expOf(it), ctx)}</div>`
    );
  return `<div class="bd-page" style="width:${page.w / 10}mm;height:${page.h / 10}mm">${blocks.join('')}</div>`;
}

/** 画布 / 导出共用的样式（全 mm / pt 单位） */
export const BOARD_CSS = `
.bd-page { position: relative; overflow: hidden; background: #fff; color: #1c1b19;
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
.bd-item { position: absolute; }
.bd-item img { display: block; width: 100%; height: auto; }
.bd-cap { margin-top: 1.4mm; font-size: 7.5pt; line-height: 1.35; color: #4a4740;
  text-align: center; word-break: break-word; }
.bd-text { font-size: 9.5pt; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
/* 画布上的形状：箭头 / 方框。线宽用 mm，跟纸上的字一样是「印刷单位」，
   所以屏幕上缩小看和导出 PDF 一样粗细。 */
/* .bd-body 是 itemHtml 外面那层，不给它高度的话 height:100% 的百分比会落到 auto 上，
   形状就只剩一条线（踩过：方框渲染成 3px 高的细条）。注意别在这段 CSS 里写反引号——
   它整个是 JS 模板字符串。 */
.bd-body { height: 100%; }
.bd-shape { box-sizing: border-box; width: 100%; height: 100%; }
.bd-box { border: 0.45mm solid var(--sc, #1c1b19); border-radius: 1.4mm; }
.bd-box.is-thick { border-width: 0.9mm; }
.bd-arrow { display: flex; align-items: center; }
.bd-arrow.is-l { flex-direction: row-reverse; }
.bd-arrow .ln { flex: 1 1 auto; border-top: 0.55mm solid var(--sc, #1c1b19); }
.bd-arrow .hd { flex: 0 0 auto; width: 0; height: 0;
  border-top: 1.6mm solid transparent; border-bottom: 1.6mm solid transparent; }
.bd-arrow.is-r .hd { border-left: 3mm solid var(--sc, #1c1b19); }
.bd-arrow.is-l .hd { border-right: 3mm solid var(--sc, #1c1b19); }
.bd-arrow.is-thick .ln { border-top-width: 1.1mm; }
.bd-arrow.is-thick .hd { border-top-width: 2.6mm; border-bottom-width: 2.6mm; }
.bd-arrow.is-thick.is-r .hd { border-left-width: 4.4mm; }
.bd-arrow.is-thick.is-l .hd { border-right-width: 4.4mm; }
.bd-h1 { font-family: "Iowan Old Style", Georgia, serif; font-size: 11.5pt; line-height: 1.35; }
.bd-h2 { font-family: "SF Mono", Menlo, monospace; font-size: 7pt; letter-spacing: 0.1em; color: #a09c93;
  margin-bottom: 1.2mm; }
table.bd-cmp { font-size: 7.6pt; }
table.bd-cmp td.mono { font-family: "SF Mono", Menlo, monospace; white-space: nowrap; }
.bd-sub { margin-top: 1mm; font-size: 7.5pt; color: #6d6862; }
.bd-kv { font-size: 8.8pt; line-height: 1.65; color: #1c1b19; }
.bd-kv .k { font-size: 6.8pt; color: #a09c93; margin-right: 1.2mm; }
.bd-kv .sep { color: #c9c6bd; margin: 0 1.6mm; }
.bd-ph { font-size: 8pt; color: #b4b2aa; }
table.bd-tb { width: 100%; border-collapse: collapse; font-size: 7.8pt; }
table.bd-tb th { font-weight: 500; font-size: 6.4pt; letter-spacing: 0.04em; color: #a09c93;
  text-align: left; padding: 0 1.2mm 0.8mm; border-bottom: 0.2mm solid #ddd9d0; white-space: nowrap; }
table.bd-tb td { padding: 0.7mm 1.2mm; border-bottom: 0.2mm solid #f2f0ec; }
table.bd-tb td.n, table.bd-tb th.n { text-align: right; font-family: "SF Mono", Menlo, monospace; }
table.bd-tb td.role { color: #6d6862; font-size: 7.2pt; }
table.bd-tb td.amt { font-weight: 600; }
`;

/**
 * 导 PDF 时才加：清掉 body 边距 + `zoom: 0.7498`。
 * **那个 zoom 不能省**：print.swift 给的页面视口是 595.28×841.89 **CSS px**（不是 pt），
 * 而 A4 是 210mm = 794px，不缩就会被裁掉右边和下面（踩过：表格右列直接消失）。
 */
export const PRINT_CSS = `html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
body { zoom: 0.7498; }
${BOARD_CSS}`;
