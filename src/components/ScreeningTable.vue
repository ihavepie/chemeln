<script setup>
import { computed } from 'vue';
import { autoValue } from '../lib/sctfields.js';

/**
 * 一张条件筛选表的「三线表」本体（照文献里优化表的样子）。
 *
 * 详情页（`ScreeningView`）传 `editable` 才出现表头的「改 / ×」、行尾 ×、手动列的输入框；
 * 条件筛选首页（`ScreeningsView`）只读地摊开同一张表，点行进那条记录。
 * 列定义来自 `screening.vars`，每一列要么自动（读记录）要么手动（`entries[].cells`）。
 */
const props = defineProps({
  screening: { type: Object, required: true },
  rows: { type: Array, default: () => [] },
  editable: { type: Boolean, default: false },
  // 能画出结构时给一段反应式 SVG（不带白底），画在表格上方
  scheme: { type: String, default: '' },
  // 文献表的表标题：`表 1　条件优化`（index 是这张表在本页的序号）
  index: { type: Number, default: 0 },
  caption: { type: String, default: '' },
});
const emit = defineEmits(['open', 'change', 'rename-field', 'remove-field', 'remove-row']);

const fields = computed(() => (Array.isArray(props.screening?.vars) ? props.screening.vars : []));
// 表头照文献用英文（这张表本来就照论文里的优化表做）；用户自己命名的「手动」列才保留原名
const EN_LABEL = {
  variation: 'Variations from the standard conditions',
  temperature: 'Temperature',
  solvent: 'Solvent',
  duration: 'Time',
  atmosphere: 'Atmosphere',
  addition: 'Additive',
  reagent: 'Reagents',
  yield: 'Yield',
  sel: 'Selectivity',
  product: 'Product',
  substrates: 'Substrate',
  appearance: 'Appearance',
  tlc_note: 'TLC',
  conclusion: 'Conclusion',
  notes: 'Notes',
  date: 'Date',
};
const labelOf = (f) => EN_LABEL[f.source] || f.label;
const isManual = (f) => !f.source || f.source === 'manual';
// 文献表的表头带单位（`Yield (%)`）；只有明确是百分比的来源才标，别的列不猜
const unitOf = (f) => (f.source === 'yield' || f.source === 'sel' ? '%' : '');
// 长文字的列要占宽，不然表头一带上「(%)」它们就被挤成两行
const WIDE = new Set(['variation', 'reagent', 'substrates', 'product', 'appearance', 'tlc_note', 'conclusion', 'notes']);
const isWide = (f) => WIDE.has(f.source);
const base = computed(() => props.rows[0]?.exp || null);
// 有带单位的列（产率 / 选择性）才在标题后挂 [a]、表下挂 [b]，跟文献的脚注锚点对上
const hasUnit = computed(() => fields.value.some((f) => unitOf(f)));
const hasStd = computed(() => !!props.scheme);

// 表头已经写了单位（产率 [%]），格子里就不再重复一个 %——文献里的数字是裸的
const cell = (f, r) => {
  const v = isManual(f) ? r.cells[f.key] || '' : autoValue(f.source, r.exp, base.value);
  return unitOf(f) && typeof v === 'string' ? v.replace(/\s*%\s*$/, '') : v;
};
</script>

<template>
  <div class="scope-wrap sct-plain">
    <p v-if="index || caption" class="sct-cap">
      <span v-if="index" class="sct-cap-no">Table {{ index }}.</span><span v-if="caption" class="sct-cap-ti">{{ caption }}</span><sup
        v-if="hasStd"
        class="sct-cap-fn"
      >[a]</sup>
    </p>
    <!-- 反应式居中压在表格上方（条件就画在箭头上下，不再另起一行字） -->
    <div v-if="scheme" class="sct-std">
      <div class="sct-std-scheme" v-html="scheme" />
    </div>
    <!-- 表格铺满内容宽度（以前那条「自己拖表格宽度」的竖线用户不要了：要调宽度拖列表↔纸面那条） -->
    <table class="sct-table">
      <thead>
        <tr>
          <th class="sct-c-entry">Entry</th>
          <th class="sct-c-fix">Code</th>
          <th
            v-for="f in fields"
            :key="f.key"
            class="sct-field"
            :class="{ 'sct-num': f.num, 'sct-wide': isWide(f) }"
          >
            <div class="sct-th">
              <span class="sct-th-label">
                {{ labelOf(f) }}<template v-if="unitOf(f)"> [{{ unitOf(f) }}]</template><sup
                  v-if="unitOf(f)"
                  class="sct-th-fn"
                >[b]</sup>
              </span>
              <span v-if="isManual(f)" class="sct-th-src">manual</span>
              <span v-if="editable" class="sct-th-acts">
                <button class="sct-var-x" title="改名" @click="emit('rename-field', f)">改</button>
                <button class="sct-var-x is-del" title="删这一列" @click="emit('remove-field', f)">×</button>
              </span>
            </div>
          </th>
          <th v-if="editable" class="sct-c-x"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="r.exp_id" :class="{ 'is-base': i === 0 }">
          <td class="sct-c-entry">{{ i + 1 }}</td>
          <td class="sct-c-fix sct-sub">
            <button v-if="r.exp" class="linklike" @click="emit('open', r)">{{ r.exp.code }}</button>
            <span v-else class="mono muted">#{{ r.exp_id }}</span>
            <!-- 记录页那个「实验名」多半是空的（编号才是日常叫法），有才跟在编号后面 -->
            <span v-if="r.exp && r.exp.title" class="sct-title">{{ r.exp.title }}</span>
          </td>
          <td
            v-for="f in fields"
            :key="f.key"
            class="sct-field"
            :class="{ 'sct-num': f.num, 'sct-wide': isWide(f), 'is-manual': isManual(f) }"
          >
            <input
              v-if="editable && isManual(f)"
              :value="r.cells[f.key]"
              class="sct-cell"
              @input="(e) => { r.cells[f.key] = e.target.value; emit('change'); }"
            />
            <span
              v-else
              class="sct-auto"
              :class="{ 'sct-wrap': f.source === 'reagent' || f.source === 'variation' }"
            >
              {{ cell(f, r) || '—' }}
            </span>
          </td>
          <td v-if="editable" class="sct-c-x">
            <button class="sct-row-x" title="从表里去掉" @click="emit('remove-row', i)">×</button>
          </td>
        </tr>
      </tbody>
    </table>
    <!-- 文献表下面那行小字脚注：上标字母 + 小字，锚点跟标题的 [a]、表头的 [b] 对上 -->
    <p class="sct-note">
      <span v-if="hasStd" class="sct-note-item"><sup>[a]</sup>Standard conditions are shown above; the variations column lists only what differs from them.</span>
      <span v-if="hasUnit" class="sct-note-item"><sup>[b]</sup>Yields and selectivities are taken from the record entries.</span>
    </p>
  </div>
</template>
