<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import CmpListPane from '../components/CmpListPane.vue';
import PaneGrip from '../components/PaneGrip.vue';
import CmpGrid from '../components/CmpGrid.vue';
import CmpTable from '../components/CmpTable.vue';
import LabelBatchPanel from '../components/LabelBatchPanel.vue';
import { store, viewOf, setView, groupOf, setGroup, createCompound, addCategory } from '../store.js';
import { prompt, toast } from '../lib/feedback.js';

/**
 * 化合物库：中栏列表 + 右边「卡片 / 表格」两种看法（跟实验记录页一个排法）。
 */
const router = useRouter();
const table = computed(() => viewOf('cmp') === 'table');
const batchOpen = ref(false);

const toggleView = () => setView('cmp', table.value ? 'card' : 'table');

/** 卡片墙按什么分组：分类（自己建的分桶）还是类型（底物/中间体/产物/配体…本身就等于一个个库） */
const kindMode = computed(() => groupOf('cmp') === 'kind');
const toggleGroup = () => setGroup('cmp', kindMode.value ? 'cat' : 'kind');

/** 卡片墙上直接建一个化合物分类：空分类会在墙上占一格，接着就能往里拖卡片 */
async function newCategory() {
  const name = await prompt({ title: '新建分类', placeholder: '比如：手性配体库、中间体', confirmText: '建' });
  if (!name) return;
  try {
    await addCategory(name, 'compound');
    toast(`建好了「${name}」，卡片墙上已经多出一格`);
  } catch (e) {
    toast(e.message || '建不了这个分类', 'err');
  }
}

async function create() {
  try {
    const c = await createCompound();
    router.push(`/c/${c.id}`);
  } catch (e) {
    toast(e.message || '建不了这个化合物', 'err');
  }
}
</script>

<template>
  <div class="panes">
    <CmpListPane />
    <PaneGrip />
    <div class="editor">
      <div class="grid-tools">
        <button class="btn btn-sm btn-ghost" :title="table ? '切成卡片墙' : '切成一行一条的表格'" @click="toggleView">
          <Icon name="grid" :size="12" /> {{ table ? '卡片视图' : '表格视图' }}
        </button>
        <button
          v-if="!table"
          class="btn btn-sm btn-ghost"
          :title="kindMode ? '按分类分组（你自己建的桶）' : '按类型分组：底物 / 中间体 / 产物 / 配体 各成一组'"
          @click="toggleGroup"
        >
          <Icon name="molecule" :size="12" /> {{ kindMode ? '按分类分组' : '按类型分组' }}
        </button>
        <button class="btn btn-sm btn-ghost" title="批量打印标签（当前列表里的化合物）" @click="batchOpen = true">
          <Icon name="qr" :size="12" /> 批量标签
        </button>
        <button class="btn btn-sm btn-ghost" title="新建一个化合物分类（卡片墙上多出一格）" @click="newCategory">
          <Icon name="plus" :size="12" /> 新建分类
        </button>
        <button class="btn btn-sm btn-ghost" title="新建一个化合物" @click="create">
          <Icon name="plus" :size="12" /> 新建化合物
        </button>
      </div>
      <CmpTable v-if="table" />
      <CmpGrid v-else />
    </div>
  </div>
  <LabelBatchPanel
    v-if="batchOpen"
    :compounds="store.compounds"
    :owner="store.boot?.settings?.owner_name || ''"
    @close="batchOpen = false"
  />
</template>
