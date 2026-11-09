<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import AppModal from '../components/AppModal.vue';
import ExpPick from '../components/ExpPick.vue';
import { api } from '../api.js';
import { prompt, toast, confirm } from '../lib/feedback.js';
import { SOURCES, DEFAULT_FIELDS, autoValue } from '../lib/sctfields.js';

/**
 * 一张条件筛选表：行 = 自己挑的实验，列 = 一串「字段」。
 *
 * 每列可以设成**自动**（温度 / 投料 / 产率 / ee…，直接读记录，改了记录这边跟着变）
 * 或者**手动**（单元格自己填，比如「配体」「观察」）。表里只存「挑了哪些实验」+
 * 「手动列填了什么」+「列定义」，自动列一格都不存，所以永远不会跟记录脱节。
 */
const route = useRoute();
const router = useRouter();

const s = ref(null);
const rows = ref([]);
const loading = ref(true);
const saving = ref(false);
const pickOpen = ref(false);

const id = computed(() => Number(route.params.id));
const fields = computed(() => (Array.isArray(s.value?.vars) ? s.value.vars : []));
const ids = computed(() => rows.value.map((r) => r.exp_id));
const isManual = (f) => !f.source || f.source === 'manual';

async function load() {
  loading.value = true;
  try {
    const d = await api.screening(id.value);
    s.value = d.screening;
    // 老表（字段还是纯字符串 / 没有 source）按手动列接住，别丢
    s.value.vars = (s.value.vars || []).map((f, i) =>
      typeof f === 'string' ? { key: `old${i}`, label: f, source: 'manual' } : { ...f, source: f.source || 'manual' }
    );
    rows.value = (d.rows || []).map((r) => ({ ...r, cells: { ...(r.cells || {}) } }));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(id, load);

let timer = 0;
/** 改一下就存（防抖 600ms）：这张表就几行，别让用户找保存按钮 */
function save() {
  clearTimeout(timer);
  saving.value = true;
  timer = setTimeout(async () => {
    try {
      await api.saveScreening(id.value, {
        title: s.value.title,
        vars: fields.value,
        entries: rows.value.map((r) => ({ exp_id: r.exp_id, cells: r.cells })),
      });
    } catch (e) {
      toast(e.message || '存不了', 'err');
    } finally {
      saving.value = false;
    }
  }, 600);
}

/* ---- 行 ---- */
function addRows(picked) {
  pickOpen.value = false;
  for (const expId of picked) if (!rows.value.some((r) => r.exp_id === expId)) rows.value.push({ exp_id: expId, cells: {}, exp: null });
  save();
  void load();
}

const removeRow = (i) => {
  rows.value.splice(i, 1);
  save();
};

/* ---- 字段 ---- */
const fieldOpen = ref(false);
const newLabel = ref('');
const newSource = ref('manual');

function openField() {
  newLabel.value = '';
  newSource.value = 'manual';
  fieldOpen.value = true;
}

function confirmField() {
  const label = newLabel.value.trim();
  if (!label) return toast('给它起个名字', 'err');
  const key = `f${Date.now().toString(36)}`;
  s.value.vars = [...fields.value, { key, label, source: newSource.value, num: newSource.value === 'yield' }];
  fieldOpen.value = false;
  save();
}

async function renameField(f) {
  const label = await prompt({ title: '改字段名', value: f.label, confirmText: '改' });
  if (!label || label === f.label) return;
  s.value.vars = fields.value.map((x) => (x.key === f.key ? { ...x, label } : x));
  save();
}

function removeField(f) {
  s.value.vars = fields.value.filter((x) => x.key !== f.key);
  for (const r of rows.value) delete r.cells[f.key];
  save();
}

async function renameScreen() {
  const title = await prompt({ title: '这张表叫什么', value: s.value.title, confirmText: '改' });
  if (!title || title === s.value.title) return;
  s.value.title = title;
  save();
}

async function removeScreen() {
  const ok = await confirm({
    title: `删掉「${s.value.title}」？`,
    body: '只是这张表没了，记录本身不受影响。',
    confirmText: '删掉',
    danger: true,
  });
  if (!ok) return;
  await api.deleteScreening(id.value);
  router.push('/screenings');
}

const base = computed(() => rows.value[0]?.exp || null);
const cell = (f, r) => (isManual(f) ? r.cells[f.key] || '' : autoValue(f.source, r.exp, base.value));
const subText = (exp) =>
  exp ? [exp.substrates, exp.product_name].filter(Boolean).join(' → ') || '—' : '记录已删';
</script>

<template>
  <div class="single">
    <div class="inner">
      <div v-if="loading" class="empty-note">正在打开…</div>
      <template v-else-if="s">
        <div class="scr-head">
          <h1 class="page-title">{{ s.title }}</h1>
          <button class="btn btn-sm btn-ghost" @click="renameScreen"><Icon name="edit" :size="12" /> 改名</button>
          <span class="spacer" />
          <span class="scr-save">{{ saving ? '保存中…' : '已保存' }}</span>
          <button class="btn btn-sm btn-ghost" @click="openField"><Icon name="plus" :size="12" /> 加字段</button>
          <button class="btn btn-sm btn-ghost" @click="pickOpen = true"><Icon name="plus" :size="12" /> 加实验</button>
          <button class="btn btn-sm btn-ghost scr-del" @click="removeScreen"><Icon name="trash" :size="12" /> 删表</button>
        </div>
        <p class="page-desc">
          列可以设成「自动」——温度 / 投料 / 产率这些直接读记录，改了记录这边跟着变；也可以是「手动」，自己填。点编号进那条记录。
        </p>

        <div v-if="!rows.length" class="empty-note">这张表还是空的，点右上「加实验」从记录里挑几条。</div>

        <div v-else class="scope-wrap">
          <table class="sct-table">
            <thead>
              <tr>
                <th class="sct-c-entry">Entry</th>
                <th class="sct-c-fix">编号</th>
                <th class="sct-c-fix">底物 → 产物</th>
                <th v-for="f in fields" :key="f.key" :class="{ 'sct-num': f.num }">
                  <div class="sct-th">
                    <span class="sct-th-label">{{ f.label }}</span>
                    <span v-if="isManual(f)" class="sct-th-src">手动</span>
                    <span class="sct-th-acts">
                      <button class="sct-var-x" title="改名" @click="renameField(f)">改</button>
                      <button class="sct-var-x is-del" title="删这一列" @click="removeField(f)">×</button>
                    </span>
                  </div>
                </th>
                <th class="sct-c-x"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in rows" :key="r.exp_id" :class="{ 'is-base': i === 0 }">
                <td class="sct-c-entry mono">{{ i + 1 }}</td>
                <td class="sct-c-fix">
                  <button v-if="r.exp" class="linklike mono" @click="router.push(`/e/${r.exp_id}`)">{{ r.exp.code }}</button>
                  <span v-else class="mono muted">#{{ r.exp_id }}</span>
                </td>
                <td class="sct-c-fix sct-sub">{{ subText(r.exp) }}</td>
                <td v-for="f in fields" :key="f.key" :class="{ 'sct-num': f.num, 'is-manual': isManual(f) }">
                  <input
                    v-if="isManual(f)"
                    v-model="r.cells[f.key]"
                    class="sct-cell"
                    @input="save()"
                  />
                  <span v-else class="sct-auto" :class="{ 'sct-wrap': f.source === 'reagent' }">{{ cell(f, r) || '—' }}</span>
                </td>
                <td class="sct-c-x">
                  <button class="sct-row-x" title="从表里去掉" @click="removeRow(i)">×</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <div v-else class="empty-note">这张筛选表不存在。</div>
    </div>

    <ExpPick :model-value="pickOpen" :exclude="ids" title="挑几条实验加进这张表" @close="pickOpen = false" @confirm="addRows" />

    <AppModal
      :model-value="fieldOpen"
      title="加一个字段"
      confirm-text="加"
      width="440px"
      @close="fieldOpen = false"
      @confirm="confirmField"
    >
      <div class="sct-form">
        <label class="sct-form-label">字段名</label>
        <input v-model="newLabel" class="input" placeholder="比如：配体、添加剂、观察" @keyup.enter="confirmField" />
      </div>
      <div class="sct-form">
        <label class="sct-form-label">内容</label>
        <div class="sct-src">
          <button
            v-for="opt in [{ key: 'manual', label: '手动填写' }, ...SOURCES]"
            :key="opt.key"
            type="button"
            class="sct-src-chip"
            :class="{ 'is-on': newSource === opt.key }"
            @click="newSource = opt.key"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </AppModal>
  </div>
</template>
