/**
 * A QR code encoder, for the `otpauth://` URI an authenticator app scans.
 *
 * Written here rather than installed: the panel takes no dependency for a
 * single picture, and the subset needed is small — byte mode, error correction
 * level M (15% of the symbol can be lost and it still reads), every version
 * from 1 to 40, automatic mask choice. It follows ISO/IEC 18004 step by step,
 * in the order of the well-known reference implementation by Project Nayuki,
 * so each stage can be checked against the standard on its own.
 *
 * Zero imports, no DOM and no Node: it runs in the browser that draws the
 * code and in the unit suite that decodes it back (`tests/suites/qr-unit`).
 */

export interface QrMatrix {
  /** Modules per side, 21 for version 1 up to 177 for version 40. */
  size: number;
  version: number;
  mask: number;
  /** Row-major, `true` for a dark module. */
  modules: boolean[];
}

// Level M, indexed by version (index 0 unused). From the standard's table 9.
const ECC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33,
  35, 37, 38, 40, 43, 45, 47, 49,
];
/** Level M in the two format bits (L = 01, M = 00, Q = 11, H = 10). */
const ECL_M_FORMAT_BITS = 0;

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

/** Modules left for data and error correction once every function pattern is drawn. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords of a version at level M: the raw ones minus every block's error correction. */
export function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[version] * NUM_ERROR_CORRECTION_BLOCKS[version];
}

/** Bits of the character count in byte mode: 8 up to version 9, 16 after. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** The most bytes a version holds in byte mode at level M. */
export function byteCapacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

// --- Reed-Solomon over GF(2^8), primitive polynomial x^8+x^4+x^3+x^2+1 -------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator polynomial of a degree, highest coefficient first and the leading 1 dropped. */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error correction codewords of one block: the remainder of the data over the divisor. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

