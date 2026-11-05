<script setup>
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { loadBoot, setProject, store } from '../store.js';
import { STATUS_TONE } from '../lib/ui.js';
import { round } from '../lib/reagent.js';

const router = useRouter();
onMounted(() => {
  if (!store.boot) void loadBoot();
});
const b = computed(() => store.boot || {});

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
    </div>
  </div>
</template>
