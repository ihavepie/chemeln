/**
 * 投料表 / 结果区的**纯计算**（`src/lib/reagent.js`）。
 *
 * 为什么先测这一块：这里的数直接进记录、进导出、进打印，算错了不会报错，
 * 只会安静地给出一个错的产率 —— 唯一能自动化把关的地方。
 *
 * 跑法：`npm run check`（`node --test test/`，零依赖，不装东西）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  num,
  eqNum,
  eqLabel,
  round,
  saneDensity,
  densityUsable,
  amountText,
  volText,
  yieldInfo,
  setAmountDecimals,
} from '../src/lib/reagent.js';

test('num：空 / 非法 → null，数字原样', () => {
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num(''), null);
  assert.equal(num('  '), 0); // 空白字符串 Number(' ')=0 —— 已知行为，别改成 null（投料表依赖）
  assert.equal(num('abc'), null);
  assert.equal(num('1.20'), 1.2);
  assert.equal(num(0), 0);
  assert.equal(num(-3), -3);
});

test('eqNum：`10%` 折成 0.1，`2` 就是 2', () => {
  assert.equal(eqNum('10%'), 0.1);
  assert.equal(eqNum('20 %'), 0.2);
  assert.equal(eqNum('2'), 2);
  assert.equal(eqNum('1.2'), 1.2);
  assert.equal(eqNum(''), null);
  assert.equal(eqNum('%'), null);
});

test('eqLabel：不到 1 的写 mol%，其余一位小数的 eq', () => {
  assert.equal(eqLabel('0.2'), '20 mol%');
  assert.equal(eqLabel('10%'), '10 mol%');
  assert.equal(eqLabel('1'), '1.0 eq');
  assert.equal(eqLabel('2.5'), '2.5 eq');
  assert.equal(eqLabel(''), '');
  assert.equal(eqLabel('乱写'), '');
});

test('round：不返回 NaN，空值返回空串', () => {
  assert.equal(round(1.2345, 2), '1.23');
  assert.equal(round('1.235', 2), '1.24');
  assert.equal(round(0, 2), '0');
  assert.equal(round(null), '');
  assert.equal(round('x'), '');
});

test('saneDensity：只认 0.3–3.5 之间的密度', () => {
  assert.equal(saneDensity(0.069), null); // PubChem 的预测值，不能拿来折体积
  assert.equal(saneDensity(1.74), 1.74);
  assert.equal(saneDensity(''), null);
  assert.equal(saneDensity(4), null);
});

test('densityUsable：只有「按体积量」的组分才给密度，固体的不给', () => {
  assert.equal(densityUsable({ role: '溶剂', density: 1.5 }), 1.5);
  assert.equal(densityUsable({ role: '试剂', density: 1.5 }), 1.5);
  assert.equal(densityUsable({ role: '添加剂', density: 1.5 }), 1.5);
  // 配体 / 碱 / 催化剂 / 底物都是按 g 称的
  assert.equal(densityUsable({ role: '配体', density: 1.5 }), null);
  assert.equal(densityUsable({ role: '底物', density: 1.5 }), null);
  // 标了固体的，密度是结晶密度
  assert.equal(densityUsable({ role: '试剂', density: 1.5, solid: 1 }), null);
});

test('amountText：用量一律按克写，mg 只在 < 1 mg 时出现', () => {
  setAmountDecimals(0);
  // 2.671 g 这种大数：两位
  assert.equal(amountText({ mass_mg: 2671, role: '配体' }), '2.67 g');
  // 0.0915 g（0.2 mmol × 457.59）
  assert.equal(amountText({ mass_mg: 91.5, role: '底物' }), '0.0915 g');
  // 不到 1 mg 才退回 mg
  assert.equal(amountText({ mass_mg: 0.4, role: '配体' }), '0.4 mg');
  // 按体积量的（溶剂行）走 mL / µL；体积**去掉尾零**（30 mL 不写成 30.000 mL）
  assert.equal(amountText({ volume_ul: 2000, role: '溶剂' }), '2 mL');
  assert.equal(amountText({ volume_ul: 41.49, role: '添加剂', density: 1.6 }), '41 µL');
  // mmol + 浓度 → mL
  assert.equal(amountText({ mmol: 2, conc: 2 }), '1 mL');
  // 什么都没有 → 空串（不是 0）
  assert.equal(amountText({ role: '配体' }), '');
});

test('amountText：设了固定小数位就补齐尾零（称量精度本身是信息）', () => {
  setAmountDecimals(4);
  assert.equal(amountText({ mass_mg: 2671, role: '配体' }), '2.6710 g');
  setAmountDecimals(0); // 还原成自适应，别影响别的测试
});

test('volText：够 1 mL 写 mL，不够写 µL（体积去掉尾零）', () => {
  assert.equal(volText(2000), '2 mL');
  assert.equal(volText(1000), '1 mL');
  assert.equal(volText(41.49), '41 µL');
  assert.equal(volText(4.5), '4.5 µL');
  assert.equal(volText(0), '');
  assert.equal(volText(null), '');
});

test('yieldInfo：质量 → 产率，超过理论 105% 标 over', () => {
  // 0.2 mmol × 431.6 = 0.08632 g 理论；称到 0.0612 g
  const a = yieldInfo({ base_mmol: 0.2, product_mw: 431.6, product_mass: '0.0612' });
  assert.equal(round(a.theo, 6), '0.08632');
  assert.equal(round(a.calc, 1), '70.9');
  assert.equal(a.over, false);

  // 称到的比理论还多 → over（页面会报那句「检查规模 / 产物 MW / 残留溶剂」）
  const b = yieldInfo({ base_mmol: 0.2, product_mw: 431.6, product_mass: '0.1' });
  assert.equal(b.over, true);

  // 105% 以内不算 over
  const c = yieldInfo({ base_mmol: 0.2, product_mw: 431.6, product_mass: '0.0906' });
  assert.equal(c.over, false);
});

test('yieldInfo：缺一个就不算，不返回 NaN', () => {
  assert.deepEqual(yieldInfo({ base_mmol: 0.2, product_mw: '', product_mass: '0.0612' }), {
    theo: null,
    calc: null,
    over: false,
    saved: null,
  });
  assert.equal(yieldInfo({ base_mmol: null, product_mw: 431.6, product_mass: '0.1' }).theo, null);
  assert.equal(yieldInfo({ base_mmol: 0.2, product_mw: 431.6, product_mass: '' }).calc, null);
  // 产率还没填时 saved 是 null（不是 0）——「不计产率」靠它判断
  assert.equal(yieldInfo({ base_mmol: 0.2, product_mw: 431.6 }).saved, null);
  // 已经填过产率的照原样带出来
  assert.equal(yieldInfo({ base_mmol: 0.2, product_mw: 431.6, yield_pct: 71 }).saved, 71);
});
