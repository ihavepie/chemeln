<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { loadBoot, loadList, setProject, store } from '../store.js';
import { STATUS_TONE } from '../lib/ui.js';
import { round } from '../lib/reagent.js';
import DocGrip from '../components/DocGrip.vue';

const router = useRouter();
onMounted(() => {
  if (!store.boot) void loadBoot();
});
const b = computed(() => store.boot || {});

/* 全局搜索：一次搜「实验 + 化合物」两类，分别列一组，点一条直接进记录。
   两个接口本来就支持 q（实验还搜试剂名），所以这里只是并行发两次、分开展示。
   跟着当前课题走：在某个课题里就只搜这个课题，在「全部课题」下搜全部。 */
const q = ref('');
const searching = ref(false);
const expHits = ref([]);
const expTotal = ref(0);
const cmpHits = ref([]);
const cmpTotal = ref(0);
let timer = 0;
let seq = 0;

function clearHits() {
  expHits.value = [];
  expTotal.value = 0;
  cmpHits.value = [];
  cmpTotal.value = 0;
}

async function runSearch() {
  const s = q.value.trim();
  if (!s) return clearHits();
  const mine = ++seq;                 // 连着打字时，先发后到的结果不许盖掉新的
  searching.value = true;
  try {
    const [ex, cp] = await Promise.all([
      api.experimentsPage({ q: s, project: store.project }),
      api.compoundsPage({ q: s, project: store.project }),
    ]);
    if (mine !== seq) return;
    expHits.value = ex.items.slice(0, 8);
    expTotal.value = ex.total;
    cmpHits.value = cp.items.slice(0, 8);
    cmpTotal.value = cp.total;
  } catch {
    if (mine === seq) clearHits();
  } finally {
    if (mine === seq) searching.value = false;
  }
}

watch(q, (v) => {
  clearTimeout(timer);
  if (!v.trim()) {
    clearHits();
    searching.value = false;
    return;
  }
  timer = setTimeout(runSearch, 220);
});

/** 结果太多时把这一串词带到实验记录页去慢慢看 */
async function openList() {
  store.filters.q = q.value.trim();
  router.push('/list');
  // 中栏列表只在「自己没数据」时才自动拉一次，所以这里显式按新关键词重拉一遍
  await loadList();
}

/** 点课题名 = 切到那个「空间」：统计、列表、卡片墙全跟着换 */
async function byProject(name) {
  await setProject(name);
  router.push('/list');
}
</script>

