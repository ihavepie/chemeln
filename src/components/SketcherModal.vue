<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import { toast } from '../lib/feedback.js';
import { structureInfo, chemicalBookUrl, describeInfo, describeProps } from '../lib/lookup.js';
import { spreadAbbrevBonds } from '../lib/abbrevspread.js';

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
  /** 打开时预填的结构（SMILES / MOL）或反应式（RXN），可选；不给就清空画板 */
  initial: { type: String, default: '' },
  /** molecule = 画单个结构式（化合物页）；reaction = 画整条反应式（实验页的「反应式」格子） */
  mode: { type: String, default: 'molecule' },
});
const emit = defineEmits(['close', 'pick']);

const isReaction = computed(() => props.mode === 'reaction');

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
  // 反应式：不自动排版（箭头和 + 的位置是人手摆的，排一遍反而会挪走），
  // 直接拿 RXN 让 Ketcher 自己的 Indigo 画成图，连同 RXN 一起交回去存着，下次能接着改
  if (props.mode === 'reaction') {
    const rxn = String((await a.getRxn()) || '').trim();
    if (!rxn) return toast('画板上还是空的', 'warn');
    const svg = await a.image(rxn);
    if (!svg || !svg.includes('<svg')) return toast('反应式导不出来，再试一次', 'err');
    // 顺手把反应式文本也带回去：RXN 保留版式（重新打开用），SMILES 用来认反应物 / 产物
    const smiles = String((await a.getSmiles()) || '').trim();
    emit('pick', { rxn, smiles, svg });
    emit('close');
    return;
  }
  // **不要在这里 layout**：以前取图前会先让 Indigo 重排一遍坐标，结果是「画板上一个样、
  // 存下来另一个样」（四元环被转成菱形、手摆的原子全被挪走）。用户要的是「画板画什么就出什么」，
  // 所以原样取；真想摆正画板上的结构，点底部的「摆正」按钮（`straighten()`）。
  // Ketcher 的接口是异步的（导出要过一遍 Indigo），等它算完再取
  const smiles = String((await a.getSmiles()) || '').trim();
  if (!smiles) return toast('画板上还是空的', 'warn');
  // **图直接用 Ketcher 自己渲的**（用户点名要画板里那张）：用户手画的缩写也在 MOL 里，
  // 所以优先拿 molfile 去过 Indigo，拿不到才退回 SMILES
  let mol = '';
  try {
    mol = String((await a.getMol?.()) || '');
  } catch {
    mol = '';
  }
  // 缩写基团（Ph / OMe / CO2Me…）的键会被 Indigo 截短到 0.72 倍（见 lib/abbrevspread.js），
  // 把附着原子往外挪 0.3 个键长正好补回来。挪的是 2D 坐标，化学一点没变；
  // 出图和存底稿都用挪过的这份，画板里再打开看到的间距跟存档图也一致。
  mol = spreadAbbrevBonds(mol);
  let svg = '';
  try {
    svg = await a.image(mol || smiles);
  } catch {
    svg = '';
  }
  emit('pick', { smiles, mol, svg: svg && svg.includes('<svg') ? svg : '', info: info.value });
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

/**
 * 手动「摆正」：让 Indigo 重新算一遍 2D 坐标（拖歪的环、挤在一起的原子会规整）。
 * **只能手点，不能自动跑** —— 以前在 `pick()` 里自动跑，结果就是「画板上一个样、
 * 存下来的图另一个样」（四元环被转成菱形），用户明确要「画板画什么就出什么」。
 */
async function straighten() {
  const a = api();
  if (!a || !a.ready()) return toast('画板还在加载', 'warn');
  const ok = await a.layout?.();
  if (!ok) toast('摆正失败，再试一次', 'err');
}
</script>

<template>
  <AppModal
    :model-value="open"
    :title="isReaction ? '画反应式' : '画结构式'"
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
      <span v-if="isReaction" class="hint">先画反应物，用工具栏的 <b>＋</b> 添料、点 <b>→</b> 画箭头，再把产物画在右边；条件想写在箭头上就用 <b>文字</b> 工具。<b>⌘V</b> 可以直接粘 ChemDraw 的反应式。不自动排版，摆成什么样就存什么样。</span>
      <span v-else class="hint">原子之间拖一下就连键；停在原子上打字 = 换原子；<b>⌘V</b> 粘 ChemDraw 的结构，<b>⌘Z</b> 撤销。画成什么样就存什么样，不会替你重排。</span>
      <span class="spacer" style="flex: 1" />
      <button v-if="!isReaction" class="btn btn-sm btn-ghost" @click="straighten">摆正</button>
      <button v-if="!isReaction" class="btn btn-sm btn-ghost" :disabled="looking" @click="lookup">
        {{ looking ? '查…' : '查一下是什么' }}
      </button>
      <button class="btn btn-sm btn-ghost" @click="clearAll">清空</button>
      <button class="btn btn-sm" @click="pick">{{ isReaction ? '用这个反应式' : '用这个结构' }}</button>
    </div>
  </AppModal>
</template>
