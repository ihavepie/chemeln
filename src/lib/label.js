/** 打印化合物标签：结构式 + 编号/名称/分子式/MW/Rf + 二维码（和 v1 一致） */
import { isImageName, todayISO } from './ui.js';
import { num, round } from './reagent.js';

/**
 * 一张标签的 HTML（100mm × 46mm 版式，样式在 eln.css 的 @media print 里）。
 * 单张打印和批量排 A4 都用它，所以这里只吐字符串、不碰 DOM。
 * structureId 可以由调用方直接给——列表接口只带 structure_id，不带 files。
 */
export function labelMarkup(c, opts = {}) {
  if (!c) return '';
  const meta = [c.mw ? `MW ${round(c.mw, 2)}` : '', c.tlc_rf ? `Rf ${c.tlc_rf}` : ''].filter(Boolean).join(' · ');
  const structId =
    opts.structureId ??
    (c.files || []).find((f) => f.category === 'structure' && isImageName(f.original_name || f.filename))?.id ??
    c.structure_id ??
    null;
  return `
    <div class="label">
      ${structId ? `<div class="label-struct"><img src="/api/compound-files/${structId}" alt=""></div>` : ''}
      <div class="label-text">
        <div class="label-code">${c.code || '—'}</div>
        <div class="label-name">${c.name || ''}</div>
        ${c.formula ? `<div class="label-formula">${c.formula}</div>` : ''}
        <div class="label-meta">${meta}</div>
        <div class="label-meta dim">${[c.tlc_solvent, opts.owner || ''].filter(Boolean).join(' · ')}</div>
      </div>
      <img class="label-qr" src="/api/compounds/${c.id}/qr.svg?unit=6" alt="">
    </div>`;
}

/**
 * 迷你标签（24×11mm 那种小瓶贴）：放不下结构式和 MW，
 * 只留二维码 + 编号 + 名称——扫得到、认得出就够了。
 */
export function labelMarkupMini(c, opts = {}) {
  if (!c) return '';
  const structId =
    opts.structureId ??
    (c.files || []).find((f) => f.category === 'structure' && isImageName(f.original_name || f.filename))?.id ??
    c.structure_id ??
    null;
  const meta = [c.mw ? `MW ${round(c.mw, 2)}` : '', c.tlc_rf ? `Rf ${c.tlc_rf}` : ''].filter(Boolean).join(' · ');
  return `
    <div class="label label-mini">
      ${structId ? `<div class="label-struct"><img src="/api/compound-files/${structId}" alt=""></div>` : ''}
      <div class="label-text">
        <div class="label-code">${c.code || '—'}</div>
        <div class="label-name">${c.name || ''}</div>
        <div class="label-meta">${meta}</div>
      </div>
      <img class="label-qr" src="/api/compounds/${c.id}/qr.svg?unit=6" alt="">
    </div>`;
}

export function printCompoundLabel(c, opts = {}) {
  if (!c) return;
  const el = document.createElement('div');
  el.className = 'label-sheet';
  el.id = 'label-sheet';
  el.innerHTML = labelMarkup(c, opts);
  document.body.appendChild(el);
  document.body.classList.add('printing-label');
  const done = () => {
    document.body.classList.remove('printing-label');
    document.getElementById('label-sheet')?.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 80);
}

export const qrUrl = (id, unit = 6) => `/api/compounds/${id}/qr.svg?unit=${unit}`;
export const _unusedTodayISO = todayISO;
export const _unusedNum = num;
