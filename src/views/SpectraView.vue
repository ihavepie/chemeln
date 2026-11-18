<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppModal from '../components/AppModal.vue';
import FilePreview from '../components/FilePreview.vue';
import Icon from '../components/Icon.vue';
import { api } from '../api.js';
import { store } from '../store.js';
import { useColResize } from '../lib/colresize.js';
import { setPageMenu } from '../lib/pagemenu.js';
import { openCtxMenu, CTX_SEP } from '../lib/ctxmenu.js';
import { toast, confirm } from '../lib/feedback.js';
import { CATEGORY_LABEL } from '../lib/ui.js';

/**
 * 谱图库：把**实验附件**和**化合物文件**里所有「谱图类」的东西平铺成一张表 ——
 * 原始数据（FID / mnova 文件夹）和处理后的谱图（PDF / ¹H / ¹³C / 其它 / HRMS / IR）。
 *
 * 不新开表、不复制文件：列表走 `/api/spectra`（两条表 UNION 出来的），
 * 打开 / 下载还是 `/api/files/:id`（实验）和 `/api/compound-files/:id`（化合物），
 * 所以在这一页删掉的，记录页 / 化合物页也跟着没了（它们本来就是同一份）。
 */
const router = useRouter();

const items = ref([]);
const counts = ref({ all: 0, raw: 0, proc: 0 });
const loading = ref(false);
const kind = ref('all');   // all | raw | proc
const q = ref('');

const KINDS = computed(() => [
  { key: 'all', label: '全部', n: counts.value.all },
  { key: 'raw', label: '原始数据', n: counts.value.raw },
  { key: 'proc', label: '处理后的谱图', n: counts.value.proc },
]);

const COLDEFS = [
  { key: 'cat', w: 132 },
  { key: 'name', w: 300 },
  { key: 'owner', w: 250 },
  { key: 'size', w: 76 },
  { key: 'when', w: 108 },
];
const { tableEl, start: startResize, colStyle } = useColResize(
  'spectra',
  Object.fromEntries(COLDEFS.map((c) => [c.key, c.w]))
);

const RAW = 'nmr_raw';
const isRaw = (it) => it.category === RAW;
const catLabel = (it) => CATEGORY_LABEL[it.category] || '谱图';
const whoLabel = (it) => (it.src === 'exp' ? '记录' : '化合物');

async function load() {
  loading.value = true;
  try {
    const r = await api.spectra({ kind: kind.value, q: q.value.trim() });
    items.value = (r && r.items) || [];
    const raw = (r && r.raw) || 0;
    const proc = (r && r.proc) || 0;
    counts.value = { raw, proc, all: raw + proc };
  } catch (e) {
    items.value = [];
    toast(e.message || '读不到谱图列表', 'err');
  } finally {
    loading.value = false;
  }
}

function setKind(k) {
  if (kind.value === k) return;
  kind.value = k;
  void load();
}

let qTimer = 0;
watch(q, () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(load, 260);
});
watch(() => store.project, load);

/* ---------------- 打开：文件就地预览，文件夹列出内容 ---------------- */
const peek = ref(null);       // { src, name }
const dirOpen = ref(false);
const dirName = ref('');
const dirFiles = ref([]);

async function open(it) {
  if (it.is_dir) {
    dirName.value = it.name;
    dirFiles.value = [];
    dirOpen.value = true;
    try {
      const r = await fetch(it.url).then((x) => x.json());
      dirFiles.value = (r && r.files) || [];
    } catch {
      toast('这个文件夹读不出来', 'err');
    }
    return;
  }
  peek.value = { src: it.url, name: it.name };
}

