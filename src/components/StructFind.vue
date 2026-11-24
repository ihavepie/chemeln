<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import AppModal from './AppModal.vue';
import SketcherModal from './SketcherModal.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { structureInfo } from '../lib/lookup.js';
import { toast } from '../lib/feedback.js';

/**
 * 「按结构找」：记不住名字、但画得出结构时用。
 *
 * 1. 画（Ketcher）或直接粘 SMILES；
 * 2. 结构 → 名称 / 分子式 / MW / CAS（PubChem，走 `structureInfo`）；
 * 3. 化合物库里按结构对：**完全一致**（openchemlib 的 ID code 相同）+ **含这个片段**（子结构匹配）；
 * 4. 试剂库里没有结构，只能按 **分子量** 缩范围（±0.6）——挑出「可能就是它」的那几条。
 *
 * 找到名称后可以用它回填调用方的搜索框（`fill`）。
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'fill']);

const router = useRouter();
const smiles = ref('');
const sketchOpen = ref(false);
const busy = ref(false);
const err = ref('');
const ext = ref(null);
const exact = ref(null);
const sub = ref(null);
const byMw = ref(null);
const ran = ref(false);

let chemLib = null;
async function chem() {
  if (!chemLib) chemLib = await import('openchemlib');
  return chemLib;
}

const close = () => emit('update:modelValue', false);

/** 外部查回来的名字（OPSIN / PubChem 给的那个） */
const extName = computed(() => String((ext.value && ext.value.name) || '').trim());
const extCas = computed(() => {
  const c = (ext.value && ext.value.cas) || [];
  return Array.isArray(c) ? c[0] || '' : String(c || '');
});

async function search() {
  const s = smiles.value.trim();
  err.value = '';
  if (!s) {
    err.value = '先画一个结构，或粘一条 SMILES';
    return;
  }
  busy.value = true;
  ext.value = null;
  exact.value = null;
  sub.value = null;
  byMw.value = null;
  ran.value = false;
  try {
    const lib = await chem();
    let q;
    try {
      q = lib.Molecule.fromSmiles(s);
    } catch {
      throw new Error('这条 SMILES 读不出来');
    }
    const qId = q.getIDCode();

    // 本地两份清单（都按当前课题取：在某个课题里找，就别把别的课题的也算进来）
    const [page, reagents] = await Promise.all([
      api.compoundsPage({ project: store.project }).catch(() => ({ items: [] })),
      api.reagents(store.project).catch(() => []),
    ]);
    const hits = [];
    const partial = [];
    for (const c of page.items || []) {
      const cs = String(c.smiles || '').trim();
      if (!cs) continue;
      let m;
      try {
        m = lib.Molecule.fromSmiles(cs);
      } catch {
        continue;
      }
      if (m.getIDCode() === qId) {
        hits.push(c);
        continue;
      }
      // 子结构：把「要找的那个」当片段塞进去
      try {
        const frag = lib.Molecule.fromSmiles(s);
        frag.setFragment(true);
        const se = new lib.SSSearcher();
        se.setFragment(frag);
        se.setMolecule(m);
        if (se.findFragmentInMolecule({ countMode: 'overlapping' })) partial.push(c);
      } catch {
        /* 匹配不了就跳过这一个 */
      }
    }
    exact.value = hits;
    sub.value = partial.filter((c) => !hits.some((h) => h.id === c.id));

    // 试剂库没有结构，只能拿分子量对：查回来的 MW 附近（±0.6）的那几个
    const info = await structureInfo(s);
    ext.value = info;
    const mw = Number(info && info.mw);
    if (Number.isFinite(mw) && mw > 0) {
      byMw.value = (reagents || []).filter((r) => {
        const v = Number(r.mw);
        return Number.isFinite(v) && Math.abs(v - mw) <= 0.6;
      });
    } else {
      byMw.value = [];
    }
    ran.value = true;
  } catch (e) {
    err.value = e.message || '没查成';
  }
  busy.value = false;
}

function onSketch(r) {
  sketchOpen.value = false;
  if (!r || !r.smiles) return;
  smiles.value = String(r.smiles).trim();
  void search();
}

