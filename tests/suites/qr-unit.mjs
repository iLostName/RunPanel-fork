import { createReporter } from "../harness.mjs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The QR code the authenticator app scans is drawn by `lib/qr.ts`, which the
 * panel wrote itself instead of installing a library. A symbol that is almost
 * right is a symbol no phone reads, and the person enabling two-step sign-in
 * is then stuck on the step that should take ten seconds.
 *
 * So each symbol is decoded back here by a reader written from the standard,
 * not from the encoder: format and version bits with their BCH codes, the
 * mask taken off, the codewords read in the zigzag order, the blocks
 * de-interleaved, every block's Reed-Solomon syndromes checked to be zero, and
 * the byte segment parsed back into the text. The golden hashes were produced
 * by an independent encoder (node-qrcode) for the same input and mask.
 */
export const meta = { name: "qr-unit", needsDocker: false, drivers: [], standalone: true };

/** Byte-mode capacity at level M, versions 1–40, from the standard's table 7. */
const STANDARD_CAPACITY = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666, 711, 779, 857, 911, 997,
  1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331,
];

/** Level M block structure (table 9): total codewords, EC per block, [blocks, data codewords] groups. */
const BLOCKS = {
  1: { total: 26, ec: 10, groups: [[1, 16]] },
  2: { total: 44, ec: 16, groups: [[1, 28]] },
  5: { total: 134, ec: 24, groups: [[2, 43]] },
  7: { total: 196, ec: 18, groups: [[4, 31]] },
  8: { total: 242, ec: 22, groups: [[2, 38], [2, 39]] },
  9: { total: 292, ec: 22, groups: [[3, 36], [2, 37]] },
  10: { total: 346, ec: 26, groups: [[4, 43], [1, 44]] },
  40: { total: 3706, ec: 28, groups: [[18, 47], [31, 48]] },
};

/** Alignment pattern centres (annex E). */
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  5: [6, 30],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  40: [6, 30, 58, 86, 114, 142, 170],
};

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// GF(256) by tables, a different construction from the encoder's bit-serial multiply.
const EXP = new Array(512);
const LOG = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** BCH remainder of `value` (already shifted) by `generator`, both as integers. */
function bchRemainder(value, generator) {
  const genBits = Math.floor(Math.log2(generator));
  for (let i = Math.floor(Math.log2(value || 1)); i >= genBits; i--) {
    if (value & (1 << i)) value ^= generator << (i - genBits);
  }
  return value;
}

/** Decode a symbol back into its bytes, checking everything the standard lets one check. */
function decode(matrix) {
  const size = matrix.size;
  const version = (size - 17) / 4;
  const at = (r, c) => matrix.modules[r * size + c];
  const problems = [];

  // --- which modules are not data -------------------------------------------
  const reserved = new Set();
  const reserve = (r, c) => reserved.add(r * size + c);
  for (let i = 0; i < size; i++) {
    reserve(6, i);
    reserve(i, 6);
  }
  for (const [r0, c0] of [[0, 0], [0, size - 8], [size - 8, 0]]) {
    for (let r = r0; r < r0 + 8; r++) for (let c = c0; c < c0 + 8; c++) reserve(r, c);
  }
  const align = ALIGNMENT[version];
  for (const r of align) {
    for (const c of align) {
      const clash = (r === 6 && c === 6) || (r === 6 && c === align.at(-1)) || (r === align.at(-1) && c === 6);
      if (clash) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) reserve(r + dr, c + dc);
    }
  }
  for (let i = 0; i <= 8; i++) {
    reserve(8, i);
    reserve(i, 8);
  }
  for (let i = 0; i < 8; i++) reserve(8, size - 1 - i);
  for (let i = 0; i < 7; i++) reserve(size - 1 - i, 8);
  reserve(size - 8, 8);
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserve(i, size - 11 + j);
        reserve(size - 11 + j, i);
      }
    }
  }

  // --- finder, timing and the dark module -------------------------------------
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      const want = ring !== 2;
      if (at(r, c) !== want || at(r, size - 7 + c) !== want || at(size - 7 + r, c) !== want) problems.push("finder");
    }
  }
  for (let i = 8; i < size - 8; i++) if (at(6, i) !== (i % 2 === 0) || at(i, 6) !== (i % 2 === 0)) problems.push("timing");
  if (!at(size - 8, 8)) problems.push("dark module");

  // --- format: two copies, BCH(15,5), level M ---------------------------------
  let first = 0;
  // Bit 0 at the top of column 8, bit 14 at the left end of row 8 (as ZXing reads it).
  const firstOrder = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  firstOrder.forEach(([r, c], i) => {
    if (at(r, c)) first |= 1 << i;
  });
  let second = 0;
  for (let i = 0; i < 8; i++) if (at(8, size - 1 - i)) second |= 1 << i;
  for (let i = 8; i < 15; i++) if (at(size - 15 + i, 8)) second |= 1 << i;
  if (first !== second) problems.push("format copies differ");
  const format = first ^ 0x5412;
  if (bchRemainder(format, 0x537) !== 0) problems.push("format BCH");
  const level = format >> 13;
  const mask = (format >> 10) & 7;
  if (level !== 0) problems.push(`level ${level} is not M`);

  // --- version: BCH(18,6) ------------------------------------------------------
  if (version >= 7) {
    let bits = 0;
    let mirrored = 0;
    for (let i = 0; i < 18; i++) {
      if (at(Math.floor(i / 3), size - 11 + (i % 3))) bits |= 1 << i;
      if (at(size - 11 + (i % 3), Math.floor(i / 3))) mirrored |= 1 << i;
    }
    if (bits !== mirrored) problems.push("version copies differ");
    if (bits >> 12 !== version || bchRemainder(bits, 0x1f25) !== 0) problems.push("version BCH");
  }

  // --- codewords: unmask and read the zigzag ------------------------------------
  const bitsOut = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let k = 0; k < size; k++) {
      const r = upward ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (reserved.has(r * size + c)) continue;
        bitsOut.push(at(r, c) !== MASKS[mask](r, c) ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const spec = BLOCKS[version];
  const codewords = [];
  for (let i = 0; i + 8 <= bitsOut.length && codewords.length < spec.total; i += 8) {
    codewords.push(bitsOut.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  }
  if (codewords.length !== spec.total) problems.push(`read ${codewords.length} codewords, want ${spec.total}`);

  // --- de-interleave, then check each block -----------------------------------
  const blocks = spec.groups.flatMap(([count, len]) => Array.from({ length: count }, () => ({ len, data: [], ec: [] })));
  const longest = Math.max(...blocks.map((b) => b.len));
  let p = 0;
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.len) b.data.push(codewords[p++]);
  for (let i = 0; i < spec.ec; i++) for (const b of blocks) b.ec.push(codewords[p++]);
  for (const b of blocks) {
    const word = [...b.data, ...b.ec];
    for (let s = 0; s < spec.ec; s++) {
      let value = 0;
      for (const c of word) value = mul(value, EXP[s]) ^ c;
      if (value !== 0) {
        problems.push("Reed-Solomon syndrome");
        break;
      }
    }
  }

  // --- the byte segment ----------------------------------------------------------
  const stream = blocks.flatMap((b) => b.data).flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
  let q = 0;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | stream[q++];
    return v;
  };
  if (read(4) !== 0b0100) problems.push("not byte mode");
  const count = read(version <= 9 ? 8 : 16);
  const bytes = Array.from({ length: count }, () => read(8));
  return { version, mask, bytes: Buffer.from(bytes), problems: [...new Set(problems)] };
}

