<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import { api } from '../api.js';

/**
 * 附件就地预览：图片直接铺开、PDF 用浏览器自带的阅读器（iframe，Safari 能直接看）、
 * 文本类（.txt/.csv/.md/.jdx）拉下来放在等宽区里；谱图原始数据这种没法看的走下载。
 * 调用方只管给 src + name（实验附件是 /api/files/:id，化合物文件是 /api/compound-files/:id）。
 *
 * **批注**（传了 `expId` 才有）：TLC 板上圈两个点、画条溶剂前沿、标一句 Rf，直接在这张大图上画。
 * 存的时候把原图和红笔合成一张 PNG，作为**新附件**传回去（原名 + `-批注.png`，同一个 category），
 * 原图一个字节都不动 —— 打印 / 排版板 / 汇报卡读到的还是一张普通图片，不用为批注再造渲染。
 */
const props = defineProps({
  src: { type: String, required: true },
  name: { type: String, default: '附件' },
  /** 哪条实验的附件：给了才允许批注（合成图要挂回这条记录） */
  expId: { type: [Number, String], default: null },
  /** 合成图存成哪一类附件（跟着原图：tlc / photo / scheme） */
  category: { type: String, default: 'tlc' },
});
const emit = defineEmits(['close', 'saved']);

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const TEXT = ['txt', 'csv', 'md', 'jdx', 'dx', 'log', 'json'];

const ext = computed(() => {
  const m = /\.([a-z0-9]+)$/i.exec(props.name || '');
  return m ? m[1].toLowerCase() : '';
});
const kind = computed(() => {
  if (IMAGE.includes(ext.value)) return 'image';
  if (ext.value === 'pdf') return 'pdf';
  if (TEXT.includes(ext.value)) return 'text';
  return 'other';
});

const text = ref('');
const err = ref('');
watch(
  () => props.src,
  async (src) => {
    text.value = '';
    err.value = '';
    if (kind.value !== 'text') return;
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.text();
      text.value = raw.length > 200000 ? `${raw.slice(0, 200000)}\n\n…（只显示前 200 KB）` : raw;
    } catch (e) {
      err.value = `读不了这个文本文件：${e.message || e}`;
    }
  },
  { immediate: true }
);

/* 弹窗宽度跟着图片走：小图（粘贴截屏常常只有一百多像素宽）别再撑成一个空荡荡的大框，
   大图仍然夹在 1180px / 92vw 里。图片加载出来才知道原始尺寸，所以先按默认宽渲染。 */
const size = ref(null);
const imgEl = ref(null);
function onImgLoad(ev) {
  const el = ev.target;
  if (el?.naturalWidth) size.value = { w: el.naturalWidth, h: el.naturalHeight };
  nextTick(resizePen);
}
const modalWidth = computed(() => {
  // 批注时给个固定宽：小图上画圈要放大才好下笔，工具条也才摆得下一行
  if (pen.value) return 'min(620px, 92vw)';
  if (kind.value !== 'image' || !size.value) return 'min(1180px, 92vw)';
  const want = Math.max(360, Math.min(1180, size.value.w + 64));
  return `min(${want}px, 92vw)`;
});

const openTab = () => window.open(props.src, '_blank');
const download = () => window.open(`${props.src}${props.src.includes('?') ? '&' : '?'}download=1`, '_blank');

/* ---------------- 批注 ---------------- */
const canAnnot = computed(() => kind.value === 'image' && props.expId != null);
const pen = ref(false); // 批注模式：画布接鼠标
const canvasEl = ref(null);
const box = ref({ w: 0, h: 0 }); // 图上显示尺寸（CSS px），画布照着它铺
/** 笔画用归一化坐标（0–1）：换窗口大小、换设备都不跑位 */
const strokes = ref([]);
const busy = ref(false);
const saveErr = ref('');
let drawing = null; // 正在画的那一笔
let ro = null;

const DPR = () => Math.min(3, window.devicePixelRatio || 1);
const INK = '#c0392b';
const WIDTH = 2.4; // CSS px

function resizePen() {
  const img = imgEl.value;
  const cv = canvasEl.value;
  if (!img || !cv) return;
  const w = Math.round(img.clientWidth);
  const h = Math.round(img.clientHeight);
  if (!w || !h) return;
  const dpr = DPR();
  if (box.value.w !== w || box.value.h !== h) box.value = { w, h };
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  paintAll();
}

function paintAll() {
  const cv = canvasEl.value;
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const dpr = DPR();
  const { w, h } = box.value;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = WIDTH;
  for (const s of strokes.value) {
    if (s.pts.length < 2) {
      // 只点了一下也留个点，不然想点个小圈会画不出来
      const [x, y] = s.pts[0];
      ctx.beginPath();
      ctx.arc(x * w, y * h, 1.6, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    ctx.stroke();
  }
}

function pointAt(ev) {
  const r = canvasEl.value.getBoundingClientRect();
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return [clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height)];
}

function penDown(ev) {
  if (!pen.value || busy.value) return;
  ev.preventDefault();
  try {
    canvasEl.value.setPointerCapture?.(ev.pointerId);
  } catch {
    /* 合成事件 / pointerId 不在活动列表里时抓不住，不影响画 */
  }
  drawing = { pts: [pointAt(ev)] };
  strokes.value = [...strokes.value, drawing];
  paintAll();
}
function penMove(ev) {
  if (!drawing) return;
  ev.preventDefault();
  const p = pointAt(ev);
  const last = drawing.pts[drawing.pts.length - 1];
  // 太密的点丢掉：划一道下来几百个点没必要
  if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.004) return;
  drawing.pts.push(p);
  paintAll();
}
function penUp() {
  drawing = null;
}

