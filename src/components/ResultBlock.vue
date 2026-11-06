<script setup>
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import AppModal from './AppModal.vue';
import { compoundDict } from '../store.js';
import { api } from '../api.js';
import { num, round, yieldInfo } from '../lib/reagent.js';
import { applyNumeric } from '../lib/numinput.js';

const props = defineProps({
  model: { type: Object, required: true },
  base: { type: [Number, String], default: null },
  notify: { type: Function, required: true },
  locked: Boolean,
});
const emit = defineEmits(['open-compound']);

const picking = ref(false);
const list = ref([]);
const picked = ref(null);
/** 产率格用户手填过没有：手填过就不再自动覆盖（和「手填过就不动」的约定一致） */
const yieldTyped = ref(num(props.model.yield_pct) !== null);
const baseMmol = computed(() => props.base ?? props.model.base);
const info = computed(() => yieldInfo({
  base_mmol: baseMmol.value,
  product_mw: props.model.product_mw,
  product_mass: props.model.product_mass,
  yield_pct: props.model.yield_pct,
}));

/**
 * 质量变了就刷新产率格（自动填的那种才刷新）。
 * 以前这里卡的是 `!num(yield_pct)`：质量的第一个字符就先把产率写进去了，
 * 后面补全质量时条件已经不成立，产率就永远停在半截值上。
 */
function syncYield() {
  if (yieldTyped.value) return;
  const i = info.value;
  if (i.calc === null || i.over) return;
  props.model.yield_pct = round(i.calc, 1);
}

const linked = computed(() => compoundDict().find((c) => Number(c.id) === Number(props.model.product_compound_id)));

async function openPicker() {
  list.value = await api.compounds();
  picked.value = props.model.product_compound_id || list.value[0]?.id || null;
  picking.value = true;
}

async function applyPick() {
  const hit = list.value.find((c) => c.id === picked.value);
  picking.value = false;
  if (!hit) return;
  const full = await api.compound(hit.id);
  props.model.product_name = full.name || full.code || '';
  if (full.mw) props.model.product_mw = round(full.mw, 2);
  props.model.product_compound_id = full.id;
  props.notify();
}

function unlink() {
  props.model.product_compound_id = null;
  props.notify();
}

/** 边打字边算：数字格先清洗，再写回模型（不用等失焦） */
function onNumInput(ev, field) {
  applyNumeric(ev.target, '');
  props.model[field] = ev.target.value;
  props.notify();
}

function onMassInput(ev) {
  applyNumeric(ev.target, '');
  props.model.product_mass = ev.target.value;
  syncYield();
  props.notify();
}

/** 自动补产率（手填过就不动） */
function afterMass() {
  syncYield();
  props.notify();
}

/** 手填产率：从此停止自动算；把它清空就退回自动 */
function onYieldInput(ev) {
  applyNumeric(ev.target, '');
  props.model.yield_pct = ev.target.value;
  yieldTyped.value = num(props.model.yield_pct) !== null;
  props.notify();
}
</script>

