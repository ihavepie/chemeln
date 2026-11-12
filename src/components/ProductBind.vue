<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import AppModal from './AppModal.vue';
import { api } from '../api.js';
import { analyzeSmiles } from '../lib/chem.js';
import { productSmilesOf } from '../lib/expScheme.js';
import { round } from '../lib/reagent.js';
import { toast } from '../lib/feedback.js';

/**
 * **「绑定产物」**：把这条记录的产物跟化合物库里的档案对上。
 *
 * 以前那个「产物存库」是**新建一份档案**，还会把整张反应式当它的结构图存进去（不对）。
 * 现在默认是「绑定」——产物本来就有档案（中间体 / 产物都在库里），挑一个挂上就行；
 * 库里还没有的时候，走这条路：
 *   ① 反应式里读出来的产物结构（`scheme_smiles` 里 `>>` 后面那段，两条画法都会写）→ 建一份新的并绑定；
 *   ② 从库里挑（带结构缩略图，点一下即绑）；
 *   ③ 都没有 → 打开画板画一个（画板那边新建完会回调过来）。
 * 底部那条小字留着老的「连表征 / TLC / 操作一起建档案」，还没建档案时用。
 */
const props = defineProps({
  model: { type: Object, required: true },
  expCode: { type: String, default: '' },
  locked: Boolean,
});
const emit = defineEmits(['close', 'bind', 'create', 'draw', 'archive']);

const list = ref([]);
const loading = ref(true);
const q = ref('');
const info = ref(null);      // 反应式里那个产物：{ smiles, formula, mw, svg }
const reading = ref(false);
const readError = ref('');

const norm = (s) => String(s || '').replace(/\s+/g, '');

/** 反应式里那个产物的 SMILES（`lib/expScheme.js` 里跟「按投料表生成」共用同一个解析） */
const productSmiles = computed(() => productSmilesOf(props.model.scheme_smiles));

const bound = computed(
  () => list.value.find((c) => Number(c.id) === Number(props.model.product_compound_id)) || null
);

/** 库里已经有同样结构的：直接绑它，别再建一份 */
const same = computed(() => {
  const s = norm(productSmiles.value);
  if (!s) return null;
  return list.value.find((c) => norm(c.smiles) === s) || null;
});

/** 已经绑的就是反应式里这个结构：没什么可做的了 */
const alreadySame = computed(
  () => !!bound.value && !!same.value && Number(bound.value.id) === Number(same.value.id)
);

const shown = computed(() => {
  const key = q.value.trim().toLowerCase();
  if (!key) return list.value.slice(0, 40);
  return list.value
    .filter((c) =>
      [c.code, c.name, c.formula, c.mw].some((v) => String(v ?? '').toLowerCase().includes(key))
    )
    .slice(0, 40);
});

async function readReaction() {
  const smiles = productSmiles.value;
  if (!smiles) {
    readError.value = '这张反应式里没有产物结构（用「按投料表生成」或画一条带产物的反应式就有了）';
    return;
  }
  reading.value = true;
  try {
    const a = await analyzeSmiles(smiles);
    if (!a || !a.svg) readError.value = '这条产物 SMILES 读不出来';
    else info.value = { smiles, formula: a.formula || '', mw: a.mw ?? null, svg: a.svg };
  } catch {
    readError.value = '这条产物 SMILES 读不出来';
  } finally {
    reading.value = false;
  }
}

onMounted(async () => {
  try {
    list.value = await api.compounds();
  } catch (e) {
    toast(e.message || '化合物库没读出来', 'err');
  }
  loading.value = false;
  await readReaction();
});

function createNew() {
  emit('create', {
    smiles: info.value?.smiles || '',
    svg: info.value?.svg || '',
    formula: info.value?.formula || '',
    mw: info.value?.mw ?? null,
    name: props.model.product_name || `${props.expCode || ''} 产物`.trim(),
  });
}
</script>

