<script setup>
import { computed } from 'vue';
import { ICONS } from '../lib/icons.js';

const props = defineProps({ name: { type: String, required: true }, size: { type: Number, default: 15 } });
const icon = computed(() => ICONS[props.name] || ICONS.file);
</script>

<template>
  <svg class="i" :width="size" :height="size" :viewBox="icon.vb" aria-hidden="true" v-html="icon.inner" />
</template>
