<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import { toast } from '../lib/feedback.js';

/**
 * 画结构式：弹窗里嵌 Ketcher（`/vendor/ketcher/index.html`，由 vendor-build/ketcher 打包而来，
 * 见 scripts/build-ketcher.sh）。
 * 画完点「用这个结构」→ 把 SMILES 交回调用方，后面走现有的 openchemlib 流程
 * （算分子式 / MW、画结构式），跟从 ChemDraw 粘贴完全同一条路。
 *
 * 为什么是 iframe：Ketcher 是 React 应用（还要 Indigo 的 WASM），跟这个 Vue 项目是两套技术栈，
 * 编成独立静态页塞进 iframe 最省事，也天然隔离（不吃主项目的依赖和打包体积）。
 */
const props = defineProps({
  /** 打开时预填的结构（SMILES 或 MOL），可选 */
  initial: { type: String, default: '' },
});
const emit = defineEmits(['close', 'pick']);

const frame = ref(null);
const loading = ref(true);
let pollTimer = 0;

const api = () => frame.value?.contentWindow?.sketcherApi || null;

onMounted(() => {
  // JSME 加载完才会挂上 sketcherApi，轮询等它
  pollTimer = window.setInterval(() => {
    const a = api();
    if (a && a.ready()) {
      window.clearInterval(pollTimer);
      pollTimer = 0;
      loading.value = false;
      if (props.initial) Promise.resolve(a.set(props.initial)).catch(() => {});
    }
  }, 200);
});

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});

async function pick() {
  const a = api();
  if (!a) return toast('画板还在加载', 'warn');
  // Ketcher 的接口是异步的（导出要过一遍 Indigo），等它算完再取
  const smiles = String((await a.getSmiles()) || (a.smiles ? a.smiles() : '') || '').trim();
  if (!smiles) return toast('画板上还是空的', 'warn');
  let mol = '';
  try {
    mol = (await a.getMol()) || '';
  } catch {
    /* MOL 拿不到也无所谓，SMILES 够用了 */
  }
  emit('pick', { smiles, mol });
  emit('close');
}

function clearAll() {
  api()?.clear();
}
</script>

<template>
  <AppModal title="画结构式" :show-confirm="false" cancel-text="取消" width="min(1080px, 94vw)" @close="emit('close')">
    <div class="sk">
      <iframe ref="frame" class="sk-frame" src="/vendor/ketcher/index.html" title="结构画板" />
      <div v-if="loading" class="sk-loading">画板加载中…</div>
    </div>

    <div class="sk-foot">
      <span class="hint">左边竖条是键 / 环 / 电荷，右边是元素表；画完点「用这个结构」。</span>
      <span class="spacer" style="flex: 1" />
      <button class="btn btn-sm btn-ghost" @click="clearAll">清空</button>
      <button class="btn btn-sm" @click="pick">用这个结构</button>
    </div>
  </AppModal>
</template>
