<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';

/**
 * 记录页里的「课题」格子：直接打字也行，点右边小箭头从已有课题里挑一个。
 * 不用系统 select；菜单用 fixed 定位，免得被表格/滚动区裁掉。
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  projects: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
  /** 菜单里那个数字用哪个计数：实验页用 n（实验条数），化合物页传 cmp（化合物个数） */
  countKey: { type: String, default: 'n' },
});
const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const wrap = ref(null);
const pos = ref({ top: 0, left: 0, width: 0, maxHeight: 0 });

/**
 * 就是普通下拉：菜单贴着输入框正下方弹出、宽度跟输入框一样；
 * 下面放不下就往上翻。之所以用 fixed，是因为表格和滚动区会把它裁掉。
 */
function toggle() {
  if (props.disabled) return;
  if (!open.value && wrap.value) {
    const r = wrap.value.getBoundingClientRect();
    const width = Math.round(r.width);
    const est = Math.min(Math.max((props.projects.length || 3) * 27 + 10, 74), Math.round(window.innerHeight * 0.4));
    const roomBelow = window.innerHeight - r.bottom;
    const top = roomBelow < est + 10 ? Math.max(8, Math.round(r.top - est - 4)) : Math.round(r.bottom + 4);
    const left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - width - 8));
    pos.value = { top, left, width, maxHeight: est };
  }
  open.value = !open.value;
}

function pick(name) {
  open.value = false;
  emit('update:modelValue', name);
}

function onDocClick(ev) {
  if (!ev.target.closest?.('.proj-pick')) open.value = false;
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
  <div ref="wrap" class="proj-pick">
    <input
      :value="modelValue"
      placeholder="课题 / 项目"
      :disabled="disabled"
      @input="emit('update:modelValue', $event.target.value)"
    />
    <button ref="btn" type="button" class="proj-pick-btn" :disabled="disabled" title="从已有课题里选" @click.stop="toggle">
      <Icon name="down" :size="9" />
    </button>

    <div
      v-if="open"
      class="qmenu cat-menu cat-menu--fixed"
      :style="{
        position: 'fixed',
        top: `${pos.top}px`,
        left: `${pos.left}px`,
        width: `${pos.width}px`,
        maxWidth: 'none',
        maxHeight: `${pos.maxHeight}px`,
        overflowY: 'auto',
      }"
      @click.stop
    >
      <button v-for="p in projects" :key="p.name" type="button" class="cat-menu-opt" @click="pick(p.name)">
        <span class="cat-menu-name">{{ p.name }}</span>
        <span class="cat-menu-n mono">{{ p[countKey] }}</span>
      </button>
      <div v-if="!projects.length" class="cat-menu-opt" style="cursor: default; color: var(--ink-4)">直接打名字就行</div>
    </div>
  </div>
</template>
