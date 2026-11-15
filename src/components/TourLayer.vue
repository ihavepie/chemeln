<script setup>
/**
 * 教程浮层（漫游式引导）。
 *
 * 没用 Element Plus 的 `el-tour`：那套默认是 Element 蓝、白底大圆角，要改成这里的纸白 / 1px 线
 * 得覆盖一堆内部类；自己写一版 90 行就够，还能跟全站同一个卡片质感（`--card-r` / `--card-shadow`）。
 *
 * 暗底是「四块」拼出来的（目标框周围各一块），**别用 `box-shadow: 0 0 0 100vmax` 那一招**：
 * 展开成 3000px 的阴影在 WKWebView 里会被裁掉、屏幕上一点暗色都看不到（踩过）。
 * 目标框和卡片都用 `position:fixed`，位置按 `getBoundingClientRect()` 现算，窗口尺寸 /
 * 页面滚动 / 侧栏拖动都会重算。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  steps: { type: Array, default: () => [] },
  modelValue: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'close']);

const CARD_W = 288;
const GAP = 14;
const EDGE = 10;

const i = ref(0);
const box = ref(null); // 高亮框（视口坐标）
const pos = ref({ left: 0, top: 0 }); // 卡片位置
const cardEl = ref(null);
let watchTimer = 0;

const cur = computed(() => props.steps[i.value] || null);
const total = computed(() => props.steps.length);

function close() {
  emit('update:modelValue', false);
  emit('close');
}
function go(step) {
  if (!total.value) return;
  const n = Math.min(Math.max(0, step), total.value - 1);
  if (n !== i.value) {
    i.value = n;
    void nextTick(layout);
  }
}
const next = () => (i.value + 1 >= total.value ? close() : go(i.value + 1));
const prev = () => go(i.value - 1);

/** 量目标、摆卡片 */
function layout() {
  const s = cur.value;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const el = s && s.target ? document.querySelector(s.target) : null;
  if (!el) {
    // 目标不在页面上（栏收起了 / 还没渲染）：卡片居中，不带高亮
    box.value = null;
    const ch = cardEl.value?.offsetHeight || 160;
    pos.value = { left: Math.round((vw - CARD_W) / 2), top: Math.round(Math.max(EDGE + 52, (vh - ch) / 2)) };
    return;
  }
  const r = el.getBoundingClientRect();
  box.value = { left: r.left - 6, top: r.top - 6, width: r.width + 12, height: r.height + 12 };

  const ch = cardEl.value?.offsetHeight || 160;
  const place = s.place || 'bottom';
  let left;
  let top;
  if (place === 'right') {
    left = r.right + GAP;
    top = r.top;
    if (left + CARD_W > vw - EDGE) left = r.left - GAP - CARD_W; // 右边放不下就翻到左边
  } else if (place === 'left') {
    left = r.left - GAP - CARD_W;
    top = r.top;
    if (left < EDGE) left = r.right + GAP;
  } else if (place === 'top') {
    left = r.left;
    top = r.top - GAP - ch;
    if (top < EDGE) top = r.bottom + GAP;
  } else if (place === 'center') {
    left = (vw - CARD_W) / 2;
    top = Math.max(EDGE + 20, (vh - ch) / 2 - 40);
  } else {
    left = r.left;
    top = r.bottom + GAP;
    if (top + ch > vh - EDGE) top = r.top - GAP - ch;
  }
  pos.value = {
    left: Math.round(Math.min(Math.max(EDGE, left), vw - CARD_W - EDGE)),
    top: Math.round(Math.min(Math.max(EDGE, top), vh - ch - EDGE)),
  };
}

function onKey(ev) {
  if (ev.key === 'Escape') close();
  else if (ev.key === 'ArrowRight') next();
  else if (ev.key === 'ArrowLeft') prev();
}

