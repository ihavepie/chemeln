<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import ExcalidrawHost from '../components/ExcalidrawHost.vue';
import { api } from '../api.js';
import { toast } from '../lib/feedback.js';
import { BLOCKS, itemHtml } from '../lib/board.js';

/**
 * 排版板 · 新版画布（试作）：把一张板交给 Excalidraw 显示 / 编辑。
 *
 * 分工：**画布本身的操作**（框选、八点手柄、旋转、撤销、吸附、箭头绑框边）全交给 Excalidraw；
 * 我们只管两件事 ——
 * ① 把 `items`（0.1mm 坐标）**翻译**成 Excalidraw 的元素：文字 / 结论 / 箭头 / 方框 → 原生对象，
 *    TLC 图 / 反应式 → 原生 image（用原文件 / 矢量 SVG，所以放大不糊）；
 * ② 把场景存回 `boards.scene_json`（跟老的 `items_json` 并存，随时能切回旧画布）。
 * 表格类块（投料 / 结果 / TLC 判断 / 对比表）暂时跳过，先在旧画布上摆。
 */
const route = useRoute();
const router = useRouter();

const board = ref(null);
const initial = ref(null);
const loading = ref(true);
const skipped = ref(0);
const hostEl = ref(null);
let exApi = null;
const saving = ref(false);

/** 0.1mm → CSS px（96dpi）：A4 = 794 × 1123 */
const K = 96 / 25.4 / 10;
const px = (u) => Math.round((u || 0) * K * 10) / 10;

const blockCount = computed(() => (board.value ? board.value.items.length : 0));

