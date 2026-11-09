<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppRail from './components/AppRail.vue';
import ContextMenu from './components/ContextMenu.vue';
import { loadBoot, store } from './store.js';

const route = useRoute();
const router = useRouter();

/** 手机端只提供「扫瓶签看化合物档案」这一页，别的路由没有入口也不渲染 */
const isPhone = ref(typeof window !== 'undefined' && window.innerWidth <= 820);
const onResize = () => { isPhone.value = window.innerWidth <= 820; };
const allowOnPhone = computed(() =>
  ['compound', 'editor', 'mobile'].includes(route.name)
);

onMounted(() => {
  window.addEventListener('resize', onResize);
  if (!store.boot) void loadBoot();
  // 手机上直接打开根地址：进「最近实验」那一页，而不是那句「请到电脑上用」
  if (isPhone.value && (route.name === 'home' || route.name === 'list')) router.replace('/m');
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
