<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ExpPick from '../components/ExpPick.vue';
import DocGrip from '../components/DocGrip.vue';
import FilePreview from '../components/FilePreview.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { prompt, toast } from '../lib/feedback.js';
import { schemeParts } from '../lib/expScheme.js';
import { DEFAULT_FIELDS, variations } from '../lib/sctfields.js';
import { eqLabel, num, round } from '../lib/reagent.js';

/**
 * 把**多条**实验摊在一起，做成「汇报展示」的样子：
 * 每条一列，列里就一张小卡——编号 / 反应式 / 条件一行 / 相对基准改了什么 / 产率 + 选择性 / 产物 / TLC 小图，
 * 版式照 `lib/reportcard.js` 那张「一页汇报卡」（发给导师看的那张纸）。
 * 字段全表默认**不出现**，右上「明细」才展开（那才是逐项对齐、看当量细节的地方）。
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

/* ---------- 每条一列的那张小卡 ---------- */
const txt = (v) => (v == null ? '' : String(v).trim());
const mw = (v) => (num(v) == null ? '' : String(round(num(v), 2)));
const mass = (v) => (num(v) == null ? '' : `${round(num(v), 4)} g`);
const pct = (v) => (num(v) == null ? '' : `${round(num(v), 1)}%`);
const scale = (e) => (num(e.base_mmol) == null ? '' : `${round(num(e.base_mmol), 3)} mmol`);

/** 溶剂现在是投料表的一行（role=溶剂），老记录才看 `solvent` 字段 */
const solventOf = (e) => txt(((e && e.reagents) || []).find((r) => r.role === '溶剂' && txt(r.name))?.name) || txt(e.solvent);

/** 条件那几格，顺序就是卡片上 / 那一行的顺序 */
const COND_FIELDS = [
  ['溶剂', solventOf],
  ['温度', (e) => e.temperature],
  ['时间', (e) => e.duration],
  ['气氛', (e) => e.atmosphere],
  ['装置', (e) => e.apparatus],
  ['光照', (e) => e.light],
  ['规模', (e) => scale(e)],
];

/** 条件一行（照汇报卡的 `card-cond`）：空的自动略过，不摆占位 */
const condLine = (e) => COND_FIELDS.map(([, get]) => txt(get(e))).filter(Boolean).join(' · ');

/**
 * 几条记录的**共同条件**：只在卡片上方写一次。
 * 「突出变量」靠的就是这个——每一列不再重复同一串条件，剩下没被抽走的才是变量。
 */
const commonConds = computed(() => {
  const list = picked.value;
  if (list.length < 2) return [];
  const out = [];
  for (const [, get] of COND_FIELDS) {
    const v = txt(get(list[0]));
    if (v && list.every((e) => txt(get(e)) === v)) out.push(v);
  }
  return out;
});

/** 相对第一个（基准）改了什么：文案直接复用筛选表那套 `variations()`，两处口径一致 */
const base = computed(() => picked.value[0] || null);
function varLine(e) {
  if (!base.value || picked.value.length < 2 || e.id === base.value.id) return '';
  const v = variations(base.value, e);
  if (!v.length) return '重复 / 平行';
  // 拿两条不相干的反应来对照时能列出十几项，摊在卡上就没法看了：只留前 4 项
  return v.length > 4 ? `${v.slice(0, 4).join(' · ')} 等 ${v.length} 项` : v.join(' · ');
}

