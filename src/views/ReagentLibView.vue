<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../lib/feedback.js';
import DocGrip from '../components/DocGrip.vue';

/**
 * 试剂库 = 「用过的试剂」的完整版。
 * 数据全从投料行汇总（服务端 /api/reagents）：同一个名字取最近一次的组分 / 分子量 /
 * 浓度 / 密度，再折一个「1 mmol ≈ 多少 g / 多少 µL」，称量的时候直接照着抄。
 */
const items = ref([]);
const q = ref('');
const loading = ref(true);

const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  if (!k) return items.value;
  return items.value.filter(
    (it) => String(it.name || '').toLowerCase().includes(k) || String(it.role || '').includes(k)
  );
});

const solidCount = computed(() => items.value.filter((it) => it.mw && !it.per_mmol_ul).length);

async function load() {
  loading.value = true;
  try {
    items.value = await api.reagents(store.project);
  } catch {
    items.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => store.project, load);

/** 点一行就把名字复制走——录记录时多半是要粘到试剂名那一格 */
async function copyName(it) {
  try {
    await navigator.clipboard.writeText(it.name);
    toast(`已复制「${it.name}」`, 'ok', 1600);
  } catch {
    toast('复制不了（浏览器没给权限）', 'warn');
  }
}

const gPer = (it) => (it.per_mmol_g == null ? '' : `${it.per_mmol_g} g`);
const ulPer = (it) => (it.per_mmol_ul == null ? '' : `${it.per_mmol_ul} µL`);
</script>

<template>
  <div class="single">
    <div class="inner">
      <DocGrip />
      <header class="page-head rl-head">
        <div>
          <h1 class="page-title">试剂库</h1>
          <p class="page-desc">
            用过的试剂都在这里：某个名字最近一次用的组分、分子量、浓度 / 密度，以及「1 mmol 折多少 g / µL」。点一行复制名字。
          </p>
        </div>
        <span class="spacer" />
        <input v-model="q" class="rl-search" placeholder="搜试剂名 / 组分…" spellcheck="false" />
      </header>

      <div v-if="loading" class="rl-empty">读取中…</div>
      <div v-else-if="!items.length" class="rl-empty">
        还没有用过的试剂。在记录页的投料表里填几行，这里就会自动攒出来。
      </div>

      <template v-else>
        <div class="rl-sum">
          {{ items.length }} 个试剂 · 固体 {{ solidCount }} 个 · 液体 {{ items.length - solidCount }} 个
          <span v-if="q.trim()">· 筛出 {{ shown.length }} 个</span>
        </div>

        <table class="rl-table">
          <thead>
            <tr>
              <th>试剂</th>
              <th>组分</th>
              <th class="n">MW</th>
              <th class="n">浓度 / 密度</th>
              <th class="n">1 mmol ≈</th>
              <th class="n">用过</th>
              <th class="n">最近</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in shown" :key="it.name" @click="copyName(it)" :title="`点一下复制「${it.name}」`">
              <td class="rl-name">{{ it.name }}</td>
              <td class="rl-role">{{ it.role || '—' }}</td>
              <td class="n mono">{{ it.mw == null ? '—' : Number(it.mw).toFixed(2) }}</td>
              <td class="n mono">
                <template v-if="it.conc">={{ Number(it.conc).toFixed(2) }} M</template>
                <template v-else-if="it.per_mmol_ul">ρ {{ Number(it.density).toFixed(2) }}</template>
                <template v-else>—</template>
              </td>
              <td class="n mono">
                <template v-if="it.per_mmol_g">{{ gPer(it) }}</template>
                <template v-if="it.per_mmol_ul"> · {{ ulPer(it) }}</template>
                <template v-if="!it.per_mmol_g && !it.per_mmol_ul">—</template>
              </td>
              <td class="n mono">{{ it.uses }}</td>
              <td class="n mono rl-last">
                {{ it.lastCode || '' }}
                <span v-if="it.lastAt" class="rl-date">{{ it.lastAt }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!shown.length" class="rl-empty">没有匹配的试剂。</div>
      </template>
    </div>
  </div>
</template>
