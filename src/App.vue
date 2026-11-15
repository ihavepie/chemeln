<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppRail from './components/AppRail.vue';
import ContextMenu from './components/ContextMenu.vue';
import TourLayer from './components/TourLayer.vue';
import { loadBoot, store } from './store.js';
import { TOURS, liveSteps, markTourSeen, tourKeyOf, tourSeen } from './lib/tours.js';

const route = useRoute();

/** 手机端只提供「扫瓶签看化合物档案」这一页，别的路由没有入口也不渲染 */
const isPhone = ref(typeof window !== 'undefined' && window.innerWidth <= 820);
const onResize = () => { isPhone.value = window.innerWidth <= 820; };
const allowOnPhone = computed(() =>
  ['compound', 'editor', 'mobile'].includes(route.name)
);

/* ---------------- 教程：每页一套，第一次进自动放一遍，右下角 ? 随时能再看 ---------------- */

const tourKey = computed(() => tourKeyOf(route.name));
const hasTour = computed(() => !isPhone.value && !!TOURS[tourKey.value]);
const tourSteps = ref([]);
const tourOpen = ref(false);
let autoTimer = 0;

/** 只放 target 真的在页面上的那几步（栏目收起 / 画布还没渲染好都会缺） */
function openTour() {
  const steps = liveSteps(TOURS[tourKey.value] || []);
  if (!steps.length) return;
  tourSteps.value = steps;
  tourOpen.value = true;
}

function onTourClose() {
  markTourSeen(tourKey.value);
}

function scheduleAutoTour() {
  clearTimeout(autoTimer);
  tourOpen.value = false;
  const key = tourKey.value;
  if (!key || isPhone.value || tourSeen(key)) return;
  // 画布那页要等 Excalidraw 动态 import 完才有工具条，放晚一点；其它页 0.9s 够
  autoTimer = setTimeout(openTour, key === 'board' ? 1600 : 900);
}

watch(() => route.name, scheduleAutoTour, { immediate: true });

onMounted(() => {
  window.addEventListener('resize', onResize);
  if (!store.boot) void loadBoot();
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  clearTimeout(autoTimer);
});
</script>

<template>
  <div class="app">
    <AppRail v-if="!isPhone" />
    <div class="workspace">
      <div v-if="isPhone && !allowOnPhone" class="phone-note phone-note-page">
        手机端只支持扫瓶签看化合物档案，记录本请在电脑上打开。
      </div>
      <router-view v-else />
    </div>
    <!-- 教程：右下角一个小 ?（每页第一次进来会自动放一遍，看完记下来，设置里能重置） -->
    <button v-if="hasTour && !tourOpen" class="tour-ask noprint" title="看这一页的教程" @click="openTour">?</button>
    <TourLayer v-model="tourOpen" :steps="tourSteps" @close="onTourClose" />
    <!-- 右键菜单全站只挂这一个（卡片上右键时由 lib/rowmenu.js 填内容） -->
    <ContextMenu />
  </div>
</template>

<style scoped>
.tour-ask {
  position: fixed; right: 14px; bottom: 12px; z-index: 45;
  width: 24px; height: 24px; padding: 0; border-radius: 50%;
  border: 1px solid var(--line-2); background: #fff;
  color: var(--ink-4); font-size: 12px; line-height: 1; cursor: pointer;
  box-shadow: 0 1px 3px rgba(20, 18, 14, 0.08);
}
.tour-ask:hover { color: var(--ink-2); border-color: var(--ink-4); }
</style>
