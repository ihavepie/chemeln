<script setup>
import { computed, reactive, ref } from 'vue';
import Icon from './Icon.vue';
import AppModal from './AppModal.vue';
import { compoundDict } from '../store.js';
import { api } from '../api.js';
import { num, round, yieldInfo } from '../lib/reagent.js';
import { applyNumeric } from '../lib/numinput.js';
import { TLC_VERDICTS } from '../lib/ui.js';
import FilePreview from './FilePreview.vue';

const props = defineProps({
  model: { type: Object, required: true },
  base: { type: [Number, String], default: null },
  notify: { type: Function, required: true },
  locked: Boolean,
  /** 记录类型（现在只用来显示 / 兼容；「算不算产率」改由 `yieldDefault` 决定） */
  kind: { type: String, default: '' },
  /** 这一类的默认：计产率吗（设置页 06 里按记录类型各记一套） */
  yieldDefault: { type: Boolean, default: true },
  /** 「选择性测定」那行要不要出现（同一套设置里的开关） */
  showSel: { type: Boolean, default: true },
  /**
   * 多步记录：每一步自己的结果（产物 / MW / 质量 / 产率 / 选择性）。
   * **最后一步就是这条记录本身**——列表、筛选表、导出读的都是记录那几格，
   * 所以最后一行直接读写 `model`，前面几步写 `steps[i]`。
   */
  steps: { type: Array, default: () => [] },
  /** 这条记录的 TLC 板图（`category === 'tlc'` 的附件）：小反应只看板子时，结果这块就靠它们 */
  tlc: { type: Array, default: () => [] },
});
const emit = defineEmits(['open-compound']);

const picking = ref(false);
const shot = ref(null); // 点开的大图（TLC 板子）
const pickShot = ref(false); // 「换一张板」的小弹层

/** 结果区引用的那张板：优先用记录里明确引用的，只有一张时就默认那张 */
const refShot = computed(() => {
  const id = Number(props.model.tlc_shot_id);
  const hit = id ? props.tlc.find((a) => Number(a.id) === id) : null;
  return hit || (props.tlc.length === 1 ? props.tlc[0] : null);
});

function chooseShot(a) {
  if (props.locked) return;
  props.model.tlc_shot_id = Number(a.id);
  pickShot.value = false;
  props.notify();
}
const list = ref([]);
const picked = ref(null);
/** 正在挑「产物是库里的哪个化合物」的那一行（多步时每行各挑各的） */
const pickTarget = ref(null);

const multi = computed(() => Array.isArray(props.steps) && props.steps.length > 1);
/** 一行结果：`{i, label, rm, last}`；单步记录就一行、直接绑记录本身 */
const rows = computed(() => {
  const list = props.steps || [];
  if (!multi.value) return [{ i: 0, label: '', rm: props.model, last: true }];
  return list.map((s, i) => {
    const last = i === list.length - 1;
    return { i, label: `第 ${i + 1} 步`, rm: last ? props.model : s, last };
  });
});
/** 「产率手填过」按行记：手填过就不再自动覆盖（和「手填过就不动」的约定一致） */
const typed = reactive({});
const rowKey = (r) => (r.last ? 'final' : `s${r.i}`);
const isTyped = (r) => {
  const k = rowKey(r);
  if (!(k in typed)) typed[k] = num(r.rm.yield_pct) !== null;
  return typed[k];
};

/**
 * 计不计产率：**按记录类型在设置页里配**（`sheetFx.yield`，见 `lib/sheetprefs.js`），
 * 以前的写死规则（kind === '原料' 就不计）已经搬进默认值。
 * 类型默认不计、但这条记录已经手填过产率的，照旧显示——不把已有数据藏起来。
 */
const kindNoYield = computed(() => !props.yieldDefault);
const noYield = computed(
  () => Number(props.model.no_yield) === 1 || (kindNoYield.value && num(props.model.yield_pct) === null)
);
/** 多步记录不给那种「整条不计产率」的开关：哪一步没算产率就把那格空着 */
const showNoYieldBtn = computed(() => !multi.value && !kindNoYield.value);

/** TLC 判断：点一下设档，再点一次取消（没看清就空着） */
function setVerdict(v) {
  if (props.locked) return;
  props.model.tlc_verdict = props.model.tlc_verdict === v ? '' : v;
  props.notify();
}