/** 把名字交给调用方（试剂库那边填进搜索框） */
function useName() {
  if (!extName.value) return;
  emit('fill', extName.value);
  close();
}

async function copyName() {
  if (!extName.value) return;
  try {
    await navigator.clipboard.writeText(extName.value);
    toast('名字复制好了');
  } catch {
    toast('复制不了，手动选一下吧', 'warn');
  }
}

function openCompound(c) {
  close();
  router.push(`/c/${c.id}`);
}

</script>

<template>
  <AppModal v-if="modelValue" :model-value="modelValue" title="按结构找" width="620px" :show-confirm="false" cancel-text="关闭" @close="close">
    <div class="sf">
      <div class="sf-row">
        <input
          v-model="smiles"
          class="sf-input"
          placeholder="粘一条 SMILES，或点「画结构」"
          spellcheck="false"
          @keydown.enter="search"
        />
        <button type="button" class="sf-btn" @click="sketchOpen = true">画结构</button>
        <button type="button" class="sf-btn is-primary" :disabled="busy" @click="search">
          {{ busy ? '找…' : '找' }}
        </button>
      </div>
      <p v-if="err" class="sf-err">{{ err }}</p>

      <template v-if="ran">
        <div class="sf-sec-head">查到的名字</div>
        <div v-if="extName" class="sf-name">
          <span class="sf-name-t">{{ extName }}</span>
          <button type="button" class="sf-mini" @click="copyName">复制</button>
          <button type="button" class="sf-mini is-primary" @click="useName">用它搜试剂库</button>
        </div>
        <p v-else class="sf-none">PubChem / OPSIN 没给出名字</p>
        <p v-if="ext" class="sf-meta">
          {{ [ext.formula, ext.mw && `${ext.mw} g/mol`, extCas && `CAS ${extCas}`].filter(Boolean).join(' · ') || '—' }}
        </p>

        <div class="sf-sec-head">化合物库 · 结构完全一致（{{ (exact || []).length }}）</div>
        <div v-if="(exact || []).length" class="sf-hits">
          <button v-for="c in exact" :key="`e-${c.id}`" type="button" class="sf-hit" @click="openCompound(c)">
            <span class="sf-hit-code">{{ c.code }}</span>
            <span class="sf-hit-name">{{ c.name }}</span>
            <span class="sf-hit-meta">{{ [c.formula, c.mw].filter(Boolean).join(' · ') }}</span>
          </button>
        </div>
        <p v-else class="sf-none">库里没有一样的结构</p>

        <div class="sf-sec-head">化合物库 · 含这个片段（{{ (sub || []).length }}）</div>
        <div v-if="(sub || []).length" class="sf-hits">
          <button v-for="c in sub.slice(0, 20)" :key="`s-${c.id}`" type="button" class="sf-hit" @click="openCompound(c)">
            <span class="sf-hit-code">{{ c.code }}</span>
            <span class="sf-hit-name">{{ c.name }}</span>
            <span class="sf-hit-meta">{{ [c.formula, c.mw].filter(Boolean).join(' · ') }}</span>
          </button>
          <p v-if="sub.length > 20" class="sf-none">还有 {{ sub.length - 20 }} 条没列</p>
        </div>
        <p v-else class="sf-none">没有含这个片段的化合物</p>

        <div class="sf-sec-head">试剂库 · 分子量对得上（±0.6）</div>
        <div v-if="(byMw || []).length" class="sf-hits">
          <button
            v-for="r in byMw"
            :key="`m-${r.name}`"
            type="button"
            class="sf-hit"
            @click="emit('fill', r.name); close()"
          >
            <span class="sf-hit-code">{{ r.role || '试剂' }}</span>
            <span class="sf-hit-name">{{ r.name }}</span>
            <span class="sf-hit-meta">{{ r.mw }}</span>
          </button>
        </div>
        <p v-else class="sf-none">没有分子量对得上的（试剂库只存了名字和 MW，没有结构）</p>
      </template>
    </div>
  </AppModal>

  <SketcherModal :open="sketchOpen" mode="molecule" @close="sketchOpen = false" @pick="onSketch" />
</template>
