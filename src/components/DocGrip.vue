<script setup>
import { useDocSize } from '../lib/panesize.js';

// 内容区左右两条抓手指（照 DSH 的：整列高的透明判定区 + 跟手的一小段发光条）。
// 拖任一条都只改内容区宽度（内容始终居中），双击回默认宽度。
const { docResizing: resizing, startDocDrag, resetDocSize } = useDocSize();

// 让那段小竖条跟着鼠标的纵坐标走：位置写进 CSS 变量 --doc-grip-y
function onMove(e) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const pct = ((e.clientY - r.top) / Math.max(1, r.height)) * 100;
  el.style.setProperty('--doc-grip-y', `${pct}%`);
}
</script>

<template>
  <span
    class="doc-grip is-left"
    :class="{ 'is-on': resizing }"
    title="拖动改内容宽度，双击恢复"
    @mousemove="onMove"
    @mousedown="startDocDrag($event, 'left')"
    @dblclick="resetDocSize"
    @dragstart.prevent
  />
  <span
    class="doc-grip is-right"
    :class="{ 'is-on': resizing }"
    title="拖动改内容宽度，双击恢复"
    @mousemove="onMove"
    @mousedown="startDocDrag($event, 'right')"
    @dblclick="resetDocSize"
    @dragstart.prevent
  />
</template>
