/**
 * Indigo（Ketcher 背后那个排版 / 绘图引擎的 WASM 版）——**只在一种情况下用**：
 * 结构里带「基团缩写」（Ts / Boc / Ph / TBS 这类超原子、原子别名）。
 * openchemlib 读得进这种 MOL，但会把缩写展开画成全结构、标签丢掉；Indigo 会照缩写画。
 * 其余结构式仍然走 openchemlib（用户选定的观感，别改）。
 *
 * WASM 11 MB，只在真要画缩写结构时动态加载；wasm 文件放 `vendor/indigo/`（不进 git，
 * 由 `scripts/copy-indigo.sh` 从 node_modules 拷过去），走服务端现成的 `/vendor/*` 路由。
 */

let loading = null;

async function moduleIndigo() {
  if (!loading) {
    loading = (async () => {
      const mod = await import('indigo-ketcher/binaryWasm');
      const factory = mod.default || mod;
      return factory({ locateFile: (name) => `/vendor/indigo/${name}` });
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

function utf8FromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Indigo（以及所有 molfile 解析器）认的是「首行是标题、第二行是程序名、第三行是注释」的版式，
 * 所以只能去尾部空白——顺手 trim 会把开头的空标题行吃掉、整段错位。真少了标题行就补一行。
 */
function fitMolfile(data) {
  let s = String(data || '').replace(/\s+$/, '');
  if (!s) return '';
  if (/^\s*\d+\s+\d+/.test(s.split('\n')[0])) s = '\n' + s;
  return s;
}

/**
 * Indigo 输出里「一根键」占多少 viewBox 单位 —— 实测值：苯环（键长 1、分子宽 √3≈1.732）
 * 画出来是 `viewBox="0 0 181 208"`：208 = 2×100 + 上下各 4 的留白，所以 100 单位/键。
 * 它**不看 molfile 里的坐标**（把整份坐标放大 2 倍再画，输出尺寸一模一样，它自己重排），
 * 所以只能按这个常数反推缩放，不能拿输入坐标去算。
 */
export const INDIGO_BOND_UNITS = 100;

/**
 * molfile → 重新排过 2D 坐标的 molfile。就是 Ketcher 里那个「layout」（Indigo 的 clean2d）：
 * openchemlib 自己排出来的键角常常是歪的（螺环、并环、多取代的环尤其难看），用户点名要重排一遍。
 * **第二个参数是输出格式**，缺了或者传错会报 `Cannot pass non-string to std::string`（踩过）。
 */
export async function indigoLayout(molfile) {
  const s = fitMolfile(molfile);
  if (!s) throw new Error('没有结构');
  const M = await moduleIndigo();
  const out = M.layout(s, 'molfile', new M.MapStringString());
  const laid = String(out || '');
  if (!/V2000|V3000/.test(laid)) throw new Error('Indigo 没排出来');
  return laid;
}

/** MOL / RXN → SVG 字符串（走 molfile 而不是 SMILES，缩写的超原子才带得进去） */
export async function indigoSvg(data) {
  const s = fitMolfile(data);
  if (!s) throw new Error('没有结构');
  const M = await moduleIndigo();
  const opts = new M.MapStringString();
  opts.set('render-output-format', 'svg');
  opts.set('render-coloring', 'true');
  const raw = String(M.render(s, opts) || '');
  const svg = raw.includes('<svg') ? raw : utf8FromBase64(raw);
  if (!svg.includes('<svg')) throw new Error('Indigo 没画出图');
  return svg;
}

/**
 * 给 SVG 里的 id（尤其是 `defs` 里那套 `glyph-0-0` 字形）加一段前缀。
 * **别省这一步**：Indigo 每条图都用同一批固定 id，一张拼图里塞好几个 Indigo 画的结构时，
 * 后面那些 `<use href="#glyph-0-0">` 会全指到第一张图的字形上，标签就串成乱码（踩过：
 * 三个分子摆一起，Boc 显示成 "Occ"、CO2Et 显示成 "CH3Ts"）。
 */
let stamp = 0;
function namespaceIds(body) {
  const pfx = `g${++stamp}-`;
  return body
    .replace(/\bid="([^"]+)"/g, (_, id) => `id="${pfx}${id}"`)
    .replace(/(xlink:href|href)="#([^"]+)"/g, (_, attr, id) => `${attr}="#${pfx}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${pfx}${id})`);
}

/**
 * molfile → 拆好的 { svg, vb, body, w, h }：`w`/`h` 按「一根键 = bondPx 像素」反算，
 * 拼反应式图时和 openchemlib 画的结构键长才齐（Indigo 自己那套 viewBox 里的留白也一起算进来了）。
 * `padPx` 是四周额外留的空（px），换算成 viewBox 单位再塞进 viewBox，缩放比不变。
 */
export async function indigoSvgSized(data, bondPx = 26, padPx = 6) {
  const svg = await indigoSvg(data);
  const body = namespaceIds(svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, ''));
  const nums = ((svg.match(/viewBox="([^"]+)"/) || [])[1] || '').split(/[\s,]+/).map(Number);
  if (nums.length !== 4 || !nums.every((n) => Number.isFinite(n)) || nums[2] <= 0 || nums[3] <= 0) {
    return { svg, body, vb: '', w: 0, h: 0 };
  }
  const [vx, vy, vw, vh] = nums;
  const k = bondPx / INDIGO_BOND_UNITS; // 1 个 viewBox 单位 = k 像素
  const pad = padPx / k;
  return {
    svg,
    body,
    vb: `${vx - pad} ${vy - pad} ${vw + pad * 2} ${vh + pad * 2}`,
    w: Math.round((vw + pad * 2) * k),
    h: Math.round((vh + pad * 2) * k),
  };
}
