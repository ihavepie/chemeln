<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { confirm, prompt, toast } from '../lib/feedback.js';
import { variantText } from '../lib/reagent.js';
import { LOOKUP_SITES } from '../lib/lookup.js';

// 自定义检索站点（设置里加的）：url 模板里 {name} 换成试剂名
const customSites = ref([]);
const sitesOpen = ref(false);
const sitesDraft = ref([]);

// 查不到时给的外部检索入口：内置那几家 + 自己加的
const extSites = (name) => {
  const builtin = LOOKUP_SITES.map((s) => ({ label: s.label, href: s.url({ name }) })).filter((s) => s.href);
  const mine = customSites.value
    .map((s) => ({ label: s.label, href: String(s.url || '').replace(/\{name\}/g, encodeURIComponent(name)) }))
    .filter((s) => s.href);
  return [...builtin, ...mine];
};

async function openSites() {
  try {
    customSites.value = await api.lookupSites();
  } catch {
    customSites.value = [];
  }
  sitesDraft.value = customSites.value.map((s) => ({ ...s }));
  if (!sitesDraft.value.length) sitesDraft.value.push({ label: '', url: '' });
  sitesOpen.value = true;
}
async function saveSites() {
  try {
    const r = await api.saveLookupSites(sitesDraft.value.filter((s) => String(s.label || '').trim() && String(s.url || '').trim()));
    customSites.value = r.items || [];
    sitesOpen.value = false;
    toast(`检索站点已保存（${(r.items || []).length} 个）`, 'ok', 2000);
  } catch (e) {
    toast(e.message || '没存上', 'err');
  }
}

/** 手填 MW / 密度：写回库条目，并标记成 manual（以后核对不再覆盖） */
async function editNumber(it, field) {
  const isDensity = field === 'density';
  const cur = isDensity ? it.density : it.mw;
  const v = await prompt({
    title: isDensity ? `「${it.name}」的密度（g/mL）` : `「${it.name}」的分子量`,
    placeholder: isDensity ? '例如 1.21；不确定就留空' : '例如 280.43',
    value: cur == null ? '' : String(cur),
    confirmText: '保存',
    allowEmpty: true,
  });
  if (v === null) return;
  const patch = field === 'density' ? { density: v.trim() === '' ? null : Number(v) } : { mw: v.trim() === '' ? null : Number(v) };
  if (field !== 'density' && v.trim() !== '' && !Number.isFinite(patch.mw)) return toast('分子量要是个数字', 'warn', 2000);
  if (field === 'density' && v.trim() !== '' && !Number.isFinite(patch.density)) return toast('密度要是个数字', 'warn', 2000);
  try {
    await api.reagentPatch(it.key || it.name.toLowerCase(), patch);
    await load();
    toast('已保存（以后核对不会再覆盖它）', 'ok', 2200);
  } catch (e) {
    toast(e.message || '没存上', 'err');
  }
}
import DocGrip from '../components/DocGrip.vue';
import AppModal from '../components/AppModal.vue';

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
async function loadSites() {
  try {
    customSites.value = await api.lookupSites();
  } catch {
    customSites.value = [];
  }
}

onMounted(() => {
  void load();
  void loadSites();
});
watch(() => store.project, load);

/** 改试剂名：所有记录里的这个名字会一起改（不然下次保存又长回旧名字） */
async function renameEntry(it) {
  const name = await prompt({
    title: '改试剂名',
    placeholder: '新的名字',
    value: it.name,
    confirmText: '改名',
  });
  if (!name || name === it.name) return;
  try {
    const r = await api.reagentRename(it.key || it.name.toLowerCase(), name);
    await load();
    toast(`改名：${it.name} → ${r.name || name}`, 'ok', 2400);
  } catch (e) {
    toast(e.message || '没改成', 'err');
  }
}

/** 删掉这一条库条目（记录里的投料行不动）；还有记录在用的，下次保存会重新长出来 */
async function removeEntry(it) {
  const live = Number(it.live) || 0;
  const okd = await confirm({
    title: `删除「${it.name}」这条试剂记录？`,
    body: live
      ? `还有 ${live} 条记录在用这个名字，删掉后它们再保存一次，这条会重新出现。`
      : '它现在没有记录在用，删了就干净了。记录里的投料行不会被动。',
    danger: true,
    confirmText: '删除',
  });
  if (!okd) return;
  try {
    await api.reagentRemove(it.key || it.name.toLowerCase());
    await load();
    toast(`已删除「${it.name}」`, 'ok', 2000);
  } catch (e) {
    toast(e.message || '没删成', 'err');
  }
}

