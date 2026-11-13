<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ExpPick from '../components/ExpPick.vue';
import DocGrip from '../components/DocGrip.vue';
import FilePreview from '../components/FilePreview.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { prompt, toast } from '../lib/feedback.js';
import { schemeParts } from '../lib/expScheme.js';
import { DEFAULT_FIELDS } from '../lib/sctfields.js';
import { eqLabel, num, round } from '../lib/reagent.js';

/**
 * 把**多条**实验摊在一起：反应式 / 结果 / TLC 一条一列，下面只列「不一样」的行。
 * 相同的一律收进一行「相同」（点开才摊平），一条都没填的行直接不出现——
 * 用户要的是信息陈列：变的那一两行要一眼看见，别被九成相同的行埋掉。
 * 只读，不改任何记录。
 */
const route = useRoute();
const router = useRouter();

const exps = ref([]);
const svgs = ref([]);
const loading = ref(false);
let cmps = null;

const MAX = 5;

/** URL：`?ids=1,2,3`（也认老的 `?a=&b=`） */
const ids = computed(() => {
  const q = route.query;
  const raw = String(q.ids || '').trim();
  if (raw) return raw.split(',').map((n) => Number(n)).filter((n) => n > 0).slice(0, MAX);
  return [Number(q.a) || 0, Number(q.b) || 0].filter((n) => n > 0);
});

function go(list) {
  const clean = [...new Set(list.map(Number).filter((n) => n > 0))].slice(0, MAX);
  router.replace(`/compare${clean.length ? `?ids=${clean.join(',')}` : ''}`);
}

async function load() {
  loading.value = true;
  try {
    const got = await Promise.all(ids.value.map((id) => api.experiment(id).catch(() => null)));
    exps.value = got.filter(Boolean);
    svgs.value = await Promise.all(exps.value.map((e) => schemeOf(e)));
  } finally {
    loading.value = false;
  }
}

/** 按投料表把这条记录的反应式画出来（不铺白底） */
async function schemeOf(exp) {
  try {
    if (!cmps) cmps = await api.compounds();
    const parts = schemeParts(exp, cmps);
    const { composeChainSvg, composeSchemeSvg } = await import('../lib/scheme.js');
    if (parts.stages && parts.stages.length > 1) return await composeChainSvg({ stages: parts.stages, background: false });
    if (!parts.reactants.length) return '';
    return await composeSchemeSvg({
      reactants: parts.reactants,
      reactantIds: parts.reactantIds,
      product: parts.product,
      productId: parts.productId,
      productLabel: parts.productLabel,
      above: parts.above,
      below: parts.below,
      background: false,
    });
  } catch {
    return '';
  }
}

watch(() => route.query, load, { immediate: true, deep: true });

/* ---------- 挑记录 ---------- */
const picking = ref(false);
const picked = computed(() => exps.value);

function openPick() {
  picking.value = true;
}
function onPicked(list) {
  picking.value = false;
  const add = (list || []).map(Number).filter((n) => n > 0);
  if (!add.length) return;
  go([...ids.value, ...add]);
}
function dropSide(id) {
  go(ids.value.filter((n) => Number(n) !== Number(id)));
}

/* ---------- 字段 ---------- */
const txt = (v) => (v == null ? '' : String(v).trim());
const mw = (v) => (num(v) == null ? '' : String(round(num(v), 2)));
const mass = (v) => (num(v) == null ? '' : `${round(num(v), 4)} g`);
const pct = (v) => (num(v) == null ? '' : `${round(num(v), 1)}%`);
const scale = (e) => (num(e.base_mmol) == null ? '' : `${round(num(e.base_mmol), 3)} mmol`);

/**
 * 一行 = 一个字段在各条记录里的值，分三档：
 * `empty` 一条都没填（不显示）、`same` 每条都有值且全一样（收进「相同」）、`diff` 其余（摊在表里）。
 * 注意 `same` 要求**每条都填了**：只有一条填了值（`RuPhos — — 20 mol%`）是加/去试剂，
 * 属于差异，不能因为「去重后只剩一个值」就当成相同（踩过）。
 * 以前这两种都照原样画出来，于是满屏「—」和整片一样的行，真正变的那一两行反而找不着。
 */
