<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import DocGrip from '../components/DocGrip.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { prompt, confirm, toast } from '../lib/feedback.js';

/** 排版板列表：一张板一行，点进去就是那张自由画布 */
const router = useRouter();
const items = ref([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const r = await api.boards(store.project || '');
    items.value = r.items || [];
  } catch (e) {
    toast(e.message || '读不到排版板', 'err');
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function create() {
  const title = await prompt({ title: '新建排版板', value: '排版板', confirmText: '建' });
  if (!title) return;
  try {
    const r = await api.createBoard({ title, project: store.project || '' });
    router.push(`/b/${r.board.id}`);
  } catch (e) {
    toast(e.message || '建不了', 'err');
  }
}

async function del(b) {
  const yes = await confirm({
    title: `删掉「${b.title || '排版板'}」？`,
    body: '只删这张板，记录和附件都不动。',
    confirmText: '删掉',
    danger: true,
  });
  if (!yes) return;
  try {
    await api.deleteBoard(b.id);
    toast('已删掉', 'ok');
    load();
  } catch (e) {
    toast(e.message || '删不了', 'err');
  }
}

const when = (ts) => String(ts || '').replace('T', ' ').slice(0, 16);
</script>

<template>
  <div class="single">
    <div class="inner">
      <DocGrip />
      <header class="page-head">
        <div>
          <h1 class="page-title">排版板</h1>
          <p class="page-desc">自由画布：一条记录里的编号 / 反应式 / 条件 / 投料 / 结果 / 结论 / TLC，加上文字，随便摆在一张 A4 上，导出 PDF 贴进汇报里。</p>
        </div>
        <span class="spacer" />
        <button class="btn btn-sm" @click="create"><Icon name="plus" :size="12" /> 新建排版板</button>
      </header>

      <div v-if="loading" class="cmp-empty">读取中…</div>
      <div v-else-if="!items.length" class="page-card"><div class="cmp-empty">
        还没有排版板。点右上「新建排版板」，从左边挑几块摆上去试试。
      </div></div>

      <div v-else class="page-card board-card">
        <div class="board-list">
        <div v-for="b in items" :key="b.id" class="board-row" @click="router.push(`/b/${b.id}`)">
          <span class="board-row-title">{{ b.title || '（未命名）' }}</span>
          <span class="board-row-meta">{{ b.count }} 块素材</span>
          <span class="board-row-meta">{{ when(b.updated_at) }}</span>
          <span v-if="b.project" class="board-row-proj">{{ b.project }}</span>
          <button class="board-row-del" title="删掉这张板" @click.stop="del(b)"><Icon name="x" :size="10" /></button>
        </div>
        </div>
      </div>
    </div>
  </div>
</template>
