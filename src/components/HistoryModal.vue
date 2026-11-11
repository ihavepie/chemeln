<script setup>
import { onMounted, reactive, ref } from 'vue';
import AppModal from './AppModal.vue';
import { api } from '../api.js';
import { toast } from '../lib/feedback.js';

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
const emit = defineEmits(['close', 'restored']);

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

/** 正在恢复哪一行（`${eventId}:${field}`），只用来做按钮态 */
const busy = ref('');

/**
 * 把这一格改回「改之前」的值。历史不只是看——真改错了要能一键退回去。
 * 恢复本身也会写一条新的留痕（「按 X 那次改动之前的值恢复了…」），所以再退也退得回来。
 */
async function restore(it, c) {
  const key = `${it.id}:${c.f}`;
  if (busy.value) return;
  busy.value = key;
  try {
    const body = { event: it.id, field: c.f };
    await api.historyRestore(props.entity, props.id, body);
    toast(`已改回：${c.label}`, 'ok', 2200);
    emit('restored');
    await load();
  } catch (e) {
    toast(e.message || '恢复失败', 'err');
  } finally {
    busy.value = '';
  }
}

async function load() {
  try {
    items.value = await api.history(props.entity, props.id);
  } catch {
    items.value = [];
  } finally {
    loading.value = false;
  }
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
            <button
              v-if="c.can"
              type="button"
              class="chg-restore"
              :disabled="!!busy"
              :title="`把「${c.label}」改回 ${c.from || '空'}（这次改动之前的${c.label}）`"
              @click.stop="restore(it, c)"
            >
              {{ busy === `${it.id}:${c.f}` ? '恢复中…' : '改回去' }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <p class="hint" style="margin-top: 12px">
      同一段时间里对同一字段的连续改动会合并成一行，所以「改前」是最初的值。长文本在列表里只显示开头，「改回去」用的是完整原值；恢复本身也会留一条新记录。
    </p>
  </AppModal>
</template>
