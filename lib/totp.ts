import crypto from "node:crypto";

/**
 * One-time codes for two-step sign-in: TOTP (RFC 6238) over HOTP (RFC 4226),
 * and the recovery codes that stand in for a lost phone.
 *
 * Only `node:crypto`, and nothing that needs the panel's secret or its
 * database: the unit suite loads this file directly, and the rules here have to
 * be right independently of where the seed is kept (`lib/two-factor.ts`).
 *
 * The parameters are the ones every authenticator app assumes when an
 * `otpauth://` URI says nothing else — SHA-1, six digits, thirty seconds —
 * and they are spelled out in the URI anyway. Anything else is a code that
 * works in one app and silently not in another.
 */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ALGORITHM = "SHA1";
/** 160 bits: the key length RFC 4226 asks for with HMAC-SHA-1. */
export const TOTP_SECRET_BYTES = 20;
/**
 * Steps accepted either side of now. One is thirty seconds of clock drift or of
 * typing, which is what a phone and a server disagree by in practice; more
 * only multiplies the codes a guess can hit.
 */
export const TOTP_WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, without padding: what authenticator apps expect to be typed or scanned. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * The inverse, forgiving about what people do when they copy a key by hand:
 * spaces, dashes, lower case, padding. Null on any other character, rather than
 * a key that decodes to something and then never produces a valid code.
 */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean.length === 0) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) return null;
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(TOTP_SECRET_BYTES));
}

export type HotpAlgorithm = "sha1" | "sha256" | "sha512";

/**
 * RFC 4226 §5.3: HMAC over the 8-byte big-endian counter, then "dynamic
 * truncation" — four bytes at the offset named by the low nibble of the last
 * byte, top bit cleared, modulo 10^digits.
 */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS, algorithm: HotpAlgorithm = "sha1"): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The time step a moment falls in (RFC 6238 §4, T0 = 0). */
export function totpStep(nowMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

export function totp(key: Uint8Array, nowMs: number, digits = TOTP_DIGITS, algorithm: HotpAlgorithm = "sha1"): string {
  return hotp(key, totpStep(nowMs), digits, algorithm);
}

/** Six digits, once spaces are gone — "123 456" is how apps display them. */
export function normalizeTotpCode(raw: string): string | null {
  const code = raw.replace(/\s/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * The step a code belongs to, or null.
 *
 * `lastUsedStep` is the replay guard: a code is good for its thirty seconds
 * (plus the window), and without this the same six digits — read over a
 * shoulder, or out of a phishing page that relays them — would open a second
 * session in that time. Only a step strictly after the last one accepted
 * counts. The caller stores the step it gets back, and must store it with a
 * conditional write: two requests racing with the same code both pass this.
 *
 * Every candidate is computed and compared, whichever matches, so the time
 * taken does not say which step a guess was closest to.
 */
export function verifyTotp(
  key: Uint8Array,
  rawCode: string,
  opts: { nowMs?: number; lastUsedStep?: number | null; window?: number } = {}
): number | null {
  const code = normalizeTotpCode(rawCode);
  if (!code) return null;
  const current = totpStep(opts.nowMs ?? Date.now());
  const window = opts.window ?? TOTP_WINDOW;
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    if (sameCode(hotp(key, step), code) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (opts.lastUsedStep !== null && opts.lastUsedStep !== undefined && matched <= opts.lastUsedStep) return null;
  return matched;
}

/**
 * The URI an authenticator app scans (Google's "Key Uri Format", which every
 * app follows). The label is `issuer:account`; the issuer is repeated as a
 * parameter because some apps read only one of the two.
 */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  // URLSearchParams writes a space as `+`, which some apps show literally.
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, "%20")}`;
}

// --- recovery codes ----------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;

/**
 * Crockford's base32 alphabet: no I, L, O or U, so a code copied onto paper
 * reads back the same. 32 symbols, so five random bits pick one with no bias.
 */
const RECOVERY_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const RECOVERY_LENGTH = 12;

/**
 * Ten codes of twelve symbols, 60 bits each, shown as `xxxx-xxxx-xxxx`.
 *
 * Long enough that, hashed below, a copy of the database does not give them
 * away; short enough to type from a sheet of paper on the one bad day they are
 * needed.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const bytes = crypto.randomBytes(RECOVERY_LENGTH);
    const symbols = Array.from(bytes, (byte) => RECOVERY_ALPHABET[byte & 31]).join("");
    return `${symbols.slice(0, 4)}-${symbols.slice(4, 8)}-${symbols.slice(8)}`;
  });
}

/**
 * What was typed, in the form that was hashed: lower case, separators gone,
 * and the letters Crockford's alphabet leaves out read as the digits they look
 * like. Null when it cannot be a recovery code, so a mistyped TOTP code is not
 * hashed ten times for nothing.
 */
export function normalizeRecoveryCode(raw: string): string | null {
  const code = raw
    .toLowerCase()
    .replace(/[\s-]/g, "")
    .replace(/o/g, "0")
    .replace(/[il]/g, "1");
  if (code.length !== RECOVERY_LENGTH) return null;
  for (const char of code) if (!RECOVERY_ALPHABET.includes(char)) return null;
  return code;
}

/**
 * scrypt with a salt per code, not a bare SHA-256.
 *
 * A recovery code is the one secret here that must keep working when the
 * panel's key is gone — a store restored onto a new server without
 * `RUNPANEL_SECRET` cannot decrypt the TOTP seeds, and the recovery codes are
 * then the way back in — so it cannot be keyed with that secret. A slow hash
 * is what stands between a copy of the database and the codes in it.
 */
const SCRYPT = { N: 2 ** 14, r: 8, p: 1, keylen: 32 } as const;

function scrypt(code: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(code, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

/** `s1$<salt hex>$<hash hex>`; the prefix leaves room for another scheme later. */
export async function hashRecoveryCode(code: string): Promise<string> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw new Error("not a recovery code");
  const salt = crypto.randomBytes(16);
  return `s1$${salt.toString("hex")}$${(await scrypt(normalized, salt)).toString("hex")}`;
}

/** Whether `code` is the one `stored` was made from. False for anything malformed. */
export async function recoveryCodeMatches(code: string, stored: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (!normalized || scheme !== "s1" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== SCRYPT.keylen) return false;
  const actual = await scrypt(normalized, Buffer.from(saltHex, "hex"));
  return crypto.timingSafeEqual(actual, expected);
}
