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
});
const emit = defineEmits(['open', 'change', 'rename-field', 'remove-field', 'remove-row']);

const fields = computed(() => (Array.isArray(props.screening?.vars) ? props.screening.vars : []));
const isManual = (f) => !f.source || f.source === 'manual';
const base = computed(() => props.rows[0]?.exp || null);

const cell = (f, r) => (isManual(f) ? r.cells[f.key] || '' : autoValue(f.source, r.exp, base.value));
</script>

<template>
  <div class="scope-wrap">
    <table class="sct-table">
      <thead>
        <tr>
          <th class="sct-c-entry">Entry</th>
          <th class="sct-c-fix">实验编号</th>
          <th v-for="f in fields" :key="f.key" :class="{ 'sct-num': f.num }">
            <div class="sct-th">
              <span class="sct-th-label">{{ f.label }}</span>
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
            <button v-if="r.exp" class="linklike mono" @click="emit('open', r)">{{ r.exp.code }}</button>
            <span v-else class="mono muted">#{{ r.exp_id }}</span>
            <!-- 记录页那个「实验名」多半是空的（编号才是日常叫法），有才跟在编号后面 -->
            <span v-if="r.exp && r.exp.title" class="sct-title">{{ r.exp.title }}</span>
          </td>
          <td v-for="f in fields" :key="f.key" :class="{ 'sct-num': f.num, 'is-manual': isManual(f) }">
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
  </div>
</template>
