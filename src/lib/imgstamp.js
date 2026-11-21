/**
 * 图片下载时的「信息条」：把编号 / 分类 / 展开剂·Rf / 日期这些字压在图片底部再存下来。
 *
 * 为什么要它：TLC 板图存到手机、放进汇报里，过一周就只剩下「一块绿板」——
 * 哪条记录、哪个展开剂、Rf 多少全靠记忆。这里在**下载**那一刻把这几条烧进图片
 * （不是给预览加浮层），下载下来的文件到哪都带着信息。
 *
 * 设置里能开关、能挑字段（`uiprefs` 的 `imgStamp`）；没开或没有可写的字就退回原样下载。
 */
import { uiGet } from './uiprefs.js';

/** 设置里列出来的字段（顺序就是烧进图片的顺序） */
export const STAMP_FIELDS = [
  { key: 'code', label: '编号', hint: 'SJ-2-14 / sub02' },
  { key: 'cat', label: '分类', hint: 'TLC 板 / ¹H NMR / 实验照片…' },
  { key: 'tlc', label: '展开剂 · Rf', hint: 'TLC 才有：PE:EA = 3:1 · Rf 0.45' },
  { key: 'date', label: '日期' },
  { key: 'project', label: '课题' },
  { key: 'owner', label: '记录人' },
];

export const STAMP_DEFAULTS = {
  on: true,
  fields: { code: true, cat: true, tlc: true, date: true, project: false, owner: false },
};

/** 当前设置（跟默认值合并，老版本没有的键自动补齐） */
export function stampPref() {
  const raw = uiGet('imgStamp', null) || {};
  const f = raw && typeof raw.fields === 'object' && raw.fields ? raw.fields : {};
  return {
    on: raw.on !== false,
    fields: { ...STAMP_DEFAULTS.fields, ...f },
  };
}

/**
 * 一行信息：`SJ-2-14 · TLC 板 · PE:EA = 3:1 · Rf 0.45 · 2026-11-20`
 * meta 由调用方给（记录页 / 化合物页各自知道自己有什么），这里只按设置的字段挑。
 */
export function stampText(meta) {
  if (!meta) return '';
  const pref = stampPref();
  if (!pref.on) return '';
  const bits = [];
  for (const f of STAMP_FIELDS) {
    if (!pref.fields[f.key]) continue;
    const v = String(meta[f.key] ?? '').trim();
    if (v) bits.push(v);
  }
  return bits.join(' · ');
}

const barPad = (w) => Math.max(10, Math.round(w * 0.02));

/** 把字烧进图片底部，返回 PNG Blob */
export async function stampedBlob(src, text) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  const W = Math.max(1, img.naturalWidth || img.width);
  const H = Math.max(1, img.naturalHeight || img.height);

  const pad = barPad(W);
  let fs = Math.max(12, Math.round(W * 0.026));
  const bar = () => Math.round(fs * 2.1);

  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H + bar();
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('这块画布起不来');
  ctx.drawImage(img, 0, 0, W, H);

  const font = (size) => `${size}px -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif`;
  // 长信息先缩字号，实在放不下就截断加省略号（宁可小一点也别糊掉）
  ctx.font = font(fs);
  const maxW = W - pad * 2;
  while (fs > 10 && ctx.measureText(text).width > maxW) {
    fs -= 1;
    ctx.font = font(fs);
  }
  let line = text;
  if (ctx.measureText(line).width > maxW) {
    while (line.length > 6 && ctx.measureText(`${line}…`).width > maxW) line = line.slice(0, -1);
    line = `${line}…`;
  }

  // 白底信息条（不透明：贴到深色演示文稿里也读得清），上面一道极淡分割线
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, H, W, bar());
  ctx.fillStyle = 'rgba(28, 27, 25, 0.12)';
  ctx.fillRect(0, H, W, Math.max(1, Math.round(W * 0.0015)));

  ctx.fillStyle = '#1c1b19';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = font(fs);
  ctx.fillText(line, pad, H + bar() / 2);

  return new Promise((resolve, reject) => {
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('转 PNG 失败'))), 'image/png');
  });
}

/**
 * 下载图片并在底部加信息条。
 * 返回 true = 已经走了「带信息」这条路；false = 交给调用方退回原样下载。
 */
export async function downloadStamped(src, name, meta) {
  const text = stampText(meta);
  if (!text) return false;
  try {
    const blob = await stampedBlob(src, text);
    const base = String(name || '图片').replace(/\.[^.]+$/, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}-带信息.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return true;
  } catch {
    return false; // 跨域 / 解码失败：宁可给原图也别什么都不给
  }
}
