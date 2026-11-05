<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import CmpListPane from '../components/CmpListPane.vue';
import CmpGrid from '../components/CmpGrid.vue';
import CmpTable from '../components/CmpTable.vue';
import LabelBatchPanel from '../components/LabelBatchPanel.vue';
import { store, viewOf, setView, createCompound } from '../store.js';
import { toast } from '../lib/feedback.js';

/**
 * 化合物库：中栏列表 + 右边「卡片 / 表格」两种看法（跟实验记录页一个排法）。
 */
const router = useRouter();
const table = computed(() => viewOf('cmp') === 'table');
const batchOpen = ref(false);

const toggleView = () => setView('cmp', table.value ? 'card' : 'table');

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
    <div class="editor">
      <div class="grid-tools">
        <button class="btn btn-sm btn-ghost" :title="table ? '切成卡片墙' : '切成一行一条的表格'" @click="toggleView">
          <Icon name="grid" :size="12" /> {{ table ? '卡片视图' : '表格视图' }}
        </button>
        <button class="btn btn-sm btn-ghost" title="批量打印标签（当前列表里的化合物）" @click="batchOpen = true">
          <Icon name="qr" :size="12" /> 批量标签
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
