<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { STATUS_TONE } from '../lib/ui.js';

/**
 * 手机端的门：`#/m`。
 * 站在通风橱前手机能做的其实就两件事 —— 找到某条实验（看/拍照）、扫瓶签看化合物。
 * 所以这里只列最近实验，点进去就是那条的移动页（里面有拍照上传）。
 */
const list = ref([]);
const error = ref('');
const loading = ref(true);

onMounted(async () => {
  try {
    const r = await api.experiments({ sort: 'newest' });
    list.value = (r || []).slice(0, 30);
  } catch (e) {
    error.value = e.message || '列表读不出来';
  } finally {
    loading.value = false;
  }
});

const rows = computed(() => list.value);
</script>

<template>
  <div class="phone-cmp">
    <div class="phone-head">
      <div class="phone-code mono">EXP · ELN</div>
      <h1 class="phone-name">最近实验</h1>
      <p class="phone-hint">点一条进去看内容、拍 TLC / 照片 / 谱图；画结构式请回电脑。</p>
    </div>

    <div v-if="error" class="phone-note">{{ error }}</div>
    <div v-else-if="loading" class="phone-note">读取中…</div>

    <ul v-else class="phone-list">
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

    <p class="phone-foot">瓶签二维码可直接打开化合物档案</p>
  </div>
</template>
