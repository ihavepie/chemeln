<script setup>
import { ref } from 'vue';
import AppModal from './AppModal.vue';
import { api } from '../api.js';
import { toast } from '../lib/feedback.js';
import { guessRf, guessSolvent, summarize } from '../lib/ocr.js';

/**
 * 从 TLC 板照片上读手写字（展开剂配比 / Rf）。
 * 用系统自带的 Vision（服务端 `server/ocr.swift` 编成的小程序），**不联网**。
 * 手写识别不保证准，所以：只有一个候选就直接填（父组件决定要不要覆盖空着的格子），
 * 多行 / 认不准就把识别结果摊开让人点。
 */
const props = defineProps({
  /** 图片列表：`{ id }`（化合物文件 id） */
  shots: { type: Array, default: () => [] },
  /** 'compound' | 'attachment'：告诉后端到哪张表里找文件 */
  scope: { type: String, default: 'compound' },
});
const emit = defineEmits(['pick']);

const busy = ref(false);
const lines = ref(null);

async function read() {
  const shot = props.shots[0];
  if (!shot) return toast('先放一张 TLC 照片', 'warn');
  busy.value = true;
  try {
    const res = await api.ocrPhoto({ scope: props.scope, file_id: shot.id });
    const got = (res.lines || []).filter((l) => String(l.text || '').trim());
    // Vision 的 y 是左下原点：从大到小就是「从上往下」
    got.sort((a, b) => (b.y || 0) - (a.y || 0));
    lines.value = got;
    const { sols, rfs } = summarize(got);
    // 每种只有一个候选 → 直接交回调用方（它只往空着的格子填）
    if (sols.length === 1 || rfs.length === 1) {
      emit('pick', { solvent: sols[0] || '', rf: rfs[0] || '', auto: true });
    }
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    busy.value = false;
  }
}

/** 点识别结果里的一行 */
function useLine(l) {
  const solvent = guessSolvent(l.text);
  const rf = guessRf(l.text);
  emit('pick', { solvent, rf, auto: false, raw: l.text });
  lines.value = null;
}
</script>

<template>
  <button
    v-if="shots.length"
    type="button"
    class="mini-copy noprint"
    title="读 TLC 照片上的手写字（展开剂 / Rf），本机识别"
    :disabled="busy"
    @click.stop="read"
  >{{ busy ? '读…' : '读图' }}</button>

  <AppModal
    v-if="lines"
    title="图里读到这些字"
    :show-confirm="false"
    cancel-text="关闭"
    width="520px"
    @close="lines = null"
  >
    <div class="ocr-list">
      <button
        v-for="(l, i) in lines"
        :key="i"
        type="button"
        class="ocr-row"
        :class="{ 'is-pick': guessSolvent(l.text) || guessRf(l.text) }"
        @click="useLine(l)"
      >
        <span class="mono">{{ l.text }}</span>
        <span v-if="guessSolvent(l.text)" class="ocr-tag">展开剂</span>
        <span v-else-if="guessRf(l.text)" class="ocr-tag">Rf</span>
      </button>
      <div v-if="!lines.length" class="hint">这张图上没认出字来（手写太淡 / 角度太斜都可能）。</div>
    </div>
    <div class="hint" style="margin-top: 10px">
      点一行就填进「展开剂」；带 Rf 的填到 Rf 那一格。识别在本机跑，不联网。
    </div>
  </AppModal>
</template>
