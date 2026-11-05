<script setup>
import { computed, ref, watch } from 'vue';
import AppModal from './AppModal.vue';

/**
 * 附件就地预览：图片直接铺开、PDF 用浏览器自带的阅读器（iframe，Safari 能直接看）、
 * 文本类（.txt/.csv/.md/.jdx）拉下来放在等宽区里；谱图原始数据这种没法看的走下载。
 * 调用方只管给 src + name（实验附件是 /api/files/:id，化合物文件是 /api/compound-files/:id）。
 */
const props = defineProps({
  src: { type: String, required: true },
  name: { type: String, default: '附件' },
});
const emit = defineEmits(['close']);

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const TEXT = ['txt', 'csv', 'md', 'jdx', 'dx', 'log', 'json'];

const ext = computed(() => {
  const m = /\.([a-z0-9]+)$/i.exec(props.name || '');
  return m ? m[1].toLowerCase() : '';
});
const kind = computed(() => {
  if (IMAGE.includes(ext.value)) return 'image';
  if (ext.value === 'pdf') return 'pdf';
  if (TEXT.includes(ext.value)) return 'text';
  return 'other';
});

const text = ref('');
const err = ref('');
watch(
  () => props.src,
  async (src) => {
    text.value = '';
    err.value = '';
    if (kind.value !== 'text') return;
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.text();
      text.value = raw.length > 200000 ? `${raw.slice(0, 200000)}\n\n…（只显示前 200 KB）` : raw;
    } catch (e) {
      err.value = `读不了这个文本文件：${e.message || e}`;
    }
  },
  { immediate: true }
);

const openTab = () => window.open(props.src, '_blank');
const download = () => window.open(`${props.src}${props.src.includes('?') ? '&' : '?'}download=1`, '_blank');
</script>

<template>
  <AppModal :title="name" :show-confirm="false" cancel-text="关闭" width="min(1180px, 92vw)" @close="emit('close')">
    <div class="fp">
      <img v-if="kind === 'image'" class="fp-img" :src="src" :alt="name" />
      <iframe v-else-if="kind === 'pdf'" class="fp-pdf" :src="src" :title="name" />
      <pre v-else-if="kind === 'text'" class="fp-text">{{ err || text || '读取中…' }}</pre>
      <div v-else class="fp-other">
        <span class="fp-ext mono">{{ ext || '文件' }}</span>
        <p class="hint">这种格式没法在页面里预览（谱图原始数据、mnova、压缩包都走下载）。</p>
      </div>
    </div>

    <div class="fp-foot">
      <span class="hint mono" style="font-size: 10.5px">{{ name }}</span>
      <span class="spacer" style="flex: 1" />
      <button class="btn btn-sm btn-ghost" @click="openTab">新标签页打开</button>
      <button class="btn btn-sm" @click="download">下载</button>
    </div>
  </AppModal>
</template>