watch(
  () => props.modelValue,
  (on) => {
    clearInterval(watchTimer);
    if (!on) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    i.value = 0;
    document.addEventListener('keydown', onKey);
    void nextTick(layout);
    // 页面里的东西会自己动（画布 fit、图加载完变高），跟着重量几次
    watchTimer = setInterval(layout, 240);
  }
);
watch([() => props.steps, i], () => void nextTick(layout));

onBeforeUnmount(() => {
  clearInterval(watchTimer);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <teleport to="body">
    <div v-if="modelValue && cur" class="tour">
      <!-- 点任何地方都算「跳过」（和别的弹窗一致：点背景可关） -->
      <div class="tour-mask" @click="close" />
      <template v-if="box">
        <div class="tour-dim" :style="{ left: '0px', top: '0px', right: '0px', height: `${Math.max(0, box.top)}px` }" />
        <div
          class="tour-dim"
          :style="{ left: '0px', top: `${box.top + box.height}px`, right: '0px', bottom: '0px' }"
        />
        <div
          class="tour-dim"
          :style="{ left: '0px', top: `${Math.max(0, box.top)}px`, width: `${Math.max(0, box.left)}px`, height: `${box.height}px` }"
        />
        <div
          class="tour-dim"
          :style="{ left: `${box.left + box.width}px`, top: `${Math.max(0, box.top)}px`, right: '0px', height: `${box.height}px` }"
        />
        <div
          class="tour-ring"
          :style="{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }"
        />
      </template>
      <div ref="cardEl" class="tour-card" :style="{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${CARD_W}px` }">
        <div class="tour-top">
          <span class="tour-k">{{ i + 1 }} / {{ total }}</span>
          <button class="tour-x" title="跳过" @click="close">×</button>
        </div>
        <p class="tour-title">{{ cur.title }}</p>
        <p class="tour-text">{{ cur.text }}</p>
        <div class="tour-btns">
          <button class="tour-skip" @click="close">跳过</button>
          <span class="tour-space" />
          <button v-if="i > 0" class="tour-btn" @click="prev">上一步</button>
          <button class="tour-btn tour-primary" @click="next">{{ i + 1 >= total ? '完成' : '下一步' }}</button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.tour {
  position: fixed;
  inset: 0;
  z-index: 900;
}
/* 透明的一层：只负责吃掉点击，暗底交给高亮框那圈巨影 */
.tour-mask {
  position: absolute;
  inset: 0;
  cursor: default;
}
.tour-dim {
  position: absolute;
  background: rgba(28, 27, 25, 0.2);
  pointer-events: none;
  transition: left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease;
}
.tour-ring {
  position: absolute;
  border-radius: 9px;
  box-shadow: 0 0 0 1px rgba(168, 71, 31, 0.55);
  pointer-events: none;
  transition: left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease;
}
.tour-card {
  position: absolute;
  background: var(--card-bg, #fff);
  border-radius: var(--card-r, 10px);
  box-shadow: 0 0 0 1px var(--line), 0 8px 26px rgba(20, 18, 14, 0.14);
  padding: 12px 13px 11px;
  transition: left 140ms ease, top 140ms ease;
}
.tour-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tour-k {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--ink-4);
}
.tour-x {
  border: 0;
  background: none;
  color: var(--ink-4);
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
}
.tour-x:hover {
  color: var(--ink-2);
}
.tour-title {
  margin: 2px 0 4px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
}
.tour-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ink-2);
}
.tour-btns {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 11px;
}
.tour-space {
  flex: 1 1 auto;
}
.tour-skip {
  border: 0;
  background: none;
  padding: 0;
  font-size: 11.5px;
  color: var(--ink-4);
  cursor: pointer;
}
.tour-skip:hover {
  color: var(--ink-2);
}
.tour-btn {
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: #fff;
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
}
.tour-btn:hover {
  border-color: var(--ink-4);
}
.tour-primary {
  border-color: var(--ink);
  background: var(--ink);
  color: #fff;
}
.tour-primary:hover {
  border-color: var(--ink);
  opacity: 0.9;
}
</style>
