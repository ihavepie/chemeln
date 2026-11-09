<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import AppModal from '../components/AppModal.vue';
import { api } from '../api.js';
import { peekPrefs, setPeekPref, PEEK_LABELS } from '../lib/peek.js';
import { sheetPrefs, setSheetPref, showAllSheetBlocks, SHEET_BLOCKS } from '../lib/sheetprefs.js';
import { loadBoot, setProject, settings, store, allCategories, addCategory } from '../store.js';
import { confirm, prompt, toast } from '../lib/feedback.js';

const saving = ref(false);

const form = reactive({ lab_heading: '', code_prefix: 'EXP', owner_name: '', group_name: '', label_base_url: '', lan_access: false, auto_sync: false });
const syncing = ref(false);
const syncLog = ref('');

/** 全局那套：课题里编辑时当占位符，让人看得见「留空会用成什么」 */
const globalSettings = computed(() => store.boot?.settingsGlobal || {});
const ph = computed(() => ({
  lab_heading: globalSettings.value.lab_heading || '方法学实验记录',
  code_prefix: globalSettings.value.code_prefix || 'EXP',
  owner_name: globalSettings.value.owner_name || '记录人姓名',
  group_name: globalSettings.value.group_name || '导师 / 组名',
  label_base_url: globalSettings.value.label_base_url || store.boot?.lanUrl || '',
}));

/** fill() 之后表单长什么样：用来判断现在有没有还没点「保存」的改动 */
let filledSig = '';

/**
 * 在某个课题里就编辑这个课题自己的覆盖值（空 = 跟着全局），
 * 「全部课题」时编辑的就是全局那份。
 */
function fill() {
  const g = settings();
  const ov = store.boot?.projectOverrides || {};
  if (store.project) {
    // 课题里「标题」就是课题名：改它等于改名
    form.lab_heading = store.project;
    form.code_prefix = ov.code_prefix || '';
    form.owner_name = ov.owner_name || '';
    form.group_name = ov.group_name || '';
    form.label_base_url = ov.label_base_url || '';
    form.lan_access = !!store.boot?.lanAccess;
    form.auto_sync = String(settings().auto_sync || '') === '1';
  } else {
    form.lab_heading = g.lab_heading || '';
    form.code_prefix = g.code_prefix || 'EXP';
    form.owner_name = g.owner_name || '';
    form.group_name = g.group_name || '';
    form.label_base_url = g.label_base_url || '';
    form.lan_access = !!store.boot?.lanAccess;
    form.auto_sync = String(g.auto_sync || '') === '1';
  }
  filledSig = JSON.stringify(form);
}

