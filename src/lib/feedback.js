import { ElMessageBox, ElNotification } from 'element-plus';

/** 最近弹过的那几句：同一句在 1.6 秒内再来一次，就把上一条关掉只留一条
    （连点两下放大镜、或几行同名试剂同时查不到时，右下角会叠成一摞一样的卡片） */
const recentToasts = new Map();

/** 右下角的小 toast（轻提示，几秒后自己消失）。
    kind：'ok' 成功 / 'err' 出错 / 'warn' 提醒 / 'info' 中性（像「已切换到 EXP-0082」这种纯通知） */
export function toast(message, kind = 'ok', duration = 2600) {
  const now = Date.now();
  const prev = recentToasts.get(message);
  if (prev && now - prev.at < 1600) {
    try { prev.handle.close(); } catch { /* 已经自己消失了 */ }
  }
  const handle = ElNotification({
    message,
    type: kind === 'err' ? 'error' : kind === 'warn' ? 'warning' : kind === 'info' ? 'info' : 'success',
    duration,
    position: 'bottom-right',
    offset: 18,
    showClose: false,
    customClass: 'eln-toast',
  });
  recentToasts.set(message, { handle, at: now });
  if (recentToasts.size > 40) recentToasts.clear();
  return handle;
}

/** 确认框，返回 true / false（替代 v1 的 modal({danger:true}) 那条路） */
export async function confirm({ title, body = '', confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  try {
    await ElMessageBox.confirm(body, title, {
      confirmButtonText: confirmText,
      cancelButtonText: cancelText,
      showClose: false,
      closeOnClickModal: true,
      closeOnPressEscape: true,
      confirmButtonClass: danger ? 'eln-confirm-danger' : '',
      customClass: 'eln-messagebox',
    });
    return true;
  } catch {
    return false;
  }
}

/** 单行输入框，返回输入内容（取消返回 null）；allowEmpty 时空输入返回 ''，用来清空某格 */
export async function prompt({ title, placeholder = '', value = '', confirmText = '确定', allowEmpty = false } = {}) {
  try {
    const r = await ElMessageBox.prompt('', title, {
      confirmButtonText: confirmText,
      cancelButtonText: '取消',
      showClose: false,
      inputPlaceholder: placeholder,
      inputValue: value,
      customClass: 'eln-messagebox',
    });
    const v = String(r.value || '').trim();
    return v || (allowEmpty ? '' : null);
  } catch {
    return null;
  }
}
