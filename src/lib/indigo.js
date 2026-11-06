/**
 * 用 Indigo（Ketcher 背后那个排版 / 绘图引擎，WASM 版）画结构式图。
 *
 * 为什么不用 openchemlib 那张：openchemlib 的自动排版对小分子还行，但一上到
 * 「环丁酮 + 磺酰胺 + 两个苄基 + 炔」这种就明显不行——键会互相穿过、取代基绕着
 * 分子乱摆、甲氧基叠在一起（用户看着就是「整理得不好」）。Indigo 排出来是干净的
 * 树枝状、环走标准取向、不交叉。
 *
 * WASM 有 11 MB，所以：
 *  - 只在真要画图时动态 import（跟 openchemlib 一个待遇，首屏不受影响）；
 *  - wasm 文件放 `vendor/indigo/`（不进 git，由 `scripts/build-ketcher.sh` 从
 *    node_modules 拷过去），走服务端现成的 `/vendor/*` 路由。
 * 拿不到就抛错，调用方退回 openchemlib，不让「画不出图」把粘贴流程整个搞挂。
 */

let loading = null;

async function moduleIndigo() {
  if (!loading) {
    loading = (async () => {
      const mod = await import('indigo-ketcher/binaryWasm');
      const factory = mod.default || mod;
      // 自己拼 wasm 的地址：打包后 import.meta.url 指向 assets/，跟 wasm 不同目录
      return factory({ locateFile: (name) => `/vendor/indigo/${name}` });
    })();
    // 失败就把缓存清掉，下次还能再试（比如 wasm 文件后来才拷过去）
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** SMILES → SVG 字符串（Indigo 自己算坐标 + 自己画）。
 *  尺寸交给 Indigo 自己按内容定（`render-image-size` 写死 460×320 的话，
 *  矮胖 / 瘦高的分子会在缩略图里留下很大一圈白边，看着比以前的图小一号）。 */
export async function indigoSvg(smiles, { width = 0, height = 0 } = {}) {
  const s = String(smiles || '').trim();
  if (!s) throw new Error('没有 SMILES');
  const M = await moduleIndigo();
  const opts = new M.MapStringString();
  opts.set('render-output-format', 'svg');
  // 杂原子要跟 ChemDraw / 以前那套一样上色（O 红、N 蓝、S 黄），
  // Indigo 默认是全黑的，用户明确要「原子需要有颜色」
  opts.set('render-coloring', 'true');
  if (width && height) opts.set('render-image-size', `${width},${height}`);
  const raw = String(M.render(s, opts) || '');
  // render() 回来的是 SVG 文本的 base64（WASM 那边按字节返回），解一下再给出去
  const svg = raw.includes('<svg') ? raw : utf8FromBase64(raw);
  if (!svg.includes('<svg')) throw new Error('Indigo 没画出图');
  return svg;
}

function utf8FromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
