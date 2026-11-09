import { openCtxMenu, CTX_SEP } from './ctxmenu.js';
import { router } from '../router.js';
import { createExperiment, createCompound, addCategory, loadList, loadCompounds } from '../store.js';
import { prompt, toast } from './feedback.js';

/**
 * 空白处（页面底色、纸面、表格缝里）右键：接管系统菜单，给一份「到处都能用」的菜单。
 * 卡片、组头、列表行自己有菜单（它们会先 preventDefault + stopPropagation），轮不到这里。
 * 输入框里、以及选了一段文字时**不接管**——那里要复制粘贴，交给系统。
 */
export function openPageMenu(ev) {
  const onCompounds = router.currentRoute.value.path.startsWith('/c');
  openCtxMenu(
    ev,
    [
      { key: 'new-exp', label: '新建实验', icon: 'plus' },
      { key: 'new-cmp', label: '新建化合物', icon: 'plus' },
      { key: 'new-cat', label: onCompounds ? '新建化合物分类' : '新建实验分类', icon: 'folder' },
      CTX_SEP,
      { key: 'reload', label: '刷新当前列表', icon: 'down' },
      CTX_SEP,
      { key: 'home', label: '工作台', icon: 'flask' },
      { key: 'list', label: '实验记录', icon: 'file' },
      { key: 'compounds', label: '化合物库', icon: 'molecule' },
      { key: 'settings', label: '设置', icon: 'settings' },
    ],
    async (key) => {
      try {
        if (key === 'new-exp') {
          const exp = await createExperiment();
          router.push(`/e/${exp.id}`);
          return;
        }
        if (key === 'new-cmp') {
          const c = await createCompound();
          router.push(`/c/${c.id}`);
          return;
        }
        if (key === 'new-cat') {
          const scope = onCompounds ? 'compound' : 'experiment';
          const name = await prompt({
            title: '新建分类',
            placeholder: scope === 'compound' ? '比如：手性配体库' : '比如：方法学 A',
            confirmText: '建',
          });
          if (!name) return;
          await addCategory(name, scope);
          await (scope === 'compound' ? loadCompounds() : loadList());
          toast(`建好了「${name}」`);
          return;
        }
        if (key === 'reload') {
          await (onCompounds ? loadCompounds() : loadList());
          return;
        }
        const paths = { home: '/', list: '/list', compounds: '/compounds', settings: '/settings' };
        if (paths[key]) router.push(paths[key]);
      } catch (e) {
        toast(e.message || '没做成', 'err');
      }
    }
  );
}

/** 这个右键要不要让给系统：输入框里要复制粘贴；选中了字也要复制 */
export function keepNativeMenu(ev) {
  const t = ev.target;
  const tag = (t?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return true;
  const sel = String(window.getSelection?.()?.toString() || '');
  return sel.length > 0;
}
