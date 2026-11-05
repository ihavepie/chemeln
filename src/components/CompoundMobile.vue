<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { isImageName } from '../lib/ui.js';
import { round } from '../lib/reagent.js';

/**
 * 手机端（≤820px）扫瓶签二维码后看到的东西：
 * 只读、只放这一页、**不做任何跳转**（没有任何链接），内容也精简
 * —— 站在通风橱前想知道的就这几项：结构式、分子式、MW、性状、熔点、TLC。
 */
const props = defineProps({ id: { type: [String, Number], required: true } });

const c = ref(null);
const error = ref('');

onMounted(async () => {
  try {
    c.value = await api.compound(props.id);
  } catch (e) {
    error.value = e.message || '读取不到这个化合物';
  }
});

const file = (cat) =>
  (c.value?.files || []).find((f) => f.category === cat && isImageName(f.original_name || f.filename));

const structure = computed(() => file('structure'));
const nmrs = computed(() =>
  ['h1', 'c13', 'nmr_other'].map((k) => ({ key: k, label: { h1: '¹H NMR', c13: '¹³C NMR', nmr_other: '其他谱图' }[k], f: file(k) })).filter((x) => x.f)
);

const rows = computed(() => {
  const d = c.value;
  if (!d) return [];
  return [
    ['类型', d.kind || ''],
    ['分子式', d.formula || ''],
    ['分子量', d.mw ? round(d.mw, 2) : ''],
    ['性状', d.appearance || ''],
    ['熔点', d.mp || ''],
    ['TLC', [d.tlc_rf ? `Rf ${d.tlc_rf}` : '', d.tlc_solvent].filter(Boolean).join('　')],
    ['说明', d.notes || ''],
  ].filter(([, v]) => v);
});
</script>

<template>
  <div class="phone-cmp">
    <div v-if="error" class="phone-note">{{ error }}</div>
    <div v-else-if="!c" class="phone-note">读取中…</div>

    <template v-else>
      <div class="phone-head">
        <div class="phone-code mono">{{ c.code || '—' }}</div>
        <h1 class="phone-name">{{ c.name || '（未命名）' }}</h1>
      </div>

      <div v-if="structure" class="phone-struct">
        <img :src="`/api/compound-files/${structure.id}`" alt="结构式" />
      </div>

      <dl class="phone-rows">
        <template v-for="[k, v] in rows" :key="k">
          <dt>{{ k }}</dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>

      <div v-if="c.smiles" class="phone-smiles">
        <div class="phone-label">SMILES</div>
        <div class="mono">{{ c.smiles }}</div>
      </div>

      <div v-if="nmrs.length" class="phone-spectra">
        <div class="phone-label">谱图</div>
        <figure v-for="n in nmrs" :key="n.key">
          <img :src="`/api/compound-files/${n.f.id}`" :alt="n.label" />
          <figcaption>{{ n.label }}</figcaption>
        </figure>
      </div>

      <p class="phone-foot">只读 · 扫码查看</p>
    </template>
  </div>
</template>
