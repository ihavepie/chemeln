import { reactive } from 'vue';

/**
 * 全站共用一个右键菜单：谁想右键，就把「菜单项 + 回调」交给 openCtxMenu()，
 * App.vue 里那个 <ContextMenu /> 负责画出来（位置贴着鼠标，自己避让屏幕边缘）。
 * 只接管我们挂了的卡片，输入框 / 选中文字上的系统菜单不动——那里还要复制粘贴。
 */
export const ctxMenu = reactive({ open: false, x: 0, y: 0, items: [], pick: null });

/** 菜单项：{ key, label, icon, hint, danger }；分隔线用 CTX_SEP */
export const CTX_SEP = { sep: true };

export function openCtxMenu(ev, items, pick) {
  ev.preventDefault();
  ev.stopPropagation();
  ctxMenu.items = items.filter(Boolean);
  ctxMenu.pick = pick || null;
  ctxMenu.x = ev.clientX || 0;
  ctxMenu.y = ev.clientY || 0;
  ctxMenu.open = true;
}

export function closeCtxMenu() {
  ctxMenu.open = false;
}
