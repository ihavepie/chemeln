<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { markPopupOpen, ignoreOutsideClick } from '../lib/popguard.js';
import { compoundDict, store } from '../store.js';

/**
 * 条件组里的「候选名」输入框：空着点一下就出一个小菜单——
 *   ① 本槽已经填过的名字（同一列里前面几行的候选）
 *   ② 试剂库里同组分的试剂（带它最常用的当量）
 *   ③ 化合物库里同类型的化合物（配体 / 催化剂…）
 * 选中就把名字填进去，当量顺手带过来（还能改）。不记得缩写也能选。
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  role: { type: String, default: '' },          // 组分名（催化剂 / 配体…）；空 = 这一列不是试剂槽
  cands: { type: Array, default: () => [] },    // 本槽已有的名字
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'pick']);

const open = ref(false);
const up = ref(false);
const q = ref('');
const hi = ref(-1);
const wrap = ref(null);
const libAll = ref(null); // 试剂库（带 defaultEq）——第一次打开才去要，别拖慢开记录
const maxH = ref(272);    // 这一下能放多高：贴着输入框往下（放不下就往上）尽量铺开，别被页面底边切掉

const norm = (s) => String(s || '').trim().toLowerCase();

/** 有命中就按命中，没命中就当没筛（改一个字就「什么都搜不到」很难用） */
function match(list) {
  const k = norm(q.value);
  if (!k) return list;
  const hit = list.filter((x) => norm(x.name).includes(k));
  return hit.length ? hit : list;
}

/** 试剂库里同名那个（本槽候选也借它带上「常用当量」） */
const libByName = computed(() => {
  const m = new Map();
  for (const it of libAll.value || []) if (!m.has(norm(it.name))) m.set(norm(it.name), it);
  return m;
});
const recent = computed(() =>
  match(
    props.cands
      .filter(Boolean)
      .filter((n) => norm(n) !== norm(props.modelValue)) // 正在填的这个不用再列一遍
      .map((n) => ({ name: n, sec: 'recent', defaultEq: libByName.value.get(norm(n))?.defaultEq ?? null }))
  )
);
const lib = computed(() =>
  props.role
    ? match(
        (libAll.value || [])
          .filter((it) => it.role === props.role)
          .filter((it) => !/\(\s*\)/.test(it.name)) // 名字里空括号是记录里的手误，别当候选推
          .map((it) => ({ ...it, sec: 'lib' }))
      )
    : []
);
const cmps = computed(() => {
  if (!props.role) return [];
  const all = compoundDict().filter((c) => c.kind === props.role);
  const k = norm(q.value);
  const hit = k ? all.filter((c) => norm(c.name).includes(k) || norm(c.code).includes(k)) : all;
  return (hit.length ? hit : all).map((c) => ({ name: c.name, code: c.code, formula: c.formula, sec: 'cmp' }));
});

/** 三节：同名只留第一次出现的那条（本槽候选 > 试剂库 > 化合物库） */
const sections = computed(() => {
  const seen = new Set();
  const out = [];
  const push = (title, items) => {
    const list = [];
    for (const it of items) {
      const k = norm(it.name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      list.push(it);
    }
    if (list.length) out.push({ title, items: list });
  };
  push('本槽已有', recent.value);
  if (props.role) {
    push(`试剂库 · ${props.role}`, lib.value);
    push(`化合物库 · ${props.role}`, cmps.value);
  }
  return out;
});
const flat = computed(() => sections.value.flatMap((s) => s.items));

function subOf(it) {
  if (it.defaultEq != null && it.defaultEq !== '') return `${it.defaultEq} eq`;
  if (it.sec === 'cmp') return [it.code, it.formula].filter(Boolean).join(' · ');
  return '';
}

async function ensureLib() {
  if (!props.role || libAll.value) return;   // 温度 / 时间那种槽用不到试剂库
  try {
    libAll.value = await api.reagents(store.project);
  } catch {
    // 拿不到就退回 bootstrap 里那份（没有常用当量，只是少一个提示）
    libAll.value = (store.boot?.reagentDict || []).map((it) => ({ name: it.name, role: it.role }));
  }
}

function measure() {
  const r = wrap.value?.getBoundingClientRect();
  if (!r) return;
  const below = window.innerHeight - r.bottom - 12;
  up.value = below < 260 && r.top - 12 > below;
  maxH.value = Math.max(140, Math.min(272, up.value ? r.top - 12 : below));
}

function onFocus() {
  if (props.disabled) return;
  q.value = '';
  hi.value = -1;
  markPopupOpen();
  open.value = true;
  ensureLib();
  nextTick(() => requestAnimationFrame(measure));
}

function onInput(ev) {
  emit('update:modelValue', ev.target.value);
  q.value = ev.target.value;
  hi.value = -1;
  markPopupOpen();
  open.value = true;
  ensureLib();
  nextTick(() => requestAnimationFrame(measure));
}

function pick(it) {
  emit('update:modelValue', it.name);
  emit('pick', { name: it.name, eq: it.defaultEq != null && it.defaultEq !== '' ? String(it.defaultEq) : '' });
  open.value = false;
  q.value = '';
  hi.value = -1;
}

function onKey(ev) {
  if (ev.key === 'Escape') {
    open.value = false;
    return;
  }
  if (!open.value || !flat.value.length) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const n = flat.value.length;
    hi.value = ev.key === 'ArrowDown' ? (hi.value + 1) % n : (hi.value - 1 + n) % n;
  } else if (ev.key === 'Enter' && hi.value >= 0) {
    ev.preventDefault();
    pick(flat.value[hi.value]);
  }
}

function onDocDown(ev) {
  if (ignoreOutsideClick()) return;   // 刚打开的那一下不算「点外面」
  if (!open.value) return;
  if (!wrap.value?.contains(ev.target)) open.value = false;
}
function onDocKey(ev) {
  if (ev.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocDown);
  document.addEventListener('keydown', onDocKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown);
  document.removeEventListener('keydown', onDocKey);
});
</script>

<template>
  <span ref="wrap" class="cond-cand">
    <input
      class="cond-in"
      :value="modelValue"
      :disabled="disabled"
      :placeholder="placeholder"
      :aria-expanded="open ? 'true' : 'false'"
      autocomplete="off"
      spellcheck="false"
      @focus="onFocus"
      @input="onInput"
      @keydown="onKey"
    />
    <div v-if="open" class="condc-menu" :class="{ 'is-up': up }" :style="{ maxHeight: maxH + 'px' }" @mousedown.prevent>
      <template v-for="s in sections" :key="s.title">
        <div class="condc-h">{{ s.title }}</div>
        <button
          v-for="it in s.items"
          :key="s.title + it.name"
          type="button"
          class="condc-opt"
          :class="{ 'is-hi': flat.indexOf(it) === hi }"
          @click="pick(it)"
        >
          <span class="condc-name">{{ it.name }}</span>
          <span v-if="subOf(it)" class="condc-sub">{{ subOf(it) }}</span>
        </button>
      </template>
      <p v-if="!sections.length" class="condc-none">没有可选的名，直接手打也行</p>
    </div>
  </span>
</template>
