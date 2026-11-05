'use strict';

/**
 * 极简 QR 编码器：字节模式，纠错等级 M，版本 1–10（约 190 字节以内）。
 * 零依赖，直接算模块矩阵，输出 SVG —— 用来打印贴瓶子的标签。
 *
 * 算法照 ISO/IEC 18004 的实现路线（模式位 → 字节填充 → RS 纠错 → 交织 →
 * 功能图形 → 掩码择优），结构参考了公开的 QR 生成实现思路。
 */

/* 版本 → 纠错块结构（等级 M）：[ [块数, 每块数据码字数], ... ]，每块纠错码字数统一 */
const BLOCKS_M = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
};

const ALIGN = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const EC_LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const MAX_VERSION = 10;

/* ---------------------------------------------------------------- 位与 GF */

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

function gfMul(a, b) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/* ---------------------------------------------------------------- 编码 */

function dataCodewords(version) {
  const { groups } = BLOCKS_M[version];
  return groups.reduce((sum, [count, len]) => sum + count * len, 0);
}

function pickVersion(byteLen) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const needBits = 4 + countBits + byteLen * 8;
    if (needBits <= dataCodewords(v) * 8) return v;
  }
  throw new Error(`内容太长，二维码版本 ${MAX_VERSION} 也放不下（${byteLen} 字节）`);
}

/** 字节模式 → 数据码字 */
function buildDataCodewords(bytes, version) {
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4); // 字节模式
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // 终止符
  while (bits.length % 8 !== 0) bits.push(0);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  for (let pad = 0xec; out.length < dataCodewords(version); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function addEccAndInterleave(data, version) {
  const { ec, groups } = BLOCKS_M[version];
  const divisor = rsDivisor(ec);
  const blocks = [];
  let offset = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(offset, offset + len);
      offset += len;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, divisor) });
    }
  }
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  const out = [];
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ec; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

/* ---------------------------------------------------------------- 矩阵 */

function computeMatrix(version, codewords) {
  const size = version * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (row, col, dark) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    mod[row][col] = !!dark;
    fn[row][col] = true;
  };

  /* 定位图形（三个角）+ 分隔带 */
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFn(r0 + r, c0 + c, inRing || inCore);
      }
    }
  }

  /* 定时图形 */
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  /* 校正图形 */
  const centers = ALIGN[version] || [];
  for (const r of centers) {
    for (const c of centers) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) setFn(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }
  }

  /* 预留格式信息区 */
  const reserveFmt = () => {
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        fn[8][i] = true;
        fn[i][8] = true;
      }
    }
    for (let i = 0; i < 8; i++) {
      fn[8][size - 1 - i] = true;
      fn[size - 1 - i][8] = true;
    }
  };
  reserveFmt();
  setFn(size - 8, 8, true); // 固定的黑模块

  /* 版本信息（7 版以上） */
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(b, a, dark);
      setFn(a, b, dark);
    }
  }

  /* 数据填充（右→左之字形，跳过第 6 列） */
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (!fn[row][col] && bitIndex < totalBits) {
          mod[row][col] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
          bitIndex++;
        }
      }
    }
  }

  return { mod, fn, size };
}

/* ---------------------------------------------------------------- 掩码 */

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask({ mod, fn, size }, mask) {
  const out = mod.map((row) => row.slice());
  const test = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fn[r][c] && test(r, c)) out[r][c] = !out[r][c];
    }
  }
  return out;
}

function drawFormat(m, fn, size, mask) {
  const data = (EC_LEVEL_BITS.M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const put = (row, col, dark) => {
    m[row][col] = dark;
    fn[row][col] = true;
  };
  // 第一份：左上角
  for (let i = 0; i <= 5; i++) put(i, 8, getBit(bits, i));
  put(7, 8, getBit(bits, 6));
  put(8, 8, getBit(bits, 7));
  put(8, 7, getBit(bits, 8));
  for (let i = 9; i < 15; i++) put(8, 14 - i, getBit(bits, i));
  // 第二份：右上 + 左下
  for (let i = 0; i < 8; i++) put(8, size - 1 - i, getBit(bits, i));
  for (let i = 8; i < 15; i++) put(size - 15 + i, 8, getBit(bits, i));
  put(size - 8, 8, true);
}

function penalty(m, size) {
  let score = 0;
  const runs = (line) => {
    let s = 0;
    for (let i = 0; i < line.length - 4; i++) {
      if (line[i] === line[i + 1] && line[i] === line[i + 2] && line[i] === line[i + 3] && line[i] === line[i + 4]) {
        let len = 5;
        while (i + len < line.length && line[i + len] === line[i]) len++;
        s += 3 + (len - 5);
        i += len - 1;
      }
    }
    return s;
  };
  for (let r = 0; r < size; r++) score += runs(m[r]);
  for (let c = 0; c < size; c++) score += runs(m.map((row) => row[c]));

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  const finderLike = [true, false, true, true, true, false, true];
  const check = (line) => {
    let s = 0;
    for (let i = 0; i + 7 <= line.length; i++) {
      let hit = true;
      for (let j = 0; j < 7; j++) {
        if (line[i + j] !== finderLike[j]) {
          hit = false;
          break;
        }
      }
      if (!hit) continue;
      const before = line.slice(Math.max(0, i - 4), i).every((x) => x === false);
      const after = line.slice(i + 7, i + 11).every((x) => x === false);
      if (before || after) s += 40;
    }
    return s;
  };
  for (let r = 0; r < size; r++) score += check(m[r]);
  for (let c = 0; c < size; c++) score += check(m.map((row) => row[c]));

  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/* ---------------------------------------------------------------- 对外 */

/** 返回模块矩阵（true = 黑） */
function encodeMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = pickVersion(bytes.length);
  const data = buildDataCodewords(bytes, version);
  const codewords = addEccAndInterleave(data, version);
  const base = computeMatrix(version, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = applyMask(base, mask);
    const fn = base.fn.map((row) => row.slice());
    drawFormat(m, fn, base.size, mask);
    const score = penalty(m, base.size);
    if (!best || score < best.score) best = { m, score, mask };
  }
  return { size: base.size, modules: best.m, version, mask: best.mask };
}

/** SVG 字符串：1 模块 = unit px，quietZone 个模块的静区 */
function toSvg(text, { unit = 4, quiet = 4, dark = '#17181a', light = '#ffffff' } = {}) {
  const { size, modules } = encodeMatrix(text);
  const total = size + quiet * 2;
  const rects = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total * unit}" height="${total * unit}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="${light}"/><g fill="${dark}">${rects.join('')}</g></svg>`;
}

module.exports = { encodeMatrix, toSvg };
