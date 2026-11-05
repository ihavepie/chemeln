<script setup>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { loadScreenings, store } from '../store.js';
import { round } from '../lib/reagent.js';

const router = useRouter();

onMounted(() => void loadScreenings());

async function create() {
  const s = await api.createScreening({ title: '未命名条件筛选' });
  router.push(`/s/${s.id}`);
}
</script>

<template>
  <div class="single">
    <div class="inner">
      <header class="page-head">
        <h1 class="page-title">条件筛选</h1>
        <p class="page-desc">方法学里的一轮平行实验：同一张表里换催化剂、配体、溶剂、温度，盯住产率和 ee。</p>
        <div class="mt16"><button class="btn btn-primary" @click="create"><Icon name="plus" :size="14" /> 新建筛选表</button></div>
      </header>

      <div class="scr-grid">
        <div v-for="s in store.screenings" :key="s.id" class="scr-card" @click="router.push(`/s/${s.id}`)">
          <div class="t">
            <b>{{ s.title }}</b>
            <span>{{ s.varCount }} 个变量 · {{ s.entryCount }} 组条件{{ s.best ? ` · 最佳 ${round(s.best, 1)}%` : '' }}</span>
          </div>
          <Icon name="chevron" :size="16" />
        </div>
        <div v-if="!store.screenings.length" class="empty-note">暂无条件筛选表。</div>
      </div>
    </div>
  </div>
</template>
