import { onBeforeUnmount, ref, watch } from 'vue';
import { savedLabel } from './ui.js';

/**
 * 自动保存：拿 payload() 的 JSON 快照当依赖
 * —— 只要 payload 里读到的任何一个响应式字段变了，watch 就会重跑，
 *    不用再在每个输入框上挂 @input="notify"。
 *
 *   const { state, dirty, markLoaded, touch, flush } = useAutosave(payload, save, { delay: 900 })
 *
 * - markLoaded(): 数据刚从服务端拿回来时调用，把这版快照当「已保存」
 * - touch():      手动标记一下（比如改了 payload 读不到的东西）
 * - flush():      立刻存（离开页面前、锁定前）
 */
export function useAutosave(payload, save, { delay = 850, enabled = () => true, onError, keep = 20 } = {}) {
  const state = ref(savedLabel());
  const dirty = ref(false);
  let timer = null;
  let lastSaved = '';
  // 每次保存前那一版快照：撤销「上一次保存」时按这个还原（只在内存里，刷新就没了）
  const history = [];

  const snap = () => {
    try {
      return JSON.stringify(payload());
    } catch {
      return '';
    }
  };

  function markLoaded() {
    lastSaved = snap();
    dirty.value = false;
    state.value = savedLabel();
  }

  function touch() {
    if (!enabled()) return;
    dirty.value = true;
    state.value = '未保存…';
    clearTimeout(timer);
    timer = setTimeout(() => void flush().catch(() => {}), delay);
  }

  async function flush() {
    clearTimeout(timer);
    if (!enabled()) return;
    state.value = '保存中…';
    // 「已保存」要对的是发出去那一刻的内容：请求在途时又改了，就不能算存完了
    const sent = snap();
    const before = lastSaved;   // 这次保存之前是什么样
    try {
      await save();
      if (before && before !== sent && history[history.length - 1] !== before) {
        history.push(before);
        if (history.length > keep) history.shift();
      }
      lastSaved = sent;
      dirty.value = snap() !== sent;
      state.value = dirty.value ? '未保存…' : savedLabel();
    } catch (e) {
      state.value = '保存失败';
      if (onError) onError(e);
      throw e;
    }
  }

  watch(snap, (now) => {
    if (now !== lastSaved) touch();
  });

  // 卸载前把还没落盘的改动补存一次：敲完最后一个字就点走（防抖还没到）不能静默丢
  onBeforeUnmount(() => {
    clearTimeout(timer);
    if (dirty.value) void flush().catch(() => {});
  });

  /** 撤销上一次保存：把删掉的那版快照取出来（调用方负责写回表单，watch 会接着存）。
   *  返回 null 表示没有可撤销的。 */
  function undoLast() {
    const prev = history.pop();
    if (!prev) return null;
    try {
      return JSON.parse(prev);
    } catch {
      return null;
    }
  }

  const canUndo = () => history.length > 0;

  return { state, dirty, markLoaded, touch, flush, undoLast, canUndo };
}