<template>
  <section class="sec sec-tight">
    <div class="block-head"><span class="lbl">结果</span></div>
    <table class="rtable res-table">
      <colgroup>
        <col class="r-name" /><col class="r-appear" /><col class="r-mw" /><col class="r-mass" /><col class="r-yield" /><col class="r-dr" />
      </colgroup>
      <thead>
        <tr>
          <th>产物名称</th><th>性状</th><th class="n">产物 MW</th>
          <th class="n">质量 / g</th><th class="n">产率 / %</th><th class="n">dr / ee</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <div class="pick-wrap">
              <span v-if="linked" class="prod-link">
                <span class="cmp-tag" :title="linked.name" @click="emit('open-compound', linked.id)">{{ linked.code || linked.name }}</span>
                <button v-if="!locked" class="cmp-unlink noprint" title="解除关联" @click.stop="unlink"><Icon name="x" :size="9" /></button>
              </span>
              <input :value="model.product_name" placeholder="C" :disabled="locked" @input="model.product_name = $event.target.value; notify()" @change="notify()" />
              <button v-if="!locked && !linked" type="button" class="pick-btn noprint" title="从化合物库选" @click="openPicker"><Icon name="molecule" :size="12" /></button>
            </div>
          </td>
          <td><input :value="model.appearance" placeholder="白色固体" :disabled="locked" @input="model.appearance = $event.target.value; notify()" @change="notify()" /></td>
          <td><input class="n" inputmode="decimal" :value="model.product_mw ?? ''" placeholder="自动" :disabled="locked" @input="onNumInput($event, 'product_mw')" /></td>
          <td><input class="n" inputmode="decimal" :value="model.product_mass ?? ''" placeholder="2.3975" :disabled="locked" @input="onMassInput($event)" @change="afterMass()" /></td>
          <td><input class="n" inputmode="decimal" :value="model.yield_pct ?? ''" placeholder="自动" :disabled="locked" @input="onYieldInput($event)" /></td>
          <td><input class="n" :value="model.dr_ee" placeholder="> 20:1" :disabled="locked" @input="model.dr_ee = $event.target.value; notify()" @change="notify()" /></td>
        </tr>
      </tbody>
    </table>
    <div class="res-sel">
      <span class="sel-cap">选择性测定</span>
      <label class="sel-f">
        <span>ee / %</span>
        <input class="n" inputmode="decimal" :value="model.ee_pct ?? ''" placeholder="92" :disabled="locked" @input="onNumInput($event, 'ee_pct')" />
      </label>
      <label class="sel-f">
        <span>方式</span>
        <input :value="model.sel_method" placeholder="HPLC" :disabled="locked" @input="model.sel_method = $event.target.value; notify()" @change="notify()" />
      </label>
      <label class="sel-f sel-wide">
        <span>手性柱 / 流动相</span>
        <input :value="model.sel_condition" placeholder="Chiralpak IA，n-hexane/i-PrOH = 90:10，1.0 mL/min" :disabled="locked" @input="model.sel_condition = $event.target.value; notify()" @change="notify()" />
      </label>
      <label class="sel-f">
        <span>tR / min</span>
        <input :value="model.sel_rt" placeholder="12.4 / 14.1" :disabled="locked" @input="model.sel_rt = $event.target.value; notify()" @change="notify()" />
      </label>
    </div>

    <div v-if="info.theo" class="res-note" :class="{ warn: info.over }"><template v-if="info.over">理论产量只有 <b>{{ round(info.theo, 4) }} g</b>（{{ round(baseMmol, 3) }} mmol × {{ round(model.product_mw, 2) }}），称到的 {{ round(model.product_mass, 4) }} g 对应 <b>{{ round(info.calc, 1) }}%</b> —— 检查规模 / 产物 MW / 残留溶剂。</template><template v-else-if="info.calc !== null">理论产量 <b>{{ round(info.theo, 4) }} g</b>（{{ round(baseMmol, 3) }} mmol）　·　实测产率 <b>{{ round(info.calc, 1) }}%</b></template><template v-else>理论产量 <b>{{ round(info.theo, 4) }} g</b>（{{ round(baseMmol, 3) }} mmol）</template></div>

    <AppModal v-if="picking" title="产物是库里的哪个化合物" confirm-text="选它" @close="picking = false" @confirm="applyPick">
      <div class="recipe-list">
        <button
          v-for="c in list"
          :key="c.id"
          type="button"
          class="recipe-opt"
          :class="{ 'is-on': picked === c.id }"
          @click="picked = c.id"
        >
          <span class="recipe-thumb">
            <img v-if="c.structure_id" :src="`/api/compound-files/${c.structure_id}`" alt="" loading="lazy" />
            <Icon v-else name="molecule" :size="14" />
          </span>
          <span class="recipe-code mono">{{ c.code || '—' }}</span>
          <span class="recipe-title">{{ c.name || '（未命名）' }}</span>
          <span class="recipe-meta">{{ c.formula || '' }}{{ c.mw ? ` · ${c.mw}` : '' }}</span>
        </button>
      </div>
      <div class="hint" style="margin-top: 10px">选中后将带入名称与分子量，本实验亦与该化合物建立关联。</div>
    </AppModal>
  </section>
</template>