/** 服务器存的是 UTC ISO，显示成本地时间 */
function fmtTime(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function runSync() {
  syncing.value = true;
  syncLog.value = '';
  try {
    const r = await api.syncServer();
    syncLog.value = (r.log || '').trim().split('\n').slice(-6).join('\n') || '同步完成';
    toast('已同步到服务器');
    await loadBoot();
  } catch (e) {
    syncLog.value = e.message || '同步失败';
    toast(e.message || '同步失败', 'err');
  } finally {
    syncing.value = false;
  }
}

/** 01 卡有没有没保存的改动 */
const formDirty = () => JSON.stringify(form) !== filledSig;

onMounted(async () => {
  if (!store.boot) await loadBoot();
  fill();
  await loadAllCats();
});

/* ---- 课题与分类：一颗树 ---- */

/** 全部分类（不按当前课题筛）：设置页要看「所有课题下各有什么分类」 */
const allCats = ref([]);

async function loadAllCats() {
  try {
    allCats.value = await api.categories();
  } catch {
    allCats.value = [];
  }
}

/** 改完分类 / 课题：boot（当前课题视角）和全量清单一起刷 */
async function refresh() {
  await loadBoot();
  await loadAllCats();
}

/**
 * 「共用课题」+ 每个课题挂在下面的分类（课题清单里没有的残留也列出来，别让它们消失）。
 * 共用课题就是 project = '' 这个课题：在「全部课题」下新建的记录和分类都落在这里。
 */
const catTree = computed(() => {
  const all = allCats.value;
  const shared = all.filter((g) => !g.project);
  const known = new Set((store.boot?.projects || []).map((x) => x.name));
  const groups = (store.boot?.projects || []).map((x) => ({
    key: x.name,
    name: x.name,
    info: x,
    items: all.filter((g) => g.project === x.name),
  }));
  const orphanNames = [...new Set(all.filter((g) => g.project && !known.has(g.project)).map((g) => g.project))];
  const orphans = orphanNames.map((name) => ({
    key: name,
    name,
    info: { name, n: 0, prefix: '' },
    items: all.filter((g) => g.project === name),
  }));
  return { shared, groups: [...groups, ...orphans] };
});

/** 共用课题的记录数：跟别的课题组一样在组头显示「条 / 个」 */
const sharedCounts = computed(() => store.boot?.sharedCounts || { exp: 0, cmp: 0 });

/**
 * 「未分类」是固定桶（category_id = NULL），不是真的分类：
 * 树里给它占一行、显示条数，但不能改名 / 删除 / 拖动。
 */
const uncatLabel = (e, c) => [e ? `${e} 条` : '', c ? `${c} 个` : ''].filter(Boolean).join(' · ');

const isCurrentProject = (name) => store.project === name;

/**
 * 新建分类落到哪个课题下：null = 跟着侧栏当前课题；
 * 点某个课题组的标题就把它设成目标（'' = 共用课题）。
 */
const catTarget = ref(null);
const targetProject = computed(() => (catTarget.value === null ? store.project : catTarget.value));
const targetLabel = computed(() => (targetProject.value ? `「${targetProject.value}」` : '共用课题'));
const isTarget = (name) => targetProject.value === name;
const catCount = (g) => (g.scope === 'compound' ? `${g.cmp_count || 0} 个` : `${g.exp_count || 0} 条`);



// 侧栏切了课题（或 boot 重新拉过），这块要跟着换成那个课题的值。
// 但 03 卡的新建分类 / 改名 / 删课题都会触发 loadBoot（boot 换新对象），
// 这时候如果 01 卡有没保存的输入，重填会把它悄悄冲掉 —— 换课题才重填，其余情况有改动就不动。
watch([() => store.project, () => store.boot], ([newProject], [oldProject]) => {
  if (newProject !== oldProject || !formDirty()) fill();
});

async function save() {
  saving.value = true;
  try {
    const res = await api.saveSettings({
      project: store.project,
      lab_heading: form.lab_heading,
      // 全局那份前缀不能空（要有个默认值）；课题里空着就是没覆盖
      code_prefix: store.project ? form.code_prefix.trim() : form.code_prefix.trim() || 'EXP',
      owner_name: form.owner_name,
      group_name: form.group_name,
      label_base_url: form.label_base_url.trim(),
      lan_access: !!form.lan_access,
      auto_sync: !!form.auto_sync,
    });
    if (res?.renamedTo) {
      // 标题改了 = 课题改名，前端当前课题跟着切过去
      await setProject(res.renamedTo);
      toast(`标题改了，课题名也一起改成「${res.renamedTo}」`);
    } else {
      await loadBoot();
      toast(store.project ? `「${store.project}」的信息已保存` : '设置已保存');
    }
    fill();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    saving.value = false;
  }
}

const openLink = (url) => window.open(url, '_blank');
/** 在某个课题里就只导这个课题 */
const exportLink = computed(
  () => `/api/export/notebook.md${store.project ? `?project=${encodeURIComponent(store.project)}` : ''}`
);

/* ---- 分类管理 ---- */

async function newCategory(scope) {
  const where = `（${targetLabel.value}）`;
  const name = await prompt({
    title: `${scope === 'compound' ? '新建化合物分类' : '新建实验分类'}${where}`,
    placeholder: scope === 'compound' ? '比如：手性配体库、中间体' : '比如：方法学 A、条件筛选',
    confirmText: '新建',
  });
  if (!name) return;
  try {
    await addCategory(name, scope, targetProject.value);
    await loadAllCats();
    toast(`已新建分类，归到${targetLabel.value}`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function renameCategory(g) {
  const name = await prompt({ title: '重命名', value: g.name, confirmText: '确定' });
  if (!name || name === g.name) return;
  try {
    await api.saveCategory(g.id, { name });
    await refresh();
    toast('已重命名');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 正在拖的那个分类（拖到别的课题组标题上就移过去） */
const dragCat = ref(null);
/** 鼠标此刻悬在哪个组头上（'共用' 用空串表示）——落点高亮靠它 */
const dropTarget = ref(null);

const sameProject = (g, project) => (g?.project || '') === (project || '');

function onCatDragStart(ev, g) {
  dragCat.value = g;
  dropTarget.value = null;
  document.body.classList.add('cat-dragging');
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(g.id));
  // 默认的拖动影像太淡，给一格更明显的描边（浏览器会把它当缩略图）
  const row = ev.currentTarget.closest('.cat-item');
  if (row) ev.dataTransfer.setDragImage(row, 24, 12);
}

function onCatDragEnd() {
  dragCat.value = null;
  dropTarget.value = null;
  document.body.classList.remove('cat-dragging');
}

/** 拖着分类时，组头要么是落点（描强调色 + 淡底），要么是它现在待的那个（灰掉、不放） */
function onHeadDragOver(name) {
  if (!dragCat.value) return;
  dropTarget.value = sameProject(dragCat.value, name) ? null : name;
}

function onHeadDragLeave(ev, name) {
  if (ev.currentTarget.contains(ev.relatedTarget)) return;
  if (dropTarget.value === name) dropTarget.value = null;
}

/** 拖到某个课题组标题上：把分类（连同里面的记录）移过去 */
async function onCatDrop(project) {
  const g = dragCat.value;
  onCatDragEnd();
  if (!g || (g.project || '') === (project || '')) return;
  await moveCategoryTo(g, project);
}

/** 分类的归属：改到共用或某个课题；换课题时分类里的记录一起搬 */
async function moveCategoryTo(g, nextProject) {
  if (nextProject === (g.project || '')) return;
  const n = (g.exp_count || 0) + (g.cmp_count || 0);
  const target = nextProject || '共用';
  if (nextProject && n) {
    const from = String(g.exp_projects || '')
      .split(',')
      .filter(Boolean);
    const spread = from.length > 1 ? `注意：这些记录目前分属 ${from.length} 个课题（${from.join('、')}）。` : '';
    const ok = await confirm({
      title: `将分类「${g.name}」移到「${target}」？`,
      body: `该分类下的 ${n} 条记录（实验 ${g.exp_count || 0} 条、化合物 ${g.cmp_count || 0} 个）将一并移到「${target}」，在原课题中不再出现。${spread}`,
      confirmText: '一并移入',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const r = await api.saveCategory(g.id, { project: nextProject });
    await refresh();
    const moved = r?.moved;
    toast(
      moved && (moved.experiments || moved.compounds)
        ? `已移到「${target}」，连同 ${moved.experiments} 条实验、${moved.compounds} 个化合物`
        : `已移到「${target}」`
    );
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function removeCategory(g) {
  const n = g.scope === 'compound' ? g.cmp_count || 0 : g.exp_count || 0;
  const unit = g.scope === 'compound' ? '个化合物' : '条实验';
  const ok = await confirm({
    title: `删除分类「${g.name}」？`,
    body: n
      ? `里面有 ${n} ${unit}。删掉分类只是把它们变回「未分类」，记录本身不会动。`
      : '该分类下暂无记录，可直接删除。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteCategory(g.id);
    await refresh();
    toast('已删除分类');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---- 课题 ---- */

const projects = computed(() => store.boot?.projects || []);

/** 改名会连带把记录、化合物、编号前缀、课题级设置一起搬过去 */
async function renameProject(p) {
  const name = await prompt({ title: `将「${p.name}」重命名为`, value: p.name, confirmText: '确定' });
  if (!name || name === p.name) return;
  try {
    await api.renameProject(p.name, name);
    if (store.project === p.name) await setProject(name); // 正站在这课题里就一起跟过去
    await loadAllCats();
    toast(`改好了，记录都跟到「${name}」名下了`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function newProject() {
  const name = await prompt({ title: '新建课题', placeholder: '比如：手性配体、光催化方法学', confirmText: '新建' });
  if (!name) return;
  try {
    await api.createProject({ name });
    await refresh();
    toast('课题建好了，侧栏最上面能切过去');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/** 课题自己的编号前缀；清空就按课题名自动生成（每个课题都从 xxxx-0001 起，互不干扰） */
async function editProjectPrefix(p) {
  const auto = p.auto_prefix || p.name || 'EXP';
  const prefix = await prompt({
    title: `「${p.name}」的编号前缀`,
    value: p.prefix || '',
    placeholder: `留空 = 自动用「${auto}」`,
    confirmText: '确定',
    allowEmpty: true,
  });
  if (prefix === null) return;
  try {
    await api.createProject({ name: p.name, prefix });
    await loadBoot();
    toast(prefix ? `新实验会用 ${prefix}-1 这样的编号` : `已改回自动前缀「${auto}」`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function removeProject(p) {  const ok = await confirm({
    title: `删除课题「${p.name}」？`,
    body: p.n
      ? `里面有 ${p.n} 条实验，删不掉。先把那些记录的「课题」格改到别的课题。`
      : '该课题暂无记录。删除仅从清单中移除，记录与文件均不受影响。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteProject(p.name);
    await loadBoot();
    toast('课题删掉了');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---- 分类与化合物不再有「跨课题共用」开关 ---- */
/* 两者都严格按课题归属；project = '' 就是「共用课题」，在「全部课题」下新建的东西落进去。 */

</script>

<template>
  <div class="single">
    <div class="inner">
      <header class="page-head">
        <h1 class="page-title">设置</h1>
        <p class="page-desc">记录本的所有数据都在本机一个目录里，随时可以整个拷走。</p>
      </header>

      <section class="card">
        <div class="card-head">
          <h2 class="card-title">
            <span class="n">01</span>记录本信息<span v-if="store.project" class="title-sub">· {{ store.project }}</span>
          </h2>
        </div>
        <p class="hint" v-if="store.project">
          以下各项可按「{{ store.project }}」单独设置，留空则沿用全局值。标题即课题名称，修改后将同步重命名该课题及其名下记录。
        </p>
        <p class="hint" v-else>此处为全局默认值。每个课题可单独覆盖：在侧栏切换到该课题后进入本页修改。课题的标题即其名称。</p>
        <div class="grid-2" :class="{ 'mt12': true }">
          <div class="field"><label>{{ store.project ? '标题（= 课题名）' : '标题' }}</label><input class="input" v-model="form.lab_heading" :placeholder="ph.lab_heading" /></div>
          <div class="field"><label>编号前缀</label><input class="input num" v-model="form.code_prefix" :placeholder="ph.code_prefix" /></div>
          <div class="field"><label>记录人</label><input class="input" v-model="form.owner_name" :placeholder="ph.owner_name" /></div>
          <div class="field"><label>课题组</label><input class="input" v-model="form.group_name" :placeholder="ph.group_name" /></div>
          <div class="field" style="grid-column: 1/-1">
            <label>手机 / 局域网访问</label>
            <label class="check-row">
              <input type="checkbox" v-model="form.lan_access" />
              <span>允许同一 Wi-Fi 下的手机打开（监听 0.0.0.0）</span>
            </label>
            <p class="hint mt8">
              当前：<b>{{ store.boot?.lanAccess ? '已允许' : '仅本机' }}</b>；本机局域网地址
              <span class="mono">{{ store.boot?.lanUrl || '（没检测到网卡）' }}</span>。
              <b>改完要重启服务</b>才生效（<span class="mono">node server/index.js</span>）；只在自己信得过的网络里开。
            </p>
          </div>
          <div class="field" style="grid-column: 1/-1">
            <label>同步到服务器（单向：本机 → 服务器）</label>
            <div class="row" style="gap: 10px; align-items: center">
              <button class="btn btn-sm" :disabled="syncing" @click="runSync">
                {{ syncing ? '同步中…' : '立即同步一次' }}
              </button>
              <label class="check-row">
                <input type="checkbox" v-model="form.auto_sync" />
                <span>开着服务时每 6 小时自动推一次</span>
              </label>
              <span class="hint" v-if="store.boot?.syncLastAt">上次：{{ fmtTime(store.boot.syncLastAt) }}</span>
            </div>
            <p class="hint mt8" v-if="syncLog" style="white-space: pre-wrap">{{ syncLog }}</p>
            <p class="hint mt8">
              本机是主库，服务器只是副本（手机查看用）。服务器上的改动会被下次同步覆盖，别在服务器上改数据。
            </p>
          </div>
          <div class="field" style="grid-column: 1/-1">
            <label>瓶子标签的二维码地址</label>
            <input class="input mono" v-model="form.label_base_url" :placeholder="ph.label_base_url" />
            <p class="hint mt8">
              留空则使用本机局域网地址（当前 <span class="mono">{{ store.boot?.lanUrl || '' }}</span>）。
              手机扫码要能打开，得先在上面勾上「允许手机 / 局域网访问」并重启服务（默认只听 127.0.0.1）。
            </p>
          </div>
        </div>
        <div class="row mt16">
          <button class="btn btn-primary" :disabled="saving" @click="save">保存</button>
          <span class="hint">编号前缀仅作用于此后新建的实验，已有编号不变。</span>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2 class="card-title"><span class="n">02</span>数据与备份</h2></div>
        <div class="field">
          <label>数据目录</label>
          <div class="input mono" style="background: #fafaf8; color: var(--ink-2); user-select: all">{{ store.boot?.dataDir }}</div>
        </div>
        <p class="hint mt12">
          全部记录由 <span class="mono">eln.db</span>（结构化数据）与 <span class="mono">attachments/</span>（谱图等原始文件）组成。
          将该目录纳入 iCloud 或时间机器的备份范围，即等于自动备份。
        </p>
        <div class="row mt16">
          <button class="btn" @click="openLink('/api/backup')"><Icon name="download" :size="13" /> 下载完整备份 .zip</button>
          <button class="btn" @click="openLink(exportLink)"><Icon name="download" :size="13" /> {{ store.project ? `导出「${store.project}」` : '全部导出为 Markdown' }}</button>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2 class="card-title"><span class="n">03</span>课题与分类</h2>
          <span class="spacer" />
          <span class="newcat-target">新建到 {{ targetLabel }}</span>
          <button class="btn btn-sm btn-ghost" @click="newProject"><Icon name="plus" :size="11" /> 课题</button>
          <button class="btn btn-sm btn-ghost" @click="newCategory('experiment')"><Icon name="plus" :size="11" /> 实验分类</button>
          <button class="btn btn-sm btn-ghost" @click="newCategory('compound')"><Icon name="plus" :size="11" /> 化合物分类</button>
        </div>
        <p class="hint mt12">
          分类和化合物都归属一个课题，切到别的课题就看不到了。分类的归属和里面的记录一起走：换课题时，分类里的实验与化合物也一起移过去。
        </p>

        <!-- 共用课题（project = ''）：在「全部课题」下新建的东西落在这里 -->
        <div
          class="tree-group"
          :class="{
            'is-drop-live': dropTarget === '',
            'is-drop-self': !!dragCat && sameProject(dragCat, ''),
          }"
          @dragover.prevent="onHeadDragOver('')"
          @dragleave="onHeadDragLeave($event, '')"
          @drop.prevent="onCatDrop('')"
        >
          <div class="tree-head" :class="{ 'is-pickable': true, 'is-target': isTarget('') }" @click="catTarget = ''">
            <span class="tree-name">共用课题</span>
            <span v-if="isTarget('')" class="tree-tag is-fill">新建到此</span>
            <span class="tree-meta mono">{{ sharedCounts.exp }} 条 · {{ sharedCounts.cmp }} 个</span>
          </div>
          <div
            v-if="!catTree.shared.length && !sharedCounts.uncatExp && !sharedCounts.uncatCmp"
            class="tree-empty"
          >
            暂无记录。在「全部课题」下新建实验、化合物或分类，就落在这里。
          </div>
          <div v-else class="tree-body">
            <div
              v-for="g in catTree.shared"
              :key="g.id"
              class="cat-item merged"
              :class="{ 'is-dragging': dragCat && dragCat.id === g.id }"
            >
              <span
                class="cat-grip"
                draggable="true"
                title="拖动这个分类到别的课题组标题上＝移过去（里面的记录一起搬）"
                @dragstart="onCatDragStart($event, g)"
                @dragend="onCatDragEnd"
                >⠿</span
              >
              <span class="cat-scope-badge" :title="g.scope === 'compound' ? '化合物分类' : '实验分类'">
                {{ g.scope === 'compound' ? '化合物' : '实验' }}
              </span>
              <span class="cat-name">{{ g.name }}</span>
              <span class="cat-count mono">{{ catCount(g) }}</span>
              <span class="spacer" />
              <button class="icon-act" title="给分类改名" @click="renameCategory(g)">
                <Icon name="edit" :size="15" />
              </button>
              <button class="icon-act is-danger" title="删除这个分类" @click="removeCategory(g)">
                <Icon name="trash" :size="15" />
              </button>
            </div>
            <!-- 未分类是固定桶：没归分类的记录都在这儿，不能改名 / 删除 -->
            <div v-if="sharedCounts.uncatExp || sharedCounts.uncatCmp" class="cat-item merged is-uncat">
              <span class="cat-name">未分类</span>
              <span class="cat-count mono">{{ uncatLabel(sharedCounts.uncatExp, sharedCounts.uncatCmp) }}</span>
            </div>
          </div>
        </div>

        <!-- 每个课题一棵 -->
        <div
          v-for="gp in catTree.groups"
          :key="gp.key"
          class="tree-group"
          :class="{
            'is-drop-live': dropTarget === gp.name,
            'is-drop-self': !!dragCat && sameProject(dragCat, gp.name),
          }"
          @dragover.prevent="onHeadDragOver(gp.name)"
          @dragleave="onHeadDragLeave($event, gp.name)"
          @drop.prevent="onCatDrop(gp.name)"
        >
          <div class="tree-head" :class="{ 'is-pickable': true, 'is-target': isTarget(gp.name) }" @click="catTarget = gp.name">
            <span class="tree-name">{{ gp.name }}</span>
            <span v-if="isCurrentProject(gp.name)" class="tree-tag">当前</span>
            <span v-if="isTarget(gp.name)" class="tree-tag is-fill">新建到此</span>
            <span class="tree-meta mono">
              {{ gp.info.prefix || (gp.name ? gp.info.auto_prefix : store.boot?.settings?.code_prefix) || 'EXP' }} · {{ gp.info.n }} 条 · {{ gp.info.cmp || 0 }} 个
            </span>
            <span class="spacer" />
            <button class="icon-act" title="给课题改名" @click.stop="renameProject(gp.info)">
              <Icon name="edit" :size="16" />
            </button>
            <button class="icon-act" title="课题的编号前缀" @click.stop="editProjectPrefix(gp.info)">
              <Icon name="hash" :size="16" />
            </button>
            <button class="icon-act is-danger" title="删除这个课题" @click.stop="removeProject(gp.info)">
              <Icon name="trash" :size="16" />
            </button>
          </div>
          <div v-if="!gp.items.length && !gp.info.uncat_exp && !gp.info.uncat_cmp" class="tree-empty">
            该课题下暂无分类。
          </div>
          <div v-else class="tree-body">
            <div
              v-for="g in gp.items"
              :key="g.id"
              class="cat-item merged"
              :class="{ 'is-dragging': dragCat && dragCat.id === g.id }"
            >
              <span
                class="cat-grip"
                draggable="true"
                title="拖动这个分类到别的课题组标题上＝移过去（里面的记录一起搬）"
                @dragstart="onCatDragStart($event, g)"
                @dragend="onCatDragEnd"
                >⠿</span
              >
              <span class="cat-scope-badge" :title="g.scope === 'compound' ? '化合物分类' : '实验分类'">
                {{ g.scope === 'compound' ? '化合物' : '实验' }}
              </span>
              <span class="cat-name">{{ g.name }}</span>
              <span class="cat-count mono">{{ catCount(g) }}</span>
              <span class="spacer" />
              <button class="icon-act" title="给分类改名" @click="renameCategory(g)">
                <Icon name="edit" :size="15" />
              </button>
              <button class="icon-act is-danger" title="删除这个分类" @click="removeCategory(g)">
                <Icon name="trash" :size="15" />
              </button>
            </div>
            <!-- 未分类是固定桶：没归分类的记录都在这儿，不能改名 / 删除 -->
            <div v-if="gp.info.uncat_exp || gp.info.uncat_cmp" class="cat-item merged is-uncat">
              <span class="cat-name">未分类</span>
              <span class="cat-count mono">{{ uncatLabel(gp.info.uncat_exp, gp.info.uncat_cmp) }}</span>
            </div>
          </div>
        </div>

      </section>

      <section class="card">
        <div class="card-head"><h2 class="card-title"><span class="n">04</span>快捷键</h2></div>
        <div class="row" style="gap: 24px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2)">
          <span><kbd>Enter</kbd> 确认本格</span>
          <span><kbd>Tab</kbd> 移至下一格</span>
          <span><kbd>⌘</kbd> <kbd>Enter</kbd> 新增一行</span>
          <span><kbd>⌘</kbd> <kbd>⌫</kbd> 删除本行</span>
          <span><kbd>⌘</kbd> <kbd>S</kbd> 立即保存</span>
          <span><kbd>⌘</kbd> <kbd>N</kbd> 新建实验</span>
          <span><kbd>⌘</kbd> <kbd>K</kbd> 搜索</span>
          <span><kbd>Esc</kbd> 关闭对话框</span>
          <span><kbd>右键</kbd> 列表卡片上出快捷菜单（复制 / 锁定 / 删除）</span>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2 class="card-title"><span class="n">05</span>书签悬停预览</h2></div>
        <p class="card-note">实验页纸面左边那排平行书签，鼠标停上去会浮一张预览卡。这里决定卡片上显示哪些块（只存在这台浏览器里，跟记录无关）。</p>
        <div class="row" style="gap: 18px; flex-wrap: wrap; font-size: 12px; color: var(--ink-2)">
          <label v-for="(label, key) in PEEK_LABELS" :key="key" style="display: flex; align-items: center; gap: 6px; cursor: pointer">
            <input type="checkbox" :checked="peekPrefs[key]" @change="setPeekPref(key, $event.target.checked)" />
            {{ label }}
          </label>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2 class="card-title"><span class="n">06</span>记录页显示</h2>
          <span class="spacer" />
          <button class="btn btn-sm btn-ghost" @click="showAllSheetBlocks()">全部显示</button>
        </div>
        <p class="card-note">
          实验记录那张 A4 上要出现哪几块。取消勾选的块，页面和打印 / 存 PDF 都不出现（内容不会丢，重新勾上就回来；只存在这台浏览器里）。
        </p>
        <div class="sheet-blocks">
          <label v-for="(label, key) in SHEET_BLOCKS" :key="key">
            <input type="checkbox" :checked="sheetPrefs[key]" @change="setSheetPref(key, $event.target.checked)" />
            {{ label }}
          </label>
        </div>
      </section>

      <p class="version-line">ELN 1.0.2 · 全本机运行 · 数据存自己的盘上</p>
    </div>
  </div>
</template>
