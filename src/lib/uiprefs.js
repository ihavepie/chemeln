import { api } from '../api.js';

/**
 * 「页面设置」（视图模式 / 显示哪几块 / 列宽 / 内容区宽度…）的存法：
 *
 * **浏览器是日常缓存，数据库是长期存储。** 用户原话是「服务器启动和关闭的时候把页面的
 * 这些数据上传上去」——但浏览器不知道服务器什么时候开关，所以换成两个等价时机：
 *   ① 打开本子（bootstrap 回来）先对一次，两边按 key 比时间戳，谁新用谁的；
 *   ② 改完之后防抖 1.2s 推一次；关页面 / 切到后台再补推一次（`keepalive`）。
 *
 * 为什么还留缓存：列宽那种是拖一下改一次的，写库太勤；本机读内存也就没延迟。
 *
 * 本地一份 `eln:ui` = `{ [key]: { v, t } }`；服务器 settings 表 `ui_prefs` 同一份格式。
 * **当前课题不同步**（还是 `eln:project`）：那是「这台机器上我正想看哪个课题」。
 */
const CACHE = 'eln:ui';
const PUSH_DELAY = 1200;

/** 老版本这些偏好各存一个 key，第一次进来搬进缓存（搬完就删，别留着两份） */
const LEGACY = {
  view: 'eln:view',
  group: 'eln:group',
  sheet: 'eln:sheet',
  peek: 'eln:peek',
  docw: 'eln:docw',
  'colw:exp': 'eln:colw:exp',
  'colw:cmp': 'eln:colw:cmp',
};

const clone = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

let cache = null;

function readLegacy(key) {
  const lsKey = LEGACY[key];
  if (!lsKey) return undefined;
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw === null) return undefined;
    if (key === 'docw') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

function dropLegacy() {
  try {
    for (const lsKey of Object.values(LEGACY)) localStorage.removeItem(lsKey);
  } catch {
    /* 隐私模式下写不进去，不碍事 */
  }
}

function load() {
  if (cache) return cache;
  cache = {};
  let fresh = true;
  try {
    const raw = localStorage.getItem(CACHE);
    if (raw) {
      fresh = false;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, e] of Object.entries(parsed)) {
          if (e && typeof e === 'object' && 'v' in e) cache[k] = { v: e.v, t: Number(e.t) || 0 };
        }
      }
    }
  } catch {
    cache = {};
  }
  if (fresh) {
    // 头一回跑这一版：把老 key 里的值搬过来（时间戳用现在，让服务器那份真正有更新的才盖掉）
    const now = Date.now();
    for (const key of Object.keys(LEGACY)) {
      const v = readLegacy(key);
      if (v !== undefined) cache[key] = { v, t: now };
    }
    dropLegacy();
    save();
  }
  return cache;
}

function save() {
  try {
    localStorage.setItem(CACHE, JSON.stringify(cache));
  } catch {
    /* 存不了就算了，这次开着页面照样生效 */
  }
}

/* ---------------- 读 / 写 ---------------- */

/** 读一个键（没有就用 fallback）。对象会复制一份，调用方随便改不会串到缓存里 */
export function uiGet(key, fallback) {
  const c = load();
  if (c[key] && 'v' in c[key]) return clone(c[key].v);
  return fallback === undefined ? undefined : clone(fallback);
}

/** 写一个键：先落缓存（同步、不阻塞），再排一次上传 */
export function uiSet(key, value) {
  const c = load();
  c[key] = { v: clone(value), t: Date.now() };
  save();
  dirty = true;
  schedulePush();
  return value;
}

/**
 * 只有真变了才写（返回有没有改）。
 * 记录页每次打开都会按「记录类型」重设一遍显示哪几块 —— 值没变的话别刷新时间戳，
 * 否则每开一条记录都往服务器推一次，还会把别的设备上更新的那份盖掉。
 */
export function uiSetIfChanged(key, value) {
  const c = load();
  const cur = c[key];
  if (cur && JSON.stringify(cur.v) === JSON.stringify(value)) return false;
  uiSet(key, value);
  return true;
}

/* ---------------- 同步 ---------------- */

let dirty = false;
let pushTimer = 0;
let pushing = false;
const appliers = new Set();

/** 合并之后要跟着变的（reactive 的那些）：注册一个回调，开机合并改了谁就通知谁 */
export function onUiMerged(fn) {
  appliers.add(fn);
  return () => appliers.delete(fn);
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void push(false), PUSH_DELAY);
}

/**
 * 把整张表推给服务器。服务器按 key 的时间戳合并，返回合并后的那份，
 * 再拿回来对一次（另一个设备可能刚改过别的键）。
 */
async function push(keepalive = false) {
  if (pushing) {
    schedulePush();
    return;
  }
  clearTimeout(pushTimer);
  pushTimer = 0;
  if (!dirty) return;
  pushing = true;
  const sent = JSON.parse(JSON.stringify(load()));
  dirty = false;
  try {
    const r = await api.saveUiPrefs(sent, { keepalive });
    if (r && r.prefs) merge(r.prefs, { allowPush: false });
  } catch {
    // 服务没开 / 断网：留在缓存里，下次改东西或下次开机再推
    dirty = true;
  } finally {
    pushing = false;
  }
}

/**
 * 开机时把服务器那份并下来：同一个 key 比时间戳，服务器新就用服务器的。
 * 本地有、服务器没有（或者本地更新）的键，攒一次上传。
 */
export function uiMerge(serverPrefs) {
  if (!serverPrefs || typeof serverPrefs !== 'object') return false;
  return merge(serverPrefs, { allowPush: true });
}

function merge(serverPrefs, { allowPush }) {
  const c = load();
  let changed = false;
  let needPush = false;
  for (const [k, e] of Object.entries(serverPrefs)) {
    if (!e || typeof e !== 'object' || !('v' in e)) continue;
    const t = Number(e.t) || 0;
    const cur = c[k];
    if (!cur || t > (Number(cur.t) || 0)) {
      c[k] = { v: e.v, t };
      changed = true;
    } else if ((Number(cur.t) || 0) > t) {
      needPush = true;
    }
  }
  for (const k of Object.keys(c)) if (!(k in serverPrefs)) needPush = true;
  if (changed) save();
  if (needPush && allowPush) {
    dirty = true;
    schedulePush();
  }
  if (changed) for (const fn of appliers) {
    try {
      fn();
    } catch {
      /* 某个模块回灌失败不该影响别的 */
    }
  }
  return changed;
}

/** 立刻推一次（关页面 / 切后台时用） */
export function uiFlush() {
  if (!dirty) return;
  clearTimeout(pushTimer);
  pushTimer = 0;
  void push(true);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', uiFlush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') uiFlush();
  });
}
