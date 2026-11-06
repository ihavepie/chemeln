<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { closeCtxMenu, ctxMenu } from '../lib/ctxmenu.js';

const el = ref(null);
const pos = ref({ left: '0px', top: '0px' });

/* 子菜单（菜单项带 sub 时用）：贴在那一行右边，放不下就往左翻 */
const subEl = ref(null);
const sub = ref(null);
const subPos = ref({ left: '0px', top: '0px' });
let hideTimer = null;

async function showSub(it, ev) {
  if (!it.sub || !it.sub.length) return hideSub();
  const r = ev.currentTarget.getBoundingClientRect();
  sub.value = { items: it.sub };
  subPos.value = { left: `${r.right + 2}px`, top: `${r.top - 4}px` };
  await nextTick();
  const s = subEl.value;
  if (!s) return;
  const pad = 8;
  const w = s.offsetWidth;
  const h = s.offsetHeight;
  let left = r.right + 2;
  let top = r.top - 4;
  if (left + w + pad > window.innerWidth) left = Math.max(pad, r.left - w - 2);
  if (top + h + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - h - pad);
  subPos.value = { left: `${left}px`, top: `${top}px` };
}

function hideSub() {
  clearTimeout(hideTimer);
  sub.value = null;
}
/** 鼠标已经滑进子菜单了：把「待会儿收起来」那个定时器撤掉 */
function keepSub() {
  clearTimeout(hideTimer);
}
/** 鼠标从主菜单滑向子菜单时会先离开主菜单，给一点缓冲再收 */
function laterHideSub() {
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    sub.value = null;
  }, 130);
}

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
  if (it.sub) return;      // 带子菜单的那一行：点一下不动作，靠悬停展开
  const run = ctxMenu.pick;
  hideSub();
  closeCtxMenu();
  if (!it.sep && !it.head) run?.(it.key);
}

/* 该收起来的几种情况：点了别处、按 Esc、滚走、窗口变了、右键空白处（那次交给浏览器自己弹） */
function onPointerDown(ev) {
  if (el.value?.contains(ev.target) || subEl.value?.contains(ev.target)) return;
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
    sub.value = null;
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
    <div
      v-if="ctxMenu.open"
      ref="el"
      class="ctx-menu"
      role="menu"
      :style="pos"
      @contextmenu.prevent
      @pointerleave="laterHideSub"
    >
      <template v-for="(it, i) in ctxMenu.items" :key="`${i}-${it.key || it.head || 'sep'}`">
        <div v-if="it.sep" class="ctx-sep" />
        <div v-else-if="it.head" class="ctx-head">{{ it.head }}</div>
        <button
          v-else
          type="button"
          class="ctx-opt"
          :class="{ 'is-danger': it.danger }"
          role="menuitem"
          @click="choose(it)"
          @pointerenter="showSub(it, $event)"
        >
          <Icon :name="it.icon || 'file'" :size="12" class="ctx-icon" />
          <span class="ctx-label">{{ it.label }}</span>
          <span v-if="it.hint" class="ctx-hint">{{ it.hint }}</span>
          <span v-if="it.sub" class="ctx-caret">›</span>
        </button>
      </template>
    </div>

    <!-- 子菜单：单独一层，鼠标从主菜单滑过来不算「点别处」 -->
    <div
      v-if="sub"
      ref="subEl"
      class="ctx-menu is-sub"
      role="menu"
      :style="subPos"
      @contextmenu.prevent
      @pointerenter="keepSub"
      @pointerleave="laterHideSub"
    >
      <template v-for="(it, i) in sub.items" :key="`s${i}-${it.key || 'sep'}`">
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
