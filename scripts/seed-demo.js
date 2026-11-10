#!/usr/bin/env node
/**
 * seed-demo.js — 造一份**演示数据**（合成例子，不含任何真实实验记录），给公开的演示站用。
 *
 *   node scripts/seed-demo.js /tmp/eln-demo-data
 *
 * 做法：起一个临时服务端（ELN_DATA_DIR 指到目标目录、端口随机），用它的 REST 接口
 * 建几条记录——这样归一化 / 编号 / 试剂库 / 变更历史全都走后端同一套代码，数据形状不会跑偏。
 * 结束前把服务端关掉，目标目录里就留下一个可以拷去部署的 data/。
 *
 * 注意：脚本里**不要**写任何私人信息（人名、真实课题、真实记录编号）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.argv[2] || path.join(ROOT, '.demo-data'));
const PORT = 4900 + Math.floor(Math.random() * 80);
const BASE = `http://127.0.0.1:${PORT}`;

const log = (...a) => console.log('  ' + a.join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${String(text).slice(0, 200)}`);
  return data;
}

/* ---------------- 演示用的合成化合物（教科书级的简单分子） ---------------- */
const COMPOUNDS = [
  { name: '苯甲醛', code: 'D-01', kind: '底物', smiles: 'O=Cc1ccccc1', mw: 106.12, formula: 'C7H6O' },
  { name: '4-甲氧基苯甲醛', code: 'D-02', kind: '底物', smiles: 'COc1ccc(C=O)cc1', mw: 136.15, formula: 'C8H8O2' },
  { name: '苯甲酸', code: 'D-03', kind: '产物', smiles: 'OC(=O)c1ccccc1', mw: 122.12, formula: 'C7H6O2' },
  { name: '4-甲氧基苯甲酸', code: 'D-04', kind: '产物', smiles: 'COc1ccc(C(=O)O)cc1', mw: 152.15, formula: 'C8H8O3' },
  { name: '联苯', code: 'D-05', kind: '标准品', smiles: 'c1ccc(-c2ccccc2)cc1', mw: 154.21, formula: 'C12H10' },
];

/* ---------------- 一批「条件筛选」演示记录 ---------------- */
const BASES = [
  { name: 'Na2CO3', mw: 105.99, eq: 1.5, yield: 62 },
  { name: 'K2CO3', mw: 138.21, eq: 1.5, yield: 74 },
  { name: 'Cs2CO3', mw: 325.82, eq: 1.5, yield: 88 },
];

