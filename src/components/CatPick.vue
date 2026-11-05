<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';

/**
 * 分类筛选的小下拉：不用系统 select，样式跟旁边那个「＋」小方块一致，
 * 点开是一个自己画的小菜单（全部分类 / 未分类 / 每个分类 + 条数）。
 */
const props = defineProps({
  value: { type: String, default: '' },                 // '' | 'none' | String(id)
  categories: { type: Array, default: () => [] },
  countKey: { type: String, default: 'exp_count' },
  // 侧栏用来筛（'' = 全部分类）；记录页用来归类（'' = 未分类，没有「全部」这一项）
  showAll: { type: Boolean, default: true },
  // 顺带把「类型」并进这个下拉，选中的值用 'kind:底物' 这种形式发出去
  kinds: { type: Array, default: () => [] },
  // 实验那边把「状态」也并进来，值形如 'status:进行中'
  statuses: { type: Array, default: () => [] },
});

const EMPTY_LABEL = computed(() => (props.showAll ? '全部分类' : '未分类'));

const emit = defineEmits(['change', 'create']);

const open = ref(false);

const current = computed(() => {
  if (!props.value) return EMPTY_LABEL.value;
  if (props.value === 'none') return '未分类';
  if (props.value.startsWith('kind:')) return props.value.slice(5);
  if (props.value.startsWith('status:')) return props.value.slice(7);
  return props.categories.find((c) => String(c.id) === props.value)?.name || EMPTY_LABEL.value;
});

function pick(v) {
  open.value = false;
  if (v !== props.value) emit('change', v);
}

function onDocClick(ev) {
  if (!ev.target.closest?.('.cat-pick-wrap')) open.value = false;
}

function onKey(ev) {
  if (ev.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="cat-pick-wrap">
    <button
      type="button"
      class="cat-trigger"
      :title="showAll ? `按分类筛：${current}` : `分类：${current}`"
      @click.stop="open = !open"
    >
      <span class="cat-trigger-label">{{ current }}</span>
      <Icon name="down" :size="10" class="cat-caret" />
    </button>

    <div v-if="open" class="qmenu cat-menu" @click.stop>
      <button v-if="showAll" type="button" class="cat-menu-opt" :aria-selected="value === ''" @click="pick('')">
        {{ EMPTY_LABEL }}
      </button>
      <button
        v-else
        type="button"
        class="cat-menu-opt"
        :aria-selected="value === ''"
        @click="pick('')"
      >
        未分类
      </button>
      <button v-if="showAll" type="button" class="cat-menu-opt" :aria-selected="value === 'none'" @click="pick('none')">未分类</button>
      <template v-if="categories.length">
        <div class="cat-menu-sep" />
        <button
          v-for="c in categories"
          :key="c.id"
          type="button"
          class="cat-menu-opt"
          :aria-selected="value === String(c.id)"
          @click="pick(String(c.id))"
        >
          <span class="cat-menu-name">{{ c.name }}</span>
          <span class="cat-menu-n mono">{{ c[countKey] ?? 0 }}</span>
        </button>
      </template>
      <template v-if="statuses.length">
        <div class="cat-menu-sep" />
        <div class="cat-menu-label">状态</div>
        <div class="cat-menu-kinds">
          <button
            v-for="st in statuses"
            :key="st"
            type="button"
            class="cat-menu-opt"
            :aria-selected="value === `status:${st}`"
            @click="pick(`status:${st}`)"
          >
            <span class="cat-menu-name">{{ st }}</span>
          </button>
        </div>
      </template>

      <template v-if="kinds.length">
        <div class="cat-menu-sep" />
        <div class="cat-menu-label">类型</div>
        <!-- 类型排两列，免得整个菜单拉太长 -->
        <div class="cat-menu-kinds">
          <button
            v-for="k in kinds"
            :key="k"
            type="button"
            class="cat-menu-opt"
            :aria-selected="value === `kind:${k}`"
            @click="pick(`kind:${k}`)"
          >
            <span class="cat-menu-name">{{ k }}</span>
          </button>
        </div>
      </template>
      <div class="cat-menu-sep" />
      <button type="button" class="cat-menu-opt cat-menu-new" @click="open = false; emit('create')">
        <Icon name="plus" :size="10" /> 新建分类
      </button>
    </div>
  </div>
</template>
