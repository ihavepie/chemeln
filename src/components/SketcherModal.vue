<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AppModal from './AppModal.vue';
import { toast } from '../lib/feedback.js';

/**
 * 画结构式：弹窗里嵌一块 JSME 画板（`/vendor/sketcher.html`，见 scripts/fetch-sketcher.sh）。
 * 画完点「用这个结构」→ 把 SMILES 交回调用方，后面走现有的 openchemlib 流程
 * （算分子式 / MW、画结构式），跟从 ChemDraw 粘贴完全同一条路。
 *
 * 为什么是 iframe：JSME 是个 GWT 编译的独立小应用，自己管 canvas 和资源文件，
 * 塞进 Vue 组件里反而要跟它的 DOM 抢地盘；iframe 里跑它最省事，也天然隔离。
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
      if (props.initial) a.set(props.initial);
    }
  }, 200);
});

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});

async function pick() {
  const a = api();
  if (!a) return toast('画板还在加载', 'warn');
  // JSME 解析结构是异步的，刚画完立刻读可能还是空的，给它一拍
  let smiles = a.smiles() || '';
  if (!smiles) {
    await new Promise((r) => setTimeout(r, 260));
    smiles = a.smiles() || '';
  }
  if (!smiles) return toast('画板上还是空的', 'warn');
  emit('pick', { smiles, mol: a.mol() || '' });
  emit('close');
}

function clearAll() {
  api()?.clear();
}
</script>

<template>
  <AppModal title="画结构式" :show-confirm="false" cancel-text="取消" width="min(1080px, 94vw)" @close="emit('close')">
    <div class="sk">
      <iframe ref="frame" class="sk-frame" src="/vendor/sketcher.html" title="结构画板" />
      <div v-if="loading" class="sk-loading">画板加载中…</div>
    </div>

    <div class="sk-foot">
      <span class="hint">画笔在左上角：单键 / 环 / 元素表在下方工具条里；画完点「用这个结构」。</span>
      <span class="spacer" style="flex: 1" />
      <button class="btn btn-sm btn-ghost" @click="clearAll">清空</button>
      <button class="btn btn-sm" @click="pick">用这个结构</button>
    </div>
  </AppModal>
</template>