function reagent({ name, role, eq, mw, mmol, compoundId = null, density = null, conc = null }) {
  const base = { name, role, eq, mw, mmol, compound_id: compoundId };
  if (conc) return { ...base, conc, volume_ul: Math.round((mmol / conc) * 1000 * 1000) / 1000 };
  if (density) return { ...base, density, mass_mg: mmol * mw };
  return { ...base, mass_mg: Math.round(mmol * mw * 1e4) / 1e4 };
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  log('临时服务端启动中…', `data=${DATA_DIR}`, `port=${PORT}`);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, ELN_DATA_DIR: DATA_DIR, PORT: String(PORT), ELN_AUTO_VERIFY: '0' },
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (d) => (boot += String(d)));
  child.stderr.on('data', (d) => (boot += String(d)));

  const deadline = Date.now() + 15000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('服务端起不来：\n' + boot.slice(-800));
    }
    try {
      await api('GET', '/api/bootstrap');
      break;
    } catch {
      await sleep(200);
    }
  }

  try {
    // 记录本抬头：写死成演示文案，不带任何个人信息
    await api('PUT', '/api/settings', {
      lab_heading: '示例电子实验记录本',
      owner_name: 'demo',
      group_name: '演示课题组',
      code_prefix: 'DEMO',
    });

    const ids = {};
    for (const c of COMPOUNDS) {
      const r = await api('POST', '/api/compounds', c);
      ids[c.code] = (r.compound || r).id;
      log('化合物', c.code, c.name);
    }

    // 分类
    const cat = await api('POST', '/api/categories', { scope: 'exp', name: '示例：条件筛选', project: '' });
    const catId = (cat.category || cat).id;

    // 基准实验（试反应）
    const base = await api('POST', '/api/experiments', {
      title: '苯甲醛 → 苯甲酸的碱筛选',
      objective: '示例记录：换碱看收率（演示平行组与筛选表）',
      project: '',
      kind: '条件筛选',
      rxn_type: '改当量',
      category_id: catId,
      base_mmol: 0.2,
      solvent: '二甲基亚砜',
      temperature: '80 ℃',
      duration: '6 h',
      atmosphere: '空气',
      status: '已完成',
      yield_pct: BASES[0].yield,
      product_name: '苯甲酸',
      product_compound_id: ids['D-03'],
      reagents: [
        reagent({ name: '苯甲醛', role: '底物', eq: 1, mw: 106.12, mmol: 0.2, compoundId: ids['D-01'] }),
        reagent({ name: BASES[0].name, role: '碱', eq: BASES[0].eq, mw: BASES[0].mw, mmol: 0.3 }),
        reagent({ name: '二甲基亚砜', role: '溶剂', eq: '', mw: 78.13, mmol: null, density: 1.1 }),
      ],
    });
    const baseId = (base.experiment || base).id;
    log('基准实验', baseId);

    // 平行组：换碱两条（走「新建平行实验」那条接口，这样才真的归到同一摞）
    for (const b of BASES.slice(1)) {
      const copy = await api('POST', `/api/experiments/${baseId}/parallel`, {});
      const id = (copy.experiment || copy).id;
      await api('PUT', `/api/experiments/${id}`, {
        status: '已完成',
        yield_pct: b.yield,
        reagents: [
          reagent({ name: '苯甲醛', role: '底物', eq: 1, mw: 106.12, mmol: 0.2, compoundId: ids['D-01'] }),
          reagent({ name: b.name, role: '碱', eq: b.eq, mw: b.mw, mmol: 0.3 }),
          reagent({ name: '二甲基亚砜', role: '溶剂', eq: '', mw: 78.13, mmol: null, density: 1.1 }),
        ],
      });
      log('平行记录', id, b.name, `${b.yield}%`);
    }

    // 底物扩展：换底物一条（不在平行组里）
    await api('POST', '/api/experiments', {
      title: '4-甲氧基苯甲醛 → 4-甲氧基苯甲酸',
      objective: '示例记录：换底物',
      project: '',
      kind: '底物扩展',
      rxn_type: '底物扩展',
      category_id: catId,
      base_mmol: 0.2,
      solvent: '二甲基亚砜',
      temperature: '80 ℃',
      duration: '6 h',
      atmosphere: '空气',
      status: '进行中',
      product_name: '4-甲氧基苯甲酸',
      product_compound_id: ids['D-04'],
      reagents: [
        reagent({ name: '4-甲氧基苯甲醛', role: '底物', eq: 1, mw: 136.15, mmol: 0.2, compoundId: ids['D-02'] }),
        reagent({ name: 'Cs2CO3', role: '碱', eq: 1.5, mw: 325.82, mmol: 0.3 }),
        reagent({ name: '二甲基亚砜', role: '溶剂', eq: '', mw: 78.13, mmol: null, density: 1.1 }),
      ],
    });
    log('底物扩展记录');

    const boot2 = await api('GET', '/api/bootstrap');
    log('完成：实验', boot2.totals?.experiments ?? '?', '个 · 化合物', boot2.totals?.compounds ?? '?', '个');
    console.log(`\n演示数据目录：${DATA_DIR}`);
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    child.kill('SIGKILL');
  }
}

main().catch((e) => {
  console.error('造演示数据失败：', e.message);
  process.exit(1);
});
