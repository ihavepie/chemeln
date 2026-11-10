<script setup>
import { useDocSize } from '../lib/panesize.js';

// 内容区左右各一条抓手指：拖任一条都只改内容区宽度（内容始终居中）。
// 平时完全透明，鼠标靠近才浮出一小段把手；双击回默认宽度。
// 外面套一层 position: sticky（挂在 .inner 最前面），把手就停在屏幕中间，
// 内容再长、滚到哪儿都还抓得到；纯绝对定位会跟着内容一起滚走。
const { docResizing: resizing, startDocDrag, resetDocSize } = useDocSize();
</script>

<template>
  <span class="doc-grip-wrap">
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
  </span>
</template>
