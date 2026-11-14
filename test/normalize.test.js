/**
 * 服务端写库前的那道闸（`server/lib/normalize.js`）。
 * 这里每一条错了都会让**脏数据进库**，而且是安静的：页面照常显示，只是数字不对。
 * 这条是 CommonJS（`server/` 有 `{"type":"commonjs"}` 的 package.json），所以在 ESM 测试里用默认导入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import normalize from '../server/lib/normalize.js';

const {
  str,
  numOrNull,
  safeName,
  normalizeCondVars,
  parseConds,
  normalizeConds,
  normalizeFieldVars,
  parseFieldVars,
} = normalize;

test('str / numOrNull：空值给安全默认，不认识的不抛错', () => {
  assert.equal(str(null), '');
  assert.equal(str(undefined, '—'), '—');
  assert.equal(str(12), '12');
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull('0.2'), 0.2);
  assert.equal(numOrNull(0), 0);
});

test('safeName：路径分隔符与控制字符都抹掉，扩展名留着', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('谱图 1.jpg'), '谱图 1.jpg');
  // POSIX 上 `\\` 不是分隔符，basename 只切 `/`
  assert.equal(safeName('a/b\\c:d*.png'), 'b_c_d_.png');
  assert.equal(safeName('a:b*c?.png'), 'a_b_c_.png');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('.hidden'), '_hidden');
});

test('parseConds / parseFieldVars：坏 JSON 当空数组，不抛', () => {
  assert.deepEqual(parseConds('[]'), []);
  assert.deepEqual(parseConds('{不是数组}'), []);
  assert.deepEqual(parseConds(''), []);
  assert.deepEqual(parseConds(null), []);
  assert.deepEqual(parseFieldVars('nope'), []);
});

test('normalizeCondVars：键 ≤8 字、值 ≤maxLen，空值丢掉，最多 6 个', () => {
  // 注意：只按长度截断，**不 trim**（全空白的值会留下来，历史行为；要改得单独确认）
  assert.deepEqual(normalizeCondVars({ L: 'RuPhos', T: '  ' }), { L: 'RuPhos', T: '  ' });
  assert.deepEqual(normalizeCondVars({ L: 'RuPhos', T: '' }), { L: 'RuPhos' });
  assert.deepEqual(normalizeCondVars(null), {});
  assert.deepEqual(normalizeCondVars('不是对象'), {});
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, `v${i}`]));
  assert.equal(Object.keys(normalizeCondVars(many)).length, 6);
  const long = normalizeCondVars({ verylongkey: 'x'.repeat(300) }, 20);
  assert.deepEqual(Object.keys(long), ['verylong']);
  assert.equal(long.verylong.length, 20);
});

test('normalizeConds：产率夹到 0–100 并留一位小数，null 保持 null', () => {
  const out = normalizeConds([
    { vars: { L: 'A' }, yield_pct: 120 },
    { vars: { L: 'B' }, yield_pct: -5 },
    { vars: { L: 'C' }, yield_pct: 70.94 },
    { vars: { L: 'D' }, yield_pct: '' },
  ]);
  assert.deepEqual(
    out.map((c) => c.yield_pct),
    [100, 0, 70.9, null]
  );
});

test('normalizeConds：什么都不填的候选被滤掉（空行不占 Entry）', () => {
  const out = normalizeConds([
    { label: '', mass: '', yield_pct: null, sel: '', note: '', vars: {}, varEq: {} },
    { label: '', yield_pct: null, vars: { L: 'RuPhos' }, varEq: { L: '20%' } },
    { label: '', mass: '0.0612', vars: { L: 'Dcpf' } },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].vars.L, 'RuPhos');
  assert.equal(out[1].mass, '0.0612');
});

test('normalizeConds：最多 60 个候选；不是数组就返回 null（调用方保留原字符串）', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ vars: { L: `L${i}` } }));
  assert.equal(normalizeConds(many).length, 60);
  assert.equal(normalizeConds('不是数组'), null);
  assert.equal(normalizeConds(null), null);
});

test('normalizeConds：字段都截断（label 200 / sel 60 / note 200）', () => {
  const out = normalizeConds([{ label: 'x'.repeat(500), sel: 'y'.repeat(99), note: 'z'.repeat(500), vars: { L: 'A' } }]);
  assert.equal(out[0].label.length, 200);
  assert.equal(out[0].sel.length, 60);
  assert.equal(out[0].note.length, 200);
});

test('normalizeFieldVars：只认白名单四个键，重复的只留第一个，label 缺了给默认', () => {
  assert.deepEqual(normalizeFieldVars([{ key: 'temperature' }, { key: 'temperature', label: 'T2' }, { key: '乱写' }]), [
    { key: 'temperature', label: 'T' },
  ]);
  assert.deepEqual(normalizeFieldVars(['duration']), [{ key: 'duration', label: 't' }]);
  assert.equal(normalizeFieldVars(null), null);
  assert.deepEqual(normalizeFieldVars([]), []);
});
