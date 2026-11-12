<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import RulerPick from './RulerPick.vue';
import { QUICK } from '../lib/ui.js';
import { api } from '../api.js';
import { loadBoot, quickExtra } from '../store.js';
import { prompt, toast } from '../lib/feedback.js';

const props = defineProps({
  model: { type: Object, required: true },
  notify: { type: Function, required: true },
  locked: Boolean,
  /** 由投料表算出来的字段（溶剂 / 浓度）：只显示，不给编辑 */
  fixed: { type: Object, default: () => ({}) },
  /** 本次筛选把哪些字段当变量：`[{key,label}]`（温度 [T] / 时间 [t] / 气氛 [atm]） */
  fieldVars: { type: Array, default: () => [] },
});
const emit = defineEmits(['toggle-var']);
/** 这些字段才允许当变量（跟服务端白名单一致：apparatus / light 不是筛选变量） */
const VAR_KEYS = new Set(['temperature', 'duration', 'atmosphere']);

/** 和下面「结果」那张表同款：一行表头 + 一行值 */
// 溶剂已经挪进投料表（作为「溶剂」行），浓度不常用就不摆了；
// 两个字段还在（导出/打印读得到，投料表里有溶剂行时会自动算出来）
const fields = [
  { key: 'temperature', label: '反应温度', ph: '−78 ℃', cls: 'ct-temp ct-temp-wide' },
  { key: 'duration', label: '时间节点', ph: '8:45 → 15:11', cls: 'ct-time' },
  { key: 'atmosphere', label: '气氛 / 容器', ph: 'N₂，封管', cls: 'ct-atm' },
  { key: 'apparatus', label: '装置 / 器皿', ph: '封管 / Schlenk / 微波', cls: 'ct-app' },
  { key: 'light', label: '光照 / 波长', ph: '365 nm / 蓝光 LED', cls: 'ct-light' },
];

const open = ref('');
/** 温度和时间的候选是**有序刻度**，用刻度滑条（按住左右拖 / 点某一格）；其余字段还是一排胶囊 */
const RULER_KEYS = new Set(['temperature', 'duration']);
const isRuler = (key) => RULER_KEYS.has(key);

const builtin = (key) => QUICK[`f-${key}`] || [];
/** 下拉里列什么：内置那几条 + 自己加的（去重，自己加的在后面） */
const optionsFor = (key) => {
  const own = quickExtra(key);
  const out = [...builtin(key)];
  for (const v of own) if (!out.includes(v)) out.push(v);
  return out;
};
const isOwn = (key, v) => !builtin(key).includes(v) && quickExtra(key).includes(v);

/** 把这个格子当前填的值加进「常用选项」；空着就先问他填什么 */
async function addOption(f) {
  const cur = String(props.model[f.key] || '').trim();
  const v = await prompt({
    title: `加一条「${f.label}」常用选项`,
    placeholder: '比如 Ar 手套箱 / 45 ℃ / 光照 24 h',
    value: cur,
  });
  if (!v) return;
  try {
    const items = [...quickExtra(f.key), v];
    await api.saveQuick(f.key, items);
    await loadBoot();
    props.model[f.key] = v;
    notify();
    open.value = '';
    toast(`「${v}」加好了，以后在这个下拉里能直接点`);
  } catch (e) {
    toast(e.message || '没存上', 'err');
  }
}

/** 从「常用选项」里删掉一条（只删自己加的，内置那几条删不掉） */
async function delOption(f, v) {
  if (!isOwn(f.key, v)) return;
  try {
    await api.saveQuick(f.key, quickExtra(f.key).filter((x) => x !== v));
    await loadBoot();
    toast(`已经从常用选项里去掉「${v}」`);
  } catch (e) {
    toast(e.message || '没删掉', 'err');
  }
}

/** 这几栏都是自由输入（−78 ℃、16 h、N₂） */
function onInput(ev, f) {
  props.model[f.key] = ev.target.value;
}

/**
 * **单击 = 出选择（轮盘 / 胶囊），双击 = 直接改文字。**
 * 以前单击就落进输入框，想点开候选得去够右边那个小箭头；现在整格都能点。
 * 单击要等 220ms 再开，不然双击时它会先弹一下再被双击关掉（闪一下）。
 */
