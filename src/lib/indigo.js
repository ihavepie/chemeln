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

/** MOL / RXN → SVG 字符串（走 molfile 而不是 SMILES，缩写的超原子才带得进去） */
export async function indigoSvg(data) {
  const s = String(data || '').trim();
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
