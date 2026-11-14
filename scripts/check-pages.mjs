/**
 * 「打印恒 2 页」的自动检查（**macOS + 服务在跑** 才用得上，所以不在 CI 里）。
 *
 * 为什么要它：每条记录 = 两张 A4，打印时每张 `.sheet` 必须塞进一页；
 * `.pdf-page` 是 `overflow: hidden`，**内容超了不会报错，只会被裁掉**（用户吃过亏）。
 * 而且第 1 页一直很满（反应式 + 投料表 + 条件 + 结果 + TLC），
 * 后来加一行就可能挤爆——这件事以前只能靠人盯着截图看。
 *
 * 做法：用系统 WebKit（`server/jsrun.swift`，跟 Safari 同一引擎）打开记录页，
 * 量每张 `.sheet` 的实际高度，跟**基线**比：
 *   - 基线存 `test/print-baseline.json`（第一次跑用 `--update` 写下来，是「人眼确认过没问题」的那一版）；
 *   - 之后每次跑，纸页高度**长超过 8px**、或者本该在的块（结果表 / 页签）不见，就报错退出 1。
 * 顺带把「computed 里抛错 → 整块静默消失」也纳入检查：`.res-table` 在不在。
 *
 * 用法：
 *   npm run check:pages              # 检查最新一条记录
 *   node scripts/check-pages.mjs --id 206
 *   node scripts/check-pages.mjs --update   # 人眼确认过之后，重写基线
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const BASE_FILE = path.join(ROOT, 'test', 'print-baseline.json');
const PORT = Number(process.env.PORT || 4780);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** 允许的高度浮动（字体渲染 / 图片亚像素差异） */
const SLACK = 8;

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const update = argv.includes('--update');

/** 1. 服务在不在（这个检查必须有真数据 + 真前端） */
async function ensureServer() {
  try {
    const r = await fetch(`${ORIGIN}/api/bootstrap`);
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    console.error(`✗ 连不上 ${ORIGIN}（先 npm run serve 或双击 start.command）: ${e.message}`);
    process.exit(2);
  }
}

/** 2. 把 jsrun 编出来（跟 server/index.js 的 swift 工具一个套路：编到 .cache/） */
function ensureJsRun() {
  const bin = path.join(CACHE, 'jsrun');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(CACHE, { recursive: true });
  try {
    execFileSync(
      'swiftc',
      ['-O', '-module-cache-path', path.join(CACHE, 'clang'), path.join(ROOT, 'server', 'jsrun.swift'), '-o', bin],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch (e) {
    console.error(`✗ 编不出 jsrun（这台机器有 swiftc 吗？）: ${String(e.stderr || e.message).slice(0, 200)}`);
    process.exit(2);
  }
  return bin;
}

/** 3. 挑一条记录：给了 --id 就用它，否则库里最新的一条 */
function pickExperiment() {
  const idArg = argOf('--id');
  if (idArg) return Number(idArg);
  // 用内置 sqlite 读（不需要任何依赖）
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'eln.db'), { readOnly: true });
  const row = db.prepare('SELECT id FROM experiments ORDER BY id DESC LIMIT 1').get();
  db.close();
  if (!row) {
    console.error('✗ 库里一条记录都没有，没法量');
    process.exit(2);
  }
  return Number(row.id);
}

/**
 * 4. 在页面里量：**当前这一页**那张纸的实际高度 + 几个「必须在」的块。
 * 纸页靠 `?p=2` 切（`EditorView` 挂载时读 `route.query.p`），所以一页一次 jsrun，
 * 比在 JS 里点页签再等 DOM 稳定可靠。
 */
const PROBE = `
(() => {
  const vis = [...document.querySelectorAll('.sheet')]
    .map((s) => Math.round(s.getBoundingClientRect().height))
    .filter((h) => h > 0);
  const tabs = document.querySelectorAll('.ptab').length;
  const resTables = document.querySelectorAll('.res-table').length;
  const reagentRows = document.querySelectorAll('.rtable tbody tr').length;
  const hasScheme = !!document.querySelector('.scheme-slot, .scheme-live svg');
  return JSON.stringify({ sheet: Math.max(0, ...vis), tabs, resTables, reagentRows, hasScheme, url: location.hash });
})()
`;

function measure(jsrun, id, page = 1, waitSec = 3.2) {
  const probeFile = path.join(CACHE, 'check-pages-probe.js');
  fs.writeFileSync(probeFile, PROBE);
  const url = `${ORIGIN}/#/e/${id}${page === 2 ? '?p=2' : ''}`;
  const out = execFileSync(jsrun, [url, probeFile, String(waitSec), '1440', '900'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    return JSON.parse(out.split('\n').pop());
  } catch {
    console.error(`✗ jsrun 没返回 JSON：${out.slice(0, 200)}`);
    process.exit(2);
  }
}

async function main() {
  await ensureServer();
  const jsrun = ensureJsRun();
  const id = pickExperiment();
  const pages = [measure(jsrun, id, 1), measure(jsrun, id, 2)];
  const base = fs.existsSync(BASE_FILE) ? JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')) : {};

  console.log(`记录 #${id}`);
  for (const [i, m] of pages.entries()) {
    console.log(
      `  第 ${i + 1} 页 ${String(m.sheet).padStart(4)}px · 页签 ${m.tabs} 个 · 结果表 ${m.resTables} 张 · 投料表 ${m.reagentRows} 行 · 反应式 ${m.hasScheme ? '有' : '无'}`
    );
  }

  if (update) {
    base[id] = {
      sheets: pages.map((m) => m.sheet),
      tabs: pages.map((m) => m.tabs),
      resTables: pages.map((m) => m.resTables),
      at: new Date().toISOString().slice(0, 10),
    };
    fs.writeFileSync(BASE_FILE, JSON.stringify(base, null, 2) + '\n');
    console.log(`✓ 基线已更新（${path.relative(ROOT, BASE_FILE)}）`);
    return 0;
  }

  const want = base[id];
  if (!want) {
    console.log(`\n… 还没有 #${id} 的基线。人眼确认这一页没问题后跑：node scripts/check-pages.mjs --id ${id} --update`);
    return 0;
  }

  const problems = [];
  // 纸页不许长：超了就会被 A4 裁掉（`.pdf-page` 是 overflow:hidden）
  for (let i = 0; i < pages.length; i++) {
    const a = want.sheets?.[i] ?? 0;
    const b = pages[i].sheet;
    if (a && !b) problems.push(`第 ${i + 1} 页不见了`);
    else if (a && b - a > SLACK) problems.push(`第 ${i + 1} 页长高了 ${b - a}px（${a} → ${b}），可能挤出一页`);
    // computed 抛错会让整块静默消失：结果表 / 页签 少了就是它
    const rt = want.resTables?.[i] ?? 0;
    if (rt && pages[i].resTables < rt) {
      problems.push(`第 ${i + 1} 页结果表从 ${rt} 张变成 ${pages[i].resTables} 张（computed 抛错会让整块静默消失）`);
    }
    const tb = want.tabs?.[i] ?? 0;
    if (tb && pages[i].tabs < tb) problems.push(`第 ${i + 1} 页页签从 ${tb} 个变成 ${pages[i].tabs} 个`);
  }

  if (problems.length) {
    console.error('\n✗ 有回归：');
    for (const p of problems) console.error(`  · ${p}`);
    console.error('\n确认是新版本本来就这样（而不是加东西挤爆了）之后，再 --update 基线。');
    return 1;
  }
  console.log(`\n✓ 跟基线一致（基线日期 ${want.at || '?'}）`);
  return 0;
}

process.exit(await main());
