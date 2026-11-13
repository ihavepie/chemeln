<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ignoreOutsideClick } from '../lib/popguard.js';

/**
 * 「刻度滑条」选择（温度 / 时间用）：不是滚轮，是**按住往左右拖**的那种——
 * 相机放大倍率、相机曝光补偿那种刻度条：手指走多少、刻度带跟着滑多少，
 * 松手回弹吸附到最近一格（带一点橡皮筋）。
 *
 * 为什么这么选：温度和时间的候选是有序刻度（−78 → rt → 回流、30 min → 过夜），
 * 拖一下就跨好几档比一格一格滚利索；鼠标上也好按（不用滚轮）。
 *
 * 实现要点：位移 `offset`（px）是唯一状态，`transform: translateX(-offset)` 直接跟手；
 * 拖动时关掉 transition（跟手）、松手打开（回弹吸附）；拖出去一点有 0.35 的阻尼。
 */
const props = defineProps({
  items: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
  locked: Boolean,
});
const emit = defineEmits(['update:modelValue', 'close', 'add']);

const STEP = 56;          // 一档多少像素
const OVER = 18;          // 能拖出边界多少（橡皮筋）
const EASE = 'transform 200ms cubic-bezier(0.22, 0.61, 0.36, 1)';

const wrap = ref(null);
const track = ref(null);
const idx = ref(0);
const offset = ref(0);
const dragging = ref(false);
const animate = ref(false);

/** 当前值不在候选里（比如手打的 `45 ℃`）：挂到最前面，不然拖不到它 */
const list = computed(() => {
  const out = [];
  for (const raw of props.items || []) {
    const v = String(raw ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  const cur = String(props.modelValue || '').trim();
  if (cur && !out.includes(cur)) out.unshift(cur);
  return out;
});

const maxOffset = computed(() => Math.max(0, (list.value.length - 1) * STEP));
const stripStyle = computed(() => ({
  transform: `translateX(${-offset.value}px)`,
  transition: animate.value && !dragging.value ? EASE : 'none',
}));

const clampi = (i) => Math.max(0, Math.min(list.value.length - 1, i));

function goTo(i, smooth = true) {
  idx.value = clampi(i);
  animate.value = smooth;
  offset.value = idx.value * STEP;
}

let startX = 0;
let startOff = 0;
let moved = 0;

/** 超出两头的位移加阻尼：越拖越沉，最多出去 OVER 像素 */
function resist(off) {
  if (off < 0) return off * 0.35 > -OVER ? off * 0.35 : -OVER;
  if (off > maxOffset.value) {
    const over = (off - maxOffset.value) * 0.35;
    return maxOffset.value + (over < OVER ? over : OVER);
  }
  return off;
}

function onDown(ev) {
  if (props.locked) return;
  dragging.value = true;
  animate.value = false;
  moved = 0;
  startX = ev.clientX;
  startOff = offset.value;
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  ev.preventDefault();
}

function onMove(ev) {
  if (!dragging.value) return;
  const dx = ev.clientX - startX;
  moved = Math.max(moved, Math.abs(dx));
  const off = resist(startOff - dx);
  offset.value = off;
  const i = clampi(Math.round(off / STEP));
  if (i !== idx.value) {
    idx.value = i;
    const v = list.value[i];
    if (v != null && v !== props.modelValue) emit('update:modelValue', v);
  }
}

function onUp() {
  if (!dragging.value) return;
  dragging.value = false;
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
  // 松手回弹吸附到最近一格（这就是那份「阻尼」）
  goTo(idx.value, true);
}

/**
 * 滚轮 / 触控板也能拨：一格一格走，攒够 60px 才算一格 ——
 * 鼠标滚轮一格通常是 100~120，触控板会连发很多小 delta（攒着走，不然一下子飞到底）。
 * 只用正负号，每次最多走一格。
 */
let wheelAcc = 0;
let wheelTimer = 0;
function onWheel(ev) {
  if (props.locked) return;
  ev.preventDefault();
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => {
    wheelAcc = 0;
  }, 200);
  wheelAcc += ev.deltaY;
  if (Math.abs(wheelAcc) < 60) return;
  const dir = wheelAcc > 0 ? 1 : -1;
  wheelAcc = 0;
  const next = clampi(idx.value + dir);
  if (next === idx.value) return;
  goTo(next, true);
  const v = list.value[next];
  if (v != null) emit('update:modelValue', v);
}

function onItemClick(i) {
  if (moved > 6) return;   // 刚才是在拖，不是点
  goTo(i, true);
  const v = list.value[i];
  if (v != null) emit('update:modelValue', v);
}

function onDocDown(ev) {
  // 刻度带是 CondRow 点开的：刚打开那一下外面点击别把弹层关掉
  if (ignoreOutsideClick()) return;
  if (wrap.value && !wrap.value.contains(ev.target)) emit('close');
}
function onKey(ev) {
  if (ev.key === 'Escape') {
    emit('close');
    return;
  }
  if (!wrap.value) return;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    ev.preventDefault();
    ev.stopPropagation();
    const next = clampi(idx.value + (ev.key === 'ArrowRight' ? 1 : -1));
    goTo(next, true);
    const v = list.value[next];
    if (v != null) emit('update:modelValue', v);
  }
}

onMounted(() => {
  goTo(Math.max(0, list.value.indexOf(String(props.modelValue || '').trim())), false);
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
  document.removeEventListener('mousedown', onDocDown);
  document.removeEventListener('keydown', onKey, true);
});

// 外面改了值（比如点了「＋ 自定义」）→ 刻度带跟着滑过去
watch(
  () => props.modelValue,
  (v) => {
    if (dragging.value) return;
    const i = list.value.indexOf(String(v || '').trim());
    if (i >= 0 && i !== idx.value) goTo(i, true);
  }
);
</script>

<template>
  <div ref="wrap" class="ruler-pop" @mousedown.stop @wheel="onWheel">
    <div ref="track" class="ruler-track" @mousedown="onDown">
      <div class="ruler-strip" :style="stripStyle">
        <button
          v-for="(v, i) in list"
          :key="v"
          type="button"
          class="ruler-item"
          :class="{ 'is-on': i === idx }"
          @click="onItemClick(i)"
        >
          <span class="ruler-tick" />
          <span class="ruler-label">{{ v }}</span>
        </button>
      </div>
      <span class="ruler-needle" />
    </div>
    <div class="ruler-foot">
      <button v-if="!locked" type="button" class="ruler-add" title="把自己常用的值加进这条刻度" @click.stop="emit('add')">
        ＋ 自定义
      </button>
    </div>
  </div>
</template>
