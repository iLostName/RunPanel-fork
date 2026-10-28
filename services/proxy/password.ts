import { createHash, randomBytes } from "node:crypto";

/**
 * The password nginx asks for in front of a name, as `auth_basic` checks it.
 *
 * SHA-512 crypt (`$6$`), not bcrypt: nginx hands any scheme it does not know
 * itself to the system's crypt(), and bcrypt is there only on some libcs — a
 * hash glibc cannot read is a 500 on every request. `$6$` is read by glibc,
 * libxcrypt and musl alike, and is far stronger than the `{SSHA}` and `$apr1$`
 * nginx knows on its own. The default 5000 rounds, written without a
 * `rounds=` prefix: nginx runs it on every request, assets included.
 *
 * Only `node:crypto`, so the standalone suite can load it as it loads the renderer.
 */

const ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ROUNDS = 5000;

const sha512 = (...parts: Buffer[]) => createHash("sha512").update(Buffer.concat(parts)).digest();

/** `count` bytes of `block` repeated — how the algorithm stretches a digest over a length. */
function stretch(block: Buffer, count: number): Buffer {
  const out = Buffer.alloc(count);
  for (let i = 0; i < count; i += block.length) block.copy(out, i, 0, Math.min(block.length, count - i));
  return out;
}

/** Ulrich Drepper's SHA-crypt, as glibc implements it. Salt of at most 16 characters. */
export function sha512Crypt(password: string, salt: string): string {
  const p = Buffer.from(password, "utf8");
  const s = Buffer.from(salt.slice(0, 16), "utf8");

  const b = sha512(p, s, p);
  const a: Buffer[] = [p, s, stretch(b, p.length)];
  for (let i = p.length; i > 0; i >>= 1) a.push(i & 1 ? b : p);
  let c = sha512(...a);

  const pSeq = stretch(sha512(...Array<Buffer>(p.length).fill(p)), p.length);
  const sSeq = stretch(sha512(...Array<Buffer>(16 + c[0]).fill(s)), s.length);

  for (let round = 0; round < ROUNDS; round++) {
    const parts = [round & 1 ? pSeq : c];
    if (round % 3) parts.push(sSeq);
    if (round % 7) parts.push(pSeq);
    parts.push(round & 1 ? c : pSeq);
    c = sha512(...parts);
  }

  // 21 groups of three bytes in the algorithm's own order — (i·22, +21, +42) mod 63 —
  // then the last byte alone.
  let encoded = "";
  const put = (value: number, chars: number) => {
    for (let n = 0; n < chars; n++, value >>= 6) encoded += ALPHABET[value & 0x3f];
  };
  for (let i = 0; i < 21; i++) {
    const first = (i * 22) % 63;
    put((c[first] << 16) | (c[(first + 21) % 63] << 8) | c[(first + 42) % 63], 4);
  }
  put(c[63], 2);
  return `$6$${s.toString("utf8")}$${encoded}`;
}

export function hashPassword(password: string): string {
  const salt = Array.from(randomBytes(16), (byte) => ALPHABET[byte & 0x3f]).join("");
  return sha512Crypt(password, salt);
}
