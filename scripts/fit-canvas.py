#!/usr/bin/env python3
"""按真实渲染外框修正结构图的 viewBox（一次算准，不累积）。

为什么要逐张单独开页面：Indigo 的字形用 <use xlink:href="#glyph-0-1">，id 是文档级的，
多张图放进同一个页面会互相引错，量出来的框是错的（踩过）。

用法： python3 scripts/fit-canvas.py [--dry]
"""
import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache')
DATA = os.path.join(ROOT, 'data/compounds')
EVALJS = os.path.join(CACHE, 'evaljs')
DRY = '--dry' in sys.argv

JS = """(() => {
  const svg = document.querySelector('svg');
  const vb = svg.getAttribute('viewBox').split(/[\\s,]+/).map(Number);
  const sr = svg.getBoundingClientRect();
  const kx = vb[2] / sr.width, ky = vb[3] / sr.height;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const el of svg.querySelectorAll('use,text,path,rect,line,polyline,circle,polygon')) {
    if (el.closest('defs')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    x0 = Math.min(x0, vb[0] + (r.left - sr.left) * kx);
    y0 = Math.min(y0, vb[1] + (r.top - sr.top) * ky);
    x1 = Math.max(x1, vb[0] + (r.right - sr.left) * kx);
    y1 = Math.max(y1, vb[1] + (r.bottom - sr.top) * ky);
  }
  return JSON.stringify([vb, x0, y0, x1, y1]);
})()"""

page = os.path.join(CACHE, 'fit1.html')
js = os.path.join(CACHE, 'fit1.js')
open(js, 'w', encoding='utf-8').write(JS)
r3 = lambda v: round(v, 3)

for f in sorted(glob.glob(os.path.join(DATA, '*/*.svg'))):
    rel = os.path.relpath(f, DATA)
    src = open(f, encoding='utf-8').read()
    body = re.sub(r'<\?xml[^>]*\?>', '', src).strip()
    open(page, 'w', encoding='utf-8').write(
        '<html><head><meta charset="utf-8"><style>body{margin:20px;background:#fff}</style></head><body>'
        + body + '</body></html>')
    out = subprocess.run([EVALJS, 'file://' + page, js, '0.7'], capture_output=True, text=True).stdout
    if 'RESULT1:' not in out:
        print(f'{rel:32s} 量不到：{out[:120]}')
        continue
    vb, x0, y0, x1, y1 = json.loads(out.split('RESULT1:', 1)[1].strip())
    bond = 40.0
    m = re.search(r'matrix\(([\d.]+),', src)
    if m:
        bond = float(m.group(1))
    pad = max(1.5, 0.05 * bond)
    nx0, ny0, nx1, ny1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    w, h = r3(nx1 - nx0), r3(ny1 - ny0)
    px = re.search(r'width="([\d.]+)(?:px)?"\s+height="([\d.]+)(?:px)?"', src)
    if not px:
        print(f'{rel:32s} 没有 px 尺寸，跳过')
        continue
    k = float(px.group(1)) / vb[2]
    changed = (abs(nx0 - vb[0]) > 0.3 or abs(ny0 - vb[1]) > 0.3
               or abs(w - vb[2]) > 0.3 or abs(h - vb[3]) > 0.3)
    if changed:
        new = re.sub(r'viewBox="[^"]*"', f'viewBox="{r3(nx0)} {r3(ny0)} {w} {h}"', src, count=1)
        new = re.sub(r'width="[\d.]+(?:px)?"\s+height="[\d.]+(?:px)?"',
                     f'width="{r3(w * k)}px" height="{r3(h * k)}px"', new, count=1)
        if not DRY:
            open(f, 'w', encoding='utf-8').write(new)
    print(f'{rel:32s} 内容 ({r3(x0)},{r3(y0)})-({r3(x1)},{r3(y1)})  旧框 {[r3(v) for v in vb]}  '
          f'新框 ({r3(nx0)},{r3(ny0)}) {w}×{h}{"" if changed else "  已贴合"}')
print('\ndry-run，没写盘' if DRY else '\n完成')
