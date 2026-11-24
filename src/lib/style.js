/**
 * 结构式「文档设置」：前端这份只做**换算**，真值在 `data/style.json`（服务端 `server/style.js`）。
 *
 * 存三个化学量（键长 / 线粗 / 字号，单位 pt）+ 几个开关，因为三处消费方要的单位各不相同：
 *
 *   ┌ 消费方              ┆ 要什么                                 ┆ 换算
 *   ├ Indigo（出图）      ┆ render-bond-line-width / render-font-size ┆ 线宽 = 线粗/键长×30
 *   │                     ┆ render-coloring                            ┆ 字号 = 字号/键长×100
 *   ├ chemdraw（换字层）  ┆ 字高 / 键长（Helvetica 大写字高 0.717 em） ┆ 字高比例 = 字号/键长×0.717
 *   │                     ┆ stroke-width（占一根键的比例）             ┆ = 线粗/键长
 *   └ Ketcher（画板）     ┆ setSettings 的 pt 值                        ┆ 原样给
 *
 * 以前这三处各写一份常量（`indigo.js` 里 1.8/4.2/56/69、`chemdraw.js` 里 0.4 和写死的 0.06、
 * `main.jsx` 里那一坨 ACS_1996），于是同一个「线粗 0.6 pt」有四个说法，出现过按 /100 换算
 * 导致线粗多画 3.4 倍的事故。现在只有这里一处。
 */
import { reactive } from 'vue';

/** 跟 `server/style.js` 的 STYLE_DEFAULTS 保持一致（服务端是权威；这份只是首帧的兜底） */
export const STYLE_DEFAULTS = {
  name: 'ACS 1996（原子上色）',
  bondLength: 14.4, // pt
  bondThickness: 0.6, // pt
  labelSize: 10, // pt
  stereoBondWidth: 2, // pt
  font: 'Arial',
  atomColoring: true,
  aromaticStyle: 'kekule',
};

export const style = reactive({ ...STYLE_DEFAULTS });

/** Helvetica / Arial 的大写字高 ≈ 0.717 em（「想要的字高」换算成 font-size 用） */
export const CAP_RATIO = 0.717;
/** Indigo 里一根键 = 100 个 viewBox 单位（实测），跟 `indigo.js` 的 INDIGO_BOND_UNITS 同一件事 */
const UNIT = 100;
/** Indigo 的线宽参数是「/30 = 占键长的比例」（不是 /100，踩过） */
const LINE_UNIT = 30;

const num = (v, d) => Number(Number(v).toFixed(d ?? 3));
const ratioOf = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);

/** 整份换掉（开机 bootstrap / 设置页保存后用）。只认 STYLE_DEFAULTS 里有的键，别的忽略 */
export function setStyle(next) {
  if (!next || typeof next !== 'object') return style;
  for (const k of Object.keys(STYLE_DEFAULTS)) {
    if (!(k in next)) continue;
    const v = next[k];
    if (k === 'atomColoring') {
      // 跟服务端同一套：false / 0 / '0' / 'false' / 'no' / 'off' 算关，其余算开
      const off = [false, 0, '0', 'false', 'no', 'off'].includes(typeof v === 'string' ? v.trim().toLowerCase() : v);
      style[k] = !off;
    }
    else if (k === 'aromaticStyle') style[k] = v === 'circle' ? 'circle' : 'kekule';
    else if (k === 'name' || k === 'font') style[k] = String(v || STYLE_DEFAULTS[k]);
    else style[k] = num(ratioOf(v, STYLE_DEFAULTS[k]), 3);
  }
  return style;
}

/** 线宽占键长的比例（换字层写 stroke-width 用）：ACS = 0.6/14.4 ≈ 0.0417 */
export function strokeRatio() {
  return num(ratioOf(style.bondThickness, 0.6) / ratioOf(style.bondLength, 14.4), 5);
}

/** 标签字高占键长的比例（换字层用）：ACS = 10/14.4×0.717 ≈ 0.498 */
export function labelRatio() {
  return num((ratioOf(style.labelSize, 10) / ratioOf(style.bondLength, 14.4)) * CAP_RATIO, 5);
}

/** Indigo 出图那套参数（`indigoSvg` 直接塞进 MapStringString） */
export function indigoOptions() {
  const bond = ratioOf(style.bondLength, 14.4);
  return {
    coloring: style.atomColoring ? 'true' : 'false',
    lineWidth: String(num((ratioOf(style.bondThickness, 0.6) / bond) * LINE_UNIT, 3)),
    fontSize: String(num((ratioOf(style.labelSize, 10) / bond) * UNIT, 2)),
    aromaticStyle: style.aromaticStyle,
  };
}

/** 画板（Ketcher）的文档设置：只影响**画板里看到的样子**，出图不走它（见 SketcherModal 的注释） */
export function ketcherSettings() {
  return {
    atomColoring: style.atomColoring !== false,
    font: style.font || 'Arial',
    fontsz: ratioOf(style.labelSize, 10),
    fontszUnit: 'pt',
    fontszsub: ratioOf(style.labelSize, 10),
    fontszsubUnit: 'pt',
    bondLength: ratioOf(style.bondLength, 14.4),
    bondLengthUnit: 'pt',
    bondThickness: ratioOf(style.bondThickness, 0.6),
    bondThicknessUnit: 'pt',
    stereoBondWidth: ratioOf(style.stereoBondWidth, 2),
    stereoBondWidthUnit: 'pt',
    aromaticCircle: style.aromaticStyle === 'circle',
  };
}

/** 样式指纹：进反应式的 sig（`EditorView.liveSig`），样式一变旧缓存就对不上、会重画 */
export function styleSig() {
  return [
    num(style.bondLength, 3),
    num(style.bondThickness, 3),
    num(style.labelSize, 3),
    num(style.stereoBondWidth, 3),
    style.font,
    style.atomColoring ? 1 : 0,
    style.aromaticStyle,
  ].join('/');
}
