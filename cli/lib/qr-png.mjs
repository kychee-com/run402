// A QR code (ISO/IEC 18004, error correction level M) written as a PNG, for
// `billing topup --qr`. Replaces the `qrcode` package and its tree (`yargs`,
// `pngjs`, `dijkstrajs` and 26 more) for the one image the CLI draws. The
// encoder follows Project Nayuki's QR Code generator (MIT); the PNG is one
// grayscale IDAT through node:zlib.

import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

// Level M, indexed by version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_BITS_M = 0;
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version) =>
  Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[version] * ERROR_CORRECTION_BLOCKS[version];

/** One segment: alphanumeric mode when every character allows it (the uppercase BOLT11 case), else UTF-8 bytes. */
function segment(text) {
  if ([...text].every((ch) => ALPHANUMERIC.includes(ch))) {
    const bits = [];
    for (let i = 0; i + 1 < text.length; i += 2) {
      pushBits(bits, ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
    }
    if (text.length % 2 === 1) pushBits(bits, ALPHANUMERIC.indexOf(text.at(-1)), 6);
    return { mode: 0x2, countBits: [9, 11, 13], count: text.length, bits };
  }
  const bytes = new TextEncoder().encode(text);
  const bits = [];
  for (const b of bytes) pushBits(bits, b, 8);
  return { mode: 0x4, countBits: [8, 16, 16], count: bytes.length, bits };
}

function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
  }
  return result;
}

function interleaveWithEcc(data, version) {
  const blocks = ERROR_CORRECTION_BLOCKS[version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLength);
  const out = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    out.push(block.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < out[0].length; i++) {
    out.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  place(x, y, dark) {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.place(6, i, i % 2 === 0);
      this.place(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) this.place(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
    const align = alignmentPositions(this.version, size);
    align.forEach((ax, i) => align.forEach((ay, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) this.place(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }));
    this.drawFormatBits(0);
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.place(a, b, dark);
        this.place(b, a, dark);
      }
    }
  }

  drawFormatBits(mask) {
    const data = (FORMAT_BITS_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.place(8, i, bit(i));
    this.place(8, 7, bit(6));
    this.place(8, 8, bit(7));
    this.place(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.place(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.place(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.place(8, size - 15 + i, bit(i));
    this.place(8, size - 8, true);
  }

  drawCodewords(codewords) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!this.fixed[y][x] && i < codewords.length * 8) {
            this.dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.fixed[y][x] && MASKS[mask](x, y)) this.dark[y][x] = !this.dark[y][x];
      }
    }
  }

  /** ISO/IEC 18004 mask penalty: long runs, 2x2 blocks, finder-like patterns, dark balance. */
  penalty() {
    const { size, dark } = this;
    let score = 0;
    const lines = [];
    for (let i = 0; i < size; i++) {
      lines.push(dark[i]);
      lines.push(dark.map((row) => row[i]));
    }
    for (const line of lines) {
      for (let i = 0, run = 1; i < size; i++, run++) {
        if (i === size - 1 || line[i] !== line[i + 1]) {
          if (run >= 5) score += run - 2;
          run = 0;
        }
      }
      const text = line.map((d) => (d ? "1" : "0")).join("");
      for (const pattern of ["10111010000", "00001011101"]) {
        for (let at = text.indexOf(pattern); at !== -1; at = text.indexOf(pattern, at + 1)) score += 40;
      }
    }
    let darkCount = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (dark[y][x]) darkCount++;
        if (x < size - 1 && y < size - 1) {
          const c = dark[y][x];
          if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
        }
      }
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/**
 * The QR modules for `text` at level M: `modules[y][x]` is true for dark.
 * `version` and `mask` are chosen automatically unless given.
 */
export function encodeQr(text, { version: forcedVersion, mask: forcedMask } = {}) {
  const seg = segment(text);
  let version = forcedVersion ?? 1;
  let bits;
  for (;; version++) {
    if (version > 40) throw new Error("QR payload too long");
    const countBits = seg.countBits[version <= 9 ? 0 : version <= 26 ? 1 : 2];
    const used = 4 + countBits + seg.bits.length;
    if (seg.count < 2 ** countBits && used <= dataCodewords(version) * 8) {
      bits = [];
      pushBits(bits, seg.mode, 4);
      pushBits(bits, seg.count, countBits);
      bits.push(...seg.bits);
      break;
    }
    if (forcedVersion !== undefined) throw new Error(`QR payload does not fit version ${forcedVersion}`);
  }
  const capacity = dataCodewords(version) * 8;
  pushBits(bits, 0, Math.min(4, capacity - bits.length));
  pushBits(bits, 0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns();
  matrix.drawCodewords(interleaveWithEcc(data, version));
  let mask = forcedMask;
  if (mask === undefined) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      matrix.applyMask(m);
      matrix.drawFormatBits(m);
      const score = matrix.penalty();
      if (score < best) {
        best = score;
        mask = m;
      }
      matrix.applyMask(m);
    }
  }
  matrix.applyMask(mask);
  matrix.drawFormatBits(mask);
  return { version, mask, size: matrix.size, modules: matrix.dark };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A grayscale PNG of `text` as a QR code, `width` pixels square with a `margin` of light modules. */
export function qrPng(text, { width = 512, margin = 2 } = {}) {
  const { size, modules } = encodeQr(text);
  const span = size + margin * 2;
  const scale = Math.max(1, width / span);
  const pixels = Math.floor(span * scale);
  const rows = Buffer.alloc((pixels + 1) * pixels, 0xff);
  for (let py = 0; py < pixels; py++) {
    rows[py * (pixels + 1)] = 0; // filter: none
    const my = Math.floor(py / scale) - margin;
    for (let px = 0; px < pixels; px++) {
      const mx = Math.floor(px / scale) - margin;
      if (my >= 0 && my < size && mx >= 0 && mx < size && modules[my][mx]) rows[py * (pixels + 1) + 1 + px] = 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(pixels, 0);
  header.writeUInt32BE(pixels, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function writeQrPng(path, text, options) {
  await writeFile(path, qrPng(text, options));
}
