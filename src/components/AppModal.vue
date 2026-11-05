<script setup>
import { ElDialog } from 'element-plus';

const props = defineProps({
  title: { type: String, default: '' },
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
  danger: { type: Boolean, default: false },
  showConfirm: { type: Boolean, default: true },
  /** 整个底部按钮区（取消 / 确定）要不要 */
  showFooter: { type: Boolean, default: true },
  width: { type: String, default: '480px' },
  /** 点遮罩是否关闭：选东西的弹窗建议关掉这个，免得手一抖就没了 */
  closeOnBackdrop: { type: Boolean, default: true },
});
const emit = defineEmits(['close', 'confirm']);
</script>

<template>
  <!-- 遮罩、焦点锁、Esc、滚动锁都交给 Element Plus；里面继续用 v1 的 .modal-* 排版 -->
  <el-dialog
    :model-value="true"
    :show-close="false"
    :width="width"
    align-center
    append-to-body
    class="eln-dialog"
    transition=""
    :close-on-click-modal="closeOnBackdrop"
    @close="emit('close')"
  >
    <template #header>
      <div class="modal-title">{{ title }}</div>
    </template>

    <div class="modal-body"><slot /></div>

    <template v-if="showFooter" #footer>
      <div class="modal-actions">
        <button class="btn" @click="emit('close')">{{ cancelText }}</button>
        <button
          v-if="showConfirm"
          class="btn btn-primary"
          :style="danger ? 'background:#9f2f2d;border-color:#9f2f2d' : ''"
          @click="emit('confirm')"
        >
          {{ confirmText }}
        </button>
      </div>
    </template>
  </el-dialog>
</template>
