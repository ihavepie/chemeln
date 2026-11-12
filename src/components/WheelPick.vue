<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * 轮盘选择（温度 / 时间用）：像相机放大倍率那种——拖 / 滚一下就过一格，停手会自己吸附到最近的值。
 *
 * 为什么不用系统 `<select>`：弹出来是系统蓝底菜单，跟纸面不搭（用户从 v1 起就否掉了）。
 * 为什么不用一排胶囊：温度和时间的候选是**有序刻度**（−78 → rt → 回流、1 h → 24 h），
 * 滚轮比在一堆胶囊里找更顺手，也有「一档一档」的手感。
 *
 * 吸附靠原生 `scroll-snap-type: y mandatory`（WebKit 自带惯性和吸附 = 阻尼感），
 * 离中间远的项自己缩小 + 变淡（JS 按滚动位置算），看着才像个转起来的轮子。
 */
const props = defineProps({
  items: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
  /** 露几条：奇数好看（3 / 5） */
  rows: { type: Number, default: 5 },
  locked: Boolean,
});
const emit = defineEmits(['update:modelValue', 'close', 'add']);

const ITEM_H = 26;
const drum = ref(null);
const wrap = ref(null);
const centerIdx = ref(0);

/** 当前值不在候选里（比如自己手打的 `45 ℃`）：挂到列表顶部，不然轮盘转不到它 */
const list = computed(() => {
  const raw = (props.items || []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const out = [];
  for (const v of raw) if (!out.includes(v)) out.push(v);
  const cur = String(props.modelValue || '').trim();
  if (cur && !out.includes(cur)) out.unshift(cur);
  return out;
});

const pad = computed(() => ((props.rows - 1) / 2) * ITEM_H);
const drumH = computed(() => props.rows * ITEM_H);

function scrollToIndex(i, smooth = false) {
  const el = drum.value;
  if (!el) return;
  const top = i * ITEM_H;
  if (smooth) el.scrollTo({ top, behavior: 'smooth' });
  else el.scrollTop = top;
}

let raf = 0;
function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const el = drum.value;
    if (!el) return;
    const idx = Math.max(0, Math.min(list.value.length - 1, Math.round(el.scrollTop / ITEM_H)));
    if (idx === centerIdx.value) return;
    centerIdx.value = idx;
    const v = list.value[idx];
    if (v != null && v !== props.modelValue) emit('update:modelValue', v);
  });
}

/** 每一项离「中间」有多远 → 缩放和透明度（0 = 正中） */
function itemStyle(i) {
  const d = Math.abs(i - centerIdx.value);
  if (d === 0) return { opacity: 1, transform: 'scale(1)' };
  if (d === 1) return { opacity: 0.55, transform: 'scale(0.92)' };
  if (d === 2) return { opacity: 0.28, transform: 'scale(0.86)' };
  return { opacity: 0.12, transform: 'scale(0.82)' };
}

function pickIndex(i) {
  scrollToIndex(i, true);
}

function onWheel(ev) {
  // 滚轮 / 触控板：一格一格走，别让页面跟着滚
  ev.preventDefault();
  const el = drum.value;
  if (!el) return;
  el.scrollTop += Math.sign(ev.deltaY) * ITEM_H;
}

let t = 0;
function onDocDown(ev) {
  if (wrap.value && !wrap.value.contains(ev.target)) emit('close');
}
function onKey(ev) {
  if (ev.key === 'Escape') emit('close');
}

onMounted(async () => {
  await nextTick();
  const idx = Math.max(0, list.value.indexOf(String(props.modelValue || '').trim()));
  scrollToIndex(idx);
  centerIdx.value = idx;
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown);
  document.removeEventListener('keydown', onKey);
  clearTimeout(t);
});

// 外面把值改掉（比如点了「＋ 自定义」）→ 轮盘跟着转过去
watch(
  () => props.modelValue,
  (v) => {
    const i = list.value.indexOf(String(v || '').trim());
    if (i >= 0 && i !== centerIdx.value) {
      centerIdx.value = i;
      scrollToIndex(i, true);
    }
  }
);
</script>

<template>
  <div ref="wrap" class="wheel-pop" @click.stop>
    <div class="wheel-mask">
      <div
        ref="drum"
        class="wheel-drum"
        :style="{ height: drumH + 'px', '--pad': pad + 'px' }"
        @scroll.passive="onScroll"
        @wheel="onWheel"
      >
        <div class="wheel-pad" />
        <button
          v-for="(v, i) in list"
          :key="v"
          type="button"
          class="wheel-item"
          :class="{ 'is-on': i === centerIdx }"
          :style="itemStyle(i)"
          @click="pickIndex(i)"
        >{{ v }}</button>
        <div class="wheel-pad" />
      </div>
      <div class="wheel-band" />
    </div>
    <div class="wheel-foot">
      <button v-if="!locked" type="button" class="wheel-add" title="把自己常用的值加进这个轮盘" @click.stop="emit('add')">
        ＋ 自定义
      </button>
    </div>
  </div>
</template>