// --- segment ------------------------------------------------------------------

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** Mode, count, data, terminator and the alternating pad bytes, as codewords. */
function dataCodewordsFor(bytes: Uint8Array, version: number): number[] {
  const capacityBits = dataCodewords(version) * 8;
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // byte mode
  appendBits(bits, bytes.length, countBits(version));
  for (const byte of bytes) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

/**
 * Split into blocks, add each block's error correction, interleave. The short
 * blocks come first and get a placeholder where the long ones carry one more
 * data byte, so a single loop can read the columns.
 */
function interleave(data: number[], version: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// --- the symbol -----------------------------------------------------------------

/** Centre coordinates of the alignment patterns, the same list for rows and columns. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** The 15 format bits: level and mask, BCH(15,5), XOR 101010000010010. */
export function formatBits(mask: number): number {
  const data = (ECL_M_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits from version 7 on: the version, BCH(18,6). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bit = (value: number, i: number) => ((value >>> i) & 1) !== 0;

/** The eight mask conditions; `x` is the column, `y` the row. */
const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly version: number;
  readonly size: number;
  readonly modules: boolean[];
  readonly isFunction: boolean[];

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = new Array<boolean>(this.size * this.size).fill(false);
    this.isFunction = new Array<boolean>(this.size * this.size).fill(false);
  }

  get(x: number, y: number): boolean {
    return this.modules[y * this.size + x];
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y * this.size + x] = dark;
    this.isFunction[y * this.size + x] = true;
  }

  drawFunctionPatterns(): void {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);

    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    positions.forEach((cx, i) => {
      positions.forEach((cy, j) => {
        // The three corners already hold a finder.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      });
    });

    // Reserved now so the data skips them; the real bits come with the mask.
    this.drawFormat(0);
    this.drawVersion();
  }

  /** A finder with its light separator; parts outside the symbol are skipped. */
  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  drawFormat(mask: number): void {
    const bits = formatBits(mask);
    const { size } = this;
    // Around the top-left finder.
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(bits, i));
    this.setFunction(8, 7, bit(bits, 6));
    this.setFunction(8, 8, bit(bits, 7));
    this.setFunction(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(bits, i));
    // The copy split between the other two finders.
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(bits, i));
    // Always dark.
    this.setFunction(8, size - 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    const bits = versionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit(bits, i));
      this.setFunction(b, a, bit(bits, i));
    }
  }

  /** Two columns at a time from the right, snaking up and down, skipping the vertical timing line. */
  drawCodewords(codewords: number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y * size + x] && i < codewords.length * 8) {
            this.modules[y * size + x] = bit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  /** XOR, so applying the same mask twice takes it off again. */
  applyMask(mask: number): void {
    const test = MASKS[mask];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const index = y * this.size + x;
        if (!this.isFunction[index] && test(x, y)) this.modules[index] = !this.modules[index];
      }
    }
  }

  /** The standard's four penalty rules; the mask with the lowest total is the one used. */
  penalty(): number {
    const { size } = this;
    let result = 0;

    for (const vertical of [false, true]) {
      for (let a = 0; a < size; a++) {
        let runColor = false;
        let runLength = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const color = vertical ? this.get(a, b) : this.get(b, a);
          if (color === runColor) {
            runLength++;
            if (runLength === 5) result += 3;
            else if (runLength > 5) result++;
          } else {
            this.addHistory(runLength, history);
            if (!runColor) result += this.countFinderLike(history) * 40;
            runColor = color;
            runLength = 1;
          }
        }
        // End of the line: close the run, then count the light border past the edge.
        if (runColor) {
          this.addHistory(runLength, history);
          runLength = 0;
        }
        this.addHistory(runLength + size, history);
        result += this.countFinderLike(history) * 40;
      }
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = this.get(x, y);
        if (color === this.get(x + 1, y) && color === this.get(x, y + 1) && color === this.get(x + 1, y + 1)) result += 3;
      }
    }

    const dark = this.modules.reduce((sum, m) => sum + (m ? 1 : 0), 0);
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * 10;
  }

  private addHistory(runLength: number, history: number[]): void {
    // The first run of a line borders the light quiet zone.
    if (history[0] === 0) runLength += this.size;
    history.pop();
    history.unshift(runLength);
  }

  /** 1:1:3:1:1 dark-light-dark-light-dark with four light modules on one side, or both. */
  private countFinderLike(history: number[]): number {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  }
}

/**
 * The QR code for a text, at the smallest version that holds it. `mask` forces
 * one of the eight patterns, for tests; otherwise the standard's penalty picks.
 * Throws when the text is longer than version 40 holds (2331 bytes).
 */
export function encodeQr(text: string, opts: { mask?: number; minVersion?: number } = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = Math.max(QR_MIN_VERSION, opts.minVersion ?? QR_MIN_VERSION);
  while (version <= QR_MAX_VERSION && bytes.length > byteCapacity(version)) version++;
  if (version > QR_MAX_VERSION) throw new RangeError("Testo troppo lungo per un codice QR");

  const symbol = new Grid(version);
  symbol.drawFunctionPatterns();
  symbol.drawCodewords(interleave(dataCodewordsFor(bytes, version), version));

  let mask = opts.mask ?? -1;
  if (mask < 0 || mask > 7) {
    let best = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < 8; candidate++) {
      symbol.applyMask(candidate);
      symbol.drawFormat(candidate);
      const score = symbol.penalty();
      if (score < best) {
        best = score;
        mask = candidate;
      }
      symbol.applyMask(candidate);
    }
  }
  symbol.applyMask(mask);
  symbol.drawFormat(mask);

  return { size: symbol.size, version, mask, modules: symbol.modules };
}

/**
 * The dark modules as one SVG path, a horizontal run per command, in module
 * units; draw it in a `viewBox` with a margin of four (the quiet zone a
 * scanner needs to find the edges).
 */
export function qrSvgPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    let x = 0;
    while (x < matrix.size) {
      if (!matrix.modules[y * matrix.size + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < matrix.size && matrix.modules[y * matrix.size + x]) x++;
      parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  }
  return parts.join("");
}
