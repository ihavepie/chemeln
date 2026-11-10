<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
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
// 有带单位的列（产率 / 选择性）才在标题后挂 [a]、表下挂 [b]，跟文献的脚注锚点对上
const hasUnit = computed(() => fields.value.some((f) => unitOf(f)));
const hasStd = computed(() => !!(props.scheme || props.standard));

// 表格宽度：默认「按内容宽」（比满页窄，文献里那种），右侧竖线可以拖宽 / 拖窄，
// 双击回到自适应。宽度存 localStorage，是这台显示器上的偏好、不进库。
const WIDTH_KEY = 'eln:sct:w';
const storedW = Number(localStorage.getItem(WIDTH_KEY));
const fitW = ref(Number.isFinite(storedW) && storedW >= 360 ? Math.round(storedW) : 0);
const fitEl = ref(null);
const resizing = ref(false);

// 量一下表格「最窄能多窄」：临时按 min-content 排，量完还原（再窄就溢出去了）
function measureMin() {
  const tb = fitEl.value?.querySelector('table');
  if (!tb) return 320;
  const keep = tb.style.width;
  tb.style.width = 'min-content';
  const min = Math.ceil(tb.getBoundingClientRect().width);
  tb.style.width = keep;
  return Math.max(320, min);
}

// 只吃 mouse 事件：Safari 里表格上的 pointer 事件常被拖选吞掉（跟 lib/colresize.js 一个理由）
function startResize(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = fitW.value || fitEl.value?.getBoundingClientRect().width || 0;
  const minW = measureMin();
  // 上限 = 外层容器（.sct-plain）的宽度，别把页面拱出横向滚动条
  const maxW = Math.max(minW, Math.round(fitEl.value?.parentElement?.clientWidth || startW));
  resizing.value = true;
  document.body.classList.add('is-sct-resizing');
  const move = (ev) => {
    fitW.value = Math.min(Math.max(Math.round(startW + ev.clientX - startX), minW), maxW);
  };
  const up = () => {
    resizing.value = false;
    document.body.classList.remove('is-sct-resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    try { localStorage.setItem(WIDTH_KEY, String(fitW.value)); } catch { /* 隐私模式写不进去就算了 */ }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
function resetWidth() {
  fitW.value = 0;
  try { localStorage.removeItem(WIDTH_KEY); } catch { /* 同上 */ }
}
onMounted(() => {
  if (!fitW.value) return;
  const minW = measureMin();
  if (fitW.value < minW) {
    fitW.value = minW;
    try { localStorage.setItem(WIDTH_KEY, String(minW)); } catch { /* 同上 */ }
  }
});
onBeforeUnmount(() => {
  document.body.classList.remove('is-sct-resizing');
});

// 表头已经写了单位（产率 [%]），格子里就不再重复一个 %——文献里的数字是裸的
const cell = (f, r) => {
  const v = isManual(f) ? r.cells[f.key] || '' : autoValue(f.source, r.exp, base.value);
  return unitOf(f) && typeof v === 'string' ? v.replace(/\s*%\s*$/, '') : v;
};
</script>

<template>
  <div class="scope-wrap sct-plain">
    <p v-if="index || caption" class="sct-cap">
      <span v-if="index" class="sct-cap-no">表 {{ index }}：</span><span v-if="caption" class="sct-cap-ti">{{ caption }}</span><sup
        v-if="hasStd"
        class="sct-cap-fn"
      >[a]</sup>
    </p>
    <!-- 表格宽度由右边那条竖线拖（双击回自适应）；反应式跟表格放在同一个宽度里居中 -->
    <div
      ref="fitEl"
      class="sct-fit"
      :class="{ 'is-fixed': fitW > 0, 'is-resizing': resizing }"
      :style="fitW ? { width: fitW + 'px' } : null"
    >
      <!-- 反应式居中压在表格上方，条件那行字居中跟在它下面（文献里压在箭头下面的那行） -->
      <div v-if="scheme" class="sct-std">
        <div class="sct-std-scheme" v-html="scheme" />
        <p v-if="standard" class="sct-std-line"><span class="sct-std-lbl">标准条件：</span>{{ standard }}</p>
      </div>
      <!-- 画不出结构时只有一行字：不套卡片（一行字的白盒子看着像半个按钮），就压在表顶上 -->
      <p v-else-if="standard" class="sct-std-line sct-std-line--bare">
        <span class="sct-std-lbl">标准条件：</span>{{ standard }}
      </p>
      <div class="sct-tbwrap">
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
                  <span class="sct-th-label">
                    {{ f.label }}<template v-if="unitOf(f)"> [{{ unitOf(f) }}]</template><sup
                      v-if="unitOf(f)"
                      class="sct-th-fn"
                    >[b]</sup>
                  </span>
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
        <span
          class="sct-grip"
          title="拖动改表格宽度，双击恢复按内容宽"
          @mousedown="startResize"
          @dblclick="resetWidth"
          @dragstart.prevent
        />
      </div>
    </div>
    <!-- 文献表下面那行小字脚注：上标字母 + 小字，锚点跟标题的 [a]、表头的 [b] 对上 -->
    <p class="sct-note">
      <span v-if="hasStd" class="sct-note-item"><sup>[a]</sup>标准条件见上方反应式；「相对标准条件」列只写相对基准改动的部分。</span>
      <span v-if="hasUnit" class="sct-note-item"><sup>[b]</sup>产率 / 选择性取自记录里填的值，未填记作「—」。</span>
    </p>
  </div>
</template>
