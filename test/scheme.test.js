/**
 * 反应式上那行字的「上下标」规则（`splitScript`，`src/lib/scheme.js`）。
 *
 * 这条规则决定 `Pd(PPh3)4` 里的 4 是下标、而 `0.05 eq` / `12 h` / `-78 °C` / `4:1` 里的数字
 * 必须保持正常字号——判错了箭头上的条件会变成一堆假的化学式，而且**不会报错**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitScript,
  capTextWidth,
  arrowLenFor,
  shouldWrapCaps,
  ARROW_MIN,
  ARROW_PAD,
  AUTO_SINGLE_MAX,
  CAP_SIZE,
} from '../src/lib/scheme.js';

/** 把分段拼回「带标记」的字符串，好写断言：正常字号、[下标]、{上标} */
const flat = (text) =>
  splitScript(text)
    .map((p) => (p.kind === 'sub' ? `[${p.t}]` : p.kind === 'sup' ? `{${p.t}}` : p.t))
    .join('');

test('字母后面的数字当下标（化学式）', () => {
  assert.equal(flat('H2O'), 'H[2]O');
  assert.equal(flat('Pd(PPh3)4'), 'Pd(PPh[3])[4]');
  assert.equal(flat('Cs2CO3'), 'Cs[2]CO[3]');
});

test('空格开头的数字不动（当量 / 时间 / 温度 / 比例都不是计量数）', () => {
  assert.equal(flat('0.05 eq'), '0.05 eq');
  assert.equal(flat('12 h'), '12 h');
  assert.equal(flat('-78 °C'), '-78 °C');
  assert.equal(flat('4:1'), '4:1');
  assert.equal(flat('dioxane, 110 °C, 12 h'), 'dioxane, 110 °C, 12 h');
});

test('结晶水的系数保持正常字号（CuSO4·5H2O 里的 5）', () => {
  assert.equal(flat('CuSO4·5H2O'), 'CuSO[4]·5H[2]O');
});

test('字母后紧跟空白或结尾的 +/- 当上标（离子）', () => {
  assert.equal(flat('Na+'), 'Na{+}');
  assert.equal(flat('Cl- 的水溶液'), 'Cl{-} 的水溶液');
  // 连字符（-40 °C 的减号）前面不是字母 → 不动
  assert.equal(flat('at -40 °C'), 'at -40 °C');
});

test('手写 `_{3}` / `^{2}` 可以强制指定', () => {
  assert.equal(flat('SO_{4}^{2-}'), 'SO[4]{2-}');
  assert.equal(flat('^{13}C'), '{13}C');
});

test('没闭合的 `_{` 当成普通文字，不吞后面的字', () => {
  assert.equal(flat('SO_{4'), 'SO_{4');
});

test('纯文字 / 空值不炸', () => {
  assert.equal(flat(''), '');
  assert.equal(flat(null), '');
  assert.equal(flat('室温搅拌过夜'), '室温搅拌过夜');
});

test('capTextWidth：西文 0.47×字号、中文全角 1.0×字号', () => {
  assert.equal(capTextWidth('H'), Number((CAP_SIZE * 0.47).toFixed(4)));
  assert.equal(capTextWidth('中'), CAP_SIZE);
  // 混合：'C 1' 三个字符；中文各自一整字宽
  assert.equal(capTextWidth(''), 0);
  assert.equal(Number(capTextWidth('中文').toFixed(1)), 30);
  assert.ok(capTextWidth('dioxane, 110 °C, 12 h') > capTextWidth('dioxane'));
});

test('arrowLenFor：字宽 + 两头各 25px，至少 110', () => {
  assert.equal(arrowLenFor(0), ARROW_MIN);
  assert.equal(arrowLenFor(100), 150);
  assert.equal(arrowLenFor(330.4), 380);
  // 关键不变量：**字永远落在箭头里面，两边各留够 ARROW_PAD**
  for (const w of [0, 12, 250, 429, 900]) {
    const len = arrowLenFor(w);
    assert.ok(len - w >= ARROW_PAD * 2 - 0.5, `w=${w} 时两端留白不够：${len - w}`);
  }
});

test('shouldWrapCaps：超过 430px 才退回两行（auto 的阈值）', () => {
  assert.equal(shouldWrapCaps(AUTO_SINGLE_MAX), false);
  assert.equal(shouldWrapCaps(AUTO_SINGLE_MAX + 1), true);
  // 一个典型的长条件（> 430）应该折行，短的不折
  assert.equal(shouldWrapCaps(capTextWidth('Pd(OAc)2, PPh3, Cs2CO3, dioxane, 110 °C, 12 h')), false);
  assert.equal(shouldWrapCaps(capTextWidth('Pd(OAc)2 (10 mol%), PPh3 (20 mol%), Cs2CO3 (2.0 eq), dioxane (2 mL), 110 °C, 12 h')), true);
});
