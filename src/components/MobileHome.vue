<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { STATUS_TONE } from '../lib/ui.js';
import { round } from '../lib/reagent.js';

/**
 * 手机端的门：`#/m`。
 * 站在通风橱前手机能做的其实就两件事 —— 找到某条实验（看/拍照）、扫瓶签看化合物。
 * 所以这里只列最近实验，点进去就是那条的移动页（里面有拍照上传）。
 */
const tab = ref('exp');           // exp | cmp
const list = ref([]);             // 实验
const cmpList = ref([]);          // 化合物
const q = ref('');
const error = ref('');
const loading = ref(true);

async function loadExps() {
  list.value = (await api.experiments({ sort: 'newest' }) || []).slice(0, 40);
}
async function loadCompounds(withQuery = '') {
  cmpList.value = (await api.compounds(withQuery ? { q: withQuery } : {}) || []).slice(0, 60);
}

onMounted(async () => {
  try {
    await Promise.all([loadExps(), loadCompounds()]);
  } catch (e) {
    error.value = e.message || '列表读不出来';
  } finally {
    loading.value = false;
  }
});

/** 搜索：实验按标题/编号，化合物走接口（编号、名称、分子式都能搜） */
let timer = null;
watch(q, (v) => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const k = String(v || '').trim();
    try {
      if (tab.value === 'cmp') await loadCompounds(k);
    } catch {
      /* 搜失败就保持原样 */
    }
  }, 220);
});

const rows = computed(() => {
  const k = String(q.value || '').trim().toLowerCase();
  if (!k || tab.value === 'cmp') return list.value;
  return list.value.filter((e) => `${e.code || ''} ${e.title || ''}`.toLowerCase().includes(k));
});

const colors = computed(() => cmpList.value.filter((c) => String(c.name || c.code || '').trim()));
</script>

<template>
  <div class="phone-cmp">
    <div class="phone-head">
      <div class="phone-code mono">EXP · ELN</div>
      <h1 class="phone-name">{{ tab === 'exp' ? '最近实验' : '化合物' }}</h1>
      <p class="phone-hint">
        {{ tab === 'exp' ? '点一条进去看内容、拍 TLC / 照片 / 谱图；画结构式请回电脑。' : '点一个看结构式、MW、谱图和性状；也可以直接搜编号或名字。' }}
      </p>
      <div class="phone-seg">
        <button type="button" :class="{ on: tab === 'exp' }" @click="tab = 'exp'">实验</button>
        <button type="button" :class="{ on: tab === 'cmp' }" @click="tab = 'cmp'">化合物</button>
      </div>
      <input class="phone-search" v-model="q" :placeholder="tab === 'exp' ? '搜编号 / 标题' : '搜编号 / 名称 / 分子式'" />
    </div>

    <div v-if="error" class="phone-note">{{ error }}</div>
    <div v-else-if="loading" class="phone-note">读取中…</div>

    <ul v-else-if="tab === 'exp'" class="phone-list">
      <li v-for="e in rows" :key="e.id">
        <a class="phone-item" :href="`#/e/${e.id}`">
          <span class="phone-item-top">
            <b class="mono">{{ e.code }}</b>
            <span class="tag" :class="STATUS_TONE[e.status]">{{ e.status }}</span>
          </span>
          <span class="phone-item-title">{{ e.title || '（未命名实验）' }}</span>
          <span class="phone-item-sub mono">{{ e.date || '' }}<template v-if="e.reagent_count"> · {{ e.reagent_count }} 行投料</template></span>
        </a>
      </li>
    </ul>
    <ul v-else class="phone-list">
      <li v-for="c in colors" :key="c.id">
        <a class="phone-item phone-item-cmp" :href="`#/c/${c.id}`">
          <img v-if="c.structure_id" class="phone-cmp-fig" :src="`/api/compound-files/${c.structure_id}`" alt="" loading="lazy" />
          <span v-else class="phone-cmp-fig is-empty" />
          <span class="phone-item-body">
            <span class="phone-item-top">
              <b class="mono">{{ c.code || '—' }}</b>
              <span v-if="c.kind" class="tag plain">{{ c.kind }}</span>
            </span>
            <span class="phone-item-title">{{ c.name || '（未命名）' }}</span>
            <span class="phone-item-sub mono">{{ c.formula || '' }}<template v-if="c.mw"> · {{ round(c.mw, 2) }}</template></span>
          </span>
        </a>
      </li>
      <li v-if="!colors.length" class="phone-hint" style="padding: 16px 2px">没有匹配的化合物</li>
    </ul>

    <p class="phone-foot">瓶签二维码可直接打开化合物档案</p>
  </div>
</template>
