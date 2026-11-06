<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import { toast } from '../lib/feedback.js';
import { structureInfo, chemicalBookUrl, describeInfo, describeProps } from '../lib/lookup.js';

/**
 * 画结构式：弹窗里嵌 Ketcher（`/vendor/ketcher/index.html`，由 vendor-build/ketcher 打包而来，
 * 见 scripts/build-ketcher.sh）。
 * 画完点「用这个结构」→ 把 SMILES 交回调用方，后面走现有的 openchemlib 流程
 * （算分子式 / MW、画结构式），跟从 ChemDraw 粘贴完全同一条路。
 *
 * 为什么是 iframe：Ketcher 是 React 应用（还要 Indigo 的 WASM），跟这个 Vue 项目是两套技术栈，
 * 编成独立静态页塞进 iframe 最省事，也天然隔离（不吃主项目的依赖和打包体积）。
 *
 * 为什么组件要常挂、只切 `open`：那个包 29 MB，关弹窗就销毁 iframe 的话每次开都要重新
 * 下载 + 解析一遍，慢到用户以为卡死（他反馈过「画板加载有点慢」）。现在关掉只是隐藏
 * （el-dialog 默认不销毁内容），第二次开是瞬开。所以调用方要用 `:open="..."`，
 * 别再写成 `v-if`。
 */
const props = defineProps({
  /** 打开 / 收起（不是销毁） */
  open: { type: Boolean, default: false },
  /** 打开时预填的结构（SMILES 或 MOL），可选；不给就清空画板 */
  initial: { type: String, default: '' },
});
const emit = defineEmits(['close', 'pick']);

const frame = ref(null);
const loading = ref(true);
const info = ref(null);      // 画板上这个结构在 PubChem 里查到的东西
const looking = ref(false);
let pollTimer = 0;

const api = () => frame.value?.contentWindow?.sketcherApi || null;

/** 画板一好就把这次要画的内容载进去（没有就清空），并切回单键工具 */
async function syncBoard() {
  const a = api();
  if (!a || !a.ready()) return false;
  loading.value = false;
  try {
    if (props.initial) await a.set(props.initial);
    else await a.clear();
  } catch {
    /* 打不开就当空白 */
  }
  a.bond?.();
  return true;
}

/** 首次打开要等 Ketcher 启动（29 MB 的包，几秒），轮询到 ready 就停 */
function waitReady() {
  if (pollTimer) return;
  pollTimer = window.setInterval(async () => {
    if (!(await syncBoard())) return;
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }, 200);
}

watch(
  () => props.open,
  (v) => {
    if (!v) return;
    // 已经好了就立刻换内容（第二次开是瞬开的），否则等轮询
    syncBoard().then((ok) => {
      if (!ok) waitReady();
    });
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});

async function pick() {
  const a = api();
  if (!a || !a.ready()) return toast('画板还在加载', 'warn');
  // 先让 Indigo 排一遍版：拖出来的环常常是扁的、原子挤在一起，取之前摆正了再取
  await a.layout?.();
  // Ketcher 的接口是异步的（导出要过一遍 Indigo），等它算完再取
  const smiles = String((await a.getSmiles()) || '').trim();
  if (!smiles) return toast('画板上还是空的', 'warn');
  emit('pick', { smiles, info: info.value });
  emit('close');
}

/** 画板上的结构 → PubChem：回来一个名字 / CAS / 分子式，下面还能跳 ChemicalBook */
async function lookup() {
  const a = api();
  if (!a || !a.ready()) return toast('画板还在加载', 'warn');
  const smiles = String((await a.getSmiles()) || '').trim();
  if (!smiles) return toast('画板上还是空的', 'warn');
  looking.value = true;
  try {
    info.value = await structureInfo(smiles);
    if (!info.value || !info.value.found) toast('PubChem 里没查到这个结构', 'warn');
  } finally {
    looking.value = false;
  }
}

function clearAll() {
  info.value = null;
  api()?.clear();
}
</script>

<template>
  <AppModal
    :model-value="open"
    title="画结构式"
    :show-confirm="false"
    cancel-text="关闭"
    width="min(1080px, 94vw)"
    @close="emit('close')"
  >
    <div class="sk">
      <iframe ref="frame" class="sk-frame" src="/vendor/ketcher/index.html" title="结构画板" />
      <div v-if="loading" class="sk-loading">画板加载中…</div>
    </div>

    <div v-if="info" class="sk-info noprint">
      <template v-if="info.found">
        <span class="sk-info-name">{{ info.name || '（PubChem 没有正式名）' }}</span>
        <span v-if="info.cas && info.cas.length" class="sk-info-cas mono">CAS {{ info.cas[0] }}</span>
        <span class="sk-info-sub">{{ describeInfo({ ...info, name: '', cas: [] }).replace(/^ · /, '') }}</span>
        <span v-if="describeProps(info)" class="sk-info-sub sk-info-props">{{ describeProps(info) }}</span>
        <span class="spacer" style="flex: 1" />
        <a :href="info.url" target="_blank" rel="noreferrer">PubChem</a>
        <a v-if="chemicalBookUrl(info)" :href="chemicalBookUrl(info)" target="_blank" rel="noreferrer">ChemicalBook</a>
      </template>
      <span v-else class="sk-info-sub">PubChem 里没查到（结构画得对不对？或者没联网）</span>
    </div>

    <div class="sk-foot">
      <span class="hint">原子之间拖一下就连键；停在原子上打字 = 换原子；<b>⌘Z</b> 撤销。</span>
      <span class="spacer" style="flex: 1" />
      <button class="btn btn-sm btn-ghost" :disabled="looking" @click="lookup">
        {{ looking ? '查…' : '查一下是什么' }}
      </button>
      <button class="btn btn-sm btn-ghost" @click="clearAll">清空</button>
      <button class="btn btn-sm" @click="pick">用这个结构</button>
    </div>
  </AppModal>
</template>
