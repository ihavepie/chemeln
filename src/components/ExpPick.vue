<script setup>
import { computed, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import Icon from './Icon.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../lib/feedback.js';

/**
 * 「从实验记录里挑几条」的弹窗（建筛选表 / 往表里加行都用它）。
 * 只挑不建：选中的 id 通过 confirm 事件交回调用方，具体塞进哪儿由调用方决定。
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  /** 已经在表里的 id，别再让勾 */
  exclude: { type: Array, default: () => [] },
  title: { type: String, default: '挑几条实验' },
});
const emit = defineEmits(['close', 'confirm']);

const q = ref('');
const all = ref([]);
const picked = ref({});
const loading = ref(false);
const loaded = ref(false);

const excl = computed(() => new Set((props.exclude || []).map(Number)));

async function load() {
  loading.value = true;
  try {
    const items = await api.experiments(store.project ? { project: store.project } : {});
    all.value = items || [];
    loaded.value = true;
  } catch (e) {
    toast(e.message || '拉不到记录', 'err');
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (v) => {
    if (!v) return;
    picked.value = {};
    q.value = '';
    if (!loaded.value) void load();
  }
);

const list = computed(() => {
  const kw = q.value.trim().toLowerCase();
  return all.value.filter((e) => {
    if (excl.value.has(Number(e.id))) return false;
    if (!kw) return true;
    return `${e.code} ${e.title} ${e.substrates || ''} ${e.product_name || ''}`.toLowerCase().includes(kw);
  });
});

const pickedCount = computed(() => Object.keys(picked.value).length);
const toggle = (id) => {
  if (picked.value[id]) delete picked.value[id];
  else picked.value[id] = true;
};
const cond = (e) =>
  [e.temperature, e.solvent, e.duration].filter(Boolean).join(' · ') || '—';

function confirm() {
  const ids = Object.keys(picked.value).map(Number);
  if (!ids.length) return toast('先勾几条', 'err');
  emit('confirm', ids);
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="title"
    confirm-text="加入"
    width="560px"
    :close-on-backdrop="false"
    @close="emit('close')"
    @confirm="confirm"
  >
    <div class="searchrow" style="margin-bottom: 8px">
      <input v-model="q" class="input" placeholder="搜编号、标题、底物、产物…" />
      <span class="px-meta">{{ pickedCount }} 条已选</span>
    </div>

    <div v-if="loading" class="empty-note">正在拉记录…</div>
    <div v-else-if="!list.length" class="empty-note">没有可挑的记录（已经是表里的会藏起来）。</div>
    <ul v-else class="xpick-list">
      <li v-for="e in list" :key="e.id">
        <button type="button" class="xpick-row" :class="{ 'is-on': picked[e.id] }" @click="toggle(e.id)">
          <span class="xpick-box"><Icon v-if="picked[e.id]" name="check" :size="10" /></span>
          <span class="xpick-code mono">{{ e.code }}</span>
          <span class="xpick-title">{{ e.title || '（未命名实验）' }}</span>
          <span class="xpick-cond">{{ cond(e) }}</span>
          <span class="xpick-y mono">{{ e.yield_pct == null ? '' : `${e.yield_pct}%` }}</span>
        </button>
      </li>
    </ul>
  </AppModal>
</template>
