<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { loadBoot, loadList } from '../store.js';
import { confirm, toast } from '../lib/feedback.js';
import DocGrip from '../components/DocGrip.vue';
import { openCtxMenu, CTX_SEP } from '../lib/ctxmenu.js';
import { setPageMenu } from '../lib/pagemenu.js';

/**
 * 回收站：删掉的实验 / 化合物暂存在这里。
 * 删除只是把记录从表里挪进 trash（附件文件还留在盘上），彻底删除时才真删文件。
 */
const items = ref([]);
const loading = ref(true);

const pad = (n) => String(n).padStart(2, '0');
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? `今天 ${hm}`
    : `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`;
}

const counts = computed(() => ({
  experiment: items.value.filter((t) => t.entity === 'experiment').length,
  compound: items.value.filter((t) => t.entity === 'compound').length,
}));

async function load() {
  loading.value = true;
  try {
    items.value = await api.trash();
  } catch {
    items.value = [];
  } finally {
    loading.value = false;
  }
}

let offPageMenu = null;
onMounted(() => {
  void load();
  offPageMenu = setPageMenu(pageMenuHere);
});
onBeforeUnmount(() => {
  if (offPageMenu) offPageMenu();
  offPageMenu = null;
});

async function restore(t) {
  try {
    const r = await api.restoreTrash(t.id);
    await load();
    await loadBoot();
    await loadList();
    toast(r.code ? `已恢复：${r.code}` : '已恢复到记录本里');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function purge(t) {
  const ok = await confirm({
    title: `彻底删除 ${t.label || '这条记录'}？`,
    body: '该记录及其附件文件将从磁盘删除，无法恢复。',
    confirmText: '彻底删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.purgeTrash(t.id);
    await load();
    await loadBoot();
    toast('已彻底删除');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 行的右键：恢复 / 彻底删除 */
function rowMenu(ev, t) {
  openCtxMenu(
    ev,
    [
      { key: 'restore', label: '恢复' },
      { key: 'purge', label: '彻底删除', danger: true },
    ],
    (key) => {
      if (key === 'restore') return restore(t);
      if (key === 'purge') return purge(t);
    }
  );
}

/** 本页空白处右键 */
function pageMenuHere(ev) {
  openCtxMenu(
    ev,
    [
      { key: 'reload', label: '刷新回收站' },
      ...(items.value.length ? [{ key: 'clear', label: '清空回收站', danger: true }] : []),
    ],
    (key) => {
      if (key === 'reload') return load();
      if (key === 'clear') return clearAll();
    }
  );
}

async function clearAll() {
  if (!items.value.length) return;
  const ok = await confirm({
    title: `清空回收站（${items.value.length} 条）？`,
    body: '回收站内的全部记录及其附件文件将被删除，无法恢复。',
    confirmText: '全部彻底删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.clearTrash();
    await load();
    await loadBoot();
    toast('回收站已清空');
  } catch (e) {
    toast(e.message, 'err');
  }
}
</script>

<template>
  <div class="single">
    <div class="inner">
      <DocGrip />
      <header class="page-head trash-head">
        <div>
          <h1 class="page-title">回收站</h1>
          <p class="page-desc">
            删除的实验与化合物暂存于此，附件文件仍保留在磁盘上。恢复后编号、投料表与附件均还原；彻底删除才会真删文件。
          </p>
        </div>
        <span class="spacer" />
        <button v-if="items.length" class="btn btn-sm btn-ghost" @click="clearAll">清空回收站</button>
      </header>

      <div v-if="loading" class="trash-empty">读取中…</div>
      <div v-else-if="!items.length" class="page-card trash-card"><div class="trash-empty">回收站为空。</div></div>

      <div v-else class="page-card trash-card">
        <div class="trash-sum">
          {{ items.length }} 条 · 实验 {{ counts.experiment }} 条 · 化合物 {{ counts.compound }} 个
        </div>
        <div class="trash-list">
          <div v-for="t in items" :key="t.id" class="trash-row" @contextmenu.prevent="rowMenu($event, t)">
            <span class="trash-kind">{{ t.entityName }}</span>
            <span class="trash-label">{{ t.label }}</span>
            <span class="spacer" />
            <span class="trash-when mono">{{ when(t.at) }}</span>
            <button class="btn btn-sm" @click="restore(t)">恢复</button>
            <button class="btn btn-sm btn-ghost" @click="purge(t)">彻底删除</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