const yieldValue = (e) => (e && Number(e.no_yield) === 1 ? null : num(e.yield_pct));
const yieldText = (e) => {
  const y = yieldValue(e);
  return y == null ? (Number(e.no_yield) === 1 ? '不计' : '—') : `${round(y, 1)}%`;
};
const selText = (e) => txt(e.dr_ee) || (num(e.ee_pct) == null ? '' : `${e.ee_pct}% ee`);
const baseYield = computed(() => (picked.value.length > 1 ? yieldValue(picked.value[0]) : null));
function yieldDelta(e) {
  const y = yieldValue(e);
  if (baseYield.value == null || y == null) return '';
  const d = Math.round((y - baseYield.value) * 10) / 10;
  if (!d) return '';
  return `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
}

/* ---------- TLC：自由对比 ----------
   板子从卡片里拿出来单独并排：挑哪几条记录就出哪几张板子，不跟基准 / 变量 / 列宽绑，
   谁跟谁比由用户自己看（他明确要的就是「自由对比 TLC」）。 */
const tlcOf = (e) => ((e && e.attachments) || []).filter((at) => (at.category || '') === 'tlc');
const fileUrl = (at) => `/api/files/${at.id}`;
const preview = ref(null);
const tlcList = computed(() =>
  picked.value.flatMap((e) =>
    tlcOf(e).map((at) => ({
      id: at.id,
      code: e.code,
      src: fileUrl(at),
      name: at.original_name || 'TLC',
      // 展开剂 / Rf 一般记在附件备注里，没写就看记录那一格
      note: txt(at.note) || txt(e.tlc_note),
    }))
  )
);

/* ---------- 明细（默认收着） ---------- */
const showAll = ref(false);

function rowOf(label, vals) {
  const norm = vals.map((v) => String(v == null ? '' : v).trim());
  const filled = norm.filter(Boolean).length;
  const empty = filled === 0;
  // 每条都有值且全一样才算相同；只有一条填了值 = 加/去试剂，算差异（踩过）
  const same = !empty && filled === norm.length && new Set(norm).size === 1;
  return { label, vals, empty, same, diff: !empty && !same };
}
const row = (label, getter) => rowOf(label, picked.value.map((e) => txt(getter(e))));

const condRows = computed(() => [
  row('溶剂', solventOf),
  row('温度', (e) => e.temperature),
  row('时间', (e) => e.duration),
  row('气氛', (e) => e.atmosphere),
  row('装置', (e) => e.apparatus),
  row('光照', (e) => e.light),
  row('反应规模', (e) => scale(e)),
]);

const resultRows = computed(() => [
  row('产物', (e) => e.product_name),
  row('产率', (e) => (Number(e.no_yield) === 1 ? '不计' : pct(e.yield_pct))),
  row('选择性', (e) => e.dr_ee),
  row('产物 MW', (e) => mw(e.product_mw)),
  row('质量', (e) => mass(e.product_mass)),
]);

const reagentRows = computed(() => {
  const nameOf = (r) => txt(r.name) || txt(r.role) || '（未命名）';
  const maps = picked.value.map((e) => {
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

/** 分段按因果顺序排：条件 → 投料 → 结果 */
const sections = computed(() => [
  { key: 'cond', title: '条件', rows: condRows.value },
  { key: 'reag', title: '投料（当量）', rows: reagentRows.value },
  { key: 'res', title: '结果', rows: resultRows.value },
]);
// 明细里空行不摆（一条都没填，摊出来全是「—」）
const rowsOf = (sec) => sec.rows.filter((r) => !r.empty);
const sectionHas = (sec) => rowsOf(sec).length > 0;

const diffCount = computed(() => sections.value.reduce((n, s) => n + s.rows.filter((r) => r.diff).length, 0));

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
          <p class="page-desc">一条一张小卡：反应式、条件、改了什么、结果。要逐项对齐的明细在右上角。</p>
        </div>
        <span class="spacer" />
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
        <button v-if="picked.length > 1" class="btn btn-sm btn-ghost" @click="showAll = !showAll">
          {{ showAll ? '收起明细' : `明细${diffCount ? ` · ${diffCount} 处不同` : ''}` }}
        </button>
      </div>

      <div v-if="loading" class="cmp-empty">读取中…</div>
      <div v-else-if="!picked.length" class="cmp-empty">
        先挑两条记录（最多 5 条）——一条一张卡，改了哪儿、结果差多少一眼看完。
      </div>

      <template v-else>
        <!-- 几条都一样的条件只写一次，卡片上剩下的才是变量 -->
        <div v-if="commonConds.length" class="cmp-same-brief">
          <span class="cmp-same-brief-k">相同</span>{{ commonConds.join(' · ') }}
        </div>

        <!-- 一条一列：编号 / 反应式 / 变量 / 结果 / 产物 / TLC -->
        <div class="cmp-visual" :style="{ '--cmp-cols': Math.min(picked.length, 4) }">
          <section v-for="(e, i) in picked" :key="`v${e.id}`" class="cmp-col">
            <div class="cmp-col-head">
              <span class="mono">{{ e.code }}</span>
              <span v-if="i === 0 && picked.length > 1" class="cmp-base-tag">基准</span>
              <span class="cmp-col-date">{{ e.date }}</span>
            </div>
            <div v-if="svgs[i]" class="cmp-scheme" v-html="svgs[i]" />
            <div v-else class="cmp-scheme cmp-scheme-empty">（还没有能画的反应式）</div>
            <div v-if="picked.length > 1" class="cmp-var is-lead" :class="{ 'is-base': !varLine(e) }">
              {{ varLine(e) || '基准' }}
            </div>
            <div v-else-if="condLine(e)" class="cmp-cond">{{ condLine(e) }}</div>
            <div v-if="yieldText(e) !== '—' || selText(e)" class="cmp-res">
              <span class="cmp-res-y mono">{{ yieldText(e) }}</span>
              <span v-if="yieldDelta(e)" class="cmp-res-d mono">{{ yieldDelta(e) }}</span>
              <span v-if="selText(e)" class="cmp-res-sel">{{ selText(e) }}</span>
            </div>
            <div v-if="txt(e.product_name)" class="cmp-prod">产物 {{ txt(e.product_name) }}</div>
          </section>
        </div>

        <!-- TLC 自由对比：所有板子并排，各自带编号 + 展开剂，点开看大图 -->
        <section v-if="tlcList.length" class="cmp-tlc-box">
          <div class="cmp-note-head">
            <span class="cmp-note-title">TLC 对比</span>
            <span class="cmp-note-hint">{{ tlcList.length }} 张 · 点开看大图</span>
          </div>
          <div class="cmp-tlc is-free">
            <figure v-for="t in tlcList" :key="t.id">
              <img :src="t.src" :alt="t.name" loading="lazy" @click="preview = { src: t.src, name: t.name }" />
              <figcaption>
                <span class="mono">{{ t.code }}</span>
                <span v-if="t.note" class="cmp-tlc-note">{{ t.note }}</span>
              </figcaption>
            </figure>
          </div>
        </section>

        <!-- 明细：逐项对齐的整张表，默认收着 -->
        <table v-if="showAll" class="cmp-table cmp-multi">
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
                <tr v-for="r in rowsOf(sec)" :key="`${sec.key}-${r.label}`" :class="{ 'is-diff': r.diff, 'is-same': r.same }">
                  <th>{{ r.label }}</th>
                  <td v-for="(v, i) in r.vals" :key="i">{{ v || '—' }}</td>
                </tr>
              </template>
            </template>
          </tbody>
        </table>

        <!-- 结论 -->
        <section class="cmp-note-box">
          <div class="cmp-note-head">
            <span class="cmp-note-title">结论 / 推理</span>
            <span class="cmp-note-hint">草稿存在这台机器上；要进记录本点右边「存成筛选表」</span>
            <span class="spacer" />
            <button class="btn btn-sm" :disabled="saving" @click="saveAsScreening">
              <Icon name="table" :size="12" /> 存成筛选表
            </button>
          </div>
          <textarea
            v-model="note"
            class="cmp-note-input"
            rows="3"
            placeholder="比如：换成 LiHMDS 后杂质少了，产率低一点但 dr 更好；下一步试 −60 ℃"
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