const fingerprint = (matrix) => createHash("sha256").update(matrix.modules.map((b) => (b ? "1" : "0")).join("")).digest("hex");

export async function run({ repoRoot }) {
  const r = createReporter("qr-unit");
  const { encodeQr, byteCapacity, qrSvgPath } = await import(pathToFileURL(join(repoRoot, "lib", "qr.ts")).href);

  const capacity = Array.from({ length: 40 }, (_, i) => byteCapacity(i + 1));
  r.check("byte capacity matches the standard for every version", capacity.join() === STANDARD_CAPACITY.join(), capacity.join());

  // Produced by node-qrcode for the same byte segment, level M and mask.
  r.check(
    "a version 1 symbol is identical to an independent encoder's",
    fingerprint(encodeQr("HELLO WORLD", { mask: 0 })) === "a28227450c6dd5abe58c1f8e24f23525b03a7d253d28c58bd135b14117f197a2"
  );
  r.check(
    "an otpauth symbol is identical to an independent encoder's",
    fingerprint(encodeQr("otpauth://totp/RunPanel:owner%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=RunPanel", { mask: 3 })) ===
      "5f6c370f9634c008a37221ac509ad786d4a2b34eac4f7cf9834927bcd7b782aa"
  );

  const uri =
    "otpauth://totp/RunPanel:owner%40example.com%20(100.64.0.5%3A3000)?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=RunPanel&algorithm=SHA1&digits=6&period=30";
  const cases = [
    ["a single character", "a"],
    ["an otpauth URI", uri],
    ["non-ASCII text, as UTF-8", "àèìòù € 漢字"],
    ["the most version 1 holds", "x".repeat(STANDARD_CAPACITY[0])],
    ["one byte more than version 9 holds (16-bit count)", "y".repeat(STANDARD_CAPACITY[8] + 1)],
    ["the most version 40 holds", "z".repeat(STANDARD_CAPACITY[39])],
  ];
  for (const [what, text] of cases) {
    const matrix = encodeQr(text);
    const decoded = decode(matrix);
    const ok = decoded.problems.length === 0 && decoded.bytes.equals(Buffer.from(text, "utf8"));
    r.check(`${what} decodes back (version ${decoded.version}, mask ${decoded.mask})`, ok, decoded.problems.join(", "));
  }

  const masks = Array.from({ length: 8 }, (_, mask) => decode(encodeQr(uri, { mask })));
  r.check(
    "every one of the eight masks is drawn and named correctly",
    masks.every((d, mask) => d.mask === mask && d.problems.length === 0 && d.bytes.toString("utf8") === uri),
    masks.map((d) => `${d.mask}:${d.problems.join("/")}`).join(" ")
  );

  const sizes = [1, 9, 10].map((v) => encodeQr("q".repeat(STANDARD_CAPACITY[v - 1])).version);
  r.check("the smallest version that fits is chosen", sizes.join() === "1,9,10", sizes.join());

  let threw = false;
  try {
    encodeQr("w".repeat(STANDARD_CAPACITY[39] + 1));
  } catch {
    threw = true;
  }
  r.check("a text longer than version 40 holds is refused", threw);

  const small = encodeQr("a");
  const path = qrSvgPath(small);
  const dark = small.modules.filter(Boolean).length;
  const drawn = [...path.matchAll(/h(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  r.check("the SVG path draws exactly the dark modules", drawn === dark, `${drawn} of ${dark}`);

  return r.result();
}