<template>
  <AppModal title="绑定产物" :show-footer="false" width="620px" @close="emit('close')">
    <div class="pbind">
      <div class="pbind-now">
        <span class="pbind-lbl">现在</span>
        <span v-if="bound" class="pbind-bound">
          <span class="cmp-tag">{{ bound.code || bound.name }}</span>
          {{ bound.name }}
          <span v-if="props.model.product_name && props.model.product_name !== bound.name" class="pbind-muted">
            （结果块写的是「{{ props.model.product_name }}」）
          </span>
        </span>
        <span v-else class="pbind-muted">还没绑定——这张记录只写了产物名字{{ props.model.product_name ? `「${props.model.product_name}」` : '' }}</span>
      </div>

      <!-- ① 反应式里读 -->
      <section class="pbind-sec">
        <div class="pbind-head">
          <span class="pbind-lbl">① 反应式里的产物</span>
          <span v-if="reading" class="pbind-muted">读结构…</span>
          <span v-else-if="readError" class="pbind-muted">{{ readError }}</span>
          <span v-else-if="info" class="pbind-muted mono">{{ info.formula }}<template v-if="info.mw"> · {{ round(info.mw, 2) }}</template></span>
        </div>
        <div v-if="info" class="pbind-struct">
          <div class="pbind-svg" v-html="info.svg" />
          <div class="pbind-acts">
            <span v-if="alreadySame" class="pbind-ok">
              <Icon name="check" :size="12" /> 已经绑好了
            </span>
            <button v-else-if="same" type="button" class="btn btn-sm" @click="emit('bind', same)">
              绑定 {{ same.code || same.name }}
            </button>
            <button v-else type="button" class="btn btn-sm" :disabled="loading" @click="createNew">
              新建化合物并绑定
            </button>
            <span v-if="alreadySame" class="pbind-muted">反应式里的产物就是「{{ bound.code || bound.name }}」，不用再建</span>
            <span v-else-if="same" class="pbind-muted">库里已经有同样结构，直接绑它</span>
            <span v-else-if="bound" class="pbind-muted">
              库里没有这个结构；会另建一份，现在绑的「{{ bound.code || bound.name }}」留在库里不动
            </span>
            <span v-else class="pbind-muted">库里没有这个结构，会新建一份档案（带结构图 / 分子式 / MW）</span>
          </div>
        </div>
      </section>

      <!-- ② 从库里挑 -->
      <section class="pbind-sec">
        <div class="pbind-head">
          <span class="pbind-lbl">② 从库里挑</span>
          <input v-model="q" class="pbind-q" placeholder="搜编号 / 名称 / 分子式" spellcheck="false" />
        </div>
        <div class="recipe-list pbind-list">
          <button
            v-for="c in shown"
            :key="c.id"
            type="button"
            class="recipe-opt"
            :class="{ 'is-on': Number(c.id) === Number(props.model.product_compound_id) }"
            @click="emit('bind', c)"
          >
            <span class="recipe-thumb">
              <img v-if="c.structure_id" :src="`/api/compound-files/${c.structure_id}`" alt="" loading="lazy" />
              <Icon v-else name="molecule" :size="14" />
            </span>
            <span class="recipe-code mono">{{ c.code || '—' }}</span>
            <span class="recipe-title">{{ c.name || '（未命名）' }}</span>
            <span class="recipe-meta">{{ c.formula || '' }}{{ c.mw ? ` · ${c.mw}` : '' }}</span>
          </button>
          <div v-if="!shown.length" class="hint">{{ loading ? '读化合物库…' : '没有匹配的化合物' }}</div>
        </div>
      </section>

      <!-- ③ 画一个 -->
      <section class="pbind-sec pbind-sec-draw">
        <div class="pbind-head"><span class="pbind-lbl">③ 画一个</span></div>
        <div class="pbind-acts">
          <button type="button" class="btn btn-sm btn-ghost" @click="emit('draw')">打开画板画结构</button>
          <span class="pbind-muted">画完「用这个结构」→ 新建化合物并绑到这条记录</span>
        </div>
      </section>

      <div class="pbind-foot">
        <button type="button" class="pbind-link" @click="emit('archive')">
          连表征 / TLC / 操作一起建一份新档案
        </button>
      </div>
    </div>
  </AppModal>
</template>
