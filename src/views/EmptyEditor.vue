<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ExpListPane from '../components/ExpListPane.vue';
import ExpGrid from '../components/ExpGrid.vue';
import ExpTable from '../components/ExpTable.vue';
import { viewOf, setView, createExperiment, addCategory } from '../store.js';
import { prompt, toast } from '../lib/feedback.js';

/**
 * 实验记录页：中栏列表 + 右边「卡片 / 表格」两种看法。
 * 两者读同一份 store.items，中栏搜什么筛什么就跟着变——表格只是另一种排法。
 */
const router = useRouter();
const table = computed(() => viewOf('exp') === 'table');

const toggleView = () => setView('exp', table.value ? 'card' : 'table');

/** 卡片墙上直接建一个实验分类：空分类会在墙上占一格，接着就能往里拖卡片 */
async function newCategory() {
  const name = await prompt({ title: '新建分类', placeholder: '比如：方法学 A、手性配体库', confirmText: '建' });
  if (!name) return;
  try {
    await addCategory(name, 'experiment');
    toast(`建好了「${name}」，卡片墙上已经多出一格`);
  } catch (e) {
    toast(e.message || '建不了这个分类', 'err');
  }
}

async function create() {
  try {
    const exp = await createExperiment();
    router.push(`/e/${exp.id}`);
  } catch (e) {
    toast(e.message || '建不了这条记录', 'err');
  }
}
</script>

<template>
  <div class="panes">
    <ExpListPane />
    <div class="editor">
      <div class="grid-tools">
        <button class="btn btn-sm btn-ghost" :title="table ? '切成卡片墙' : '切成一行一条的表格'" @click="toggleView">
          <Icon name="grid" :size="12" /> {{ table ? '卡片视图' : '表格视图' }}
        </button>
        <button class="btn btn-sm btn-ghost" title="新建一个实验分类（卡片墙上多出一格）" @click="newCategory">
          <Icon name="plus" :size="12" /> 新建分类
        </button>
        <button class="btn btn-sm btn-ghost" title="新建一条实验记录" @click="create">
          <Icon name="plus" :size="12" /> 新建实验
        </button>
      </div>
      <ExpTable v-if="table" />
      <ExpGrid v-else />
    </div>
  </div>
</template>
