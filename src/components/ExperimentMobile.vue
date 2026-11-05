<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { STATUS_TONE } from '../lib/ui.js';
import { amountText, num, round } from '../lib/reagent.js';

/**
 * 手机端（≤820px）扫实验二维码后看到的：只读、只这一页、没有任何链接。
 * 只放站在通风橱前用得上的：反应式、投料、条件、结果、表征。
 */
const props = defineProps({ id: { type: [String, Number], required: true } });

const e = ref(null);
const error = ref('');

onMounted(async () => {
  try {
    e.value = await api.experiment(props.id);
  } catch (err) {
    error.value = err.message || '读取不到这条实验';
  }
});

const scheme = computed(
  () => (e.value?.attachments || []).find((a) => a.category === 'scheme') || null
);

const rows = computed(() => (e.value?.reagents || []).filter((r) => String(r.name || '').trim()));

const conditions = computed(() => {
  const d = e.value;
  if (!d) return [];
  return [
    ['溶剂', [d.solvent, d.concentration].filter(Boolean).join('　')],
    ['温度', d.temperature],
    ['时间', d.duration],
    ['气氛', d.atmosphere],
    ['后处理', d.workup],
  ].filter(([, v]) => v);
});

const result = computed(() => {
  const d = e.value;
  if (!d) return [];
  return [
    ['产物', d.product_name],
    ['收率', d.yield_pct != null ? `${round(d.yield_pct, 1)}%` : ''],
    ['dr / ee', d.dr_ee],
    ['性状', d.appearance],
    ['TLC', d.tlc_note],
  ].filter(([, v]) => v);
});

const amount = (r) => amountText(r) || (num(r.amount_ul) ? `${round(num(r.amount_ul), 0)} μL` : '');
</script>

<template>
  <div class="phone-cmp">
    <div v-if="error" class="phone-note">{{ error }}</div>
    <div v-else-if="!e" class="phone-note">读取中…</div>

    <template v-else>
      <div class="phone-head">
        <div class="phone-code mono">{{ e.code }}{{ e.date ? ` · ${e.date}` : '' }}</div>
        <h1 class="phone-name">{{ e.title || '（未命名实验）' }}</h1>
        <div class="phone-tags">
          <span class="tag" :class="STATUS_TONE[e.status]">{{ e.status }}</span>
          <span v-if="e.project" class="tag plain">{{ e.project }}</span>
        </div>
      </div>

      <div v-if="scheme" class="phone-struct">
        <img :src="`/api/files/${scheme.id}`" alt="反应式" />
      </div>

      <div v-if="rows.length" class="phone-block">
        <div class="phone-label">投料</div>
        <table class="phone-table">
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td>{{ r.name }}</td>
              <td class="muted">{{ r.role || '' }}</td>
              <td class="num mono">{{ r.eq ? `${round(r.eq, 2)} eq` : '' }}</td>
              <td class="num mono">{{ amount(r) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <dl v-if="conditions.length" class="phone-rows">
        <template v-for="[k, v] in conditions" :key="k">
          <dt>{{ k }}</dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>

      <dl v-if="result.length" class="phone-rows">
        <template v-for="[k, v] in result" :key="k">
          <dt>{{ k }}</dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>

      <div v-if="e.characterization" class="phone-block">
        <div class="phone-label">表征</div>
        <p class="phone-text">{{ e.characterization }}</p>
      </div>

      <p class="phone-foot">只读 · 扫码查看</p>
    </template>
  </div>
</template>
