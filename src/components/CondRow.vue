<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import RulerPick from './RulerPick.vue';
import { QUICK } from '../lib/ui.js';
import { api } from '../api.js';
import { loadBoot, quickList } from '../store.js';
import { prompt, toast } from '../lib/feedback.js';
import { markPopupOpen, ignoreOutsideClick } from '../lib/popguard.js';

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
// **不给占位文字**：以前这几格的 placeholder 长得跟真值一模一样（「−78 ℃」「8:45 → 15:11」
// 「N₂，封管」…），灰字放在那儿很容易被当成已经填了 —— 用户说「有误导」。
// 每格上面本来就有标签（反应温度 / 时间节点 / …），空着就空着，右边小箭头照样能点出候选。
const fields = [
  { key: 'temperature', label: '反应温度', ph: '', cls: 'ct-temp ct-temp-wide' },
  { key: 'duration', label: '时间节点', ph: '', cls: 'ct-time' },
  { key: 'atmosphere', label: '气氛 / 容器', ph: '', cls: 'ct-atm' },
  { key: 'apparatus', label: '装置 / 器皿', ph: '', cls: 'ct-app' },
  { key: 'light', label: '光照 / 波长', ph: '', cls: 'ct-light' },
];

const open = ref('');
/** 温度和时间的候选是**有序刻度**，用刻度滑条（按住左右拖 / 点某一格）；其余字段还是一排胶囊 */
const RULER_KEYS = new Set(['temperature', 'duration']);
const isRuler = (key) => RULER_KEYS.has(key);

const builtin = (key) => QUICK[`f-${key}`] || [];
/** 下拉里列什么：整份列表（内置 + 自己加的，删过/挪过就照用户存的那份） */
const optionsFor = (key) => quickList(key);

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
    const items = [...quickList(f.key), v];
    await api.saveQuick(f.key, [...new Set(items)], true);
    await loadBoot();
    props.model[f.key] = v;
    notify();
    open.value = '';
    toast(`「${v}」加好了，以后在这个下拉里能直接点`);
  } catch (e) {
    toast(e.message || '没存上', 'err');
  }
}

/** 从「常用选项」里删掉一条（内置的也能删：存的是整份列表） */
async function delOption(f, v) {
  try {
    await api.saveQuick(f.key, quickList(f.key).filter((x) => x !== v), true);
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
 * **单击 = 出选择（刻度滑条 / 胶囊），双击 = 直接改文字。**
 *
 * 输入框平时是 `pointer-events: none`（CSS）：鼠标根本点不到它，也就不会拿焦点、
 * 不会出现打字的 I 形光标、不会闪一下光标再消失 —— `mousedown` 里 `preventDefault()`
 * 在 Safari 上拦不干净（试过，还是会进光标）。所以事件挂在**整格 `.cond-f`** 上：
 * 单击 → 开选择；双击 → 手动 `focus()`（程序化聚焦不受 pointer-events 影响），
 * 聚焦后 CSS 里再把 pointer-events 放开，编辑时还能点、能选字。
 *
 * 挂整格而不是只挂值那一行：值那一行只有 20 来 px 高、右边还留着小箭头，
 * 稍微点偏一点（点在标签上、字上面一点）就毫无反应，用户报「不太灵敏」。
 * 现在标签 + 值 + 中间那点空隙都算落点，四周没有死区。
 */
let downTimer = 0;
let lastDownAt = 0;
/** 正在用键盘编辑哪一格（用 class 控制，别指望 `:focus` —— WebKit 里算不准） */
const editing = ref('');

function onFieldDown(f, ev) {
  if (props.locked) return;
  // 小箭头 / 「变量」小开关 / 已经弹出来的选择器：各有自己的点击，别抢
  // （菜单里的 mousedown 也会冒到这里，抢了会在 mouseup 前把菜单关掉 → 那一下选不中）
  if (ev.target.closest?.('.cond-caret, .cond-var-tog, .cond-menu, .ruler-pop')) return;
  const box = ev.currentTarget;
  const el = box?.querySelector?.('input');
  if (!el) return;
  // 已经在编辑这一格：正常点、正常选字，别抢
  if (document.activeElement === el) return;

  const now = Date.now();
  const isDouble = now - lastDownAt < 340;
  lastDownAt = now;

  if (isDouble) {
    clearTimeout(downTimer);
    open.value = '';
    editing.value = f.key;
    el.focus?.();
    el.select?.();
    return;
  }

  ev.preventDefault();
  clearTimeout(downTimer);
  // 130ms 就开（以前 180ms，感觉「点了没反应」）；再点同一格 = 收起来
  downTimer = setTimeout(() => {
    open.value = open.value === f.key ? '' : f.key;
    if (open.value) markPopupOpen();
  }, 130);
}

function pick(key, v) {
  props.model[key] = v;
  open.value = '';
  props.notify();
}

/**
 * 选择器开着的时候**把页面锁住**：滚轮只用来拨刻度（或者什么都不做），
 * 不让整页跟着上下跑 —— 尤其弹窗贴在纸面中间，页面一动它就离开手指了。
 */
function onLockWheel(ev) {
  if (!open.value) return;
  ev.preventDefault();
}
function lockPage(on) {
  if (on) document.addEventListener('wheel', onLockWheel, { passive: false, capture: true });
  else document.removeEventListener('wheel', onLockWheel, { passive: false, capture: true });
}
watch(open, (v, old) => {
  if (v && !old) lockPage(true);
  if (!v && old) lockPage(false);
});

/* 点外面 / 按 Esc 就把下拉收起来（之前只能再点一次箭头，很卡手） */
function onDocClick(ev) {
  if (!open.value) return;
  if (ignoreOutsideClick()) return;   // 刚打开的那一下不算「点外面」
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
  lockPage(false);
});
</script>

<template>
  <!-- 这一块现在长在投料表的最后一行里（`条件` 那一行）：五个字段横着排，格子内联小标签 -->
  <div class="cond-inline">
    <div
      v-for="f in fields"
      :key="f.key"
      class="cond-f"
      :class="{ 'is-openable': !(f.key in fixed) && !locked }"
      @mousedown="onFieldDown(f, $event)"
    >
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
            :class="{ 'is-var': fieldVars.some((v) => v.key === f.key), 'is-editing': editing === f.key }"
            :value="model[f.key]"
            :title="model[f.key] || ''"
            :placeholder="f.ph"
            :disabled="locked"
            spellcheck="false"
            @input="onInput($event, f)"
            @blur="editing = ''"
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
              class="qchip is-own"
              :aria-selected="String(model[f.key] || '') === v"
              @click="pick(f.key, v)"
            >
              {{ v }}
              <!-- 每条都能删（内置的也一样：存的是整份列表），鼠标移上来露出 × -->
              <span
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
