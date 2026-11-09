<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import AppModal from '../components/AppModal.vue';
import ExpPick from '../components/ExpPick.vue';
import { api } from '../api.js';
import { prompt, toast, confirm } from '../lib/feedback.js';
import { round } from '../lib/reagent.js';

/**
 * 一张条件筛选表：行 = 自己挑的实验，列 = 内置条件 / 结果 + 自己加的字段。
 *
 * 表里**只存两样东西**：挑了哪些实验（`entries[].exp_id`）、自定义列里手填的文字（`entries[].cells`）。
 * 编号 / 温度 / 溶剂 / 投料 / 产率 / 选择性这些永远读记录本身，所以改了记录这边自动跟着变，不会脱节。
 */
const route = useRoute();
const router = useRouter();

const s = ref(null);
const rows = ref([]);
const loading = ref(true);
const saving = ref(false);
const pickOpen = ref(false);

const id = computed(() => Number(route.params.id));
const vars = computed(() => (Array.isArray(s.value?.vars) ? s.value.vars : []));
const ids = computed(() => rows.value.map((r) => r.exp_id));

async function load() {
  loading.value = true;
  try {
    const d = await api.screening(id.value);
    s.value = d.screening;
    rows.value = (d.rows || []).map((r) => ({ ...r, cells: { ...(r.cells || {}) } }));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(id, load);

let timer = 0;
/** 改一下就存（防抖 600ms）：这张表就几行，别让用户找保存按钮 */
function save(patch = {}) {
  clearTimeout(timer);
  saving.value = true;
  timer = setTimeout(async () => {
    try {
      await api.saveScreening(id.value, {
        title: s.value.title,
        vars: vars.value,
        entries: rows.value.map((r) => ({ exp_id: r.exp_id, cells: r.cells })),
        ...patch,
      });
    } catch (e) {
      toast(e.message || '存不了', 'err');
    } finally {
      saving.value = false;
    }
  }, 600);
}

/* 行 */
function addRows(picked) {
  pickOpen.value = false;
  for (const expId of picked) if (!rows.value.some((r) => r.exp_id === expId)) rows.value.push({ exp_id: expId, cells: {}, exp: null });
  save();
  // 立刻重新拉一次，把新行的记录内容填上
  void load();
}
function removeRow(i) {
  rows.value.splice(i, 1);
  save();
}

/* 自定义字段 */
async function addVar() {
  const label = await prompt({ title: '加一个字段', placeholder: '比如：配体、添加剂、观察', confirmText: '加' });
  if (!label) return;
  const key = `v${Date.now().toString(36)}`;
  s.value.vars = [...vars.value, { key, label }];
  save();
}
async function renameVar(v) {
  const label = await prompt({ title: '改字段名', value: v.label, confirmText: '改' });
  if (!label || label === v.label) return;
  s.value.vars = vars.value.map((x) => (x.key === v.key ? { ...x, label } : x));
  save();
}
function removeVar(v) {
  s.value.vars = vars.value.filter((x) => x.key !== v.key);
  for (const r of rows.value) delete r.cells[v.key];
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

/* 单元格文本 */
const condText = (e) => [e.temperature, e.duration, e.atmosphere].filter(Boolean).join(' · ') || '';
const reagentText = (e) =>
  (e.reagents || [])
    .filter((r) => r.name)
    .map((r) => `${r.name}${r.eq === null || r.eq === undefined || r.eq === '' ? '' : ` ${r.eq} eq`}`)
    .join(' · ');
const yieldText = (e) => (e.no_yield ? '不计' : e.yield_pct == null ? '' : `${round(e.yield_pct, 1)}%`);
const selText = (e) => String(e.dr_ee || '').trim() || (e.ee_pct == null ? '' : `${e.ee_pct}% ee`);
</script>

<template>
  <div class="single">
    <div class="inner">
      <div v-if="loading" class="empty-note">正在打开…</div>
      <template v-else-if="s">
        <header class="page-head">
          <div class="scr-head">
            <h1 class="page-title">{{ s.title }}</h1>
            <button class="btn btn-sm btn-ghost" @click="renameScreen"><Icon name="edit" :size="12" /> 改名</button>
            <span class="spacer" />
            <span class="scr-save">{{ saving ? '保存中…' : '已保存' }}</span>
            <button class="btn btn-sm btn-ghost" @click="addVar"><Icon name="plus" :size="12" /> 加字段</button>
            <button class="btn btn-sm btn-ghost" @click="pickOpen = true"><Icon name="plus" :size="12" /> 加实验</button>
            <button class="btn btn-sm btn-ghost scr-del" @click="removeScreen"><Icon name="trash" :size="12" /> 删表</button>
          </div>
          <p class="page-desc">
            行是自己挑的实验；编号 / 条件 / 产率这些一直读记录本身，「加字段」加的列是自己手填的。点行首编号进那条记录。
          </p>
        </header>

        <div v-if="!rows.length" class="empty-note">
          这张表还是空的，点右上「加实验」从记录里挑几条。
        </div>

        <div v-else class="scope-wrap">
          <table class="sct-table">
            <thead>
              <tr>
                <th class="sct-col-code">编号</th>
                <th>底物 → 产物</th>
                <th>温度</th>
                <th>溶剂</th>
                <th>投料</th>
                <th class="sct-num">产率</th>
                <th class="sct-num">选择性</th>
                <th v-for="v in vars" :key="v.key" class="sct-var">
                  <span>{{ v.label }}</span>
                  <button class="sct-var-x" title="改字段名" @click="renameVar(v)">改</button>
                  <button class="sct-var-x is-del" title="删这一列" @click="removeVar(v)">×</button>
                </th>
                <th class="sct-col-x"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in rows" :key="r.exp_id">
                <td class="sct-col-code">
                  <button v-if="r.exp" class="linklike mono" @click="router.push(`/e/${r.exp_id}`)">{{ r.exp.code }}</button>
                  <span v-else class="mono muted">#{{ r.exp_id }}</span>
                </td>
                <td>
                  <template v-if="r.exp">
                    {{ r.exp.substrates || '—' }}
                    <template v-if="r.exp.product_name"> → {{ r.exp.product_name }}</template>
                  </template>
                  <span v-else class="muted">记录已删</span>
                </td>
                <td class="mono">{{ r.exp?.temperature || '—' }}</td>
                <td class="mono">{{ r.exp?.solvent || '—' }}</td>
                <td class="sct-reagent">{{ r.exp ? reagentText(r.exp) || '—' : '—' }}</td>
                <td class="sct-num mono">{{ r.exp ? yieldText(r.exp) : '—' }}</td>
                <td class="sct-num mono">{{ r.exp ? selText(r.exp) : '—' }}</td>
                <td v-for="v in vars" :key="v.key" class="sct-var">
                  <input v-model="r.cells[v.key]" class="sct-cell" @input="save()" />
                </td>
                <td class="sct-col-x">
                  <button class="sct-row-x" title="从表里去掉" @click="removeRow(i)">×</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <div v-else class="empty-note">这张筛选表不存在。</div>
    </div>

    <ExpPick
      :model-value="pickOpen"
      :exclude="ids"
      title="挑几条实验加进这张表"
      @close="pickOpen = false"
      @confirm="addRows"
    />
  </div>
</template>
