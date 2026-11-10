<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from '../lib/feedback.js';
import DocGrip from '../components/DocGrip.vue';

/**
 * 试剂库 = 「用过的试剂」的完整版。
 * 数据全从投料行汇总（服务端 /api/reagents）：同一个名字取最近一次的组分 / 分子量 /
 * 浓度 / 密度，再折一个「1 mmol ≈ 多少 g / 多少 µL」，称量的时候直接照着抄。
 */
const items = ref([]);
const q = ref('');
const loading = ref(true);

const shown = computed(() => {
  const k = q.value.trim().toLowerCase();
  if (!k) return items.value;
  return items.value.filter(
    (it) => String(it.name || '').toLowerCase().includes(k) || String(it.role || '').includes(k)
  );
});

const solidCount = computed(() => items.value.filter((it) => it.mw && !it.per_mmol_ul).length);
const liveCount = computed(() => items.value.filter((it) => it.live > 0).length);
/** 还没联网核对过、MW 又空着的（「全部核对」要挨个查的就是这些） */
const pendingCount = computed(() => items.value.filter((it) => it.mw == null && !it.checkedAt).length);
/** 核过了、但三个库都没有的 */
const missCount = computed(() => items.value.filter((it) => it.checkState === 'miss').length);

const describe = (r) => {
  const bits = [];
  if (r.mw) bits.push(`MW ${Number(r.mw).toFixed(2)}`);
  if (r.formula) bits.push(r.formula);
  if (r.density) bits.push(`密度 ${r.density}`);
  return bits.join(' · ') || '查到条目但没 MW';
};

/** 核对一个试剂（PubChem → OPSIN → Wikidata），回来的 MW / 密度写回试剂库 */
const checking = ref('');
async function verify(it) {
  checking.value = it.name;
  try {
    // 手动点的这条一律重查（不信缓存）：改过名 / 上次网不通都靠这一下翻案
    const r = await api.reagentsVerify(it.name, true);
    if (!r || !r.ok) {
      toast(r && r.state === 'error' ? `「${it.name}」没查成：${r.reason || '网络不通'}` : `「${it.name}」三个库都没查到，手填 MW 就行`, 'warn', 3400);
    } else {
      toast(`已核对（${r.source}）：${describe(r)}`, 'ok', 3200);
    }
    await load();
  } catch (e) {
    toast(e.message || '核对失败（可能没联网）', 'err');
  } finally {
    checking.value = '';
  }
}

/** 全部核对：一批一批地喂（服务端一次查 6 个），按钮上直接显示进度 */
const allRun = ref(false);
const allDone = ref(0);
async function verifyAll() {
  if (allRun.value) return;
  const todo = pendingCount.value;
  const misses = items.value.filter((it) => it.checkState === 'miss').map((it) => it.name);
  if (!todo && !misses.length) return toast('都核对过了，没有要查的', 'ok', 2000);
  allRun.value = true;
  allDone.value = 0;
  let err = 0;
  try {
    if (todo) {
      // 一轮一轮地来，每轮把结果写回列表，看得见条数在动
      for (let round = 0; round < 30; round += 1) {
        const r = await api.reagentsVerifyAll({ limit: 6 });
        const list = (r && r.results) || [];
        if (!list.length) break;
        err += list.filter((x) => x.state === 'error').length;
        allDone.value += list.filter((x) => x.state !== 'error').length;
        await load();
        if (!r.remaining) break;
        if (err >= 4 && allDone.value === 0) break;   // 一直失败多半是网不通，别空转
      }
    } else {
      // 没核过的都核完了 → 把「查不到」的那几个再试一遍（可能上次是网的问题）
      const r = await api.reagentsVerifyAll({ names: misses, force: true });
      allDone.value = ((r && r.results) || []).filter((x) => x.state === 'ok').length;
      await load();
    }
  } catch (e) {
    toast(e.message || '核对失败（可能没联网）', 'err');
  } finally {
    allRun.value = false;
  }
  const left = pendingCount.value;
  if (!allDone.value && err) toast('一个也没查成，像是网不通', 'warn', 3000);
  else if (left) toast(`核对了 ${allDone.value} 个，还有 ${left} 个没查`, 'warn', 3200);
  else toast(todo ? `核对了 ${allDone.value} 个，都有 MW 了` : `重查了 ${allDone.value} 个`, 'ok', 2600);
}