async function blobToDataURL(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`读图失败 ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ dataURL: String(fr.result), mimeType: blob.type || 'image/png' });
    fr.onerror = () => reject(new Error('读图失败'));
    fr.readAsDataURL(blob);
  });
}

let fileSeq = 0;
const files = {}; // 迁移过程中造出来的二进制，跟着场景一起存
async function addFile(url) {
  const id = `f${fileSeq += 1}`;
  const { dataURL, mimeType } = await blobToDataURL(url);
  files[id] = { id, dataURL, mimeType, created: Date.now(), lastRetrieved: Date.now() };
  return { id, size: await imageSize(dataURL) };
}

/** 读一下图片真实宽高，搬过去才不会变形 */
function imageSize(dataURL) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 4, h: img.naturalHeight || 3 });
    img.onerror = () => resolve({ w: 4, h: 3 });
    img.src = dataURL;
  });
}

/** 把老画布的 items 翻成 Excalidraw 的 skeleton（再交给 convertToExcalidrawElements） */
async function migrate(items) {
  const sk = [
    // A4 白纸：794 × 1123 px（= 210×297mm @96dpi），锁住不让拖
    {
      type: 'rectangle', x: 0, y: 0, width: 794, height: 1123,
      backgroundColor: '#ffffff', strokeColor: 'transparent', fillStyle: 'solid',
      roughness: 0, locked: true,
    },
  ];
  skipped.value = 0;
  for (const it of items) {
    const x = px(it.x);
    const y = px(it.y);
    const w = px(it.w);
    const ink = it.color || '#1c1b19';

    if (it.type === 'text') {
      sk.push({ type: 'text', x, y, text: String(it.text || ''), fontSize: 16, fontFamily: 2, strokeColor: ink });
      continue;
    }
    if (it.type === 'shape') {
      const h = px(it.h || (it.shape === 'arrow' ? 200 : 600));
      if (it.shape === 'box') {
        sk.push({
          type: 'rectangle', x, y, width: w, height: h, strokeColor: ink,
          backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: it.thick ? 2 : 1, roughness: 0,
        });
      } else {
        // 尾 → 头（老数据没有 up = 中线水平）
        const right = it.dir !== 'left';
        const legacy = it.up === undefined || it.up === null;
        const tail = legacy ? [right ? 0 : w, h / 2] : [right ? 0 : w, it.up ? h : 0];
        const head = legacy ? [right ? w : 0, h / 2] : [right ? w : 0, it.up ? 0 : h];
        sk.push({
          type: 'arrow', x, y, width: w, height: h,
          points: [tail, head],
          strokeColor: ink, strokeWidth: it.thick ? 2 : 1, roughness: 0,
          endArrowhead: 'arrow', startArrowhead: null,
        });
      }
      continue;
    }
    if (it.type === 'tlc' && it.ref) {
      try {
        const f = await addFile(`/api/files/${it.ref}`);
        sk.push({ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id });
      } catch {
        skipped.value += 1;
      }
      continue;
    }
    if (it.type === 'block') {
      // 反应式：喂矢量 SVG（放大不糊）；其它块是 HTML 表格，先不搬
      if (it.block === 'react' && it.ref) {
        try {
          const f = await addFile(`/api/experiments/${it.ref}/scheme.svg`);
          sk.push({ type: 'image', x, y, width: w, height: Math.round((w * f.size.h) / f.size.w), fileId: f.id });
        } catch {
          skipped.value += 1;
        }
        continue;
      }
      if (it.block === 'concl') {
        sk.push({ type: 'text', x, y, text: '结论', fontSize: 10, fontFamily: 2, strokeColor: '#a09c93' });
        sk.push({ type: 'text', x, y: y + 18, text: String(it.text || '双击写结论'), fontSize: 16, fontFamily: 2, strokeColor: ink });
        continue;
      }
      skipped.value += 1;
      continue;
    }
    skipped.value += 1;
  }
  const EX = await import('@excalidraw/excalidraw');
  return EX.convertToExcalidrawElements(sk, { regenerateIds: false });
}

async function load() {
  try {
    const b = (await api.board(route.params.id)).board;
    board.value = b;
    if (b.scene && Array.isArray(b.scene.elements) && b.scene.elements.length) {
      initial.value = { elements: b.scene.elements, appState: b.scene.appState || {}, files: b.scene.files || {} };
    } else {
      const elements = await migrate(b.items || []);
      initial.value = { elements, appState: {}, files: { ...files } };
    }
  } catch (e) {
    toast(e.message || '读不到这张板', 'err');
    router.replace('/boards');
  } finally {
    loading.value = false;
  }
}

/* ---------------- 存回场景（防抖 800ms） ---------------- */
function onReady(a) {
  exApi = a;
  // 把整张纸放进视口（initialData.scrollToContent 在异步 import 下不一定生效）
  setTimeout(() => {
    try {
      a.scrollToContent(a.getSceneElements(), { fitToContent: true });
    } catch {
      /* 版本差异，忽略 */
    }
  }, 120);
}

let timer = 0;
let pending = null;
function onChange(payload) {
  pending = payload;
  clearTimeout(timer);
  timer = setTimeout(saveNow, 800);
}

async function saveNow() {
  if (!pending || !board.value) return;
  const p = pending;
  pending = null;
  saving.value = true;
  try {
    const appState = p.appState || {};
    await api.saveBoard(board.value.id, {
      scene: {
        elements: p.elements || [],
        files: { ...files, ...((exApi && exApi.getFiles && exApi.getFiles()) || {}) },
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor || '#f5f4f1',
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom,
        },
      },
    });
  } catch (e) {
    toast(e.message || '保存失败', 'err');
  } finally {
    saving.value = false;
  }
}

onBeforeUnmount(() => {
  clearTimeout(timer);
  if (pending) void saveNow();
});

load();
</script>

<template>
  <div class="single bv2">
    <div class="inner bv2-inner">
      <header class="page-head bv2-head">
        <div class="bv2-head-main">
          <h1 class="page-title">{{ board ? board.title : '排版板' }}</h1>
          <p class="page-desc">
            新版画布（Excalidraw）· 框选 / 八点手柄 / 旋转 / ⌘Z 撤销 / 吸附 / 箭头绑框边都是它自带的
            <span v-if="skipped"> · 还有 {{ skipped }} 个表格类块没搬过来（先在旧画布上摆）</span>
          </p>
        </div>
        <span class="spacer" />
        <span class="bv2-saved">{{ saving ? '保存中…' : '已保存' }}</span>
        <button class="btn btn-sm btn-ghost" @click="router.push(`/b/${route.params.id}`)">
          <Icon name="arrow-left" :size="12" /> 回旧画布
        </button>
      </header>
      <div v-if="loading" class="cmp-empty">读取中…</div>
      <div v-else class="bv2-canvas">
        <ExcalidrawHost ref="hostEl" :initial="initial" @ready="onReady" @change="onChange" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.bv2 { display: flex; flex-direction: column; height: 100%; padding: 0; overflow: hidden; }
.bv2-inner { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; padding: 28px 32px 18px; max-width: none; }
.bv2-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 14px; flex: 0 0 auto; }
.bv2-head-main { min-width: 0; }
.bv2-saved { font-size: 10.5px; color: var(--ink-4); margin-right: 8px; }
.bv2-canvas { flex: 1 1 auto; min-height: 0; border-radius: 8px; overflow: hidden; box-shadow: 0 0 0 1px var(--line); }
</style>
