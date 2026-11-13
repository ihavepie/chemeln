<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ExpPick from '../components/ExpPick.vue';
import DocGrip from '../components/DocGrip.vue';
import FilePreview from '../components/FilePreview.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { schemeParts } from '../lib/expScheme.js';
import { eqLabel, num, round } from '../lib/reagent.js';

/**
 * 两条记录并排对照：反应式 / TLC 放上面并排看，条件、投料、结果按行对齐，
 * **不一样的地方标出来**——想对比两块板、或者把信息摊在一起推一推，都在这一页。
 * 只读，不改任何记录。
 */
const route = useRoute();
const router = useRouter();

const A = ref(null);
const B = ref(null);
const svgA = ref('');
const svgB = ref('');
const loading = ref(false);
let cmps = null;

const ids = computed(() => ({ a: Number(route.query.a) || 0, b: Number(route.query.b) || 0 }));

async function load() {
  const { a, b } = ids.value;
  loading.value = true;
  try {
    const [ea, eb] = await Promise.all([a ? api.experiment(a).catch(() => null) : null, b ? api.experiment(b).catch(() => null) : null]);
    A.value = ea;
    B.value = eb;
    await draw();
  } finally {
    loading.value = false;
  }
}

/** 按投料表把这条记录的反应式画出来（不铺白底：图直接贴在画布上） */
async function schemeOf(exp) {
  if (!exp) return '';
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

async function draw() {
  const [a, b] = await Promise.all([schemeOf(A.value), schemeOf(B.value)]);
  svgA.value = a;
  svgB.value = b;
}

watch(() => [route.query.a, route.query.b], load, { immediate: true });

/* ---------- 换边 ---------- */
const picking = ref('');
function openPick(side) {
  picking.value = side;
}
function onPicked(list) {
  const id = Number((list || [])[0]);
  picking.value = '';
  if (!id) return;
  const next = { ...ids.value, [picking.value || 'b']: id };
  router.replace(`/compare?a=${next.a || ''}&b=${next.b || ''}`);
}

/* ---------- 取字段 ---------- */
const txt = (v) => (v == null ? '' : String(v).trim());
const mw = (v) => (num(v) == null ? '' : String(round(num(v), 2)));
const mass = (v) => (num(v) == null ? '' : `${round(num(v), 4)} g`);
const pct = (v) => (num(v) == null ? '' : `${round(num(v), 1)}%`);
const scale = (e) => (num(e && e.base_mmol) == null ? '' : `${round(num(e.base_mmol), 3)} mmol`);

/** 逐行对照的字段表：两边取值 + 是否不同 */
function rowsOf(label, fa, fb) {
  const va = fa ? fa() : '';
  const vb = fb ? fb() : '';
  const diff = txt(va) !== txt(vb) && (txt(va) !== '' || txt(vb) !== '');
  return { label, va, vb, diff };
}

const condRows = computed(() => {
  const a = A.value;
  const b = B.value;
  return [
    rowsOf('溶剂', () => txt(a?.solvent), () => txt(b?.solvent)),
    rowsOf('温度', () => txt(a?.temperature), () => txt(b?.temperature)),
    rowsOf('时间', () => txt(a?.duration), () => txt(b?.duration)),
    rowsOf('气氛', () => txt(a?.atmosphere), () => txt(b?.atmosphere)),
    rowsOf('装置', () => txt(a?.apparatus), () => txt(b?.apparatus)),
    rowsOf('光照', () => txt(a?.light), () => txt(b?.light)),
    rowsOf('反应规模', () => scale(a), () => scale(b)),
  ];
});

const resultRows = computed(() => {
  const a = A.value;
  const b = B.value;
  return [
    rowsOf('产物', () => txt(a?.product_name), () => txt(b?.product_name)),
    rowsOf('产物 MW', () => mw(a?.product_mw), () => mw(b?.product_mw)),
    rowsOf('质量', () => mass(a?.product_mass), () => mass(b?.product_mass)),
    rowsOf('产率', () => (Number(a?.no_yield) === 1 ? '不计' : pct(a?.yield_pct)), () => (Number(b?.no_yield) === 1 ? '不计' : pct(b?.yield_pct))),
    rowsOf('选择性', () => txt(a?.dr_ee), () => txt(b?.dr_ee)),
  ];
});

/** 投料对照：按「试剂名」把两边的当量并排（一边没有就空着，并标出来） */
const reagentRows = computed(() => {
  const nameOf = (r) => txt(r.name) || txt(r.role) || '（未命名）';
  const wrap = (e) => {
    const m = new Map();
    for (const r of (e && e.reagents) || []) {
      const k = nameOf(r);
      const eq = eqLabel(r.eq);
      const prev = m.get(k);
      // 同名出现两次（两步各一次）就都留着，写成 "1.0 / 1.2"
      m.set(k, prev ? `${prev} / ${eq || '—'}` : eq || '—');
    }
    return m;
  };
  const ma = wrap(A.value);
  const mb = wrap(B.value);
  const keys = [...new Set([...ma.keys(), ...mb.keys()])];
  return keys.map((k) => {
    const va = ma.get(k) || '';
    const vb = mb.get(k) || '';
    return { name: k, va, vb, diff: va !== vb };
  });
});

const schemeDiff = computed(() => Boolean(svgA.value || svgB.value) && svgA.value !== svgB.value);

/** 顶部那句「哪几处不一样」 */
const diffLabels = computed(() => {
  const out = [];
  for (const r of [...condRows.value, ...resultRows.value]) if (r.diff) out.push(r.label);
  for (const r of reagentRows.value) if (r.diff) out.push(r.name);
  return out;
});

/** 这一条记录的附件里，TLC 那几张 */
const tlcOf = (e) => ((e && e.attachments) || []).filter((at) => (at.category || '') === 'tlc');
const fileUrl = (at) => `/api/files/${at.id}`;
/** 点 TLC 图放大看（跟附件列表用同一个预览弹窗） */
const preview = ref(null);

const sides = computed(() => [
  { key: 'a', exp: A.value, svg: svgA.value, label: 'A' },
  { key: 'b', exp: B.value, svg: svgB.value, label: 'B' },
]);

function openRecord(id) {
  if (id) router.push(`/e/${id}`);
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
            两条记录并排看：反应式、TLC 放上面，条件 / 投料 / 结果按行对齐，<b>不一样的地方会标出来</b>。只读，不改记录。
          </p>
        </div>
        <span class="spacer" />
        <span v-if="diffLabels.length" class="cmp-diffsum">
          不同：<b>{{ diffLabels.slice(0, 7).join(' · ') }}</b>
          <template v-if="diffLabels.length > 7"> 等 {{ diffLabels.length }} 处</template>
        </span>
      </header>

      <div class="cmp-pickrow">
        <div v-for="side in sides" :key="side.key" class="cmp-pickcell">
          <button class="btn btn-sm btn-ghost" @click="openPick(side.key)">
            <Icon name="search" :size="12" /> {{ side.exp ? `换 ${side.label}` : `挑 ${side.label}` }}
          </button>
          <template v-if="side.exp">
            <span class="cmp-code mono">{{ side.exp.code }}</span>
            <span class="cmp-title">{{ side.exp.title || side.exp.objective || '（未命名）' }}</span>
            <span class="cmp-meta">{{ side.exp.date }} · {{ side.exp.kind || '—' }} · {{ side.exp.status }}</span>
            <button class="btn btn-sm btn-ghost cmp-open" @click="openRecord(side.exp.id)">打开记录</button>
          </template>
          <span v-else class="cmp-meta">还没有挑记录</span>
        </div>
      </div>

      <div v-if="loading" class="cmp-empty">读取中…</div>
      <div v-else-if="!A && !B" class="cmp-empty">上面各挑一条记录，就开始对照。</div>

      <template v-else>
        <!-- 并排看的两块板：反应式 + TLC -->
        <div class="cmp-visual">
          <section v-for="side in sides" :key="`v${side.key}`" class="cmp-col">
            <div class="cmp-col-head">
              <span class="cmp-col-tag">{{ side.label }}</span>
              <span class="mono">{{ side.exp?.code || '—' }}</span>
            </div>
            <div v-if="side.svg" class="cmp-scheme" v-html="side.svg" />
            <div v-else class="cmp-scheme cmp-scheme-empty">（这条记录还没有能画的反应式）</div>

            <div v-if="tlcOf(side.exp).length" class="cmp-tlc">
              <figure v-for="at in tlcOf(side.exp)" :key="at.id">
                <img
                  :src="fileUrl(at)"
                  :alt="at.original_name || 'TLC'"
                  loading="lazy"
                  @click="preview = { src: fileUrl(at), name: at.original_name || 'TLC' }"
                />
                <figcaption>{{ at.note || at.original_name || 'TLC' }}</figcaption>
              </figure>
            </div>
            <div v-else class="cmp-tlc-empty">这条记录没有 TLC 图</div>
            <p v-if="side.exp?.tlc_note" class="cmp-tlc-note">TLC：{{ side.exp.tlc_note }}</p>
          </section>
        </div>

        <!-- 条件 / 结果：一行两个值，不同的行标出来 -->
        <table class="cmp-table">
          <colgroup><col class="cmp-k" /><col /><col /></colgroup>
          <thead>
            <tr>
              <th />
              <th>{{ A?.code || 'A' }}</th>
              <th>{{ B?.code || 'B' }}</th>
            </tr>
          </thead>
          <tbody>
            <tr class="cmp-sec"><td colspan="3">条件</td></tr>
            <tr v-for="r in condRows" :key="`c${r.label}`" :class="{ 'is-diff': r.diff }">
              <th>{{ r.label }}</th>
              <td>{{ r.va || '—' }}</td>
              <td>{{ r.vb || '—' }}</td>
            </tr>
            <tr class="cmp-sec"><td colspan="3">结果</td></tr>
            <tr v-for="r in resultRows" :key="`r${r.label}`" :class="{ 'is-diff': r.diff }">
              <th>{{ r.label }}</th>
              <td>{{ r.va || '—' }}</td>
              <td>{{ r.vb || '—' }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 投料：按试剂名并排 -->
        <table v-if="reagentRows.length" class="cmp-table cmp-reagents">
          <colgroup><col class="cmp-k" /><col /><col /></colgroup>
          <thead>
            <tr>
              <th>投料</th>
              <th>{{ A?.code || 'A' }}</th>
              <th>{{ B?.code || 'B' }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in reagentRows" :key="`g${r.name}`" :class="{ 'is-diff': r.diff }">
              <th>{{ r.name }}</th>
              <td>{{ r.va || '—' }}</td>
              <td>{{ r.vb || '—' }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 现象与结论：两栏文字 -->
        <div class="cmp-notes">
          <section v-for="side in sides" :key="`n${side.key}`" class="cmp-note">
            <div class="cmp-col-head">
              <span class="cmp-col-tag">{{ side.label }}</span>
              <span class="mono">{{ side.exp?.code || '—' }}</span>
            </div>
            <div class="cmp-note-lbl">现象 / 观察</div>
            <p class="cmp-note-txt">{{ side.exp?.notes || '—' }}</p>
            <div class="cmp-note-lbl">结论</div>
            <p class="cmp-note-txt">{{ side.exp?.conclusion || '—' }}</p>
          </section>
        </div>
      </template>

      <FilePreview v-if="preview" :src="preview.src" :name="preview.name" @close="preview = null" />

      <ExpPick
        :model-value="!!picking"
        title="挑一条记录来对照"
        confirm-text="放到这一边"
        :exclude="[ids.a, ids.b].filter(Boolean)"
        @close="picking = ''"
        @confirm="onPicked"
      />
    </div>
  </div>
</template>