function download(it) {
  const a = document.createElement('a');
  a.href = `${it.url}?download=1`;
  a.download = it.name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function gotoOwner(it) {
  if (it.src === 'exp') router.push(`/e/${it.owner_id}`);
  else router.push(`/c/${it.owner_id}`);
}

async function del(it) {
  const okDel = await confirm({
    title: '彻底删除这个谱图？',
    text: `「${it.name}」会从${whoLabel(it)}「${it.owner_code || ''}」里一起删掉，磁盘上的文件也会删。`,
    confirmText: '删除',
    danger: true,
  });
  if (!okDel) return;
  try {
    if (it.src === 'exp') await api.deleteAttachment(it.id);
    else await api.deleteCompoundFile(it.id);
    toast('已删除', 'ok');
    void load();
  } catch (e) {
    toast(e.message || '删不掉', 'err');
  }
}

function rowMenu(ev, it) {
  openCtxMenu(
    ev,
    [
      { key: 'open', label: it.is_dir ? '看这个文件夹' : '打开', icon: 'file' },
      { key: 'down', label: '下载', icon: 'download' },
      CTX_SEP,
      { key: 'goto', label: it.src === 'exp' ? '去那条记录' : '去那个化合物页', icon: 'edit' },
      CTX_SEP,
      { key: 'del', label: '彻底删除', icon: 'trash', danger: true },
    ],
    (k) => {
      if (k === 'open') void open(it);
      else if (k === 'down') download(it);
      else if (k === 'goto') gotoOwner(it);
      else if (k === 'del') void del(it);
    }
  );
}

/* ---------------- 导入：选一条记录 / 一个化合物，放文件或整个文件夹进去 ---------------- */
const impOpen = ref(false);
const impOwner = ref('exp');          // exp | cmp
const impCat = ref('nmr_raw');
const impQ = ref('');
const impPick = ref(null);            // { id, code, title }
const owners = ref([]);
const ownersLoading = ref(false);
const filesToSend = ref([]);          // 浏览器选的 File[]
const pathValue = ref('');
const busy = ref(false);

const IMP_CATS = [
  { key: 'nmr_raw', label: '原始数据 · FID / mnova' },
  { key: 'nmr_pdf', label: '谱图 PDF' },
  { key: 'h1', label: '¹H NMR' },
  { key: 'c13', label: '¹³C NMR' },
  { key: 'nmr_other', label: '其它核磁' },
  { key: 'hrms', label: 'HRMS' },
  { key: 'ir', label: 'IR' },
];

async function loadOwners() {
  ownersLoading.value = true;
  try {
    const list = impOwner.value === 'exp' ? await api.experiments() : await api.compounds();
    owners.value = (list || []).map((x) =>
      impOwner.value === 'exp'
        ? { id: x.id, code: x.code || '', title: x.title || x.objective || '' }
        : { id: x.id, code: x.code || '', title: x.name || x.formula || '' }
    );
  } catch {
    owners.value = [];
  } finally {
    ownersLoading.value = false;
  }
}

const ownerList = computed(() => {
  const kw = impQ.value.trim().toLowerCase();
  const rows = kw
    ? owners.value.filter((o) => `${o.code} ${o.title}`.toLowerCase().includes(kw))
    : owners.value;
  return rows.slice(0, 60);
});

function openImport() {
  impOpen.value = true;
  impPick.value = null;
  impQ.value = '';
  filesToSend.value = [];
  pathValue.value = '';
  impCat.value = 'nmr_raw';
  if (!owners.value.length) void loadOwners();
}

function setOwnerType(t) {
  if (impOwner.value === t) return;
  impOwner.value = t;
  impPick.value = null;
  owners.value = [];
  void loadOwners();
}

function pickFiles(ev) {
  filesToSend.value = [...(ev.target.files || [])];
}

async function doImport() {
  if (!impPick.value) return toast('先选一条记录或一个化合物', 'warn');
  if (!filesToSend.value.length && !pathValue.value.trim()) return toast('选文件，或者填一个路径', 'warn');
  busy.value = true;
  try {
    if (filesToSend.value.length) {
      const fd = new FormData();
      fd.append('category', impCat.value);
      for (const f of filesToSend.value) fd.append('file', f, f.name);
      if (impOwner.value === 'exp') await api.upload(impPick.value.id, fd);
      else await api.uploadCompoundFile(impPick.value.id, fd);
    } else {
      const body = { path: pathValue.value.trim(), category: impCat.value };
      if (impOwner.value === 'exp') await api.uploadPath(impPick.value.id, body);
      else await api.uploadCompoundPath(impPick.value.id, body);
    }
    const n = filesToSend.value.length || 1;
    toast(`已放进${impPick.value.code || ''}（${n} 项）`, 'ok');
    impOpen.value = false;
    void load();
  } catch (e) {
    toast(e.message || '导入失败', 'err');
  } finally {
    busy.value = false;
  }
}

/* ---------------- 页面菜单 / 生命周期 ---------------- */
let offPageMenu = null;
function pageMenuHere() {
  return [
    { key: 'reload', label: '刷新谱图库', icon: 'search' },
    { key: 'import', label: '导入谱图…', icon: 'upload' },
    {
      key: 'across',
      label: '全部课题',
      icon: 'flask',
      hint: store.project ? '现在只看当前课题' : '已经是全部',
    },
  ];
}

onMounted(() => {
  void load();
  offPageMenu = setPageMenu((ev) => {
    openCtxMenu(
      ev,
      pageMenuHere().map((x) => ({ ...x })),
      (k) => {
        if (k === 'reload') void load();
        else if (k === 'import') openImport();
      }
    );
    return false;
  });
});
onBeforeUnmount(() => {
  clearTimeout(qTimer);
  if (offPageMenu) offPageMenu();
});

const sizeText = (it) => {
  const n = Number(it.size) || 0;
  if (it.is_dir) return '文件夹';
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 104857.6) / 10} MB`;
};
const whenText = (s) => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
</script>

<template>
  <div class="single">
    <div class="inner">
      <header class="page-head">
        <div class="sp-copy">
          <h1 class="page-title">谱图库</h1>
          <p class="page-desc">
            每条记录、每个化合物上传过的谱图都汇总在这儿：原始数据（FID / mnova）和处理后的谱图（PDF / ¹H / ¹³C / HRMS / IR）。
          </p>
        </div>
        <span class="spacer" />
        <button class="btn btn-sm" @click="openImport"><Icon name="upload" :size="12" /> 导入谱图</button>
      </header>

      <div class="sp-head">
        <button
          v-for="k in KINDS"
          :key="k.key"
          class="btn btn-sm btn-ghost"
          :class="{ 'is-on': kind === k.key }"
          @click="setKind(k.key)"
        >{{ k.label }}<span class="sp-n">{{ k.n }}</span></button>
        <span class="spacer" />
        <div class="searchbox sp-search">
          <Icon name="search" :size="12" />
          <input v-model="q" type="search" placeholder="文件名 / 编号 / 名称" autocomplete="off" />
        </div>
      </div>

      <div class="page-card sp-card">
        <div v-if="loading && !items.length" class="cmp-empty">读取中…</div>
        <div v-else-if="!items.length" class="cmp-empty">
          还没有谱图。点右上「导入谱图」，把某个记录的 FID 文件夹、mnova 或谱图 PDF 放进来。
        </div>
        <table v-else ref="tableEl" class="sp-table">
          <colgroup>
            <col v-for="c in COLDEFS" :key="c.key" :style="colStyle(c.key)" />
          </colgroup>
          <thead>
            <tr>
              <th data-col="cat">类型<i class="col-grip" @mousedown="startResize($event, 'cat')" /></th>
              <th data-col="name">文件<i class="col-grip" @mousedown="startResize($event, 'name')" /></th>
              <th data-col="owner">归属<i class="col-grip" @mousedown="startResize($event, 'owner')" /></th>
              <th data-col="size">大小<i class="col-grip" @mousedown="startResize($event, 'size')" /></th>
              <th data-col="when" class="is-last">上传时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in items" :key="`${it.src}-${it.id}`" @click="open(it)" @contextmenu="rowMenu($event, it)">
              <td>
                <span class="sp-cat" :class="isRaw(it) ? 'is-raw' : 'is-proc'">{{ catLabel(it) }}</span>
              </td>
              <td>
                <div class="sp-name">
                  <Icon :name="it.is_dir ? 'folder' : 'file'" :size="12" />
                  <span class="sp-fname" :title="it.name">{{ it.name }}</span>
                  <span class="sp-flag">{{ whoLabel(it) }}</span>
                </div>
              </td>
              <td>
                <div class="sp-owner">
                  <span class="mono">{{ it.owner_code }}</span>
                  <span v-if="it.owner_title" class="sp-otitle">{{ it.owner_title }}</span>
                </div>
              </td>
              <td class="sp-size">{{ sizeText(it) }}</td>
              <td class="sp-when is-last">{{ whenText(it.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 文件就地预览（图片 / PDF / 文本），原始数据这种看不了一律给下载 -->
    <FilePreview
      v-if="peek"
      :src="peek.src"
      :name="peek.name"
      @close="peek = null"
    />

    <!-- 文件夹（FID / mnova）只列里面有什么 -->
    <AppModal v-model="dirOpen" :title="dirName" :show-confirm="false" width="420px" @close="dirOpen = false">
      <div class="sp-dir">
        <p class="sp-dir-hint">{{ dirFiles.length }} 项</p>
        <div v-for="f in dirFiles" :key="f.name" class="sp-dir-row">
          <Icon :name="f.dir ? 'folder' : 'file'" :size="12" />
          <span>{{ f.name }}</span>
        </div>
      </div>
    </AppModal>

    <!-- 导入 -->
    <AppModal
      v-model="impOpen"
      title="导入谱图"
      confirm-text="放进去"
      :width="'600px'"
      :close-on-backdrop="false"
      @close="impOpen = false"
      @confirm="doImport"
    >
      <div class="sp-imp" :class="{ 'is-busy': busy }">
        <div class="sp-imp-row">
          <span class="sp-imp-l">放到</span>
          <span class="sp-chips">
            <button class="qchip" :class="{ 'is-on': impOwner === 'exp' }" @click="setOwnerType('exp')">实验记录</button>
            <button class="qchip" :class="{ 'is-on': impOwner === 'cmp' }" @click="setOwnerType('cmp')">化合物</button>
          </span>
        </div>

        <div class="sp-imp-row">
          <span class="sp-imp-l">哪一条</span>
          <div class="sp-imp-pick">
            <div class="searchbox">
              <Icon name="search" :size="12" />
              <input v-model="impQ" type="search" :placeholder="impOwner === 'exp' ? '搜编号 / 名称' : '搜编号 / 名称'" autocomplete="off" />
            </div>
            <div class="sp-pick-list">
              <div v-if="ownersLoading" class="sp-pick-none">读取中…</div>
              <button
                v-for="o in ownerList"
                :key="o.id"
                class="sp-pick-row"
                :class="{ 'is-on': impPick && impPick.id === o.id }"
                @click="impPick = o"
              >
                <span class="mono">{{ o.code }}</span>
                <span class="sp-pick-t">{{ o.title || '（未命名）' }}</span>
              </button>
              <div v-if="!ownerList.length && !ownersLoading" class="sp-pick-none">没有匹配的{{ impOwner === 'exp' ? '记录' : '化合物' }}</div>
            </div>
          </div>
        </div>

        <div class="sp-imp-row">
          <span class="sp-imp-l">算哪类</span>
          <span class="sp-chips">
            <button
              v-for="c in IMP_CATS"
              :key="c.key"
              class="qchip"
              :class="{ 'is-on': impCat === c.key }"
              @click="impCat = c.key"
            >{{ c.label }}</button>
          </span>
        </div>

        <div class="sp-imp-row">
          <span class="sp-imp-l">内容</span>
          <div class="sp-imp-src">
            <label class="btn btn-sm btn-ghost sp-file">
              <Icon name="upload" :size="12" /> 选文件（可多选）
              <input type="file" multiple @change="pickFiles" />
            </label>
            <span v-if="filesToSend.length" class="sp-pickinfo">{{ filesToSend.length }} 个文件：{{ filesToSend.map((f) => f.name).join('、').slice(0, 60) }}</span>
            <div class="sp-path">
              <input v-model="pathValue" type="text" placeholder="或填本机路径（FID / mnova 文件夹也行）" spellcheck="false" />
            </div>
          </div>
        </div>
        <p class="sp-imp-hint">
          原始数据（Bruker 的 FID 文件夹、MestReNova 的 <span class="mono">.mnova</span>）建议用「路径」导入：浏览器选文件夹会把它拆成一堆文件，路径导入才能整个文件夹一起存、一起删。
        </p>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 18px; }
.sp-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 2px 0 10px;
}
.sp-n {
  margin-left: 6px; font-family: var(--mono); font-size: 10px; color: var(--ink-4);
}
.sp-search { width: 210px; height: 30px; }
.sp-card { padding: 4px 0 0; overflow: hidden; }
.sp-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.sp-table th, .sp-table td {
  padding: 7px 10px; text-align: left; vertical-align: middle;
  font-size: 12px; border-bottom: 1px solid var(--line-2);
}
.sp-table th {
  position: relative; font-weight: 500; font-size: 10.5px; color: var(--ink-4);
  letter-spacing: 0.04em; border-bottom: 1px solid var(--line);
}
.sp-table tbody tr { cursor: pointer; }
.sp-table tbody tr:hover { background: #f9f8f5; }
.sp-table tbody tr:last-child td { border-bottom: 0; }
.is-last { text-align: right; }
.sp-cat { font-size: 10.5px; letter-spacing: 0.02em; }
.sp-cat.is-raw { color: #8a5a12; font-weight: 600; }
.sp-cat.is-proc { color: var(--ink-2); }
.sp-copy { flex: 1 1 auto; min-width: 0; }
.sp-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sp-fname {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ink); font-size: 12px;
}
.sp-flag {
  flex: 0 0 auto; font-size: 9.5px; color: var(--ink-4);
  border: 1px solid var(--line-2); border-radius: 3px; padding: 0 3px;
}
.sp-owner { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.sp-otitle {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ink-3); font-size: 11.5px;
}
.sp-size { color: var(--ink-3); font-size: 11px; }
.sp-when { color: var(--ink-4); font-size: 11px; }

.sp-dir { max-height: 50vh; overflow: auto; }
.sp-dir-hint { margin: 0 0 6px; font-size: 11px; color: var(--ink-4); }
.sp-dir-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--ink-2); padding: 3px 0;
}

.sp-imp { display: flex; flex-direction: column; gap: 12px; }
.sp-imp.is-busy { opacity: 0.6; pointer-events: none; }
.sp-imp-row { display: flex; align-items: flex-start; gap: 10px; }
.sp-imp-l { flex: 0 0 46px; padding-top: 5px; font-size: 11.5px; color: var(--ink-4); }
.sp-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.sp-imp-pick { flex: 1 1 auto; min-width: 0; }
.sp-pick-list {
  margin-top: 6px; max-height: 168px; overflow: auto;
  border: 1px solid var(--line-2); border-radius: 7px;
}
.sp-pick-row {
  display: flex; align-items: baseline; gap: 8px; width: 100%;
  padding: 5px 8px; border: 0; background: none; text-align: left; cursor: pointer;
  font-size: 12px; color: var(--ink-2);
}
.sp-pick-row:hover { background: #f8f7f2; }
.sp-pick-row.is-on { background: #fcf7f4; box-shadow: inset 2px 0 0 var(--accent); }
.sp-pick-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-pick-none { padding: 10px 8px; font-size: 11.5px; color: var(--ink-4); }
.sp-imp-src { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.sp-file { position: relative; overflow: hidden; width: fit-content; }
.sp-file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.sp-pickinfo { font-size: 11px; color: var(--ink-3); }
.sp-path input {
  width: 100%; height: 28px; padding: 0 8px;
  border: 1px solid var(--line-2); border-radius: 6px;
  font-size: 12px; font-family: var(--mono); color: var(--ink-2); background: #fff;
}
.sp-imp-hint { margin: 0; font-size: 11px; line-height: 1.7; color: var(--ink-4); }
</style>
