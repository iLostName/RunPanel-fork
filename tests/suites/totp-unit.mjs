import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The codes of two-step sign-in, against the RFCs that define them.
 *
 * A TOTP implementation that is off by a byte still produces six digits — just
 * never the six the phone shows — and the first person to notice is the one
 * who has just turned it on. The vectors below are RFC 4226's (HOTP) and
 * RFC 6238's (TOTP, all three hashes), plus RFC 4648's for base32.
 */
export const meta = { name: "totp-unit", needsDocker: false, drivers: [], standalone: true };

const SEED_SHA1 = Buffer.from("12345678901234567890");
const SEED_SHA256 = Buffer.from("12345678901234567890123456789012");
const SEED_SHA512 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234");

// RFC 6238 appendix B: time in seconds, then the 8-digit code for SHA1, SHA256, SHA512.
const RFC6238 = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

// RFC 4226 appendix D: counters 0 to 9.
const RFC4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];

export async function run({ repoRoot }) {
  const r = createReporter("totp-unit");
  const t = await import(pathToFileURL(join(repoRoot, "lib", "totp.ts")).href);

  // --- the algorithms -----------------------------------------------------------
  r.check("HOTP matches RFC 4226 for counters 0-9", RFC4226.every((code, counter) => t.hotp(SEED_SHA1, counter) === code));
  for (const [seconds, sha1, sha256, sha512] of RFC6238) {
    const ms = seconds * 1000;
    const got = [t.totp(SEED_SHA1, ms, 8, "sha1"), t.totp(SEED_SHA256, ms, 8, "sha256"), t.totp(SEED_SHA512, ms, 8, "sha512")];
    r.check(`TOTP matches RFC 6238 at T=${seconds}`, got.join() === [sha1, sha256, sha512].join(), got.join());
  }
  r.check("six digits are the last six of the RFC's eight", t.totp(SEED_SHA1, 59_000) === "287082");
  r.check("a code keeps its leading zero", t.totp(SEED_SHA1, 1111111109_000, 8) === "07081804");

  // --- base32 -------------------------------------------------------------------
  const vectors = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
  r.check("base32 encodes the RFC 4648 vectors", vectors.every(([plain, coded]) => t.base32Encode(Buffer.from(plain)) === coded));
  r.check(
    "base32 decodes them back, padding or not",
    vectors.slice(1).every(([plain, coded]) => t.base32Decode(coded)?.toString() === plain && t.base32Decode(`${coded}===`)?.toString() === plain)
  );
  r.check("a key copied by hand still decodes", t.base32Decode("mzxw 6ytb-oi")?.toString() === "foobar");
  r.check("a character outside the alphabet is refused", t.base32Decode("MZXW1") === null && t.base32Decode("") === null);
  const secret = t.generateTotpSecret();
  r.check("a new secret is 160 bits in 32 characters", /^[A-Z2-7]{32}$/.test(secret) && t.base32Decode(secret).length === 20, secret);
  r.check("two secrets differ", t.generateTotpSecret() !== secret);

  // --- verification: window and replay ----------------------------------------
  const key = t.base32Decode(secret);
  const now = 1_800_000_000_000;
  const step = t.totpStep(now);
  const codeAt = (s) => t.hotp(key, s);
  r.check("the current code is accepted and names its step", t.verifyTotp(key, codeAt(step), { nowMs: now }) === step);
  r.check("one step either side is accepted", t.verifyTotp(key, codeAt(step - 1), { nowMs: now }) === step - 1 && t.verifyTotp(key, codeAt(step + 1), { nowMs: now }) === step + 1);
  r.check("two steps away is refused", t.verifyTotp(key, codeAt(step - 2), { nowMs: now }) === null && t.verifyTotp(key, codeAt(step + 2), { nowMs: now }) === null);
  r.check("the code of the step already used is refused", t.verifyTotp(key, codeAt(step), { nowMs: now, lastUsedStep: step }) === null);
  r.check("an earlier step is refused after a later one was used", t.verifyTotp(key, codeAt(step - 1), { nowMs: now, lastUsedStep: step }) === null);
  r.check("the next step is still accepted after one was used", t.verifyTotp(key, codeAt(step + 1), { nowMs: now, lastUsedStep: step }) === step + 1);
  r.check("spaces inside the code are fine", t.verifyTotp(key, `${codeAt(step).slice(0, 3)} ${codeAt(step).slice(3)}`, { nowMs: now }) === step);
  r.check(
    "anything but six digits is refused",
    ["", "12345", "1234567", "12345a", "١٢٣٤٥٦"].every((code) => t.verifyTotp(key, code, { nowMs: now }) === null)
  );
  r.check("another key's code is refused", t.verifyTotp(t.base32Decode(t.generateTotpSecret()), codeAt(step), { nowMs: now }) === null);

  // --- the URI ------------------------------------------------------------------
  const uri = t.otpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "owner@example.com (panel)", issuer: "RunPanel" });
  const parsed = new URL(uri);
  r.check("the URI is a TOTP otpauth URI", parsed.protocol === "otpauth:" && parsed.host === "totp", uri);
  r.check("the label is issuer:account, encoded", parsed.pathname === "/RunPanel:owner%40example.com%20(panel)", parsed.pathname);
  r.check(
    "the parameters spell out the defaults",
    parsed.searchParams.get("secret") === "JBSWY3DPEHPK3PXP" &&
      parsed.searchParams.get("issuer") === "RunPanel" &&
      parsed.searchParams.get("algorithm") === "SHA1" &&
      parsed.searchParams.get("digits") === "6" &&
      parsed.searchParams.get("period") === "30"
  );
  r.check("no space is written as +", !uri.includes("+"));

  // --- recovery codes -----------------------------------------------------------
  const codes = t.generateRecoveryCodes();
  r.check("ten recovery codes", codes.length === 10);
  r.check("each reads xxxx-xxxx-xxxx in Crockford's alphabet", codes.every((c) => /^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/.test(c)), codes.join(" "));
  r.check("they are all different", new Set(codes).size === 10);

  const stored = await t.hashRecoveryCode(codes[0]);
  r.check("the stored form is a salted hash, not the code", stored.startsWith("s1$") && !stored.includes(codes[0].replace(/-/g, "")), stored);
  r.check("hashing twice gives two different salts", (await t.hashRecoveryCode(codes[0])) !== stored);
  r.check("the code matches its hash", await t.recoveryCodeMatches(codes[0], stored));
  r.check("typed without dashes, in capitals, with spaces, it still matches", await t.recoveryCodeMatches(` ${codes[0].replace(/-/g, "").toUpperCase()} `, stored));
  const lookalike = codes[0].replace(/0/g, "O").replace(/1/g, "l");
  r.check("O for 0 and l for 1 are read as the digits", await t.recoveryCodeMatches(lookalike, stored), lookalike);
  r.check("another code does not match", !(await t.recoveryCodeMatches(codes[1], stored)));
  r.check("a TOTP code is not taken for a recovery code", t.normalizeRecoveryCode("123456") === null);
  r.check("a malformed stored value never matches", !(await t.recoveryCodeMatches(codes[0], "s1$zz")) && !(await t.recoveryCodeMatches(codes[0], "")));

  return r.result();
}
