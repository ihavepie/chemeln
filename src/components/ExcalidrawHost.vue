<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Excalidraw 的 Vue 外壳：在 Vue 里挂一个 React root，把 Excalidraw 放进去。
 *
 * 为什么这么干：排行榜板要的就是「画布内部那些操作」（框选、八点手柄、旋转、撤销栈、
 * 吸附参考线、箭头绑到框边），这些 Excalidraw 已经做得很好；我们只负责
 * 把**记录里的块**变成它的对象（文字 / 图片 / 箭头 / 方框），以及把场景存回去。
 * 这一层很薄：只做「挂载 / 传初始数据 / 收回变更」，别往这里塞业务。
 */
const props = defineProps({
  /** { elements, appState, files } 的初始场景；没给就是空板 */
  initial: { type: Object, default: null },
  theme: { type: String, default: 'light' },
  /** 关掉 Excalidraw 自带的一些按钮，跟本子其它地方一致一点 */
  viewMode: { type: Boolean, default: false },
});
const emit = defineEmits(['ready', 'change', 'fail', 'pointerup']);

const host = ref(null);
const err = ref('');
let root = null;
let api = null;

onMounted(async () => {
  try {
    const React = (await import('react')).default;
    const { createRoot } = await import('react-dom/client');
    const EX = await import('@excalidraw/excalidraw');
    await import('@excalidraw/excalidraw/index.css');

    const init = props.initial || {};
    const initialData = {
      elements: Array.isArray(init.elements) ? init.elements : [],
      appState: {
        viewBackgroundColor: '#f5f4f1',
        currentItemStrokeColor: '#1c1b19',
        // 默认不要手绘（roughness 0 = 规整线）
        currentItemRoughness: 0,
        currentItemStrokeStyle: 'solid',
        currentItemFillStyle: 'solid',
        ...(init.appState || {}),
      },
      files: init.files || {},
      // 别让 Excalidraw 自己 fit：它按「所有元素」算，板上有画到纸外的图就会把纸挤歪，
      // 而且它比我们晚一拍执行，看起来就是「先正了一下又跳回去」。fit 由外面按 A4 纸做。
      scrollToContent: false,
    };

    root = createRoot(host.value);
    root.render(
      React.createElement(EX.Excalidraw, {
        initialData,
        theme: props.theme,
        viewMode: props.viewMode,
        langCode: 'zh-CN',
        UIOptions: { canvasActions: { loadScene: false, export: false, saveAsImage: false } },
        excalidrawAPI: (a) => {
          api = a;
          emit('ready', a);
        },
        onChange: (elements, appState) => {
          emit('change', { elements, appState });
        },
        // 松手这一下：缩放（八点手柄）刚结束，外面要拿它把图注的字号掰回来
        onPointerUp: () => emit('pointerup'),
      })
    );
  } catch (e) {
    err.value = String((e && e.message) || e);
    console.error('[excalidraw]', e);
    emit('fail', err.value);
  }
});

onBeforeUnmount(() => {
  if (root) root.unmount();
  root = null;
  api = null;
});

defineExpose({ getApi: () => api });
</script>

<template>
  <div class="ex-host">
    <div ref="host" class="ex-mount" />
    <div v-if="err" class="ex-err">画布起来失败：{{ err }}</div>
  </div>
</template>

<style scoped>
.ex-host {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--canvas);
}
.ex-mount { position: absolute; inset: 0; }
.ex-err {
  position: absolute; left: 16px; bottom: 16px; right: 16px;
  padding: 10px 12px; border-radius: 8px;
  background: #fdebec; color: #9f2f2d; font-size: 12px;
}
</style>