function startPen() {
  if (!canAnnot.value) return;
  saveErr.value = '';
  pen.value = true;
  nextTick(() => {
    resizePen();
    ro?.disconnect();
    if (window.ResizeObserver && canvasEl.value) {
      ro = new ResizeObserver(() => resizePen());
      ro.observe(canvasEl.value);
    }
  });
}
function stopPen() {
  pen.value = false;
  drawing = null;
  strokes.value = [];
  ro?.disconnect();
  ro = null;
  paintAll();
}
function undo() {
  strokes.value = strokes.value.slice(0, -1);
  paintAll();
}
function clearAll() {
  strokes.value = [];
  paintAll();
}

/** 原图 + 红笔合成一张新图上传，原图不动 */
async function saveAnnot() {
  if (!strokes.value.length || props.expId == null) return;
  busy.value = true;
  saveErr.value = '';
  try {
    const img = new Image();
    img.src = props.src;
    try {
      await img.decode();
    } catch {
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('原图读不回来'));
      });
    }
    // 原图是 JPEG 就还存 JPEG（一张手机照片存成 PNG 会从 90 KB 涨到 1 MB+，排版板和 PDF 都要吃这个体积）
    const asJpeg = /^jpe?g$/i.test(ext.value);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    if (asJpeg) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(img, 0, 0);
    // 显示尺寸 → 原图尺寸的换算；原图很小的截图（几十像素宽）按比例算出来不到半个像素，留个下限
    const k = c.width / (box.value.w || c.width);
    const lw = Math.max(1.6, WIDTH * k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.lineWidth = lw;
    for (const s of strokes.value) {
      if (s.pts.length < 2) {
        const [x, y] = s.pts[0];
        ctx.beginPath();
        ctx.arc(x * c.width, y * c.height, Math.max(1.2, 1.6 * k), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * c.width, y * c.height) : ctx.moveTo(x * c.width, y * c.height)));
      ctx.stroke();
    }
    const type = asJpeg ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((res) => c.toBlob(res, type, 0.92));
    if (!blob) throw new Error('合成失败');
    const base = String(props.name || '附件').replace(/\.[^.]+$/, '');
    const fname = `${base}-批注.${asJpeg ? 'jpg' : 'png'}`;
    const fd = new FormData();
    fd.append('file', new File([blob], fname, { type }), fname);
    fd.append('category', props.category || 'tlc');
    await api.upload(props.expId, fd);
    stopPen();
    emit('saved');
  } catch (e) {
    saveErr.value = e.message || '存不上批注图';
  } finally {
    busy.value = false;
  }
}

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});
</script>

<template>
  <AppModal :title="name" :show-confirm="false" cancel-text="关闭" :width="modalWidth" @close="emit('close')">
    <div class="fp" :class="{ 'is-image': kind === 'image', 'is-pen': pen }">
      <div v-if="kind === 'image'" class="fp-shot">
        <img ref="imgEl" class="fp-img" :src="src" :alt="name" @load="onImgLoad" />
        <canvas
          v-show="pen"
          ref="canvasEl"
          class="fp-pen"
          @pointerdown="penDown"
          @pointermove="penMove"
          @pointerup="penUp"
          @pointercancel="penUp"
          @pointerleave="penUp"
        />
      </div>
      <iframe v-else-if="kind === 'pdf'" class="fp-pdf" :src="src" :title="name" />
      <pre v-else-if="kind === 'text'" class="fp-text">{{ err || text || '读取中…' }}</pre>
      <div v-else class="fp-other">
        <span class="fp-ext mono">{{ ext || '文件' }}</span>
        <p class="hint">这种格式没法在页面里预览（谱图原始数据、mnova、压缩包都走下载）。</p>
      </div>
    </div>

    <div v-if="pen || saveErr" class="fp-penbar">
      <span class="fp-penhint" :class="{ warn: !!saveErr }">{{ saveErr || '画圈 / 划线，存成新图（原图不动）' }}</span>
      <button class="btn btn-sm btn-ghost" :disabled="!strokes.length" @click="undo">撤销</button>
      <button class="btn btn-sm btn-ghost" :disabled="!strokes.length" @click="clearAll">清空</button>
      <button class="btn btn-sm" :disabled="!strokes.length || busy" @click="saveAnnot">{{ busy ? '保存中…' : '存成新图' }}</button>
    </div>

    <div class="fp-foot">
      <span class="hint mono" style="font-size: 10.5px">{{ name }}</span>
      <span class="spacer" style="flex: 1" />
      <button v-if="canAnnot" class="btn btn-sm btn-ghost" @click="pen ? stopPen() : startPen()">
        {{ pen ? '结束批注' : '批注' }}
      </button>
      <button v-if="!pen" class="btn btn-sm btn-ghost" @click="openTab">新标签页打开</button>
      <button v-if="!pen" class="btn btn-sm" @click="download">下载</button>
    </div>
  </AppModal>
</template>