function rowOf(label, vals) {
  const norm = vals.map((v) => String(v == null ? '' : v).trim());
  const filled = norm.filter(Boolean).length;
  const empty = filled === 0;
  const same = !empty && filled === norm.length && new Set(norm).size === 1;
  return { label, vals, empty, same, diff: !empty && !same };
}
const row = (label, getter) => rowOf(label, exps.value.map((e) => txt(getter(e))));

const condRows = computed(() => [
  row('溶剂', (e) => e.solvent),
  row('温度', (e) => e.temperature),
  row('时间', (e) => e.duration),
  row('气氛', (e) => e.atmosphere),
  row('装置', (e) => e.apparatus),
  row('光照', (e) => e.light),
  row('反应规模', (e) => scale(e)),
]);

/** `minor` = 派生量（MW / 质量算得出来），只在「全部字段」里露 —— 摆出来只会挤掉真正要看的那两行 */
const resultRows = computed(() => [
  row('产物', (e) => e.product_name),
  row('产率', (e) => (Number(e.no_yield) === 1 ? '不计' : pct(e.yield_pct))),
  row('选择性', (e) => e.dr_ee),
  { ...row('产物 MW', (e) => mw(e.product_mw)), minor: true },
  { ...row('质量', (e) => mass(e.product_mass)), minor: true },
]);

/** 投料：按试剂名对齐（同一行 = 同一个试剂在各条记录里的当量） */
const reagentRows = computed(() => {
  const nameOf = (r) => txt(r.name) || txt(r.role) || '（未命名）';
  const maps = exps.value.map((e) => {
    const m = new Map();
    for (const r of (e && e.reagents) || []) {
      const k = nameOf(r);
      const eq = eqLabel(r.eq) || '—';
      m.set(k, m.has(k) ? `${m.get(k)} / ${eq}` : eq);
    }
    return m;
  });
  const keys = [...new Set(maps.flatMap((m) => [...m.keys()]))];
  return keys.map((k) => rowOf(k, maps.map((m) => m.get(k) || '')));
});

/** 分段按因果顺序排：条件 → 投料 → 结果（结果压在最下面，读起来跟筛选表一样） */
const sections = computed(() => [
  { key: 'cond', title: '条件', rows: condRows.value },
  { key: 'reag', title: '投料（当量）', rows: reagentRows.value },
  { key: 'res', title: '结果', rows: resultRows.value },
]);

/* 折叠：默认只看差异；「全部字段」摊开所有（空行这时才以「—」出现） */
const showAll = ref(false);
const openSame = reactive({});
// 只挑了一条记录时没啥可折叠的，照旧整张列出来
const allRows = computed(() => showAll.value || picked.value.length < 2);

const sectionHas = (sec) => {
  const list = visible(sec);
  return list.length > 0 && (allRows.value || list.some((r) => r.diff || r.same));
};
/** 「全部字段」时什么都不筛；平时派生量（MW / 质量）和一条都没填的行都不出现 */
function visible(sec) {
  return showAll.value ? sec.rows : sec.rows.filter((r) => !r.minor && !r.empty);
}
function rowsOf(sec) {
  const list = visible(sec);
  if (allRows.value) return list;
  const diff = list.filter((r) => r.diff);
  return openSame[sec.key] ? [...diff, ...list.filter((r) => r.same)] : diff;
}
const sameOf = (sec) => (allRows.value || openSame[sec.key] ? [] : visible(sec).filter((r) => r.same));
const sameSummary = (sec) =>
  sameOf(sec)
    .map((r) => {
      const v = r.vals.find((x) => String(x || '').trim()) || '';
      // 只有「—」的行（试剂没填当量）就别写成「RuPhos —」，光留个名字
      return v && v !== '—' ? `${r.label} ${v}` : r.label;
    })
    .join(' · ');
function toggleSame(key) {
  openSame[key] = !openSame[key];
}

