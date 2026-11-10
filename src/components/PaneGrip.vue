<script setup>
import { usePaneSize } from '../lib/panesize.js';

// 列表列和纸面之间的分隔线：拖动改宽度，双击回到默认宽（宽度存在 localStorage）
const { resizing, startDrag, resetWidth } = usePaneSize();
</script>

<template>
  <span
    class="pane-grip"
    :class="{ 'is-on': resizing }"
    title="拖动改列表宽度，双击恢复"
    @mousedown="startDrag"
    @dblclick="resetWidth"
    @dragstart.prevent
  />
</template>