function toggleNoYield() {
  if (props.locked) return;
  const next = noYield.value ? 0 : 1;
  props.model.no_yield = next;
  if (next) {
    props.model.yield_pct = '';
    typed.final = false;
  }
  props.notify();
}

/** 清空这一行结果（连化合物关联一起解掉），方便换产物或重填 */
function clearResult(r) {
  if (props.locked) return;
  const m = r.rm;
  m.product_name = '';
  m.appearance = '';
  m.product_mw = '';
  m.product_mass = '';
  m.yield_pct = '';
  m.dr_ee = '';
  m.product_compound_id = null;
  typed[rowKey(r)] = false;
  // 最后一行就是整条记录的结果：选择性那几格也一起清
  if (r.last) {
    props.model.ee_pct = '';
    props.model.sel_method = '';
    props.model.sel_condition = '';
    props.model.sel_rt = '';
    props.model.no_yield = 0;
  }
  props.notify();
}

const baseMmol = computed(() => props.base ?? props.model.base);
const infoOf = (rm) =>
  yieldInfo({
    base_mmol: baseMmol.value,
    product_mw: rm.product_mw,
    product_mass: rm.product_mass,
    yield_pct: rm.yield_pct,
  });
/** 底部那行「理论产量 / 实测产率」：多步时只看最后一步（中间产物的数在各自的格子里） */
const info = computed(() => infoOf(props.model));

function syncYield(r) {
  if (isTyped(r)) return;
  if (r.last && noYield.value) return;
  const i = infoOf(r.rm);
  if (i.calc === null || i.over) return;
  r.rm.yield_pct = round(i.calc, 1);
}

const linkedOf = (rm) => compoundDict().find((c) => Number(c.id) === Number(rm.product_compound_id));

/** 外面（比如「按投料表生成」发现产物没挂库）可以直接把这个选择器弹出来 */
defineExpose({ openPicker: () => openPicker(rows.value[rows.value.length - 1]) });

async function openPicker(r) {
  pickTarget.value = r ? r.rm : props.model;
  list.value = await api.compounds();
  picked.value = pickTarget.value.product_compound_id || list.value[0]?.id || null;
  picking.value = true;
}

async function applyPick() {
  const hit = list.value.find((c) => c.id === picked.value);
  picking.value = false;
  if (!hit || !pickTarget.value) return;
  const full = await api.compound(hit.id);
  const m = pickTarget.value;
  m.product_name = full.name || full.code || '';
  if (full.mw) m.product_mw = round(full.mw, 2);
  m.product_compound_id = full.id;
  props.notify();
}

function unlink(r) {
  r.rm.product_compound_id = null;
  props.notify();
}

/** 边打字边算：数字格先清洗，再写回模型（不用等失焦） */
function onNumInput(ev, rm, field) {
  applyNumeric(ev.target, '');
  rm[field] = ev.target.value;
  props.notify();
}

function onMassInput(ev, r) {
  applyNumeric(ev.target, '');
  r.rm.product_mass = ev.target.value;
  syncYield(r);
  props.notify();
}

/** 自动补产率（手填过就不动） */
function afterMass(r) {
  syncYield(r);
  props.notify();
}

/** 手填产率：从此停止自动算；把它清空就退回自动 */
function onYieldInput(ev, r) {
  applyNumeric(ev.target, '');
  r.rm.yield_pct = ev.target.value;
  typed[rowKey(r)] = num(r.rm.yield_pct) !== null;
  props.notify();
}
</script>

