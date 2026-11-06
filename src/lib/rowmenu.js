import { api } from '../api.js';
import { loadBoot, loadCompounds, loadList, store } from '../store.js';
import { confirm, toast } from './feedback.js';
import { CTX_SEP, openCtxMenu } from './ctxmenu.js';
import { printCompoundLabel } from './label.js';

/**
 * 列表卡片 / 卡片墙上的右键菜单：不先进记录页也能干活——
 * 新建平行、复制、锁定、删。危险项（回收站）排在最后、用红字。
 * 卡片堆（平行组）另有一套：整组一起处理 + 「单独处理」子菜单（每个子实验一个小菜单）。
 */

/** 复制短文本（编号之类），粘到搜索框里找东西用 */
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    toast(`${label} 已复制`);
  } catch {
    toast('剪贴板没写进去，手动选中复制吧', 'err');
  }
}

/**
 * 正开着这条记录时先离开再删：编辑器卸载时会补一次保存，
 * 得等它发完，不然那个 PUT 会打在已删的记录上报错。
 */
async function leaveIfOpen(router, routeName, id) {
  const cur = router.currentRoute.value;
  if (cur.name !== routeName || Number(cur.params.id) !== Number(id)) return false;
  await router.push(routeName === 'editor' ? '/list' : '/compounds');
  await new Promise((r) => setTimeout(r, 320));
  return true;
}

async function removeExperiment(it, router) {
  const ok = await confirm({
    title: `将 ${it.code} 移入回收站？`,
    body: '记录移到回收站后可以恢复；彻底删除时才动磁盘上的附件。',
    confirmText: '移入回收站',
    danger: true,
  });
  if (!ok) return;
  try {
    await leaveIfOpen(router, 'editor', it.id);
    await api.deleteExperiment(it.id);
    await Promise.all([loadBoot(), loadList()]);
    toast(`已把 ${it.code} 移入回收站`);
  } catch (e) {
    toast(e.message || '删不掉这条记录', 'err');
  }
}

async function newParallel(it, router) {
  try {
    const e = await api.parallel(it.id);
    await Promise.all([loadBoot(), loadList()]);
    router.push(`/e/${e.id}`);
    toast('已按这条新建平行实验；结果留空，改掉要变的那个变量就行');
  } catch (e) {
    toast(e.message || '建不了平行实验', 'err');
  }
}

async function duplicateExperiment(it, router) {
  try {
    const e = await api.duplicate(it.id);
    await Promise.all([loadBoot(), loadList()]);
    router.push(`/e/${e.id}`);
    toast('已复制为新记录；产率与表征未带入');
  } catch (e) {
    toast(e.message || '复制不了这条记录', 'err');
  }
}

async function toggleLock(it) {
  try {
    const e = await api.lock(it.id, !it.locked);
    await loadList();
    toast(e.locked ? `${it.code} 已锁定，之后只能查看` : `${it.code} 已解锁，可以继续改`);
  } catch (e) {
    toast(e.message || '改不了锁定状态', 'err');
  }
}

/**
 * 实验卡片右键。opts.groupSize —— 这条属于一个平行组（>1 时删除项写成「只删这条」）。
 * 卡片堆的展开 / 收起只在卡片头上那个小按钮上做，不放进菜单（菜单里太多项反而重）。
 */
export function experimentMenu(ev, it, router, opts = {}) {
  const items = [];
  const size = Number(opts.groupSize || 0);
  items.push(
    { key: 'open', label: '打开记录', icon: 'file' },
    { key: 'parallel', label: '新建平行实验', icon: 'plus' },
    { key: 'duplicate', label: '复制这条实验', icon: 'copy' },
    { key: 'lock', label: it.locked ? '解锁（恢复可编辑）' : '锁定（此后只读）', icon: it.locked ? 'unlock' : 'lock' },
    { key: 'copycode', label: '复制编号', icon: 'hash', hint: it.code },
    CTX_SEP,
    { key: 'delete', label: size > 1 ? '只删这条' : '移入回收站', icon: 'trash', danger: true }
  );
  openCtxMenu(ev, items, (key) => {
    if (key === 'open') return void router.push(`/e/${it.id}`);
    if (key === 'parallel') return void newParallel(it, router);
    if (key === 'duplicate') return void duplicateExperiment(it, router);
    if (key === 'lock') return void toggleLock(it);
    if (key === 'copycode') return void copyText(it.code, '编号');
    if (key === 'delete') return void removeExperiment(it, router);
  });
}

async function removeCompound(c, router) {
  const ok = await confirm({
    title: `将 ${c.code || c.name || '这个化合物'} 移入回收站？`,
    body: '档案移到回收站后可以恢复；彻底删除时才动磁盘上的文件。',
    confirmText: '移入回收站',
    danger: true,
  });
  if (!ok) return;
  try {
    await leaveIfOpen(router, 'compound', c.id);
    await api.deleteCompound(c.id);
    await Promise.all([loadBoot(), loadCompounds()]);
    toast(`已把 ${c.code || c.name || '这个化合物'} 移入回收站`);
  } catch (e) {
    toast(e.message || '删不掉这个化合物', 'err');
  }
}