<template>
  <div class="single">
    <div class="inner">
      <header class="page-head" v-anim="0">
        <h1 class="page-title">{{ store.project || '实验记录本' }}</h1>
        <p class="page-desc">{{ b.totals?.experiments ?? 0 }} 条实验 · {{ b.totals?.attachments ?? 0 }} 个附件 · 数据存在本机</p>
      </header>

      <div class="stat-grid" v-anim="1">
        <div class="stat"><div class="k">实验总数</div><div class="v">{{ b.totals?.experiments ?? 0 }}</div></div>
        <div class="stat"><div class="k">本月新增</div><div class="v">{{ b.thisMonth ?? 0 }}</div></div>
        <div class="stat">
          <!-- 用中位数：一条填错的产率（比如 8321%）不会把这一格拉到离谱 -->
          <div class="k">中位产率</div>
          <div class="v">{{ b.yieldMedian == null ? '—' : round(b.yieldMedian, 1) }}<span class="u">%</span></div>
          <div v-if="b.yieldSuspect" class="hint" style="margin-top: 2px; font-size: 10.5px">
            另有 {{ b.yieldSuspect }} 条产率不在 0–100% 内，没算进去
          </div>
        </div>
        <div class="stat"><div class="k">条件筛选表</div><div class="v">{{ b.totals?.screenings ?? 0 }}</div></div>
      </div>

      <p class="section-label" v-anim="2">搜索<span class="rule" /></p>
      <div class="dash-search" v-anim="2">
        <div class="searchbox">
          <Icon name="search" :size="13" />
          <input
            v-model="q"
            type="search"
            autocomplete="off"
            placeholder="搜实验编号 / 名称 / 试剂 / 条件，或化合物编号、名称、分子式"
            @keydown.enter="openList"
          />
        </div>

        <template v-if="q.trim()">
          <div v-if="searching" class="hint" style="padding: 10px 2px 0">搜索中…</div>
          <template v-else>
            <div v-if="expHits.length" class="dash-group">
              <p class="dash-sub">实验 <span class="mono">{{ expTotal }}</span></p>
              <div class="recent-list">
                <div v-for="e in expHits" :key="e.id" class="recent-row" @click="router.push(`/e/${e.id}`)">
                  <span class="code">{{ e.code }}</span>
                  <span class="t">{{ e.title || '（未命名实验）' }}</span>
                  <span class="tag" :class="STATUS_TONE[e.status]">{{ e.status }}</span>
                  <span class="d">{{ e.date }}</span>
                </div>
              </div>
              <p v-if="expTotal > expHits.length" class="hint" style="margin: 6px 0 0">
                还有 {{ expTotal - expHits.length }} 条 · <span class="linkish" @click="openList">去实验记录里看</span>
              </p>
            </div>

            <div v-if="cmpHits.length" class="dash-group">
              <p class="dash-sub">化合物 <span class="mono">{{ cmpTotal }}</span></p>
              <div class="recent-list">
                <div v-for="c in cmpHits" :key="c.id" class="recent-row" @click="router.push(`/c/${c.id}`)">
                  <span class="code">{{ c.code || '—' }}</span>
                  <span class="t">{{ c.name || '（未命名化合物）' }}</span>
                  <span class="tag">{{ c.kind }}</span>
                  <span class="d">{{ c.formula || '' }}</span>
                </div>
              </div>
              <p v-if="cmpTotal > cmpHits.length" class="hint" style="margin: 6px 0 0">
                还有 {{ cmpTotal - cmpHits.length }} 个 · <span class="linkish" @click="router.push('/compounds')">去化合物库看</span>
              </p>
            </div>

            <p v-if="!expHits.length && !cmpHits.length" class="hint" style="padding: 10px 2px 0">
              没有匹配的记录。
            </p>
          </template>
        </template>
      </div>

      <p class="section-label" v-anim="2">最近<span class="rule" /></p>
      <div class="recent-list" v-anim="3">
        <div
          v-for="r in b.recent || []"
          :key="r.id"
          class="recent-row"
          style="cursor: pointer"
          @click="router.push(`/e/${r.id}`)"
        >
          <span class="code">{{ r.code }}</span>
          <span class="t">{{ r.title || '（未命名实验）' }}</span>
          <span class="tag" :class="STATUS_TONE[r.status]">{{ r.status }}</span>
          <span class="d">{{ r.date }}</span>
        </div>
        <div v-if="!b.recent?.length" class="empty-note">
          {{ store.project ? '本课题暂无实验记录。' : '暂无实验记录。点左上角「新建实验」，或先到设置页调整记录本信息。' }}
        </div>
      </div>

      <template v-if="b.projects?.length && !store.project">
        <p class="section-label mt24" v-anim="4">按课题<span class="rule" /></p>
        <div class="card" v-anim="5">
          <div v-for="p in b.projects" :key="p.name" class="row" style="padding: 5px 0; border-bottom: 1px solid var(--line)">
            <span class="linkish" @click="byProject(p.name)">{{ p.name }}</span>
            <span class="spacer" style="flex: 1" />
            <span class="hint mono">{{ p.n }}</span>
          </div>
        </div>
      </template>

      <div class="mt24" v-anim="6">
        <span v-for="s in b.statusBreakdown || []" :key="s.status" class="tag" :class="STATUS_TONE[s.status]" style="margin-right: 6px">
          {{ s.status }} {{ s.n }}
        </span>
      </div>
      <DocGrip />
    </div>
  </div>
</template>
