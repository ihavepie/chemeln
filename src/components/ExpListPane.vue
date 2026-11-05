<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from './Icon.vue';
import CatPick from './CatPick.vue';
import { store, loadList, loadBoot, recordCategories, addCategory } from '../store.js';
import { STATUSES, STATUS_TONE } from '../lib/ui.js';
import { api } from '../api.js';
import { prompt, toast } from '../lib/feedback.js';

const route = useRoute();
const router = useRouter();
const q = ref(store.filters.q);
let timer = null;

onMounted(() => {
  if (!store.items.length) void loadList();
});

watch(q, (v) => {
  store.filters.q = v;
  clearTimeout(timer);
  timer = setTimeout(() => void loadList(), 220);
});

/** 下拉里的一个值：分类 id / 'none' / 'status:进行中' —— 互斥，选一个清另一个 */
const filterValue = computed(
  () => store.filters.category || (store.filters.status ? `status:${store.filters.status}` : '')
);

async function setFilter(v) {
  if (v.startsWith('status:')) {
    store.filters.status = v.slice(7);
    store.filters.category = '';
  } else {
    store.filters.status = '';
    store.filters.category = v;
  }
  await loadList();
}

async function newCategory() {
  const name = await prompt({ title: '新建分类', placeholder: '比如：方法学 A、手性配体库', confirmText: '建' });
  if (!name) return;
  try {
    await addCategory(name, 'experiment');
    toast(`建好了「${name}」，在实验页的「分类」里选它`);
  } catch (e) {
    toast(e.message || '建不了这个分类', 'err');
  }
}

/** 这一条属于哪个分类（没有就是未分类） */
const catName = (it) => it.category_name || '';

const activeId = () => (route.name === 'editor' ? Number(route.params.id) : null);
</script>

<template>
  <div class="listpane">
    <div class="listpane-head">
      <!-- 分类 + 状态都收进右边这个下拉，跟搜索框并排一行 -->
      <div class="searchrow">
        <div class="searchbox">
          <Icon name="search" :size="13" />
          <input v-model="q" type="search" placeholder="搜试剂、条件、表征…" autocomplete="off" />
        </div>
        <CatPick
          :value="filterValue"
          :categories="recordCategories('experiment')"
          :statuses="STATUSES"
          count-key="exp_count"
          @change="setFilter"
          @create="newCategory"
        />
      </div>
    </div>

    <div class="listpane-body">
      <button
        v-for="it in store.items"
        :key="it.id"
        class="exp-card"
        :aria-current="it.id === activeId() ? 'true' : 'false'"
        @click="router.push(`/e/${it.id}`)"
      >
        <div class="top">
          <span class="exp-code">{{ it.code }}</span>
          <span class="tag" :class="STATUS_TONE[it.status]" style="font-size: 9px; padding: 1px 6px">{{ it.status }}</span>
          <span class="exp-date">{{ it.date }}</span>
        </div>
        <div class="exp-title">{{ it.title || '（未命名实验）' }}</div>
        <div class="exp-meta">
          <span v-if="catName(it)" class="cat-tag">{{ catName(it) }}</span>
          <span v-if="it.project">{{ it.project }}</span>
          <template v-if="it.rxn_type"><span class="sep">·</span><span>{{ it.rxn_type }}</span></template>
          <template v-if="it.yield_pct != null"><span class="sep">·</span><span style="color: var(--ok)">{{ it.yield_pct }}%</span></template>
          <template v-if="it.attach_count"><span class="sep">·</span><span>{{ it.attach_count }} 附件</span></template>
          <template v-if="it.locked"><span class="sep">·</span><span style="color: var(--accent)">已锁定</span></template>
        </div>
      </button>

      <div v-if="!store.items.length" class="empty-note">
        {{ store.filters.q ? '无匹配记录' : '暂无实验记录。' }}
      </div>
    </div>
  </div>
</template>
