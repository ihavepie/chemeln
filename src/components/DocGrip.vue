<script setup>
import { useDocSize } from '../lib/panesize.js';

// 内容区自己右边那条分隔线：拖动改内容区宽度（导航条不动），双击回默认宽
const { docResizing: resizing, startDocDrag: startDrag, resetDocWidth: resetWidth } = useDocSize();
</script>

<template>
  <span
    class="doc-grip"
    :class="{ 'is-on': resizing }"
    title="拖动改内容宽度，双击恢复"
    @mousedown="startDrag"
    @dblclick="resetWidth"
    @dragstart.prevent
  />
</template>
