<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppRail from './components/AppRail.vue';
import ContextMenu from './components/ContextMenu.vue';
import { loadBoot, store } from './store.js';
import { useRailSize } from './lib/panesize.js';

const route = useRoute();
// 左侧导轨和内容之间那条竖线可以拖（DSH 那种分隔条），宽度存 localStorage
const { railResizing, startRailDrag, resetRailWidth } = useRailSize();

/** 手机端只提供「扫瓶签看化合物档案」这一页，别的路由没有入口也不渲染 */
const isPhone = ref(typeof window !== 'undefined' && window.innerWidth <= 820);
const onResize = () => { isPhone.value = window.innerWidth <= 820; };
const allowOnPhone = computed(() =>
  ['compound', 'editor', 'mobile'].includes(route.name)
);

onMounted(() => {
  window.addEventListener('resize', onResize);
  if (!store.boot) void loadBoot();
});
onBeforeUnmount(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <div class="app">
    <AppRail v-if="!isPhone" />
    <span
      v-if="!isPhone"
      class="rail-grip"
      :class="{ 'is-on': railResizing }"
      title="拖动改左侧导航宽度，双击恢复"
      @mousedown="startRailDrag"
      @dblclick="resetRailWidth"
      @dragstart.prevent
    />
    <div class="workspace">
      <div v-if="isPhone && !allowOnPhone" class="phone-note phone-note-page">
        手机端只支持扫瓶签看化合物档案，记录本请在电脑上打开。
      </div>
      <router-view v-else />
    </div>
    <!-- 右键菜单全站只挂这一个（卡片上右键时由 lib/rowmenu.js 填内容） -->
    <ContextMenu />
  </div>
</template>
