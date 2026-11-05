<script setup>
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import AppModal from './AppModal.vue';
import { api } from '../api.js';
import { toast } from '../lib/feedback.js';
import { CATEGORY_LABEL, CATEGORY_ORDER, fmtSize, guessCategory, isImageName } from '../lib/ui.js';

const props = defineProps({
  expId: { type: Number, required: true },
  attachments: { type: Array, default: () => [] },
  locked: Boolean,
  dropped: { type: Array, default: () => [] },
});
const emit = defineEmits(['refresh', 'consumed']);

const fileInput = ref(null);
const cat = ref('auto');
const note = ref('');
const pathModal = ref(false);
const pathValue = ref('');
const recat = ref(null);
const dragging = ref(false);

const groups = computed(() => {
  const map = new Map();
  for (const a of props.attachments) {
    const k = CATEGORY_ORDER.includes(a.category) ? a.category : 'other';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(a);
  }
  return CATEGORY_ORDER.filter((k) => map.has(k)).map((k) => ({ key: k, label: CATEGORY_LABEL[k], list: map.get(k) }));
});

async function uploadFiles(files, category) {
  if (!files?.length || props.locked) return;
  const buckets = new Map();
  for (const f of files) {
    const c = category && category !== 'auto' ? category : guessCategory(f.name);
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c).push(f);
  }
  try {
    for (const [c, list] of buckets) {
      const fd = new FormData();
      for (const f of list) fd.append('file', f, f.name);
      fd.append('category', c);
      fd.append('note', note.value || '');
      await api.upload(props.expId, fd);
    }
    note.value = '';
    emit('refresh');
    toast(files.length > 1 ? `已添加 ${files.length} 个文件` : '已添加 1 个文件');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function onPick(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  void uploadFiles(files, cat.value);
}

function onDrop(e) {
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files || []);
  void uploadFiles(files, cat.value);
}

async function importPath() {
  const p = pathValue.value.trim();
  pathModal.value = false;
  if (!p) return;
  try {
    await api.uploadPath(props.expId, { path: p, category: cat.value === 'auto' ? 'nmr_raw' : cat.value, note: note.value });
    pathValue.value = '';
    emit('refresh');
    toast('已从路径导入');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function setCategory(a, category) {
  await api.updateAttachment(a.id, { category });
  recat.value = null;
  emit('refresh');
  toast(`已归到「${CATEGORY_LABEL[category] || category}」`);
}

async function remove(a) {
  try {
    await api.deleteAttachment(a.id);
    emit('refresh');
    toast('已删除这个附件');
  } catch (e) {
    toast(e.message, 'err');
  }
}

const openFile = (a) => window.open(`/api/files/${a.id}`, '_blank');
</script>

<template>
  <section class="sec sec-att">
    <h2 class="sec-title"><span class="num">附</span>谱图与附件<span class="hint">{{ attachments.length }} 个</span></h2>

    <div v-if="!locked" class="att-tools noprint">
      <select v-model="cat" class="select">
        <option value="auto">自动识别（按文件名）</option>
        <option v-for="k in CATEGORY_ORDER" :key="k" :value="k">{{ CATEGORY_LABEL[k] }}</option>
      </select>
      <input v-model="note" class="input" placeholder="说明（可选）" />
      <button class="btn btn-sm" @click="fileInput.click()"><Icon name="upload" :size="13" /> 选择文件</button>
      <button class="btn btn-sm" @click="pathModal = true"><Icon name="folder" :size="13" /> 从路径导入</button>
      <input ref="fileInput" type="file" multiple hidden @change="onPick" />
    </div>

    <div
      v-if="!locked"
      class="dropzone noprint"
      :class="{ over: dragging }"
      @click="fileInput.click()"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="big">拖文件到这里，或者直接 ⌘V 粘贴截图</div>
    </div>

    <div>
      <div v-for="g in groups" :key="g.key" class="att-group">
        <div class="att-group-head">
          <span class="t">{{ g.label }}</span>
          <span class="rule" />
          <span class="t">{{ g.list.length }}</span>
        </div>
        <div class="att-list">
          <div v-for="a in g.list" :key="a.id" class="att-item">
            <img v-if="isImageName(a.original_name || a.filename)" class="att-thumb" :src="`/api/files/${a.id}`" alt="" loading="lazy" />
            <div v-else class="att-ico"><Icon :name="a.is_dir ? 'folder' : 'file'" :size="14" /></div>
            <span class="att-name" :title="a.original_name" @click="openFile(a)">{{ a.original_name || a.filename }}</span>
            <span v-if="a.note" class="tag plain" style="font-size: 9px">{{ a.note }}</span>
            <span class="att-sub">{{ a.is_dir ? '文件夹' : fmtSize(a.size) }}</span>
            <button v-if="!locked" class="att-del" title="改分类" @click="recat = a"><Icon name="dots" :size="12" /></button>
            <button v-if="!locked" class="att-del" title="删除" @click="remove(a)"><Icon name="trash" :size="13" /></button>
          </div>
        </div>
      </div>
      <div v-if="!attachments.length" class="hint noprint" style="padding: 10px 0">
        暂无附件。谱图、mnova 文件与 TLC 照片均可置于此处，也可直接 ⌘V 粘贴。
      </div>
    </div>

    <AppModal v-if="pathModal" title="从路径导入" confirm-text="导入" @close="pathModal = false" @confirm="importPath">
      请输入本机绝对路径（文件或文件夹）。Bruker 原始数据通常为 <span class="mono">…/实验名/10</span> 形式的目录。
      <input v-model="pathValue" class="input" placeholder="/Users/you/NMR/2026-10-27_反应A/10" style="font-family: var(--mono); font-size: 12px; margin-top: 10px" />
    </AppModal>

    <AppModal v-if="recat" title="这条附件归到哪一类？" :show-confirm="false" cancel-text="取消" @close="recat = null">
      <div class="cat-picker">
        <button
          v-for="k in CATEGORY_ORDER"
          :key="k"
          class="cat-opt"
          :aria-selected="k === recat.category ? 'true' : 'false'"
          @click="setCategory(recat, k)"
        >
          {{ CATEGORY_LABEL[k] }}
        </button>
      </div>
    </AppModal>
  </section>
</template>
