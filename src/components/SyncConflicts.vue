<script setup>
import { computed, reactive, ref } from 'vue';
import AppModal from './AppModal.vue';
import Icon from './Icon.vue';

/**
 * **冲突列表**（像代码合并那样一格一格选）：这条记录想把内容补进化合物档案，
 * 但有几格两边都有、而且不一样 —— 逐条列出来，每一行自己决定「要档案里的」还是「要记录里的」。
 *
 * 默认全选**档案里的**（不改动已存在的东西最安全）；顶部两个「全用记录里的 / 全用档案里的」
 * 一键切。谱图不参与这个列表：只在缺的时候补，那边已有同类的永远不覆盖。
 */
const props = defineProps({
  /** 目标档案：`{ code, name }` */
  compound: { type: Object, default: null },
  /** `[{ field, label, current, incoming }]` */
  conflicts: { type: Array, default: () => [] },
  /** `[{ label, value }]`：空着、会被填上的格子（只读展示） */
  fills: { type: Array, default: () => [] },
  /** 会搬过去 / 那边已有而跳过的谱图类别 */
  filesCopy: { type: Array, default: () => [] },
  filesSkip: { type: Array, default: () => [] },
  busy: Boolean,
});
const emit = defineEmits(['close', 'apply']);

/** 每一行选哪边：'archive'（默认，不动）| 'record' */
const pick = reactive({});
for (const c of props.conflicts) pick[c.field] = 'archive';

const takeCount = computed(() => props.conflicts.filter((c) => pick[c.field] === 'record').length);

function setAll(side) {
  for (const c of props.conflicts) pick[c.field] = side;
}

function toggle(field) {
  pick[field] = pick[field] === 'record' ? 'archive' : 'record';
}

/** 只把「选了记录里的」那几格带回去；一格都没选就只是补空着的 */
function apply() {
  if (props.busy) return;
  emit('apply', { fields: props.conflicts.filter((c) => pick[c.field] === 'record').map((c) => c.field) });
}

const short = (v) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
};
</script>

<template>
  <AppModal
    :title="`补档案 · ${compound?.code || compound?.name || ''}`"
    :show-footer="false"
    width="720px"
    @close="emit('close')"
  >
    <div class="scf">
      <div class="scf-head">
        <span class="scf-cap">{{ conflicts.length }} 处两边不一样 —— 点哪边就是取哪边（默认取档案里的）</span>
        <span class="scf-spacer" />
        <button type="button" class="scf-quick" @click="setAll('record')">全用记录里的</button>
        <button type="button" class="scf-quick" @click="setAll('archive')">全用档案里的</button>
      </div>

      <div class="scf-list">
        <div v-for="c in conflicts" :key="c.field" class="scf-row" :class="{ 'is-take': pick[c.field] === 'record' }">
          <button type="button" class="scf-side" :class="{ on: pick[c.field] === 'archive' }" @click="pick[c.field] = 'archive'">
            <span class="scf-side-cap">档案里</span>
            <span class="scf-val" :title="String(c.current)">{{ short(c.current) }}</span>
          </button>
          <span class="scf-lbl">{{ c.label }}</span>
          <button type="button" class="scf-side" :class="{ on: pick[c.field] === 'record' }" @click="pick[c.field] = 'record'">
            <span class="scf-side-cap">记录里</span>
            <span class="scf-val" :title="String(c.incoming)">{{ short(c.incoming) }}</span>
          </button>
        </div>
      </div>

      <div v-if="fills.length" class="scf-fills">
        <span class="scf-cap">空着的会填上：</span>
        <span v-for="f in fills" :key="f.label" class="scf-fill">{{ f.label }} · {{ short(f.value) }}</span>
      </div>

      <div v-if="filesCopy.length || filesSkip.length" class="scf-files">
        <span class="scf-cap">谱图：</span>
        <span v-if="filesCopy.length" class="scf-file">
          <Icon name="check" :size="11" /> 搬 {{ filesCopy.join(' / ') }}
        </span>
        <span v-if="filesSkip.length" class="scf-file is-muted">
          跳过 {{ filesSkip.join(' / ') }}（那边已有，不覆盖）
        </span>
      </div>

      <div class="scf-foot">
        <span class="scf-cap">{{ takeCount ? `用记录里的覆盖 ${takeCount} 格` : '全部保留档案里的值' }}</span>
        <span class="scf-spacer" />
        <button type="button" class="btn btn-sm btn-ghost" :disabled="busy" @click="emit('close')">取消</button>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="apply">
          {{ busy ? '处理中…' : takeCount ? '按上面的选' : '只补空着的' }}
        </button>
      </div>
    </div>
  </AppModal>
</template>
