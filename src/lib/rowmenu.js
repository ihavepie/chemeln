import { api } from '../api.js';
import { loadBoot, loadCompounds, loadList, store } from '../store.js';
import { confirm, toast } from './feedback.js';
import { CTX_SEP, openCtxMenu } from './ctxmenu.js';
import { printCompoundLabel } from './label.js';

/**
 * 列表卡片 / 卡片墙上的右键菜单：不先进记录页也能干活——
 * 新建平行、复制、锁定、删。危险项（回收站）排在最后、用红字。
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
 * 实验卡片右键。opts：
 *   groupSize —— 这条属于一个平行组（>1 时删之前说清楚「只删这条」）
 *   toggleStack / stackOpen —— 卡片堆的面子卡上多一条「展开 / 收起组员」
 */
export function experimentMenu(ev, it, router, opts = {}) {
  const items = [];
  const size = Number(opts.groupSize || 0);
  if (opts.toggleStack) {
    items.push(
      {
        key: 'stack',
        label: opts.stackOpen ? '收起组员' : '展开组员',
        icon: opts.stackOpen ? 'chevron' : 'down',
        hint: `${size} 条`,
      },
      CTX_SEP
    );
  }
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
    if (key === 'stack') return opts.toggleStack?.();
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
