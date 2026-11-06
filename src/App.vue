<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppRail from './components/AppRail.vue';
import ContextMenu from './components/ContextMenu.vue';
import { loadBoot, store } from './store.js';

const route = useRoute();

/** 手机端只提供「扫瓶签看化合物档案」这一页，别的路由没有入口也不渲染 */
const isPhone = ref(typeof window !== 'undefined' && window.innerWidth <= 820);
const onResize = () => { isPhone.value = window.innerWidth <= 820; };
const allowOnPhone = computed(() => route.name === 'compound' || route.name === 'editor');

onMounted(() => {
  window.addEventListener('resize', onResize);
  if (!store.boot) void loadBoot();
});
onBeforeUnmount(() => window.removeEventListener('resize', onResize));
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
    <!-- 右键菜单全站只挂这一个（卡片上右键时由 lib/rowmenu.js 填内容） -->
    <ContextMenu />
  </div>
</template>