/* ---------- 每条一列：结果放大（产率 + 相对第一列差多少） ---------- */
const yieldValue = (e) => (e && Number(e.no_yield) === 1 ? null : num(e.yield_pct));
const yieldText = (e) => {
  const y = yieldValue(e);
  return y == null ? (Number(e.no_yield) === 1 ? '不计' : '—') : `${round(y, 1)}%`;
};
const selText = (e) => txt(e.dr_ee) || (num(e.ee_pct) == null ? '' : `${e.ee_pct}% ee`);
// 基准 = 挑进来的第一条；只有它自己时不给差量
const baseYield = computed(() => (picked.value.length > 1 ? yieldValue(picked.value[0]) : null));
function yieldDelta(e) {
  const y = yieldValue(e);
  if (baseYield.value == null || y == null) return '';
  const d = Math.round((y - baseYield.value) * 10) / 10;
  if (!d) return '';
  return `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
}

/** 顶部：哪几行不一样 */
const diffLabels = computed(() => sections.value.flatMap((s) => s.rows.filter((r) => r.diff).map((r) => r.label)));

/* ---------- TLC ---------- */
const tlcOf = (e) => ((e && e.attachments) || []).filter((at) => (at.category || '') === 'tlc');
const fileUrl = (at) => `/api/files/${at.id}`;
const preview = ref(null);

/* ---------- 结论 ---------- */
const noteKey = computed(() => `eln:cmp-note:${ids.value.slice().sort((a, b) => a - b).join('-')}`);
const note = ref('');
watch(
  noteKey,
  (k) => {
    try {
      note.value = k ? localStorage.getItem(k) || '' : '';
    } catch {
      note.value = '';
    }
  },
  { immediate: true }
);
watch(note, (v) => {
  const k = noteKey.value;
  if (!k) return;
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 存不下就算了，草稿而已 */
  }
});

const saving = ref(false);
/** 把这几条 + 结论存成一张筛选表（进「条件筛选 → 我的筛选表」，那边是三线表） */
async function saveAsScreening() {
  if (!exps.value.length || saving.value) return;
  const title = await prompt({
    title: '存成筛选表',
    body: '这几条记录会进「条件筛选 → 我的筛选表」，结论写进表注。',
    value: exps.value.map((e) => e.code).join(' / '),
    confirmText: '存成表',
  });
  if (!title) return;
  saving.value = true;
  try {
    const s = await api.createScreening({
      title,
      note: note.value,
      // 列先给成筛选表默认那三列（相对标准条件 / 产率 / 选择性），进去再加减
      vars: DEFAULT_FIELDS.map((f) => ({ ...f })),
      entries: exps.value.map((e) => ({ exp_id: e.id })),
      project: store.project || exps.value[0]?.project || '',
    });
    toast('已存成筛选表', 'ok');
    router.push(`/s/${s.id}`);
  } catch (e) {
    toast(e.message || '存不了', 'err');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="single">
    <div class="inner">
      <DocGrip />
      <header class="page-head cmp-head">
        <div>
          <h1 class="page-title">对照</h1>
          <p class="page-desc">
            一条一列摊开，下面<b>只列不一样的行</b>——一样的收进「相同」，没填的不出现；
            结论自己写，顺手能存成一张筛选表。
          </p>
        </div>
        <span class="spacer" />
        <span v-if="diffLabels.length" class="cmp-diffsum">
          不同：<b>{{ diffLabels.slice(0, 7).join(' · ') }}</b>
          <template v-if="diffLabels.length > 7"> 等 {{ diffLabels.length }} 处</template>
        </span>
      </header>

      <!-- 挑进来的记录：一条一颗，点 × 拿掉 -->
      <div class="cmp-picks">
        <span v-for="e in picked" :key="e.id" class="cmp-pick">
          <span class="mono">{{ e.code }}</span>
          <span class="cmp-pick-title">{{ e.title || e.objective || '（未命名）' }}</span>
          <button class="cmp-pick-x" title="从对照里拿掉" @click="dropSide(e.id)"><Icon name="x" :size="10" /></button>
        </span>
        <button v-if="picked.length < 5" class="btn btn-sm btn-ghost" @click="openPick">
          <Icon name="plus" :size="12" /> {{ picked.length ? '再加一条' : '挑记录' }}
        </button>
        <button v-if="picked.length" class="btn btn-sm btn-ghost" @click="go([])">清空</button>
        <span class="spacer" />
        <button v-if="picked.length" class="btn btn-sm btn-ghost" @click="showAll = !showAll">
          {{ showAll ? '只看差异' : '全部字段' }}
        </button>
      </div>

      <div v-if="loading" class="cmp-empty">读取中…</div>
      <div v-else-if="!picked.length" class="cmp-empty">
        先挑两条记录（最多 5 条）——条件、投料、结果会按行对齐，不一样的地方摊在前面。
      </div>

      <template v-else>
        <!-- 并排：反应式 → 结果 → TLC -->
        <div class="cmp-visual" :style="{ '--cmp-cols': Math.min(picked.length, 4) }">
          <section v-for="(e, i) in picked" :key="`v${e.id}`" class="cmp-col">
            <div class="cmp-col-head">
              <span class="mono">{{ e.code }}</span>
              <span v-if="i === 0 && picked.length > 1" class="cmp-base-tag">基准</span>
              <span class="cmp-col-date">{{ e.date }}</span>
            </div>
            <div v-if="svgs[i]" class="cmp-scheme" v-html="svgs[i]" />
            <div v-else class="cmp-scheme cmp-scheme-empty">（还没有能画的反应式）</div>
            <div v-if="yieldText(e) !== '—' || selText(e)" class="cmp-res">
              <span class="cmp-res-y mono">{{ yieldText(e) }}</span>
              <span v-if="yieldDelta(e)" class="cmp-res-d mono">{{ yieldDelta(e) }}</span>
              <span v-if="selText(e)" class="cmp-res-sel">{{ selText(e) }}</span>
            </div>
            <div v-if="tlcOf(e).length" class="cmp-tlc">
              <figure v-for="at in tlcOf(e)" :key="at.id">
                <img
                  :src="fileUrl(at)"
                  :alt="at.original_name || 'TLC'"
                  loading="lazy"
                  @click="preview = { src: fileUrl(at), name: at.original_name || 'TLC' }"
                />
                <figcaption>{{ at.note || at.original_name || 'TLC' }}</figcaption>
              </figure>
            </div>
            <div v-else class="cmp-tlc-empty">没有 TLC 图</div>
          </section>
        </div>

        <!-- 逐行对齐：只有差异行 + 一行折叠的「相同」 -->
        <table class="cmp-table cmp-multi">
          <thead>
            <tr>
              <th />
              <th v-for="e in picked" :key="`h${e.id}`" class="mono">{{ e.code }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="sec in sections" :key="sec.key">
              <template v-if="sectionHas(sec)">
                <tr class="cmp-sec"><td :colspan="picked.length + 1">{{ sec.title }}</td></tr>
                <tr
                  v-for="r in rowsOf(sec)"
                  :key="`${sec.key}-${r.label}`"
                  :class="{ 'is-diff': r.diff && picked.length > 1, 'is-same': r.same && picked.length > 1 }"
                >
                  <th>{{ r.label }}</th>
                  <td v-for="(v, i) in r.vals" :key="i">{{ v || '—' }}</td>
                </tr>
                <tr v-if="sameOf(sec).length" class="cmp-same-row">
                  <th>相同</th>
                  <td :colspan="picked.length">
                    <button class="cmp-same-tog" :title="`展开这 ${sameOf(sec).length} 项`" @click="toggleSame(sec.key)">
                      <span class="cmp-same-txt">{{ sameSummary(sec) }}</span>
                      <span class="cmp-same-n">{{ sameOf(sec).length }} 项</span>
                      <Icon name="down" :size="10" />
                    </button>
                  </td>
                </tr>
                <tr v-else-if="!allRows && openSame[sec.key]" class="cmp-same-row">
                  <th>相同</th>
                  <td :colspan="picked.length">
                    <button class="cmp-same-tog" @click="toggleSame(sec.key)">
                      <span class="cmp-same-txt">收起</span>
                      <Icon name="arrow-left" :size="10" />
                    </button>
                  </td>
                </tr>
              </template>
            </template>
          </tbody>
        </table>

        <!-- 结论 -->
        <section class="cmp-note-box">
          <div class="cmp-note-head">
            <span class="cmp-note-title">结论 / 推理</span>
            <span class="cmp-note-hint">这里是草稿（存在这台机器上）；要进记录本点右边「存成筛选表」</span>
            <span class="spacer" />
            <button class="btn btn-sm" :disabled="saving" @click="saveAsScreening">
              <Icon name="table" :size="12" /> 存成筛选表
            </button>
          </div>
          <textarea
            v-model="note"
            class="cmp-note-input"
            rows="4"
            placeholder="比如：LDA 换成 LiHMDS 后杂质少了，产率低一点但 dr 更好；下一步试 −60 ℃"
          />
        </section>
      </template>

      <FilePreview v-if="preview" :src="preview.src" :name="preview.name" @close="preview = null" />

      <ExpPick
        :model-value="picking"
        title="挑几条记录放在一起"
        confirm-text="放进来"
        :exclude="ids"
        @close="picking = false"
        @confirm="onPicked"
      />
    </div>
  </div>
</template>
