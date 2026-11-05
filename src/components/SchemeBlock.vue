<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  attachments: { type: Array, default: () => [] },
  locked: Boolean,
  hovered: String,
  onHover: Function,
  onPick: Function,
});

const scheme = computed(() => props.attachments.find((a) => a.category === 'scheme'));
</script>

<template>
  <div class="scheme-block">
    <div class="scheme-head">
      <span class="lbl">反应式</span>
    </div>
    <div
      class="scheme-slot"
      :class="{ 'is-hover': hovered === 'scheme' }"
      @mouseenter="onHover('scheme')"
      @mouseleave="onHover('')"
      @click="onPick('scheme')"
    >
      <img v-if="scheme && /\.(png|jpe?g|gif|webp|svg)$/i.test(scheme.original_name || scheme.filename)" :src="`/api/files/${scheme.id}`" alt="" />
      <div v-else class="scheme-empty noprint">
        <Icon name="image" :size="22" />
        <span>点击上传反应式（ChemDraw 截图 / 图片）</span>
      </div>
    </div>
  </div>
</template>
