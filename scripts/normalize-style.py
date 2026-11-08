#!/usr/bin/env python3
"""把结构图的「显示尺度」和「线宽」统一：一个键固定 24 px。

为什么要这个：卡片按图片的**原始 px 尺寸**显示（CSS 只封顶不拉伸），而每张图当初
渲染的尺寸各不相同 —— 量出来同一个键在卡片里是 16–32 px，差近 2 倍，于是同一条
键的线宽、以及标签的大小看着都不一样。

做法（只改 `width/height` 和 `stroke-width`，不动几何、不动 viewBox）：
  width  = viewBox宽 × 24/键长        height = viewBox高 × 24/键长
  stroke = 0.05 × 键长（用户单位）     ← 与 Indigo 的默认粗细一致

用法： python3 scripts/normalize-style.py [--dry] [每键 px，默认 24]
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data/compounds')
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
DRY = '--dry' in sys.argv
BOND_PX = float(ARGS[0]) if ARGS else 24.0
STROKE_RATIO = 0.06      # 线宽 / 键长：取 openchemlib 原来的 0.06，别让已有的卡变细

r3 = lambda v: round(v, 3)


def bond_of(svg):
    scales = []
    for m in re.finditer(r'matrix\((-?[\d.]+),\s*(-?[\d.]+),', svg):
        s = (float(m.group(1)) ** 2 + float(m.group(2)) ** 2) ** 0.5
        if s > 1:
            scales.append(r3(s))
    if scales:
        return max(set(scales), key=scales.count), 1.0
    lens = []
    for l in re.finditer(r'<line[^>]*x1="(-?[\d.]+)"[^>]*y1="(-?[\d.]+)"[^>]*x2="(-?[\d.]+)"[^>]*y2="(-?[\d.]+)"', svg):
        v = ((float(l.group(3)) - float(l.group(1))) ** 2 + (float(l.group(4)) - float(l.group(2))) ** 2) ** 0.5
        if v > 2:
            lens.append(r3(v))
    return (max(set(lens), key=lens.count) if lens else 0), 1.0


rows = []
for f in sorted(glob.glob(os.path.join(DATA, '*/*.svg'))):
    rel = os.path.relpath(f, DATA)
    src = open(f, encoding='utf-8').read()
    bond, _ = bond_of(src)
    m = re.search(r'viewBox="([^"]+)"', src)
    if not bond or not m:
        rows.append((rel, '量不到键长/画布，跳过', ''))
        continue
    vb = [float(v) for v in m.group(1).replace(',', ' ').split()]
    scale = BOND_PX / bond
    w, h = r3(vb[2] * scale), r3(vb[3] * scale)

    out = re.sub(r'width="[\d.]+(?:px)?"\s+height="[\d.]+(?:px)?"',
                 f'width="{w}px" height="{h}px"', src, count=1)

    # 线宽：Indigo 的 stroke-width 在 matrix 之前，要除以 matrix 缩放
    mat = re.search(r'matrix\(([\d.]+),', src)
    mat_s = float(mat.group(1)) if mat else 1.0
    target_local = STROKE_RATIO * bond / mat_s
    out = re.sub(r'stroke-width="([\d.]+)"', f'stroke-width="{r3(target_local)}"', out)

    rows.append((rel, f'px {w}×{h}（键 {r3(bond*scale)}px）', f'线宽 {r3(target_local * mat_s)} 用户单位' if mat_s != 1 else f'线宽 {r3(target_local)}px'))
    if out != src and not DRY:
        open(f, 'w', encoding='utf-8').write(out)

for rel, a, b in rows:
    print(f'{rel:30s} {a:24s} {b}')
print(f'\n每键 {BOND_PX}px，线宽 = 0.05×键长{"（dry-run，没写盘）" if DRY else ""}')
