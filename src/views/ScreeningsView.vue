<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ExpPick from '../components/ExpPick.vue';
import ScreeningTable from '../components/ScreeningTable.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { round } from '../lib/reagent.js';
import { toast } from '../lib/feedback.js';
import { DEFAULT_FIELDS } from '../lib/sctfields.js';
import { schemeParts, standardLine } from '../lib/expScheme.js';

/**
 * 条件筛选 = 一摞平行实验里「跟基准不一样」的那些，摊成一张清单。
 *
 * 只列表、不铺矩阵：一个组员一行，行里只写它相对基准改了什么（`温度 -40 °C` / `LDA 1.2 eq`），
 * 没改的写「重复 / 平行」。**整摞全是重复 / 平行、或者全是原料的，不进这个页面**（后端就滤掉了）。
 */
const router = useRouter();

const groups = ref([]);
const tables = ref([]);
const loading = ref(true);
const rows = computed(() => groups.value);
const pickOpen = ref(false);

async function load() {
  loading.value = true;
  try {
    const [d, t] = await Promise.all([api.groups(store.project), api.screenings()]);
    const tag = (g, source) => ({ ...g, source });
    groups.value = [...(d.items || []).map((g) => tag(g, 'manual')), ...(d.auto || []).map((g) => tag(g, 'auto'))];
    // 首页就把每张表摊开：把它的行也一起拉回来（表不多，一次并起来）
    const full = await Promise.all((t || []).map((x) => api.screening(x.id).catch(() => null)));
    tables.value = full.filter(Boolean).map((f) => ({ ...f.screening, rows: f.rows || [] }));
    void buildSchemes();
  } finally {
    loading.value = false;
  }
}

/* 每张表顶上那张「标准条件」反应式：基准那条的底物 / 产物在化合物库里就画，画不出来退回一行字 */
const schemes = ref({});
let cmpsCache = null;

async function buildSchemes() {
  let lib = [];
  try {
    if (!cmpsCache) cmpsCache = await api.compounds();
    lib = cmpsCache;
  } catch {
    return;
  }
  const out = {};
  for (const t of tables.value) {
    const base = t.rows && t.rows[0] && t.rows[0].exp;
    if (!base) continue;
    const parts = schemeParts(base, lib);
    if (!parts.reactants.length || !parts.product) continue;
    try {
      const { composeSchemeSvg } = await import('../lib/scheme.js');
      out[t.id] = await composeSchemeSvg({
        reactants: parts.reactants,
        product: parts.product,
        above: parts.above,
        below: parts.below,
        background: false,
      });
      schemes.value = { ...schemes.value, [t.id]: out[t.id] };
    } catch {
      /* 这张画不出来就只留那行字 */
    }
  }
}

/* --- 自己的筛选表 --- */
async function createTable(picked) {
  pickOpen.value = false;
  try {
    const sc = await api.createScreening({ title: '未命名条件筛选', exp_ids: picked, vars: DEFAULT_FIELDS });
    router.push(`/s/${sc.id}`);
  } catch (e) {
    toast(e.message || '建不了', 'err');
  }
}

/** 把清单里的这一摞直接存成一张筛选表（行就是这几条） */
async function asTable(g) {
  try {
    const sc = await api.createScreening({
      title: headOf(g),
      exp_ids: g.members.map((m) => m.id),
      vars: DEFAULT_FIELDS,
    });
    router.push(`/s/${sc.id}`);
  } catch (e) {
    toast(e.message || '存不了', 'err');
  }
}

onMounted(load);
watch(() => store.project, load);

const open = (m) => router.push(`/e/${m.id}`);
const isBase = (g, m) => m.id === g.members[0].id;
const isEmpty = (v) => v === null || v === undefined || v === '';
const yieldText = (m) => (m.no_yield ? '不计产率' : isEmpty(m.yield_pct) ? '' : `${round(m.yield_pct, 1)}%`);
const selText = (m) => String(m.dr_ee || '').trim() || (isEmpty(m.ee_pct) ? '' : `${m.ee_pct}% ee`);

/** 组名：优先手动组的名字，其次「底物 → 产物」，最后退到底物名 */
const headOf = (g) => {
  if (g.title) return g.title;
  const base = g.members[0];
  const sub = String(base.substrates || g.subject || '').trim();
  const prod = String(base.product_name || '').trim();
  if (sub && prod) return `${sub} → ${prod}`;
  return sub || prod || '平行组';
};

