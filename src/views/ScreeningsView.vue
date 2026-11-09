<script setup>
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { compareMembers, memberDiffs } from '../lib/matrix.js';

/**
 * 条件筛选页 = 条件对照表。
 *
 * 一摞平行实验（同 group_id）摊成一张表：一行一个条件项、一列一条记录，第一列是基准，
 * 跟基准不一样的格子标出来。以前这里是手填的「筛选表」，跟记录里的数据是两份、容易对不上，
 * 现在直接读记录本身（`/api/groups`），不另存一份。
 */
const router = useRouter();

const groups = ref([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const d = await api.groups(store.project);
    groups.value = (d.items || []).map((g) => {
      const rows = compareMembers(g.members);
      return { ...g, rows, diffs: memberDiffs(g.members, rows) };
    });
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => store.project, load);

const open = (m) => router.push(`/e/${m.id}`);

/** 列头的「改 X、Y」：两处以上写「改 X 等 N 项」，免得把表头撑爆 */
const diffText = (d) =>
  d.base ? '基准' : d.labels.length ? `改 ${d.labels[0]}${d.labels.length > 1 ? ` 等 ${d.labels.length} 项` : ''}` : '重复';

const SECTION = { cond: '条件', reagent: '投料', result: '结果' };
</script>

<template>
  <div class="single">
    <div class="inner">
      <header class="page-head">
        <h1 class="page-title">条件筛选</h1>
        <p class="page-desc">
          同一摞平行实验摊成一张表：一行一个条件项、一列一条记录，第一列是基准，跟基准不一样的格子标出来了。想看某一条的原始记录，点列头。
        </p>
      </header>

      <div v-if="loading" class="empty-note">正在整理…</div>
      <div v-else-if="!groups.length" class="empty-note">
        还没有平行实验。到某条记录里点左侧「＋」，从它再建一条（改温度 / 换溶剂 / 重复一次都算），这里就会出现一张对照表。
      </div>

      <section v-for="g in groups" :key="g.id" class="mx-group">
        <div class="mx-head">
          <b>{{ g.title || '平行组' }}</b>
          <span class="mx-meta">{{ g.count }} 条 · 基准 {{ g.members[0].code }}</span>
          <span class="spacer" />
          <button class="btn btn-sm btn-ghost" @click="open(g.members[0])">
            <Icon name="file" :size="12" /> 打开基准
          </button>
        </div>

        <p v-if="!g.rows.some((r) => r.section !== 'result')" class="mx-blank">
          这一组几条的条件和投料都还没填，先在记录页把温度 / 溶剂 / 投料补上，这里就有得比了。
        </p>
        <div v-else class="scope-wrap">
          <table class="mx-table">
            <thead>
              <tr>
                <th class="mx-rowhead">条件项</th>
                <th v-for="(m, i) in g.members" :key="m.id" class="mx-col" :class="{ 'is-base': i === 0 }">
                  <button type="button" class="linklike mono" @click="open(m)">{{ m.code }}</button>
                  <span
                    class="mx-tag"
                    :class="g.diffs[i].base ? 'is-base' : g.diffs[i].labels.length ? 'is-diff' : ''"
                  >
                    {{ diffText(g.diffs[i]) }}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(row, ri) in g.rows" :key="row.key">
                <tr v-if="!ri || g.rows[ri - 1].section !== row.section" class="mx-sep">
                  <td :colspan="g.members.length + 1">{{ SECTION[row.section] }}</td>
                </tr>
                <tr>
                  <th class="mx-rowhead" :class="{ 'is-role': row.section === 'reagent' }">
                    <span v-if="row.role" class="mx-role">{{ row.role }}</span>{{ row.label }}
                  </th>
                  <td
                    v-for="(c, i) in row.cells"
                    :key="i"
                    class="mono"
                    :class="{ 'is-diff': row.diff && i > 0 && c !== row.cells[0], 'is-empty': !c }"
                  >
                    {{ c || '—' }}
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>
