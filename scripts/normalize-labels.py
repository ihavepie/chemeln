#!/usr/bin/env python3
"""把结构图里的标签统一到「字高 = 目标比例 × 键长」。

只做几何计算，不开浏览器：
- 字高按**每个 <use> 实际引用的字形**（glyph defs 里的 path 包围盒）来量，
  不能取「所有字形的最大值」——Indigo 的 defs 里混着别的字号，会算错。
- 倍率按当前文件算，所以任意中间态都能收敛；重复运行是空转。

两类图：
  glyph  Indigo 原生字形 → 同一个标签的若干 <use> 一起缩放（字距同步放大，不挤成一团）
  text   我们 chemdraw 换过字体的（Helvetica 字体栈标签）→ 改 font-size
  其它（openchemlib 渲的原子标）不动。

用法： python3 scripts/normalize-labels.py [--dry] [目标比例，默认 0.40]
"""
import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data/compounds')
DRY = '--dry' in sys.argv
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
TO = float(ARGS[0]) if ARGS else 0.40
CAP_RATIO = 0.717          # 大写高 / font-size
# 我们加的标签缩放层，整个开标签都要匹配上——只匹配到 scale(...) 会把标签尾巴留在文件里
WRAP_RE = re.compile(r'<g transform="translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+)\) '
                     r'translate\((-?[\d.]+) (-?[\d.]+)\)">')
JUNK_RE = re.compile(r'(?<!transform=")\s*translate\((-?[\d.]+) (-?[\d.]+)\)">')
USE_RE = re.compile(r'<use xlink:href="#(glyph[^"]*)" x="(-?[\d.]+)" y="(-?[\d.]+)"\s*/>')
DEF_RE = re.compile(r'<g id="(glyph[^"]*)">(.*?)</g>', re.S)
NUM_RE = re.compile(r'-?\d*\.?\d+')


def r3(v):
    return round(v, 3)


def unwrap(svg):
    """剥掉我们自己加过的标签缩放层，回到原始坐标 —— 保证重复运行不会叠倍率"""
    while True:
        m = WRAP_RE.search(svg)
        if not m:
            return svg
        depth, i = 1, m.end()
        while depth:
            op, cl = svg.find('<g', i), svg.find('</g>', i)
            if cl < 0:
                raise SystemExit('标签缩放层的 </g> 不配对，拒绝继续')
            if 0 <= op < cl:
                depth += 1
                i = op + 2
            else:
                depth -= 1
                i = cl + 4
        svg = svg[:m.start()] + svg[m.end():i - 4] + svg[i:]


def glyph_boxes(svg):
    """每个字形在 defs 里的墨迹尺寸 {id: (w, h)}"""
    out = {}
    for m in DEF_RE.finditer(svg):
        xs, ys = [], []
        for p in re.finditer(r'd="([^"]+)"', m.group(2)):
            nums = [float(v) for v in NUM_RE.findall(p.group(1))]
            xs += nums[0::2]
            ys += nums[1::2]
        if xs:
            out[m.group(1)] = (max(xs) - min(xs), max(ys) - min(ys))
    return out


def bond_of(svg):
    """键长：Indigo 用 matrix(s,0,0,s,…) 缩放局部坐标；openchemlib 直接画 <line>/<path>"""
    scales = []
    for m in re.finditer(r'matrix\((-?[\d.]+),\s*(-?[\d.]+),', svg):
        s = (float(m.group(1)) ** 2 + float(m.group(2)) ** 2) ** 0.5
        if s > 1:
            scales.append(r3(s))
    if scales:
        return max(set(scales), key=scales.count)
    lens = []
    for l in re.finditer(r'<line[^>]*x1="(-?[\d.]+)"[^>]*y1="(-?[\d.]+)"[^>]*x2="(-?[\d.]+)"[^>]*y2="(-?[\d.]+)"', svg):
        v = ((float(l.group(3)) - float(l.group(1))) ** 2 + (float(l.group(4)) - float(l.group(2))) ** 2) ** 0.5
        if v > 2:
            lens.append(r3(v))
    for d in re.finditer(r'd="M (-?[\d.]+) (-?[\d.]+) L (-?[\d.]+) (-?[\d.]+)"', svg):
        v = ((float(d.group(3)) - float(d.group(1))) ** 2 + (float(d.group(4)) - float(d.group(2))) ** 2) ** 0.5
        if v > 2:
            lens.append(r3(v))
    return max(set(lens), key=lens.count) if lens else 0


