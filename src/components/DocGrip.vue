<script setup>
import { useDocSize } from '../lib/panesize.js';

// 内容区左右各一条分隔线：拖右边 = 右边缘跟手，拖左边 = 左边缘跟手（宽度都变）。
// 平时完全透明，鼠标靠近/hover 才浮出来（用户说「悬浮过去才出现」）；双击回默认宽。
const { docResizing: resizing, startDocDrag, resetDocSize } = useDocSize();
</script>

<template>
  <span
    class="doc-grip is-left"
    :class="{ 'is-on': resizing }"
    title="拖动改内容宽度，双击恢复"
    @mousedown="startDocDrag($event, 'left')"
    @dblclick="resetDocSize"
    @dragstart.prevent
  />
  <span
    class="doc-grip is-right"
    :class="{ 'is-on': resizing }"
    title="拖动改内容宽度，双击恢复"
    @mousedown="startDocDrag($event, 'right')"
    @dblclick="resetDocSize"
    @dragstart.prevent
  />
</template>
