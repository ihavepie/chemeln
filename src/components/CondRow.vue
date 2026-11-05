<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { applyNumeric } from '../lib/numinput.js';
import { QUICK } from '../lib/ui.js';

const props = defineProps({
  model: { type: Object, required: true },
  notify: { type: Function, required: true },
  locked: Boolean,
  /** 由投料表算出来的字段（溶剂 / 浓度）：只显示，不给编辑 */
  fixed: { type: Object, default: () => ({}) },
});

/** 和下面「结果」那张表同款：一行表头 + 一行值 */
const fields = [
  { key: 'solvent', label: '溶剂', ph: 'THF', cls: 'ct-solvent' },
  { key: 'concentration', label: '浓度', ph: '0.1 M', cls: 'ct-conc' },
  { key: 'temperature', label: '反应温度', ph: '−78 ℃', cls: 'ct-temp' },
  { key: 'duration', label: '时间节点', ph: '8:45 → 15:11', cls: 'ct-time' },
  { key: 'atmosphere', label: '气氛 / 容器', ph: 'N₂，封管', cls: 'ct-atm' },
];

const open = ref('');
const optionsFor = (key) => QUICK[`f-${key}`] || [];

/** 浓度是数字 + M，其他栏（THF、−78 ℃、16 h、N₂）保持自由输入 */
function onInput(ev, f) {
  if (f.key === 'concentration') applyNumeric(ev.target, 'Mm');
  props.model[f.key] = ev.target.value;
}

function pick(key, v) {
  props.model[key] = v;
  open.value = '';
  props.notify();
}

/* 点外面 / 按 Esc 就把下拉收起来（之前只能再点一次箭头，很卡手） */
function onDocClick(ev) {
  if (!open.value) return;
  if (ev.target.closest?.('.cond-menu') || ev.target.closest?.('.cond-caret')) return;
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
  <table class="rtable cond-table">
    <colgroup>
      <col v-for="f in fields" :key="f.key" :class="f.cls" />
    </colgroup>
    <thead>
      <tr>
        <th v-for="f in fields" :key="f.key">{{ f.label }}</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td v-for="f in fields" :key="f.key" class="cond-cell">
          <span v-if="f.key in fixed" class="cond-fixed" title="来自投料表">{{ fixed[f.key] || '—' }}</span>
          <template v-else>
            <input
              :value="model[f.key]"
              :placeholder="f.ph"
              :disabled="locked"
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

            <div v-if="open === f.key" class="qmenu cond-menu" @click.stop>
              <button
                v-for="v in optionsFor(f.key)"
                :key="v"
                type="button"
                class="qchip"
                :aria-selected="String(model[f.key] || '') === v"
                @click="pick(f.key, v)"
              >
                {{ v }}
              </button>
            </div>
          </template>
        </td>
      </tr>
    </tbody>
  </table>
</template>
