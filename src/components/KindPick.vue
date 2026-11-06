<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { COMPOUND_KINDS } from '../lib/ui.js';

/**
 * 化合物「类型」的小下拉：不用系统 select（弹出来是系统蓝色菜单，跟纸面不搭），
 * 自己画一个跟「分类」下拉同一套样式的小菜单。
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const wrap = ref(null);
const current = computed(() => props.modelValue || '其他');

/** 现有数据里可能有列表外的老类型（比如「试剂」），照样显示出来 */
const items = computed(() =>
  COMPOUND_KINDS.includes(current.value) ? COMPOUND_KINDS : [current.value, ...COMPOUND_KINDS]
);

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}
function pick(k) {
  open.value = false;
  if (k !== props.modelValue) emit('update:modelValue', k);
}

function onDocClick(ev) {
  if (!ev.target.closest?.('.kind-pick')) open.value = false;
}
function onKey(ev) {
  if (ev.key === 'Escape') open.value = false;
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div ref="wrap" class="kind-pick" :class="{ 'is-disabled': disabled }">
    <button type="button" class="kind-trigger" :disabled="disabled" @click.stop="toggle">
      <span class="kind-text">{{ current }}</span>
      <Icon name="down" :size="9" />
    </button>
    <div v-if="open" class="qmenu cat-menu kind-menu" @click.stop>
      <button
        v-for="k in items"
        :key="k"
        type="button"
        class="cat-menu-opt"
        :aria-selected="k === current ? 'true' : 'false'"
        @click="pick(k)"
      >
        <span class="cat-menu-name">{{ k }}</span>
      </button>
    </div>
  </div>
</template>
