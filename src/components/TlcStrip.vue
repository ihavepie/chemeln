<script setup>
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps({
  /** 只看这个类别的图片：tlc / photo 都用这套 */
  category: { type: String, default: 'tlc' },
  attachments: { type: Array, default: () => [] },
  locked: Boolean,
  hovered: String,
  onHover: Function,
  onPick: Function,
  onOpen: Function,
  onDelete: Function,
  /** 图片下面给不给写一行说明（实验照片用；TLC 不写） */
  captions: Boolean,
  onCaption: Function,
});

const shots = computed(() =>
  props.attachments.filter(
    (a) => a.category === props.category && /\.(png|jpe?g|gif|webp)$/i.test(a.original_name || a.filename)
  )
);
</script>

<template>
  <div class="tlc-strip" :data-state="shots.length ? 'has' : 'empty'" @mouseenter="onHover('tlc')" @mouseleave="onHover('')">
    <figure v-for="s in shots" :key="s.id" class="tlc-shot" :class="{ 'has-cap': captions }">
      <img :src="`/api/files/${s.id}`" alt="" @click="onOpen(s.id)" />
      <button v-if="!locked" class="tlc-x" title="删除" @click.stop="onDelete(s.id)"><Icon name="x" :size="11" /></button>
      <input
        v-if="captions"
        class="tlc-cap"
        :value="s.note || ''"
        placeholder="图注，如：滴加 10 min 后"
        :disabled="locked"
        @click.stop
        @change="onCaption && onCaption(s.id, $event.target.value)"
      />
    </figure>
    <template v-if="!locked">
      <div v-for="n in (shots.length ? 1 : 2)" :key="`add-${n}`" class="tlc-empty" @click="onPick(category)">
        <span class="plus">+</span>
        <span class="cap">粘贴 / 选择</span>
      </div>
    </template>
  </div>
</template>