/** 摘掉一颗用法标签：只删这一颗（记录里的投料行不动），下次这条记录再存又会长回来 */
async function dropVariant(it, v) {
  if (!v || !v.vkey) return;
  try {
    await api.reagentVariantRemove(it.name, v.vkey);
    it.variants = (it.variants || []).filter((x) => x.vkey !== v.vkey);
    if (it.defaultEq === v.eq) it.defaultEq = (it.variants[0] || {}).eq ?? null;
    toast(`去掉了「${it.name} ${variantText(v)}」`, 'ok', 1800);
  } catch (e) {
    toast(e.message || '没删成', 'err');
  }
}

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
        <button type="button" class="rl-allcheck rl-sites-btn" @click="openSites">检索站点</button>
        <input v-model="q" class="rl-search" placeholder="搜试剂名 / 组分…" spellcheck="false" />
      </header>

      <!-- 自定义检索站点：自己的数据库 / 供应商页面，{name} 会换成试剂名 -->
      <AppModal v-if="sitesOpen" :model-value="sitesOpen" title="检索站点" confirm-text="保存" width="560px" @close="sitesOpen = false" @confirm="saveSites">
        <p class="hint" style="margin: 0 0 10px">「查不到」的试剂后面会列出这些链接。网址里用 <code>{name}</code> 占位，例如 <code>https://example.com/search?q={name}</code></p>
        <div class="site-editor">
          <div v-for="(s, i) in sitesDraft" :key="i" class="site-row">
            <input v-model="s.label" class="site-label" placeholder="名称（PubChem）" spellcheck="false" />
            <input v-model="s.url" class="site-url" placeholder="https://…/search?q={name}" spellcheck="false" />
            <button type="button" class="rl-act is-danger" @click="sitesDraft.splice(i, 1)">删除</button>
          </div>
        </div>
        <button type="button" class="add-row" style="margin-top: 8px" @click="sitesDraft.push({ label: '', url: '' })">
          <Icon name="plus" :size="12" /> 加一个站点
        </button>
      </AppModal>

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
              <th class="n rl-acts-h" />
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
                    :key="v.vkey || v.eq + '|' + v.role"
                    class="rl-var"
                    :class="{ 'is-on': it.defaultEq === v.eq, 'is-none': !v.eq }"
                  >
                    {{ variantText(v) }}<em v-if="v.n > 1">×{{ v.n }}</em>
                    <!-- 填错的那种标签可以就地摘掉（只删标签，记录里的投料行不动） -->
                    <button type="button" class="rl-var-x" aria-label="去掉这颗用法标签" @click.stop="dropVariant(it, v)">×</button>
                  </span>
                </span>
              </td>
              <td class="rl-role">{{ it.role || '—' }}</td>
              <td class="n mono rl-edit" title="点一下自己填（填过就不再被核对覆盖）" @click.stop="editNumber(it, 'mw')">
                <span v-if="it.mw == null" :class="{ 'rl-miss': it.checkState === 'miss' }">{{ it.checkState === 'miss' ? '查无' : '—' }}</span>
                <template v-else>{{Number(it.mw).toFixed(2) }}</template>
              </td>
              <td class="n mono rl-edit" title="点一下自己填密度（g/mL）" @click.stop="editNumber(it, 'density')">
                <template v-if="it.conc">={{ Number(it.conc).toFixed(2) }} M</template>
                <template v-else-if="it.density">ρ {{ Number(it.density).toFixed(2) }}</template>
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
              <td class="n rl-rowacts">
                <button type="button" class="rl-act" @click.stop="renameEntry(it)">改名</button>
                <button type="button" class="rl-act is-danger" @click.stop="removeEntry(it)">删除</button>
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
                <!-- 三个库都查不到时，给几个能直接跳到外部库检索的入口（自己看一眼再手填 MW） -->
                <template v-if="it.checkState === 'miss'">
                  <a
                    v-for="s in extSites(it.name)"
                    :key="s.label"
                    class="rl-ext"
                    :href="s.href"
                    target="_blank"
                    rel="noopener"
                    @click.stop
                  >{{ s.label }}↗</a>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!shown.length" class="rl-empty">没有匹配的试剂。</div>
      </template>
    </div>
  </div>
</template>
