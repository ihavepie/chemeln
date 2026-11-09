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
  // 「标准条件」一行字（基准那条记录的投料 + 溶剂 / 温度 / 时间），像文献表格的副标题
  standard: { type: String, default: '' },
  // 能画出结构时给一段反应式 SVG（不带白底），画在表格上方
  scheme: { type: String, default: '' },
  // 文献表的表标题：`表 1　条件优化`（index 是这张表在本页的序号）
  index: { type: Number, default: 0 },
  caption: { type: String, default: '' },
});
const emit = defineEmits(['open', 'change', 'rename-field', 'remove-field', 'remove-row']);

const fields = computed(() => (Array.isArray(props.screening?.vars) ? props.screening.vars : []));
const isManual = (f) => !f.source || f.source === 'manual';
// 文献表的表头带单位（`Yield (%)`）；只有明确是百分比的来源才标，别的列不猜
const unitOf = (f) => (f.source === 'yield' || f.source === 'sel' ? '%' : '');
// 长文字的列要占宽，不然表头一带上「(%)」它们就被挤成两行
const WIDE = new Set(['variation', 'reagent', 'substrates', 'product', 'appearance', 'tlc_note', 'conclusion', 'notes']);
const isWide = (f) => WIDE.has(f.source);
const base = computed(() => props.rows[0]?.exp || null);

const cell = (f, r) => (isManual(f) ? r.cells[f.key] || '' : autoValue(f.source, r.exp, base.value));
</script>

<template>
  <div class="scope-wrap sct-plain">
    <p v-if="index || caption" class="sct-cap">
      <span v-if="index" class="sct-cap-no">表 {{ index }}</span><span v-if="caption" class="sct-cap-ti">{{ caption }}</span>
    </p>
    <!-- 反应式 + 条件文字并排一行（像论文里表格上方那张示意图 + 条件说明） -->
    <div v-if="scheme" class="sct-std">
      <div class="sct-std-scheme" v-html="scheme" />
      <p v-if="standard" class="sct-std-line"><span class="sct-std-lbl">标准条件：</span>{{ standard }}</p>
    </div>
    <!-- 画不出结构时只有一行字：不套卡片（一行字的白盒子看着像半个按钮），就压在表顶上 -->
    <p v-else-if="standard" class="sct-std-line sct-std-line--bare">
      <span class="sct-std-lbl">标准条件：</span>{{ standard }}
    </p>
    <table class="sct-table">
      <thead>
        <tr>
          <th class="sct-c-entry">Entry</th>
          <th class="sct-c-fix">实验编号</th>
          <th
            v-for="f in fields"
            :key="f.key"
            class="sct-field"
            :class="{ 'sct-num': f.num, 'sct-wide': isWide(f) }"
          >
            <div class="sct-th">
              <span class="sct-th-label">{{ f.label }}<template v-if="unitOf(f)"> ({{ unitOf(f) }})</template></span>
              <span v-if="isManual(f)" class="sct-th-src">手动</span>
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
    <!-- 文献表下面那行小字脚注 -->
    <p v-if="rows.length > 1" class="sct-note">
      <sup>a</sup> 标「标准条件」的一行为基准，其余为相对基准的单变量改动；产率 / 选择性取记录里填的值。
    </p>
  </div>
</template>
