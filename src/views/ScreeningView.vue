<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { loadBoot, store } from '../store.js';
import { num, round } from '../lib/reagent.js';
import { useAutosave } from '../lib/autosave.js';
import { applyNumeric } from '../lib/numinput.js';
import { confirm, prompt, toast } from '../lib/feedback.js';

const props = defineProps({ screeningId: { type: [String, Number], required: true } });
const router = useRouter();

const s = ref(null);
const error = ref('');

const model = reactive({ title: '', note: '', vars: [], entries: [] });

function fill(data) {
  s.value = data;
  model.title = data.title || '';
  model.note = data.note || '';
  model.vars = [...(data.vars || [])];
  model.entries = (data.entries || []).map((e) => ({
    label: e.label || '',
    values: { ...(e.values || {}) },
    yield_pct: e.yield_pct ?? '',
    ee_pct: e.ee_pct ?? '',
    dr: e.dr || '',
    note: e.note || '',
  }));
}

async function load() {
  try {
    fill(await api.screening(props.screeningId));
    markLoaded();
  } catch (e) {
    error.value = e.message;
  }
}

onMounted(load);

/** 换一张筛选表：组件会被复用，重新读 */
watch(
  () => props.screeningId,
  async (id, old) => {
    if (!id || id === old) return;
    try {
      if (dirty.value) await flush();
    } catch {
      /* 状态栏已有提示 */
    }
    await load();
  }
);

const best = computed(() => model.entries.reduce((m, e) => Math.max(m, num(e.yield_pct) || 0), 0));

function payload() {
  return {
    title: model.title,
    note: model.note,
    vars: model.vars,
    entries: model.entries.map((e) => ({
      label: e.label,
      values: { ...e.values },
      yield_pct: num(e.yield_pct),
      ee_pct: num(e.ee_pct),
      dr: e.dr,
      note: e.note,
    })),
  };
}

async function save() {
  if (!s.value) return;
  await api.saveScreening(s.value.id, payload());
}

const { state: saveState, dirty, flush, markLoaded } = useAutosave(payload, save, {
  delay: 700,
  enabled: () => !!s.value,
  onError: (e) => toast(e.message, 'err'),
});

async function push() {
  await api.saveScreening(s.value.id, payload());
  await load();
}

async function addRow() {
  model.entries.push({
    label: String(model.entries.length + 1),
    values: {},
    yield_pct: '',
    ee_pct: '',
    dr: '',
    note: '',
  });
  await push();
}

async function addVar() {
  const name = await prompt({ title: '添加一个变量', placeholder: '如：催化剂 / 配体 / 溶剂 / 温度 / 添加物', confirmText: '添加' });
  if (!name) return;
  model.vars.push(name);
  model.entries.forEach((e) => (e.values[name] = e.values[name] || ''));
  await push();
}

/** 产率 / ee 只收数字（避免把「85%」「abc」这类存进去） */
function onNum(ev, target, field) {
  applyNumeric(ev.target, '');
  target[field] = ev.target.value;
}

async function removeRow(i) {
  model.entries.splice(i, 1);
  await push();
}

const isBest = (e) => best.value > 0 && num(e.yield_pct) === best.value;

function exportAs(kind) {
  window.open(`/api/screenings/${s.value.id}/export.${kind}`, '_blank');
}

async function remove() {
  const ok = await confirm({ title: '删除这张筛选表？', body: '删除后不可恢复。', confirmText: '删除', danger: true });
  if (!ok) return;
  await api.deleteScreening(s.value.id);
  await loadBoot();
  router.push('/screenings');
  toast('已删除这张筛选表');
}
</script>

<template>
  <div v-if="error" class="single"><div class="empty-note" style="padding: 80px">{{ error }}</div></div>
  <div v-else-if="!s" class="single"><div class="empty-note" style="padding: 80px">读取中…</div></div>

  <div v-else class="editor" style="padding: 0">
    <div class="editor-bar">
      <span class="mono" style="font-size: 10.5px; color: var(--ink-4); letter-spacing: 0.08em">筛选表</span>
      <span class="spacer" />
      <span class="save-state">{{ saveState }}</span>
      <button class="btn btn-sm" @click="exportAs('md')">
        <Icon name="download" :size="13" /> Markdown
      </button>
      <button class="btn btn-sm" @click="exportAs('csv')">
        <Icon name="download" :size="13" /> CSV
      </button>
    </div>

    <div class="editor-inner wide">
      <header class="exp-head">
        <div class="code-row">
          <span class="mono" style="font-size: 10.5px; color: var(--ink-4); letter-spacing: 0.08em">
            {{ s.exp_id ? `关联 ${store.boot?.settings.code_prefix || ''} 实验` : '独立筛选表' }}
          </span>
        </div>
        <input class="title-input" v-model="model.title" placeholder="本轮筛选目标" />
        <div class="meta-row">
          <div class="meta-field" style="flex: 1">
            <span>说明</span>
            <input v-model="model.note" placeholder="固定条件与评价指标" style="flex: 1" />
          </div>
        </div>
      </header>

      <section class="card">
        <div class="card-head">
          <h2 class="card-title"><span class="n">01</span>变量与结果</h2>
          <span class="spacer" />
          <button class="btn btn-sm" @click="addVar"><Icon name="plus" :size="13" /> 加变量</button>
          <button class="btn btn-sm" @click="addRow"><Icon name="plus" :size="13" /> 加条件</button>
        </div>
        <div class="rtable-wrap">
          <table class="stable">
            <thead>
              <tr>
                <th style="width: 88px">编号</th>
                <th v-for="(v, i) in model.vars" :key="i">
                  <input v-model="model.vars[i]" placeholder="变量名" />
                </th>
                <th style="width: 74px" class="n">产率 %</th>
                <th style="width: 66px" class="n">ee %</th>
                <th style="width: 76px">dr</th>
                <th style="width: 34px" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(e, ri) in model.entries" :key="ri" :class="{ best: isBest(e) }">
                <td><input v-model="e.label" :placeholder="String(ri + 1)" /></td>
                <td v-for="(v, vi) in model.vars" :key="vi">
                  <input v-model="e.values[v]" placeholder="—" />
                </td>
                <td><input class="n" :value="e.yield_pct" inputmode="decimal" @input="onNum($event, e, 'yield_pct')" /></td>
                <td><input class="n" :value="e.ee_pct" inputmode="decimal" @input="onNum($event, e, 'ee_pct')" /></td>
                <td><input v-model="e.dr" /></td>
                <td><button class="rowdel" title="删除" @click="removeRow(ri)"><Icon name="x" :size="12" /></button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="rtable-foot">
          <span class="hint">
            {{ model.entries.length }} 组条件<template v-if="best">
              · 最佳产率 <b style="color: var(--ok)">{{ round(best, 1) }}%</b></template
            >
          </span>
          <span class="spacer" style="flex: 1" />
        </div>
      </section>

      <div class="danger-zone" style="margin: 0 0 60px">
        <div class="row">
          <button class="btn btn-sm btn-danger" @click="remove"><Icon name="trash" :size="13" /> 删除这张筛选表</button>
        </div>
      </div>
    </div>

  </div>
</template>
