/** 数字输入框的清洗：只留数字和一个小数点，额外的单位字母由调用方指定。 */

const FULLWIDTH_DIGITS = '０１２３４５６７８９';

/** 按规则清洗一段文本；extra 里是允许保留的额外字符（比如单位字母） */
export function cleanNumeric(raw, extra = '') {
  let out = '';
  let hasDot = false;
  for (const ch of String(raw ?? '')) {
    const idx = FULLWIDTH_DIGITS.indexOf(ch);
    const c = idx >= 0 ? String(idx) : ch;
    if (c >= '0' && c <= '9') {
      out += c;
    } else if (!hasDot && (c === '.' || c === '。' || c === '·')) {
      out += '.';
      hasDot = true;
    } else if (extra.includes(c)) {
      out += c;
    }
  }
  return out;
}

/**
 * 直接作用在 input 元素上：清洗后写回，并把光标留在原来那一位
 * （不然在中间插字时，被删掉的字符会让光标跳到末尾）
 */
export function applyNumeric(el, extra = '') {
  const before = el.value;
  const pos = el.selectionStart ?? before.length;
  const clean = cleanNumeric(before, extra);
  if (clean === before) return false;
  const posClean = cleanNumeric(before.slice(0, pos), extra).length;
  el.value = clean;
  const next = Math.max(0, Math.min(clean.length, posClean));
  el.setSelectionRange(next, next);
  return true;
}
