/**
 * 排版板的坐标换算与吸附（`src/lib/board.js`）。
 *
 * 这两样错了不会报错，只会「拖一下整块飞出去」或者「块贴不到边」——
 * 而且它们又被 `fit()`（算缩放）、`syncCursor()`（算新块落点）、拖拽共用，
 * 一处错全盘错。以前这条只有一个注释里的警告，现在有测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MM_PER_PX, PAGE, unitsPerPx, pxPerUnit, SNAP, snapX } from '../src/lib/board.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('MM_PER_PX：CSS 的 96dpi 换算（1mm ≈ 3.78px）', () => {
  assert.ok(near(MM_PER_PX, 25.4 / 96));
  assert.equal(Number((1 / MM_PER_PX).toFixed(2)), 3.78);
});

test('unitsPerPx：1 倍缩放下 1px ≈ 2.646 个画布单位（0.1mm）', () => {
  // 1px = 0.2646mm = 2.646 × 0.1mm
  assert.equal(Number(unitsPerPx(1).toFixed(4)), 2.6458);
});

test('unitsPerPx：**别写成 1/(MM_PER_PX*0.1*zoom)**（会大 14 倍、一拖就飞）', () => {
  const right = unitsPerPx(1);
  const wrong = 1 / (MM_PER_PX * 0.1 * 1);
  // 实测 14.28 倍（≈ 1/0.07），这就是当年「一拖就飞」的来源
  assert.equal(Number((wrong / right).toFixed(2)), 14.28);
});

test('unitsPerPx / pxPerUnit 互为倒数（任何 zoom 下）', () => {
  for (const z of [0.25, 0.5, 0.7498, 1, 1.7, 3]) {
    assert.ok(Math.abs(unitsPerPx(z) * pxPerUnit(z) - 1) < 1e-12, `zoom=${z}`);
  }
});

test('pxPerUnit：A4 竖版在 100% 下 ≈ 794×1123 px（210×297mm @96dpi）', () => {
  const a4 = PAGE.a4p;
  assert.equal(Math.round(a4.w * pxPerUnit(1)), 794);
  assert.equal(Math.round(a4.h * pxPerUnit(1)), 1123);
});

test('zoom 越大，1px 对应的画布单位越少（画面被放大 = 同样的 px 覆盖更少 mm）', () => {
  assert.ok(unitsPerPx(2) < unitsPerPx(1));
  assert.ok(near(unitsPerPx(2), unitsPerPx(1) / 2));
});

test('unitsPerPx(0) 不返回 Infinity（zoom 还没算出来时也要安全）', () => {
  assert.ok(Number.isFinite(unitsPerPx(0)));
});

test('PAGE：A4 = 2100 × 2970 个 0.1mm 单位', () => {
  assert.equal(PAGE.a4p.w, 2100);
  assert.equal(PAGE.a4p.h, 2970);
  assert.equal(PAGE.a4l.w, 2970);
  assert.equal(PAGE.a4l.h, 2100);
});

test('snapX：贴左 / 水平居中 / 贴右，各吸在 4.5mm（45 单位）内', () => {
  const pageW = 2100;
  const w = 600;
  // 贴左
  assert.deepEqual(snapX(20, w, pageW), { x: 0, line: 0 });
  // 水平居中：(2100-600)/2 = 750，参考线画在整页中线 1050
  assert.deepEqual(snapX(760, w, pageW), { x: 750, line: 1050 });
  // 贴右：2100-600 = 1500，参考线画在右边界 2100
  assert.deepEqual(snapX(1480, w, pageW), { x: 1500, line: 2100 });
});

test('snapX：超过吸附半径就原样返回、不画参考线', () => {
  const pageW = 2100;
  const w = 600;
  assert.deepEqual(snapX(46, w, pageW), { x: 46, line: null });
  assert.deepEqual(snapX(700, w, pageW), { x: 700, line: null });
  // 边界：正好 SNAP 之内要吸
  assert.equal(snapX(SNAP, w, pageW).x, 0);
  assert.equal(snapX(SNAP + 1, w, pageW).line, null);
});

test('snapX：块比纸还宽时「居中」和「贴右」会得出负数，仍按原样算（不静默改成 0）', () => {
  // 宽度超过页面：贴右 = 2100 - 2400 = -300
  const out = snapX(-280, 2400, 2100);
  assert.equal(out.x, -300);
});
