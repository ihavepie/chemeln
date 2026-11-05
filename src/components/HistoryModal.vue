<script setup>
import { onMounted, reactive, ref } from 'vue';
import AppModal from './AppModal.vue';
import { api } from '../api.js';

/**
 * 改动历史：这条记录什么时候被改过、改了什么、改前改后各是什么。
 * 数据来自 events 表（同一次编辑窗口里的连续改动服务端已经合并成一条，
 * 合并时保留最初的「改前」值 —— 所以这里看到的是这次编辑从头到尾的净变化）。
 */
const props = defineProps({
  entity: { type: String, default: 'experiment' }, // experiment | compound
  id: { type: [String, Number], required: true },
  title: { type: String, default: '修改历史' },
});
const emit = defineEmits(['close']);

const items = ref([]);
const loading = ref(true);
/** 哪几行展开了（key = event id） */
const open = reactive({});

const pad = (n) => String(n).padStart(2, '0');

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`;
}

onMounted(async () => {
  try {
    items.value = await api.history(props.entity, props.id);
    // 只有一条改动记录时直接摊开，省一次点击
    if (items.value.length && items.value[0].changes?.length) open[items.value[0].id] = true;
  } catch {
    items.value = [];
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <AppModal :title="props.title" width="560px" cancel-text="关闭" :show-confirm="false" @close="emit('close')">
    <div v-if="loading" class="hist-empty">读取中…</div>
    <div v-else-if="!items.length" class="hist-empty">暂无改动记录</div>
    <div v-else class="hist-list">
      <div v-for="it in items" :key="it.id" class="hist-item" :class="{ 'is-open': open[it.id] }">
        <button
          type="button"
          class="hist-row"
          :class="{ 'is-toggle': it.changes && it.changes.length }"
          @click="it.changes && it.changes.length ? (open[it.id] = !open[it.id]) : null"
        >
          <span class="hist-when">{{ when(it.at) }}</span>
          <span class="hist-text">{{ it.text }}</span>
          <span v-if="it.changes && it.changes.length" class="hist-caret">{{ open[it.id] ? '−' : '+' }}</span>
        </button>

        <div v-if="open[it.id] && it.changes && it.changes.length" class="hist-changes">
          <div v-for="(c, i) in it.changes" :key="i" class="chg">
            <span class="chg-label">{{ c.label }}</span>
            <span class="chg-from">{{ c.from || '（空）' }}</span>
            <span class="chg-arrow">→</span>
            <span class="chg-to">{{ c.to || '（清空）' }}</span>
          </div>
        </div>
      </div>
    </div>
    <p class="hint" style="margin-top: 12px">
      同一段时间里对同一字段的连续改动会合并成一行，所以「改前」是最初的值。长文本只留开头一段。
    </p>
  </AppModal>
</template>