/** 化合物卡片右键：列表行里就带结构 id，瓶签直接能打 */
export function compoundMenu(ev, c, router) {
  const items = [
    { key: 'open', label: '打开档案', icon: 'file' },
    { key: 'label', label: '打印瓶签', icon: 'print' },
    { key: 'copycode', label: '复制编号', icon: 'hash', hint: c.code || '—' },
    CTX_SEP,
    { key: 'delete', label: '移入回收站', icon: 'trash', danger: true },
  ];
  openCtxMenu(ev, items, (key) => {
    if (key === 'open') return void router.push(`/c/${c.id}`);
    if (key === 'label') return void printCompoundLabel(c, { owner: store.boot?.settings?.owner_name });
    if (key === 'copycode') return void copyText(c.code, '编号');
    if (key === 'delete') return void removeCompound(c, router);
  });
}

/* ───────── 卡片堆（平行组）：整组一起处理 / 单独处理 ───────── */

/** 整组锁定 / 解锁：锁着的那几条不再改；要删的话得先解锁（服务端 423） */
async function toggleGroupLock(row, router) {
  const allLocked = row.members.every((m) => m.locked);
  try {
    await Promise.all(row.members.map((m) => api.lock(m.id, !allLocked)));
    await loadList();
    toast(allLocked ? `这一组 ${row.members.length} 条都解锁了` : `这一组 ${row.members.length} 条都锁了，之后只能查看`);
    // 正在看的那条也在这组里：它页面上的 autosave 还不知道自己被锁了，提醒一句
    const cur = Number(router.currentRoute.value.params.id);
    if (router.currentRoute.value.name === 'editor' && row.members.some((m) => m.id === cur)) {
      toast('这条正在页面里开着，重开页面才会变只读', 'info', 3200);
    }
  } catch (e) {
    toast(e.message || '改不了锁定状态', 'err');
  }
}

/** 整组移入回收站：锁着的先解锁（不然 DELETE 会被 423 拦掉） */
async function removeGroup(row, router) {
  const locked = row.members.filter((m) => m.locked);
  const ok = await confirm({
    title: `这一组 ${row.members.length} 条都移入回收站？`,
    body: `${locked.length ? `其中 ${locked.length} 条是锁定的，会先解锁再删。` : ''}移入回收站后可以逐条恢复；彻底删除时才动磁盘上的附件。`,
    confirmText: `移入回收站（${row.members.length} 条）`,
    danger: true,
  });
  if (!ok) return;
  try {
    for (const m of row.members) await leaveIfOpen(router, 'editor', m.id);
    for (const m of locked) await api.lock(m.id, false);
    for (const m of row.members) await api.deleteExperiment(m.id);
    await Promise.all([loadBoot(), loadList()]);
    toast(`这一组 ${row.members.length} 条已移入回收站`);
  } catch (e) {
    toast(e.message || '删不掉这一组', 'err');
  }
}

/**
 * 卡片堆上右键：只留四行——「整组」一行 + 每条子实验一行，各自展开子菜单。
 * 不再用分隔线/小节标题把菜单拉长（用户嫌「隔开也不顺手」），删除项在每一层的最后。
 * opts.activeId = 正在看的那条，标一下。
 */
export function groupMenu(ev, row, router, opts = {}) {
  const n = row.members.length;
  const allLocked = row.members.every((m) => m.locked);
  const items = [
    {
      key: 'g',
      label: '整组',
      icon: 'grid',
      hint: `${n} 条${allLocked ? ' · 锁定' : ''}`,
      sub: [
        { key: 'parallel', label: '新建平行实验', icon: 'plus' },
        { key: 'lockgroup', label: allLocked ? '解锁整组' : '锁定整组', icon: allLocked ? 'unlock' : 'lock', hint: `${n} 条` },
        { key: 'copycodes', label: '复制整组编号', icon: 'hash' },
        CTX_SEP,
        { key: 'delgroup', label: '移入回收站（整组）', icon: 'trash', danger: true },
      ],
    },
    ...row.members.map((m) => ({
      key: `m:${m.id}`,
      label: m.code,
      icon: 'file',
      hint: m.id === opts.activeId ? '在看' : m.locked ? '锁定' : '',
      sub: [
        { key: `open:${m.id}`, label: '打开记录', icon: 'file' },
        { key: `lock:${m.id}`, label: m.locked ? '解锁（恢复可编辑）' : '锁定（此后只读）', icon: m.locked ? 'unlock' : 'lock' },
        { key: `copy:${m.id}`, label: '复制编号', icon: 'hash', hint: m.code },
        CTX_SEP,
        { key: `del:${m.id}`, label: '移入回收站（只这条）', icon: 'trash', danger: true },
      ],
    })),
  ];
  openCtxMenu(ev, items, (key) => {
    if (key === 'parallel') return void newParallel(row.face, router);
    if (key === 'lockgroup') return void toggleGroupLock(row, router);
    if (key === 'copycodes') return void copyText(row.members.map((m) => m.code).join(' '), '整组编号');
    if (key === 'delgroup') return void removeGroup(row, router);
    const [act, id] = String(key).split(':');
    const m = row.members.find((x) => x.id === Number(id));
    if (!m) return;
    if (act === 'open') return void router.push(`/e/${m.id}`);
    if (act === 'lock') return void toggleLock(m);
    if (act === 'copy') return void copyText(m.code, '编号');
    if (act === 'del') return void removeExperiment(m, router);
  });
}