async function load() {
  loading.value = true;
  try {
    items.value = await api.reagents(store.project);
  } catch {
    items.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => store.project, load);

/** 点一行就把名字复制走——录记录时多半是要粘到试剂名那一格 */
async function copyName(it) {
  try {
    await navigator.clipboard.writeText(it.name);
    toast(`已复制「${it.name}」`, 'ok', 1600);
  } catch {
    toast('复制不了（浏览器没给权限）', 'warn');
  }
}

const gPer = (it) => (it.per_mmol_g == null ? '' : `${it.per_mmol_g} g`);
const ulPer = (it) => (it.per_mmol_ul == null ? '' : `${it.per_mmol_ul} µL`);
</script>

<template>
  <div class="single">
    <div class="inner">
      <DocGrip />
      <header class="page-head rl-head">
        <div>
          <h1 class="page-title">试剂库</h1>
          <p class="page-desc">
            用过的试剂都在这里：某个名字最近一次用的组分、分子量、浓度 / 密度，以及「1 mmol 折多少 g / µL」。点一行复制名字。
          </p>
        </div>
        <span class="spacer" />
        <button
          type="button"
          class="rl-allcheck"
          :disabled="allRun || (!pendingCount && !missCount)"
          @click="verifyAll"
        >
          {{ allRun ? `核对中 ${allDone}${pendingCount ? ` / ${allDone + pendingCount}` : ''}` : pendingCount ? `全部核对（${pendingCount}）` : missCount ? `重查查不到的（${missCount}）` : '都核对过了' }}
        </button>
        <input v-model="q" class="rl-search" placeholder="搜试剂名 / 组分…" spellcheck="false" />
      </header>

      <div v-if="loading" class="rl-empty">读取中…</div>
      <div v-else-if="!items.length" class="rl-empty">
        还没有用过的试剂。在记录页的投料表里填几行，这里就会自动攒出来。
      </div>

      <template v-else>
        <div class="rl-sum">
          {{ items.length }} 个试剂（输入过的都留着）· 当前在用 {{ liveCount }} 个 · 固体 {{ solidCount }} 个
          <span v-if="pendingCount">· 待核对 {{ pendingCount }} 个</span>
          <span v-if="q.trim()">· 筛出 {{ shown.length }} 个</span>
        </div>

        <table class="rl-table">
          <thead>
            <tr>
              <th>试剂</th>
              <th>组分</th>
              <th class="n">MW</th>
              <th class="n">浓度 / 密度</th>
              <th class="n">1 mmol ≈</th>
              <th class="n">用过</th>
              <th class="n">当前</th>
              <th class="n">最近</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in shown" :key="it.name" @click="copyName(it)" :title="`点一下复制「${it.name}」`">
              <td class="rl-name">
                <span class="rl-nm">{{ it.name }}</span>
                <!-- 同一个试剂用过的当量（一条记录填一条，这里按试剂归拢） -->
                <span v-if="it.variants && it.variants.length" class="rl-vars">
                  <span
                    v-for="v in it.variants"
                    :key="v.eq + '|' + v.role"
                    class="rl-var"
                    :class="{ 'is-on': it.defaultEq === v.eq }"
                  >
                    {{ v.eq || '不带当量' }}<em v-if="v.n > 1">×{{ v.n }}</em>
                  </span>
                </span>
              </td>
              <td class="rl-role">{{ it.role || '—' }}</td>
              <td class="n mono">
                <span v-if="it.mw == null" :class="{ 'rl-miss': it.checkState === 'miss' }">{{ it.checkState === 'miss' ? '查无' : '—' }}</span>
                <template v-else>{{Number(it.mw).toFixed(2) }}</template>
              </td>
              <td class="n mono">
                <template v-if="it.conc">={{ Number(it.conc).toFixed(2) }} M</template>
                <template v-else-if="it.per_mmol_ul">ρ {{ Number(it.density).toFixed(2) }}</template>
                <template v-else>—</template>
              </td>
              <td class="n mono">
                <template v-if="it.per_mmol_g">{{ gPer(it) }}</template>
                <template v-if="it.per_mmol_ul"> · {{ ulPer(it) }}</template>
                <template v-if="!it.per_mmol_g && !it.per_mmol_ul">—</template>
              </td>
              <td class="n mono">{{ it.used }}</td>
              <td class="n mono" :class="{ 'rl-zero': !it.live }">{{ it.live }}</td>
              <td class="n mono rl-last">
                {{ it.lastCode || '' }}
                <span v-if="it.lastAt" class="rl-date">{{ it.lastAt }}</span>
              </td>
              <td class="n">
                <button
                  type="button"
                  class="rl-check"
                  :disabled="checking === it.name || allRun"
                  @click.stop="verify(it)"
                >
                  {{ checking === it.name ? '查询中…' : it.checkedAt ? '重核' : '核对' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!shown.length" class="rl-empty">没有匹配的试剂。</div>
      </template>
    </div>
  </div>
</template>
