/**
 * 筛选表的两处纯逻辑（`src/lib/sctfields.js`）：
 *  - `variations(base, cur)`：一行「相对标准条件改了什么」——文献优化表的那一列；
 *  - `autoValue(source, exp, base, cond)`：自动列取值，**条件组里优先用那一行自己的数**。
 * 这两块只要歪一点，筛选表就会写出跟记录不符的结论，而且没人会当场发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { variations, autoValue, reagentText } from '../src/lib/sctfields.js';

const exp = (over = {}) => ({
  id: 1,
  product_name: '产物甲',
  yield_pct: 96.3,
  dr_ee: '> 20:1',
  no_yield: 0,
  base_mmol: 0.2,
  reagents: [],
  ...over,
});

test('variations：温度 / 时间 / 气氛只写「变成什么」', () => {
  const base = exp({ temperature: '110 °C', duration: '12 h', atmosphere: 'N₂' });
  const cur = exp({ temperature: '80 °C', duration: '12 h', atmosphere: '空气' });
  assert.deepEqual(variations(base, cur), ['80 °C', '空气']);
});

test('variations：去掉某个条件写「无X」', () => {
  const base = exp({ atmosphere: 'N₂' });
  assert.deepEqual(variations(base, exp({ atmosphere: '' })), ['无气氛']);
});

test('variations：换试剂只写新名字，加了溶剂写名字', () => {
  const base = exp({ reagents: [{ role: '配体', name: 'RuPhos', eq: '20%' }, { role: '溶剂', name: 'dioxane', eq: '' }] });
  const cur = exp({ reagents: [{ role: '配体', name: 'Dcpf', eq: '20%' }, { role: '溶剂', name: 'dioxane', eq: '' }] });
  // 角色相同、当量相同 → 只写新名字
  assert.deepEqual(variations(base, cur), ['Dcpf']);
});

test('variations：一进一出时当量也变了才带 eq', () => {
  const base = exp({ reagents: [{ role: '碱', name: 'Cs2CO3', eq: '1.2' }] });
  const cur = exp({ reagents: [{ role: '碱', name: 'K2CO3', eq: '2' }] });
  assert.deepEqual(variations(base, cur), ['K2CO3 2.0 eq']);
});

test('variations：同一个试剂只改当量 → 只写新当量', () => {
  const base = exp({ reagents: [{ role: '碱', name: 'LDA', eq: '1.0' }] });
  const cur = exp({ reagents: [{ role: '碱', name: 'LDA', eq: '1.2' }] });
  const out = variations(base, cur);
  assert.deepEqual(out, ['LDA 1.2 eq']);
});

test('variations：加一个新试剂写成 `+ 名字 eq`，删掉写成 `− 名字`', () => {
  const base = exp({ reagents: [{ role: '试剂', name: 'PPh3', eq: '1' }] });
  const cur = exp({ reagents: [{ role: '试剂', name: 'PPh3', eq: '1' }, { role: '添加剂', name: 'HFIP', eq: '2' }] });
  assert.deepEqual(variations(base, cur), ['+ HFIP 2.0 eq']);
  assert.deepEqual(variations(cur, base), ['− HFIP']);
});

test('variations：基准那行没填投料表时，别把整表标成「+X」', () => {
  const base = exp({ reagents: [{ role: '溶剂', name: 'dioxane', eq: '' }] });
  const cur = exp({
    reagents: [
      { role: '溶剂', name: 'dioxane', eq: '' },
      { role: '配体', name: 'RuPhos', eq: '20%' },
    ],
  });
  // 基准没填 → 不做「加了什么」的判断
  assert.deepEqual(variations(base, cur), []);
});

test('variations：规模变了写 mmol，而且数字要收敛（不甩浮点尾巴）', () => {
  const base = exp({ base_mmol: 0.2 });
  const cur = exp({ base_mmol: 0.1999677 });
  assert.deepEqual(variations(base, cur), []);
  assert.deepEqual(variations(exp({ base_mmol: 0.2 }), exp({ base_mmol: 0.4 })), ['0.4 mmol']);
});

test('variations：两行一模一样 → 空数组（＝重复实验）', () => {
  const one = exp({ temperature: '110 °C', reagents: [{ role: '配体', name: 'RuPhos', eq: '20%' }] });
  assert.deepEqual(variations(one, { ...one, id: 2 }), []);
  assert.deepEqual(variations(null, one), []);
});

test('autoValue：条件组里那一行的产率 / 选择性优先于整条记录', () => {
  const e = exp({ yield_pct: 96.3, dr_ee: '> 20:1' });
  const cond = { yield_pct: 70.9, sel: '94:6' };
  assert.equal(autoValue('yield', e, null, cond), '70.9%');
  assert.equal(autoValue('sel', e, null, cond), '94:6');
  // 那个条件没填 → 回落到整条记录
  assert.equal(autoValue('yield', e, null, { yield_pct: null, sel: '' }), '96.3%');
  assert.equal(autoValue('sel', e, null, { yield_pct: null, sel: '' }), '> 20:1');
  // 没有条件组（普通记录）也走回落
  assert.equal(autoValue('yield', e, null, null), '96.3%');
});

test('autoValue：不计产率写「不计」，不是 0', () => {
  assert.equal(autoValue('yield', exp({ no_yield: 1, yield_pct: '' }), null, null), '不计');
  assert.equal(autoValue('yield', exp({ yield_pct: null }), null, null), '');
});

test('autoValue：产品 / 底物 / 相对改动', () => {
  // `substrates` 是列表接口预先拼好的字符串（不是从 reagents 现算）
  const e = exp({ product_name: '产物甲', substrates: '环丁酮' });
  assert.equal(autoValue('product', e, null, null), '产物甲');
  assert.equal(autoValue('substrates', e, null, null), '环丁酮');
  // 条件组那行的「改了什么」＝ 变量取值 + 自己的当量
  assert.equal(autoValue('variation', e, null, { vars: { L: 'RuPhos' }, varEq: { L: '20%' } }), 'RuPhos 20%');
  // 基准那行（cond 为 null、跟 base 是同一条）写 none
  assert.equal(autoValue('variation', e, e, null), 'none');
});

test('reagentText：投料表拼成一行「名 eq + 名 eq」', () => {
  const e = exp({
    reagents: [
      { role: '配体', name: 'RuPhos', eq: '20%' },
      { role: '碱', name: 'Cs2CO3', eq: '1.2' },
    ],
  });
  assert.equal(reagentText(e), 'RuPhos 20 mol% · Cs2CO3 1.2 eq');
  // 变量行（那一槽是「换什么」的）不进「Reagents」这一格
  assert.equal(reagentText(exp({ reagents: [{ role: '配体', name: 'RuPhos', eq: '20%', variable: 1 }] })), '');
});
