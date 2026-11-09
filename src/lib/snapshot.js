import { A4_CSS, collectCss, downloadBlob } from './print.js';
import { flattenTextareas } from './autogrow.js';

/**
 * 「整页截下来」式的导出：不按 A4 分页、不裁切，把记录页排成一整条长图 / 一个自包含网页。
 *
 * 为什么不复用 PDF 那套：PDF 是按 A4 一页页出的，内容多了会被裁（用户明确不想要这个），
 * 而且图片在 PDF 里是重采样的。长图是直接拿 WebKit 截整页，图和字都按原始清晰度来。
 */

/** 克隆里的输入框只带 attribute，值要手动搬过去（Vue 改的是 property） */
function syncFields(from, to) {
  const a = from.querySelectorAll('input, textarea, select');
  const b = to.querySelectorAll('input, textarea, select');
  a.forEach((el, i) => {
    const c = b[i];
    if (!c) return;
    if (c.tagName === 'SELECT') c.value = el.value;
    else if (c.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) c.checked = el.checked;
    else if (c.tagName === 'INPUT') {
      c.value = el.value;
      c.setAttribute('value', el.value);
    } else {
      c.value = el.value;
      c.textContent = el.value;
    }
  });
}

/** 屏幕上的每一「页」纸面 → 一张接着一张、不限高的连续文档 */
function buildSheets() {
  const sheets = [...document.querySelectorAll('.editor .sheet')];
  const out = [];
  for (const sheet of sheets) {
    const clone = sheet.cloneNode(true);
    clone.classList.remove('is-hidden');
    clone.removeAttribute('style');
    syncFields(sheet, clone);
    clone.querySelectorAll('.noprint').forEach((el) => el.remove());
    flattenTextareas(clone);
    out.push(clone.outerHTML);
  }
  return out;
}

/** 连续版式（不分页、不裁切），字号/边距跟打印版一致 */
const SNAP_CSS = [
  'html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; height: auto !important; overflow: visible !important; }',
  'body { zoom: 0.7498; }',
  '.snap { background: #fff; }',
  '.snap .pdf-page { width: 210mm; height: auto !important; padding: 16mm 15mm; box-sizing: border-box; overflow: visible !important; background: #fff; }',
  '.snap .pdf-page + .pdf-page { border-top: 1px dashed #e2ded6; }',
];

/** 完整的一整页文档（服务端渲染长图用） */
export function buildSnapshotDoc() {
  const css = [...collectCss(), ...A4_CSS, ...SNAP_CSS].filter(Boolean).join('\n');
  const body = buildSheets()
    .map((html) => `<div class="pdf-page">${html}</div>`)
    .join('');
  return { html: `<div class="snap">${body}</div>`, css };
}

/** 把图改成内嵌（data:），导出的网页拷到别处也不会丢图 */
async function inlineImages(root) {
  const imgs = [...root.querySelectorAll('img[src]')];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith('/api/') && !src.startsWith(location.origin)) return;
      try {
        const r = await fetch(src);
        if (!r.ok) return;
        const blob = await r.blob();
        const b64 = await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result || ''));
          fr.readAsDataURL(blob);
        });
        if (b64) img.setAttribute('src', b64);
      } catch {
        /* 单张图拿不到就算了，别让整份导出失败 */
      }
    })
  );
}

/** 自包含单文件网页：双击就能在浏览器里看，文字可选中/可搜索，图片内嵌 */
export async function exportSnapshotHtml(name = '记录') {
  const { html, css } = buildSnapshotDoc();
  const box = document.createElement('div');
  box.innerHTML = html;
  await inlineImages(box);
  const doc = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${name}</title><style>${css}</style></head><body>${box.innerHTML}</body></html>`;
  downloadBlob(new Blob([doc], { type: 'text/html;charset=utf-8' }), `${name}.html`);
}

/**
 * 打包导出（.zip）：自包含网页 + 原始附件 + 原始 JSON。
 * 想要「一个文件拿走、里面什么都有」时用这个——网页里图是内联的，
 * 附件目录里放的是原图/原始数据（不重采样、不转码）。
 */
export async function exportSnapshotBundle(name = '记录', expId = null) {
  const { html, css } = buildSnapshotDoc();
  const box = document.createElement('div');
  box.innerHTML = html;
  await inlineImages(box);      // 网页里那几张图也内联，单看网页也不缺图
  const doc = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${name}</title><style>${css}</style></head><body>${box.innerHTML}</body></html>`;
  const res = await fetch('/api/export/bundle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html: doc, expId, filename: name }),
  });
  if (!res.ok) {
    let msg = '打包失败';
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* 保持默认提示 */
    }
    throw new Error(msg);
  }
  downloadBlob(await res.blob(), `${name}.zip`);
}

/** 整页长图：交给服务端用系统 WebKit 截图（保留 retina 清晰度，不分页不裁切） */
export async function exportSnapshotPng(name = '记录') {
  const { html, css } = buildSnapshotDoc();
  const res = await fetch('/api/snapshot/png', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html, css, width: 596, filename: `${name}.png` }),
  });
  if (!res.ok) {
    let msg = '长图生成失败';
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* 保持默认提示 */
    }
    throw new Error(msg);
  }
  downloadBlob(await res.blob(), `${name}.png`);
}
