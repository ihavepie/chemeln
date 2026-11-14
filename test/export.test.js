/**
 * Markdown 导出（`server/export.js`，CommonJS）：导出的那份是给人看、也是留档的，
 * 表头列数、单位、条件行写歪了，几个月后回看就是错的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import exp from '../server/export.js';

const { experimentToMarkdown, screeningToCsv, CELL_CATEGORY } = exp;

const baseExp = {
  code: 'SJ-2-8',
  title: '环丁酮-筛配体',
  date: '2026-11-10',
  status: '进行中',
  project: '',
  kind: '条件筛选',
  rxn_type: '筛配体',
  base_mmol: 0.2,
  product_name: '丙炔基氨基环丁酮',
  appearance: '白色固体',
  product_mw: 431.6,
  product_mass: null,
  yield_pct: null,
  dr_ee: '> 20:1',
  steps: [{ temperature: '110 °C', duration: '12 h', atmosphere: 'N₂' }],
  conds: [],
};

const reagentRows = [
  { role: '底物', name: '环丁酮', mw: 457.59, eq: '1.0', mmol: 0.2, mass_mg: 91.5, position: 1, step: 1 },
  { role: '溶剂', name: 'dioxane', volume_ul: 2000, position: 2, step: 1 },
];

test('experimentToMarkdown：抬头、条件、投料表三块都在', () => {
  const md = experimentToMarkdown(baseExp, { reagents: reagentRows, settings: { lab_heading: '方法学实验记录' } });
  assert.match(md, /^# SJ-2-8 · 环丁酮-筛配体/);
  assert.match(md, /## 反应条件/);
  assert.match(md, /## 投料表/);
  assert.match(md, /环丁酮/);
  // 溶剂是投料表的一行 → 条件行里不再重复一遍溶剂名
  const condLine = md.split('\n').find((l) => l.startsWith('- 溶剂 / 条件：'));
  assert.ok(condLine);
  assert.ok(!/dioxane/.test(condLine), `条件行不该重复溶剂：${condLine}`);
});

test('experimentToMarkdown：没填的部分不硬造小标题', () => {
  const md = experimentToMarkdown({ ...baseExp, objective: '', conclusion: '' }, { reagents: reagentRows });
  assert.ok(!md.includes('## 研究目的'));
  assert.ok(!md.includes('## 结论'));
});

test('screeningToCsv：表头固定带单位，格子只放数字 / 字，BOM + CRLF', () => {
  const s = {
    vars: ['相对标准条件', '温度'],
    entries: [
      { label: 'SJ-2-1', values: { 相对标准条件: 'none', 温度: '110 °C' }, yield_pct: 96.3, ee_pct: 99, dr: '> 20:1', note: '' },
      { label: 'SJ-2-8', values: { 相对标准条件: 'C to D' }, yield_pct: '', ee_pct: '', dr: '', note: '待测' },
    ],
  };
  const csv = screeningToCsv(s);
  const lines = csv.split('\r\n');
  // 开头有 BOM（Excel 才认 UTF-8）
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(lines[0], '\uFEFF编号,相对标准条件,温度,产率(%),ee(%),dr,说明');
  // 格子里的产率只写数字：单位在表头
  assert.equal(lines[1], 'SJ-2-1,none,110 °C,96.3,99,> 20:1,');
  // 没填的格子留空，不写 null / undefined
  assert.equal(lines[2], 'SJ-2-8,C to D,,,,\,待测');
  // 末尾有换行（追加写的时候不会粘在最后一行上）
  assert.ok(csv.endsWith('\r\n'));
});

test('CELL_CATEGORY：附件分类的中文名（导出小标题用）', () => {
  assert.equal(CELL_CATEGORY.tlc, 'TLC 板');
  assert.equal(CELL_CATEGORY.h1, '¹H NMR');
  assert.equal(CELL_CATEGORY.scheme, '反应式');
});