/** 这一摞是不是「只差一个变量」——筛条件时最想看到的那种 */
const singleVar = (g) => {
  const rest = g.members.filter((m) => !isBase(g, m));
  if (!rest.length || rest.some((m) => m.changed !== 1)) return '';
  const set = new Set(rest.map((m) => String(m.changes[0]).split(' ')[0]));
  return set.size === 1 ? [...set][0] : '';
};

async function adopt(g) {
  try {
    await api.adoptGroup(g.members.map((m) => m.id), headOf(g));
    await load();
    toast('收成平行组了，以后它就固定在这一段');
  } catch (e) {
    toast(e.message || '收不了', 'err');
  }
}
</script>

<template>
  <div class="single">
    <div class="inner">
      <header class="page-head">
        <h1 class="page-title">条件筛选</h1>
        <p class="page-desc">
          一摞平行实验里，只把「跟基准不一样」的那几条列出来，改了什么一目了然。整摞都是重复 / 平行、或者都是原料的，不占地方。
        </p>
      </header>

      <div class="sct-head">
        <h2 class="sct-head-title">我的筛选表</h2>
        <span class="cx-meta">{{ tables.length }} 张</span>
        <span class="spacer" />
        <button class="btn btn-sm btn-ghost" @click="pickOpen = true"><Icon name="plus" :size="12" /> 新建筛选表</button>
      </div>
      <template v-if="tables.length">
        <section v-for="(t, i) in tables" :key="t.id" class="sct-block">
          <div class="sct-block-head">
            <b><span class="sct-cap-no">Table {{ i + 1 }}</span>{{ t.title }}</b>
            <span class="cx-meta">{{ t.rows.length }} 条 · {{ (t.vars || []).length }} 列</span>
            <span class="spacer" />
            <button class="btn btn-sm btn-ghost" @click="router.push(`/s/${t.id}`)">
              <Icon name="edit" :size="12" /> 打开编辑
            </button>
          </div>
          <ScreeningTable
            :screening="t"
            :rows="t.rows"
            :scheme="schemes[t.id]"
            :standard="standardLine(t.rows[0] && t.rows[0].exp)"
            @open="(r) => router.push(`/e/${r.exp_id}`)"
          />
        </section>
      </template>
      <p v-else class="empty-note" style="margin-top: 4px">
        还没有筛选表。点「新建筛选表」从记录里挑几条，或者把下面某一摞直接存成一张表。
      </p>

      <div v-if="loading" class="empty-note">正在整理…</div>
      <div v-else-if="!rows.length" class="empty-note">
        还没有可以筛的东西。一摞平行实验里至少要有一条跟基准不一样（改了条件 / 加减了试剂），重复或平行的那种不会进来；原料记录也不算。
      </div>

      <section v-for="g in rows" :key="g.id" class="cx-group">
        <div class="cx-head">
          <b>{{ headOf(g) }}</b>
          <span class="cx-meta">{{ g.count }} 条 · 基准 {{ g.members[0].code }}</span>
          <span v-if="singleVar(g)" class="mx-var">单变量 · {{ singleVar(g) }}</span>
          <span v-if="g.source === 'auto'" class="cx-src">自动匹配</span>
          <span class="spacer" />
          <button v-if="g.source === 'auto'" class="btn btn-sm btn-ghost" title="把这几条收成正式平行组" @click="adopt(g)">
            <Icon name="check" :size="12" /> 收成平行组
          </button>
          <button class="btn btn-sm btn-ghost" title="把这一摞存成一张筛选表" @click="asTable(g)">
            <Icon name="plus" :size="12" /> 存成筛选表
          </button>
          <button class="btn btn-sm btn-ghost" @click="open(g.members[0])">
            <Icon name="file" :size="12" /> 打开基准
          </button>
        </div>

        <ul class="cx-list">
          <li v-for="m in g.members" :key="m.id">
            <button type="button" class="cx-row" :class="{ 'is-base': isBase(g, m) }" @click="open(m)">
              <span class="cx-code mono">{{ m.code }}</span>
              <span class="cx-tags">
                <template v-if="isBase(g, m)">
                  <span class="cx-tag is-base">基准</span>
                </template>
                <template v-else-if="!m.changed">
                  <span class="cx-tag">重复 / 平行</span>
                </template>
                <template v-else>
                  <span v-for="c in m.changes" :key="c" class="cx-tag is-diff">{{ c }}</span>
                </template>
              </span>
              <span class="spacer" />
              <span class="cx-res mono">{{ yieldText(m) }}</span>
              <span class="cx-sel mono">{{ selText(m) }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <ExpPick
      :model-value="pickOpen"
      title="挑几条实验做一张筛选表"
      @close="pickOpen = false"
      @confirm="createTable"
    />
  </div>
</template>