let clickTimer = 0;
function onFieldClick(f, ev) {
  if (props.locked) return;
  const el = ev.target;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    el.blur?.();               // 别顺手进打字状态（光标闪在那儿会让人以为要输入）
    if (open.value !== f.key) open.value = f.key;
  }, 220);
}

function onFieldDblClick(f, ev) {
  clearTimeout(clickTimer);
  open.value = '';
  const el = ev.target;
  el.focus?.();
  el.select?.();
}

function pick(key, v) {
  props.model[key] = v;
  open.value = '';
  props.notify();
}

/* 点外面 / 按 Esc 就把下拉收起来（之前只能再点一次箭头，很卡手） */
function onDocClick(ev) {
  if (!open.value) return;
  if (
    ev.target.closest?.('.cond-menu') ||
    ev.target.closest?.('.cond-caret') ||
    ev.target.closest?.('.ruler-pop') ||
    ev.target.closest?.('.cond-f')
  )
    return;
  open.value = '';
}
function onDocKey(ev) {
  if (ev.key === 'Escape' && open.value) open.value = '';
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onDocKey);
});
</script>

<template>
  <!-- 这一块现在长在投料表的最后一行里（`条件` 那一行）：五个字段横着排，格子内联小标签 -->
  <div class="cond-inline">
    <div v-for="f in fields" :key="f.key" class="cond-f">
      <span class="cond-f-label">
        {{ f.label }}
        <!-- 这一栏当「筛选变量」用：标签旁边一颗小开关，开了就在箭头上写 [T] / [t] / [atm] -->
        <button
          v-if="VAR_KEYS.has(f.key) && !locked"
          type="button"
          class="cond-var-tog"
          :class="{ on: fieldVars.some((v) => v.key === f.key) }"
          :title="fieldVars.some((v) => v.key === f.key) ? '取消这个变量（条件组里对应的列会消失）' : '把这一栏当本次筛选的变量'"
          @click.stop="emit('toggle-var', f)"
        >
          {{ fieldVars.some((v) => v.key === f.key) ? `[${(fieldVars.find((v) => v.key === f.key) || {}).label}]` : '变量' }}
        </button>
      </span>
      <span class="cond-f-val">
        <span v-if="f.key in fixed" class="cond-fixed" title="来自投料表">{{ fixed[f.key] || '—' }}</span>
        <template v-else>
          <input
            :class="{ 'is-var': fieldVars.some((v) => v.key === f.key) }"
            :value="model[f.key]"
            :title="model[f.key] || ''"
            :placeholder="f.ph"
            :disabled="locked"
            @click="onFieldClick(f, $event)"
            @dblclick="onFieldDblClick(f, $event)"
            spellcheck="false"
            @input="onInput($event, f)"
            @change="model[f.key] = $event.target.value; notify()"
          />
          <button
            v-if="!locked"
            type="button"
            class="cond-caret"
            aria-label="快速选择"
            @click.stop="open = open === f.key ? '' : f.key"
          >
            <Icon name="down" :size="10" />
          </button>

          <RulerPick
            v-if="open === f.key && isRuler(f.key)"
            :items="optionsFor(f.key)"
            :model-value="String(model[f.key] || '')"
            :locked="locked"
            @update:model-value="(v) => { model[f.key] = v; notify(); }"
            @close="open = ''"
            @add="addOption(f)"
          />
          <div v-else-if="open === f.key" class="qmenu cond-menu" @click.stop>
            <button
              v-for="v in optionsFor(f.key)"
              :key="v"
              type="button"
              class="qchip"
              :class="{ 'is-own': isOwn(f.key, v) }"
              :aria-selected="String(model[f.key] || '') === v"
              @click="pick(f.key, v)"
            >
              {{ v }}
              <!-- 自己加的那几条：鼠标移上来露出 ×，点它就删掉（内置的没有） -->
              <span
                v-if="isOwn(f.key, v)"
                class="qchip-x"
                role="button"
                title="从常用选项里去掉"
                @click.stop.prevent="delOption(f, v)"
              >×</span>
            </button>
            <button type="button" class="qchip is-add" title="把自己常用的值加进来（跟着记录本一起备份）" @click.stop="addOption(f)">
              ＋ 自定义
            </button>
          </div>
        </template>
      </span>
    </div>
  </div>
</template>
