<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { toast } from '../lib/feedback.js';
import { STATUS_TONE } from '../lib/ui.js';
import { amountText, num, round } from '../lib/reagent.js';

/**
 * 手机端（≤820px）扫实验二维码后看到的：只读、只这一页、没有任何链接。
 * 只放站在通风橱前用得上的：反应式、投料、条件、结果、表征。
 */
const props = defineProps({ id: { type: [String, Number], required: true } });

const e = ref(null);
const error = ref('');

onMounted(async () => {
  try {
    e.value = await api.experiment(props.id);
  } catch (err) {
    error.value = err.message || '读取不到这条实验';
  }
});

const scheme = computed(
  () => (e.value?.attachments || []).find((a) => a.category === 'scheme') || null
);

/* ---------------- 手机上唯一要「写」的事：拍照上传 ---------------- */
const busy = ref('');
const fileInput = ref(null);
const pendingCategory = ref('photo');

/** 手机拍的照片动辄 4–8 MB，先缩到长边 1600、JPEG 0.85 再传（快、也省盘） */
async function shrink(file) {
  if (!String(file.type || '').startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && file.size < 1_200_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) return file;
    return new File([blob], `${String(file.name || '照片').replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;            // 缩不了就原样传，别把上传卡死
  }
}

function pickShot(category) {
  pendingCategory.value = category;
  const el = fileInput.value;
  if (!el) return;
  el.value = '';
  el.click();
}

async function onShotPicked(ev) {
  const files = Array.from(ev.target.files || []);
  if (!files.length) return;
  busy.value = '上传中…';
  try {
    for (const raw of files) {
      const f = await shrink(raw);
      const fd = new FormData();
      fd.append('file', f, f.name || '照片.jpg');
      fd.append('category', pendingCategory.value);
      await api.upload(props.id, fd);
    }
    const fresh = await api.experiment(props.id);
    e.value = { ...e.value, attachments: fresh.attachments };
    toast(`已上传 ${files.length} 张`);
  } catch (err) {
    toast(err.message || '上传失败', 'err');
  } finally {
    busy.value = '';
    ev.target.value = '';
  }
}

const SHOT_LABEL = { tlc: 'TLC', photo: '照片', nmr_other: '谱图' };
const shots = computed(() =>
  (e.value?.attachments || []).filter(
    (a) => SHOT_LABEL[a.category] && /\.(png|jpe?g|gif|webp)$/i.test(a.original_name || a.filename)
  )
);

async function removeShot(a) {
  try {
    await api.deleteAttachment(a.id);
    const fresh = await api.experiment(props.id);
    e.value = { ...e.value, attachments: fresh.attachments };
  } catch (err) {
    toast(err.message || '删不掉', 'err');
  }
}

const rows = computed(() => (e.value?.reagents || []).filter((r) => String(r.name || '').trim()));

const conditions = computed(() => {
  const d = e.value;
  if (!d) return [];
  return [
    ['溶剂', [d.solvent, d.concentration].filter(Boolean).join('　')],
    ['温度', d.temperature],
    ['时间', d.duration],
    ['气氛', d.atmosphere],
    ['后处理', d.workup],
  ].filter(([, v]) => v);
});

const result = computed(() => {
  const d = e.value;
  if (!d) return [];
  return [
    ['产物', d.product_name],
    ['收率', d.yield_pct != null ? `${round(d.yield_pct, 1)}%` : ''],
    ['dr / ee', d.dr_ee],
    ['性状', d.appearance],
    ['TLC', d.tlc_note],
  ].filter(([, v]) => v);
});

const amount = (r) => amountText(r) || (num(r.amount_ul) ? `${round(num(r.amount_ul), 0)} μL` : '');
</script>

<template>
  <div class="phone-cmp">
    <a class="phone-back phone-back-top" href="#/m">← 最近记录</a>
    <div v-if="error" class="phone-note">{{ error }}</div>
    <div v-else-if="!e" class="phone-note">读取中…</div>

    <template v-else>
      <div class="phone-head">
        <div class="phone-code mono">{{ e.code }}{{ e.date ? ` · ${e.date}` : '' }}</div>
        <h1 class="phone-name">{{ e.title || '（未命名实验）' }}</h1>
        <div class="phone-tags">
          <span class="tag" :class="STATUS_TONE[e.status]">{{ e.status }}</span>
          <span v-if="e.project" class="tag plain">{{ e.project }}</span>
        </div>
      </div>

      <div v-if="scheme" class="phone-struct">
        <img :src="`/api/files/${scheme.id}`" alt="反应式" />
      </div>

      <div v-if="rows.length" class="phone-block">
        <div class="phone-label">投料</div>
        <table class="phone-table">
          <tbody>
            <tr v-for="r in rows" :key="r.id">
              <td>{{ r.name }}</td>
              <td class="muted">{{ r.role || '' }}</td>
              <td class="num mono">{{ r.eq ? `${round(r.eq, 2)} eq` : '' }}</td>
              <td class="num mono">{{ amount(r) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <dl v-if="conditions.length" class="phone-rows">
        <template v-for="[k, v] in conditions" :key="k">
          <dt>{{ k }}</dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>

      <dl v-if="result.length" class="phone-rows">
        <template v-for="[k, v] in result" :key="k">
          <dt>{{ k }}</dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>

      <div v-if="e.characterization" class="phone-block">
        <div class="phone-label">表征</div>
        <p class="phone-text">{{ e.characterization }}</p>
      </div>

      <div class="phone-block">
        <div class="phone-label">拍照 / 上传</div>
        <div class="phone-shoot">
          <button type="button" class="phone-btn" :disabled="!!busy" @click="pickShot('tlc')">拍 TLC</button>
          <button type="button" class="phone-btn" :disabled="!!busy" @click="pickShot('photo')">拍实验照片</button>
          <button type="button" class="phone-btn" :disabled="!!busy" @click="pickShot('nmr_other')">拍谱图</button>
        </div>
        <input
          ref="fileInput"
          class="phone-file"
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          @change="onShotPicked"
        />
        <p v-if="busy" class="phone-hint">{{ busy }}</p>
        <div v-if="shots.length" class="phone-shots">
          <figure v-for="a in shots" :key="a.id" class="phone-shot">
            <img :src="`/api/files/${a.id}`" :alt="a.note || a.original_name || ''" />
            <figcaption>{{ SHOT_LABEL[a.category] }}</figcaption>
            <button type="button" class="phone-shot-x" title="删除" @click="removeShot(a)">✕</button>
          </figure>
        </div>
        <p class="phone-hint">
          <template v-if="!shots.length">拍完自动缩到长边 1600 再上传，回电脑上能直接用。</template>
        </p>
      </div>

      <p class="phone-foot">画结构式请到电脑上；手机上只做查看与拍照上传</p>
    </template>
  </div>
</template>
