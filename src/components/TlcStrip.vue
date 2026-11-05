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
  onDelete: Function,
});

const shots = computed(() => props.attachments.filter((a) => a.category === 'tlc' && /\.(png|jpe?g|gif|webp)$/i.test(a.original_name || a.filename)));
</script>

<template>
  <div class="tlc-strip" :data-state="shots.length ? 'has' : 'empty'" @mouseenter="onHover('tlc')" @mouseleave="onHover('')">
    <figure v-for="s in shots" :key="s.id" class="tlc-shot">
      <img :src="`/api/files/${s.id}`" alt="" @click="onOpen(s.id)" />
      <button v-if="!locked" class="tlc-x" title="删除" @click.stop="onDelete(s.id)"><Icon name="x" :size="11" /></button>
    </figure>
    <template v-if="!locked">
      <div v-for="n in (shots.length ? 1 : 2)" :key="`add-${n}`" class="tlc-empty" @click="onPick('tlc')">
        <span class="plus">+</span>
        <span class="cap">粘贴 / 选择</span>
      </div>
    </template>
  </div>
</template>