<template>
  <section class="sec sec-tight">
    <div class="block-head">
      <span class="lbl">结果</span>
      <span v-if="multi" class="lbl-note">一步一行</span>
    </div>
    <table class="rtable res-table" :class="{ 'is-multi': multi }">
      <colgroup>
        <col v-if="multi" class="r-step" />
        <col class="r-name" /><col v-if="!multi" class="r-appear" /><col class="r-mw" /><col class="r-mass" /><col class="r-yield" /><col v-if="!multi" class="r-dr" /><col class="r-del" />
      </colgroup>
      <thead>
        <tr>
          <th v-if="multi" />
          <th class="r-name">产物名称</th><th v-if="!multi">性状</th><th class="n">产物 MW</th>
          <th class="n">质量 / g</th>
          <th class="n">
            <span class="th-with-btn"
              >产率 / %<!-- 「原料」类记录是算出来的「不计」，不给点（要产率就换类型）；其余照旧一颗 ∅ 小开关 --><span
                v-if="!multi && kindNoYield && noYield"
                class="th-mini is-static"
                title="原料类记录默认不计产率；要产率就把记录类型换成「试反应」"
                >不计</span
              ><button
                v-else-if="showNoYieldBtn"
                type="button"
                class="th-mini noprint"
                :class="{ on: noYield }"
                :disabled="locked"
                :title="noYield ? '恢复自动算产率' : '粗产物/中间体：不计产率'"
                @click.stop="toggleNoYield"
              >
                {{ noYield ? '不计' : '∅' }}
              </button></span
            >
          </th>
          <th v-if="!multi" class="n">dr / ee</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="rowKey(r)">
          <td v-if="multi" class="res-step-cell">{{ r.label }}</td>
          <td>
            <div class="pick-wrap">
              <!-- 化合物小签还在名字左边；它占的是一个**定宽**的槽（`--res-tag-w`），
                   名字因此每行都从同一个位置开始，表头也对齐到这个位置上 -->
              <span v-if="linkedOf(r.rm)" class="prod-link">
                <span
                  class="cmp-tag"
                  :title="linkedOf(r.rm).name"
                  @click="emit('open-compound', linkedOf(r.rm).id)"
                  >{{ linkedOf(r.rm).code || linkedOf(r.rm).name }}</span
                >
                <button v-if="!locked" class="cmp-unlink noprint" title="解除关联" @click.stop="unlink(r)"><Icon name="x" :size="9" /></button>
              </span>
              <span v-else class="prod-slot" />
              <input
                :value="r.rm.product_name"
                :placeholder="multi ? (r.last ? '终产物' : '中间体') : 'C'"
                :disabled="locked"
                @input="r.rm.product_name = $event.target.value; notify()"
                @change="notify()"
              />
              <button
                v-if="!locked && !linkedOf(r.rm)"
                type="button"
                class="pick-btn noprint"
                title="从化合物库选"
                @click="openPicker(r)"
              >
                <Icon name="molecule" :size="12" />
              </button>
            </div>
          </td>
          <td v-if="!multi"><input :value="r.rm.appearance" placeholder="白色固体" :disabled="locked" @input="r.rm.appearance = $event.target.value; notify()" @change="notify()" /></td>
          <td><input class="n" inputmode="decimal" :value="r.rm.product_mw ?? ''" placeholder="自动" :disabled="locked" @input="onNumInput($event, r.rm, 'product_mw')" /></td>
          <td><input class="n" inputmode="decimal" :value="r.rm.product_mass ?? ''" :placeholder="multi ? '' : '2.3975'" :disabled="locked" @input="onMassInput($event, r)" @change="afterMass(r)" /></td>
          <td>
            <input
              class="n"
              inputmode="decimal"
              :value="r.last && noYield ? '' : (r.rm.yield_pct ?? '')"
              :placeholder="r.last && noYield ? '—' : multi ? '' : (model.tlc_verdict && !r.rm.yield_pct ? '待测' : '自动')"
              :disabled="locked || (r.last && noYield)"
              @input="onYieldInput($event, r)"
            />
          </td>
          <td v-if="!multi"><input class="n" :value="r.rm.dr_ee" placeholder="> 20:1" :disabled="locked" @input="r.rm.dr_ee = $event.target.value; notify()" @change="notify()" /></td>
          <td class="del-cell">
            <button v-if="!locked" type="button" class="row-del noprint" title="清空这行结果" @click.stop="clearResult(r)"><Icon name="x" :size="10" /></button>
          </td>
        </tr>
      </tbody>
    </table>
    <!-- 多步记录：性状 / 选择性是**最终产物**的属性，挪到表下面一行，别跟每一步的数字挤在一张表里 -->
    <div v-if="multi" class="res-sel res-final">
      <span class="sel-cap">最终产物</span>
      <label class="sel-f">
        <span>性状</span>
        <input :value="model.appearance" placeholder="黄色油状液体" :disabled="locked" @input="model.appearance = $event.target.value; notify()" @change="notify()" />
      </label>
      <label class="sel-f">
        <span>dr / ee</span>
        <input class="n" :value="model.dr_ee" placeholder="> 20:1" :disabled="locked" @input="model.dr_ee = $event.target.value; notify()" @change="notify()" />
      </label>
    </div>
    <!-- TLC 判断：小反应筛条件时先看板子，产率过几天才称 —— 这一行是排在产率前面的一层结果 -->
    <div class="res-tlc">
      <span class="sel-cap">TLC 判断</span>
      <div class="tlc-verdicts">
        <button
          v-for="v in TLC_VERDICTS"
          :key="v"
          type="button"
          class="tv-chip"
          :class="{ on: model.tlc_verdict === v }"
          :disabled="locked"
          @click="setVerdict(v)"
        >
          {{ v }}
        </button>
      </div>
      <!-- 结果区只挂一个「板图」引用（不在纸上铺一排行）：点缩略看大图，多张时右边能换 -->
      <div v-if="refShot" class="tlc-ref">
        <button
          type="button"
          class="tlc-ref-btn"
          title="点开看大图"
          @click="shot = { src: `/api/files/${refShot.id}`, name: refShot.original_name || 'TLC' }"
        >
          <img :src="`/api/files/${refShot.id}`" :alt="refShot.original_name || 'TLC'" loading="lazy" />
          <span class="tlc-ref-name">{{ refShot.original_name || '板图' }}</span>
        </button>
        <button v-if="tlc.length > 1 && !locked" type="button" class="tlc-ref-swap" title="换一张板" @click="pickShot = true">
          换
        </button>
      </div>
      <span v-else-if="tlc.length > 1" class="tlc-ref-empty">有 {{ tlc.length }} 张板，
        <button v-if="!locked" type="button" class="tlc-ref-swap" @click="pickShot = true">选一张</button>
      </span>
    </div>

    <div v-if="showSel" class="res-sel">
      <span class="sel-cap">选择性测定</span>
      <label class="sel-f">
        <span>ee / %</span>
        <input class="n" inputmode="decimal" :value="model.ee_pct ?? ''" placeholder="92" :disabled="locked" @input="onNumInput($event, model, 'ee_pct')" />
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

    <!-- 多步记录不再重复这行「理论产量」：每一步的质量 / 产率在表里都有；
         但「称到的比理论还多」那种异常还是要报 -->
    <div v-if="info.theo && (!multi || info.over)" class="res-note" :class="{ warn: info.over }"><template v-if="info.over">理论产量只有 <b>{{ round(info.theo, 4) }} g</b>（{{ round(baseMmol, 3) }} mmol × {{ round(model.product_mw, 2) }}），称到的 {{ round(model.product_mass, 4) }} g 对应 <b>{{ round(info.calc, 1) }}%</b> —— 检查规模 / 产物 MW / 残留溶剂。</template><template v-else-if="noYield">理论产量 <b>{{ round(info.theo, 4) }} g</b>（{{ round(baseMmol, 3) }} mmol）　·　<span class="muted">不计产率</span></template>
      <template v-else-if="info.calc !== null">理论产量 <b>{{ round(info.theo, 4) }} g</b>（{{ round(baseMmol, 3) }} mmol）　·　实测产率 <b>{{ round(info.calc, 1) }}%</b></template><template v-else>理论产量 <b>{{ round(info.theo, 4) }} g</b>（{{ round(baseMmol, 3) }} mmol）</template></div>

    <FilePreview v-if="shot" :src="shot.src" :name="shot.name" @close="shot = null" />

    <AppModal v-if="pickShot" title="结果区挂哪张 TLC 板" confirm-text="就这张" @close="pickShot = false" @confirm="pickShot = false">
      <div class="tlc-pick">
        <button
          v-for="a in tlc"
          :key="a.id"
          type="button"
          class="tlc-pick-opt"
          :class="{ 'is-on': Number(model.tlc_shot_id) === Number(a.id) }"
          @click="chooseShot(a)"
        >
          <img :src="`/api/files/${a.id}`" alt="" loading="lazy" />
          <span>{{ a.original_name || 'TLC' }}</span>
        </button>
      </div>
    </AppModal>

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

    <!-- 一次筛好几个条件时，每个条件的产率 / 选择性放在这里（变量在投料表下面） -->
    <slot name="conds" />
  </section>
</template>
