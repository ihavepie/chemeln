/**
 * 排版板（自由画布）的几个纯函数：
 * **坐标一律用 0.1mm 的整数**（A4 = 2100 × 2970）。
 * 屏幕上按百分比摆（换窗口大小 / 拖内容区宽度，版面都不变），
 * 导 PDF 时 ÷10 直接得 mm，不会累积浮点误差。
 */
export const PAGE = {
  a4p: { w: 2100, h: 2970, label: 'A4 竖' },
  a4l: { w: 2970, h: 2100, label: 'A4 横' },
};

/** 缩到比这还窄就没法看了 */
export const MIN_W = 260;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 新素材落在下一个空位：一列三张，摆满了往下挪一行（免得全叠在左上角） */
export function nextPos(items, w, page = PAGE.a4p) {
  const n = (items || []).length;
  const x = clamp(120 + (n % 3) * 560, 0, page.w - w);
  const y = clamp(120 + Math.floor(n / 3) * 620, 0, Math.max(0, page.h - 500));
  return { x, y };
}

export const uid = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 交给 CSS 的百分比（画布是等比缩放的容器） */
export const pct = (v, total) => `${((v / total) * 100).toFixed(4)}%`;

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 素材取图的地址：TLC 走附件、反应式走 scheme_cache 那张 */
export const srcOf = (it) =>
  it.type === 'tlc' ? `/api/files/${it.ref}` : `/api/experiments/${it.ref}/scheme.svg`;

/**
 * 导 PDF：把 items 拼成**一张固定 A4** 的绝对定位 HTML（单位 mm）。
 * 交给现成的 `/api/print/pdf`（server/print.swift），不另写导出器。
 */
export function boardHtml(items, page = PAGE.a4p) {
  const blocks = (items || [])
    .filter((it) => it && it.type)
    .map((it) => {
      const style = `left:${(it.x / 10).toFixed(2)}mm;top:${(it.y / 10).toFixed(2)}mm;width:${(it.w / 10).toFixed(2)}mm`;
      if (it.type === 'text') {
        return `<div class="bd-it bd-text" style="${style}">${esc(it.text)}</div>`;
      }
      const cap = String(it.caption || '').trim()
        ? `<div class="bd-cap">${esc(it.caption)}</div>`
        : '';
      return `<div class="bd-it" style="${style}"><img src="${srcOf(it)}" alt="">${cap}</div>`;
    });
  return `<div class="bd-page" style="width:${page.w / 10}mm;height:${page.h / 10}mm">${blocks.join('')}</div>`;
}

/** 导出用的样式：只认 mm，别带全站那几千条规则 */
export const BOARD_CSS = `
html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
body { -webkit-print-color-adjust: exact; }
.bd-page { position: relative; overflow: hidden; background: #fff;
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
.bd-it { position: absolute; }
.bd-it img { display: block; width: 100%; height: auto; }
.bd-cap { margin-top: 1.6mm; font-size: 8pt; line-height: 1.35; color: #4a4740;
  text-align: center; word-break: break-word; }
.bd-text { font-size: 10.5pt; line-height: 1.55; color: #1c1b19; white-space: pre-wrap; }
`;
