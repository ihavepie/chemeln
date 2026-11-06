<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  attachments: { type: Array, default: () => [] },
  locked: Boolean,
  hovered: String,
  onHover: Function,
  onPick: Function,
  onOpen: Function,
  onSketch: Function,
  onFill: Function,        // 反应式 → 投料表
  onFromTable: Function,   // 投料表 + 产物 → 反应式
  hasScheme: Boolean,
});

const scheme = computed(() => props.attachments.find((a) => a.category === 'scheme'));
</script>

<template>
  <div class="scheme-block">
    <div class="scheme-head">
      <span class="lbl">反应式</span>
      <span class="spacer" />
      <!-- 懒得起 ChemDraw 时，直接在画板里把反应物 → 产物连起来 -->
      <button
        v-if="!locked"
        type="button"
        class="btn btn-sm btn-ghost noprint"
        title="打开画板画整条反应式（反应物 ＋ → 产物，条件可以写在箭头上）；⌘V 能直接粘 ChemDraw 的"
        @click.stop="onSketch && onSketch()"
      >
        <Icon name="molecule" :size="13" /> 画反应式
      </button>
      <button
        v-if="!locked"
        type="button"
        class="btn btn-sm btn-ghost noprint"
        title="按投料表和结果块里的产物拼一条反应式，塞进画板让你调"
        @click.stop="onFromTable && onFromTable()"
      >
        按投料表生成
      </button>
      <button
        v-if="!locked && hasScheme"
        type="button"
        class="btn btn-sm btn-ghost noprint"
        title="把这条反应式里的反应物跟化合物库对上，重建投料表并填上产物"
        @click.stop="onFill && onFill()"
      >
        从反应式填表
      </button>
    </div>
    <div
      class="scheme-slot"
      :class="{ 'is-hover': hovered === 'scheme' }"
      @mouseenter="onHover('scheme')"
      @mouseleave="onHover('')"
      @click="onPick('scheme')"
    >
      <img
        v-if="scheme && /\.(png|jpe?g|gif|webp|svg)$/i.test(scheme.original_name || scheme.filename)"
        :src="`/api/files/${scheme.id}`"
        alt=""
        title="点一下看大图"
        style="cursor: zoom-in"
        @click.stop="onOpen && onOpen(scheme.id)"
      />
      <div v-else class="scheme-empty noprint">
        <Icon name="image" :size="22" />
        <span>点击上传反应式，或点右上「画反应式」直接在画板里画</span>
      </div>
    </div>
  </div>
</template>