def label_groups(svg):
    """同一基线上、横向相邻的一串 <use> = 一个标签"""
    groups = []
    for m in USE_RE.finditer(svg):
        gid, x, y = m.group(1), float(m.group(2)), float(m.group(3))
        if groups and abs(y - groups[-1]['y']) < 4 and -6 < x - groups[-1]['maxX'] < 22:
            groups[-1]['items'].append({'gid': gid, 'x': x, 'start': m.start(), 'end': m.end()})
            groups[-1]['maxX'] = max(groups[-1]['maxX'], x)
        else:
            groups.append({'y': y, 'maxX': x, 'items': [{'gid': gid, 'x': x, 'start': m.start(), 'end': m.end()}]})
    return groups


def measure(svg, boxes):
    """返回 (字高, 标签框列表) —— 字高取各标签里最高的那个字符"""
    caps = []
    frames = []
    for g in label_groups(svg):
        hs = [boxes.get(i['gid'], (0, 0))[1] for i in g['items']]
        ws = [boxes.get(i['gid'], (0, 0))[0] for i in g['items']]
        cap = max(hs) if hs else 0
        last_w = ws[-1] if ws else 0
        caps.append(cap)
        frames.append((min(i['x'] for i in g['items']), g['y'] - cap,
                       max(i['x'] for i in g['items']) + last_w, g['y']))
    return (max(caps) if caps else 0), frames


def wrap(svg, K, frames):
    """按标签中心整体缩放；同时把标签框按 K 放大后返回，供画布修正用"""
    out, cursor, new_frames = [], 0, []
    for (x0, y0, x1, y1), g in zip(frames, label_groups(svg)):
        cx, by = (x0 + x1) / 2, g['y']
        first, last = g['items'][0]['start'], g['items'][-1]['end']
        out.append(svg[cursor:first])
        out.append(f'<g transform="translate({r3(cx)} {r3(by)}) scale({r3(K)}) translate({r3(-cx)} {r3(-by)})">'
                   + svg[first:last] + '</g>')
        cursor = last
        new_frames.append((cx + (x0 - cx) * K, by + (y0 - by) * K, cx + (x1 - cx) * K, by + (y1 - by) * K))
    out.append(svg[cursor:])
    return ''.join(out), new_frames


def text_frames(svg):
    """<text> 标签的外框：按锚点方向 + 字宽估（Helvetica 平均 0.6em）"""
    frames = []
    for m in re.finditer(r'<text([^>]*)>([^<]*)</text>', svg):
        attrs, body = m.group(1), m.group(2).strip()
        if not body:
            continue
        gx = re.search(r'\bx="(-?[\d.]+)"', attrs)
        gy = re.search(r'\by="(-?[\d.]+)"', attrs)
        gf = re.search(r'font-size="([\d.]+)"', attrs)
        if not (gx and gy and gf):
            continue
        x, y, fs = float(gx.group(1)), float(gy.group(1)), float(gf.group(1))
        w = 0.6 * fs * len(body)
        anchor = re.search(r'text-anchor="(\w+)"', attrs)
        anchor = anchor.group(1) if anchor else 'start'
        left = x if anchor == 'start' else (x - w if anchor == 'end' else x - w / 2)
        frames.append((left, y - fs * CAP_RATIO, left + w, y + fs * 0.25))
    return frames


