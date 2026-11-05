/**
 * 打印/导出共用的小工具：
 *  - collectExportCss(): 把全站 CSS 拿来，并把 @media print 里的规则提到最后
 *    （WebKit 的 createPDF 走 screen media，不提上来打印版式就不生效）
 *  - downloadBlob(): 下载一坨二进制
 */

export function collectCss() {
  const top = [];
  const print = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 跨域样式表读不到，跳过
    }
    for (const rule of rules) {
      // 用 rule.media 判断而不是 CSSRule.MEDIA_RULE 常量（后者已废弃，不同浏览器不一定有）
      if (rule.media && /print/i.test(rule.media.mediaText) && rule.cssRules) {
        for (const inner of rule.cssRules) print.push(inner.cssText);
      } else {
        top.push(rule.cssText);
      }
    }
  }
  return [...top, ...print];
}

/** A4 页面容器 + 缩放：屏幕 1px 按 96dpi 算，794px 的版心缩到 595pt 才是真的 A4 */
export const A4_CSS = [
  'html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; height: auto !important; overflow: visible !important; }',
  'body { zoom: 0.7498; }',
  '.pdf-page { width: 210mm; height: 297mm; padding: 16mm 15mm; box-sizing: border-box; overflow: hidden; background: #fff; }',
];

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
