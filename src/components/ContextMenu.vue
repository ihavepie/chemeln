<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { closeCtxMenu, ctxMenu } from '../lib/ctxmenu.js';

const el = ref(null);
const pos = ref({ left: '0px', top: '0px' });

/** 贴着鼠标弹出来，但不许出屏幕：右边放不下就往左收，下面放不下就翻到鼠标上方 */
async function place() {
  pos.value = { left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` };   // 先按鼠标位置画，量到尺寸再修
  await nextTick();
  const n = el.value;
  if (!n) return;
  const pad = 8;
  const w = n.offsetWidth;
  const h = n.offsetHeight;
  let left = ctxMenu.x;
  let top = ctxMenu.y;
  if (left + w + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - w - pad);
  if (top + h + pad > window.innerHeight) top = Math.max(pad, ctxMenu.y - h);
  pos.value = { left: `${left}px`, top: `${top}px` };
}

function choose(it) {
  const run = ctxMenu.pick;
  closeCtxMenu();
  if (!it.sep) run?.(it.key);
}

/* 该收起来的几种情况：点了别处、按 Esc、滚走、窗口变了、右键空白处（那次交给浏览器自己弹） */
function onPointerDown(ev) {
  if (el.value?.contains(ev.target)) return;
  closeCtxMenu();
}
function onKey(ev) {
  if (ev.key === 'Escape') closeCtxMenu();
}
function onContext(ev) {
  // 卡片自己会在 contextmenu 里重新打开菜单（那一次走冒泡），这里只管「别处」
  if (!el.value?.contains(ev.target)) closeCtxMenu();
}
const onAway = () => closeCtxMenu();

watch(
  () => ctxMenu.open,
  (v) => {
    if (v) void place();
  }
);

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKey);
  document.addEventListener('contextmenu', onContext, true);
  window.addEventListener('scroll', onAway, true);
  window.addEventListener('resize', onAway);
  window.addEventListener('blur', onAway);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('contextmenu', onContext, true);
  window.removeEventListener('scroll', onAway, true);
  window.removeEventListener('resize', onAway);
  window.removeEventListener('blur', onAway);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="ctxMenu.open" ref="el" class="ctx-menu" role="menu" :style="pos" @contextmenu.prevent>
      <template v-for="(it, i) in ctxMenu.items" :key="`${i}-${it.key || 'sep'}`">
        <div v-if="it.sep" class="ctx-sep" />
        <button
          v-else
          type="button"
          class="ctx-opt"
          :class="{ 'is-danger': it.danger }"
          role="menuitem"
          @click="choose(it)"
        >
          <Icon :name="it.icon || 'file'" :size="12" class="ctx-icon" />
          <span class="ctx-label">{{ it.label }}</span>
          <span v-if="it.hint" class="ctx-hint">{{ it.hint }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