def fit_canvas(svg, extra, bond):
    """把 viewBox 撑到装得下所有内容（只扩不缩），px 尺寸按原比例同步"""
    vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()]
    x0, y0, x1, y1 = vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3]
    for (a, b, c, d) in extra:
        x0, y0, x1, y1 = min(x0, a), min(y0, b), max(x1, c), max(y1, d)
    for m in re.finditer(r'd="M (-?[\d.]+) (-?[\d.]+) L (-?[\d.]+) (-?[\d.]+)"', svg):
        pass  # 键的坐标在局部系里，靠 matrix 换算，交给下面的整体比例
    pad = max(2.0, 0.06 * (bond or 40))
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    if abs(x0 - vb[0]) < 0.4 and abs(y0 - vb[1]) < 0.4 and abs(x1 - vb[0] - vb[2]) < 0.4 and abs(y1 - vb[1] - vb[3]) < 0.4:
        return svg, False
    w, h = r3(x1 - x0), r3(y1 - y0)
    px = re.search(r'width="([\d.]+)(?:px)?"\s+height="([\d.]+)(?:px)?"', svg)
    k = (float(px.group(1)) / vb[2]) if px else 1.0
    svg = re.sub(r'viewBox="[^"]*"', f'viewBox="{r3(x0)} {r3(y0)} {w} {h}"', svg, count=1)
    if px:
        svg = re.sub(r'width="[\d.]+(?:px)?"\s+height="[\d.]+(?:px)?"',
                     f'width="{r3(w * k)}px" height="{r3(h * k)}px"', svg, count=1)
    return svg, True


rows = []
for f in sorted(glob.glob(os.path.join(DATA, '*/*.svg'))):
    src = open(f, encoding='utf-8').read()
    rel = os.path.relpath(f, DATA)
    try:
        ET.fromstring(src)
    except ET.ParseError as e:
        rows.append((rel, '坏图', f'XML 解析失败：{e}'))
        continue
    bond = bond_of(src)

    if '<use xlink:href="#glyph' in src:
        kind = 'glyph'
        base = unwrap(src)                    # 回到原始坐标，倍率才是绝对值
        base, junk = JUNK_RE.subn('', base)    # 清掉早期脚本留下的标签碎片
        cap, frames = measure(base, glyph_boxes(base))
        if not (bond and cap):
            rows.append((rel, kind, '量不到键长/字高，跳过'))
            continue
        K = TO * bond / cap
        out, _ = wrap(base, K, frames)
        note = f'字高 {r3(cap)} / 键长 {bond} = {r3(cap / bond)} → ×{r3(K)}' + (f'，清碎片 {junk}' if junk else '')
    elif 'font-family="Helvetica, Arial, sans-serif"' in src:
        kind = 'text'
        main = max(float(v) for v in re.findall(r'font-size="([\d.]+)"', src))
        if not bond:
            rows.append((rel, kind, '量不到键长，跳过'))
            continue
        target = TO * bond / CAP_RATIO                      # 主字号目标值
        K = target / main
        if abs(K - 1) < 0.005:                              # 已经在目标上，别做浮点微调
            out, note = src, f'字高 {r3(main * CAP_RATIO)} / 键长 {bond} = {r3(main * CAP_RATIO / bond)}（已达标）'
        else:
            out = re.sub(r'font-size="([\d.]+)"', lambda m: f'font-size="{r3(float(m.group(1)) * K)}"', src)
            note = f'字高 {r3(main * CAP_RATIO)} / 键长 {bond} = {r3(main * CAP_RATIO / bond)} → 字号 {r3(main)}→{r3(target)}'
    else:
        # openchemlib 渲的原子标：保持它自己的比例（0.42，比 0.4 略大，看着正常），不动
        main = max(float(v) for v in re.findall(r'font-size="([\d.]+)"', src)) if 'font-size=' in src else 0
        ratio = (main * CAP_RATIO / bond) if bond else 0
        rows.append((rel, '原子标', f'字高 {r3(main * CAP_RATIO)} / 键长 {bond} = {r3(ratio)}，保持'))
        continue

    if out != src:
        ET.fromstring(out)
        if not DRY:
            open(f, 'w', encoding='utf-8').write(out)
        note += '' if DRY else ''
    else:
        note += '（无变化）'
    rows.append((rel, kind, note))

for rel, kind, note in rows:
    print(f'{rel:32s} {kind:6s} {note}')
print(f'\n共 {len(rows)} 个 svg{"（dry-run，没写盘）" if DRY else ""}；目标 {TO}')
