import crypto from "crypto";
import { cookies, headers } from "next/headers";

import { hashToken } from "./auth";
import { sessionCookieSecure } from "./cookie-security";
import { decrypt, encrypt } from "./crypto";
import { getDb, nowIso, rowCount } from "./db";
import { clearRateLimit, consumeRateLimit, refundRateLimit } from "./rate-limit";
import {
  base32Decode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  normalizeTotpCode,
  recoveryCodeMatches,
  verifyTotp,
} from "./totp";
import { generateId } from "./utils";

/**
 * Two-step sign-in, as stored: the seed, the recovery codes, the remembered
 * devices and the sign-ins halfway through. The codes themselves are
 * `lib/totp.ts`; the routes are `app/api/auth/login/**` and
 * `app/api/auth/two-factor`.
 *
 * All of it is local to this panel. The accounts replicate across a cluster,
 * this does not (migration 035 says why), so each panel asks for its own code.
 */

/** Purpose of the key the seeds are encrypted with (lib/crypto.ts): a seed opens as nothing else. */
const SEED_PURPOSE = "totp";

/** "Ricorda questo dispositivo": a cookie of its own, sent only to the sign-in routes. */
export const DEVICE_COOKIE = "runpanel_device";
const DEVICE_PATH = "/api/auth";
const DEVICE_DAYS = 30;
/** Enough for every browser a person uses; past it the oldest is forgotten. */
const MAX_DEVICES_PER_USER = 20;

/** Time to type the code after the password. Long enough to find the phone. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wrong codes one sign-in may try before the password has to be typed again. */
export const CHALLENGE_MAX_ATTEMPTS = 5;
/** Time between showing the QR code and typing its first code. */
const SETUP_TTL_MS = 30 * 60 * 1000;

// --- the seed -------------------------------------------------------------------

function openSeed(encrypted: string): Uint8Array | null {
  try {
    return base32Decode(decrypt(encrypted, SEED_PURPOSE));
  } catch {
    // Sealed with another RUNPANEL_SECRET (a store restored elsewhere): no
    // code can be checked, and the recovery codes are the way in.
    return null;
  }
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  rememberedDevices: number;
  /** Enabled, but the seed cannot be opened with this panel's key. */
  seedUnreadable: boolean;
}

export async function twoFactorStatus(userId: string): Promise<TwoFactorStatus> {
  const db = await getDb();
  const [row, codes, devices] = await Promise.all([
    db.selectFrom("user_two_factor").select(["secret_enc", "enabled_at"]).where("user_id", "=", userId).executeTakeFirst(),
    db.selectFrom("user_recovery_codes").select("id").where("user_id", "=", userId).where("used_at", "is", null).execute(),
    db
      .selectFrom("trusted_devices")
      .select("id")
      .where("user_id", "=", userId)
      .where("expires_at", ">", nowIso())
      .execute(),
  ]);
  const enabled = Boolean(row?.enabled_at);
  return {
    enabled,
    enabledAt: row?.enabled_at ?? null,
    recoveryCodesLeft: enabled ? codes.length : 0,
    rememberedDevices: enabled ? devices.length : 0,
    seedUnreadable: enabled && row ? openSeed(row.secret_enc) === null : false,
  };
}

export async function isTwoFactorEnabled(userId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.selectFrom("user_two_factor").select("enabled_at").where("user_id", "=", userId).executeTakeFirst();
  return Boolean(row?.enabled_at);
}

/**
 * A fresh seed for the setup screen, kept as pending until a code from it is
 * typed. Null when two-step sign-in is already on: a second setup over a
 * working one would replace the seed without asking for the current code.
 */
export async function beginTwoFactorSetup(userId: string): Promise<string | null> {
  const db = await getDb();
  const existing = await db.selectFrom("user_two_factor").select("enabled_at").where("user_id", "=", userId).executeTakeFirst();
  if (existing?.enabled_at) return null;
  const secret = generateTotpSecret();
  const row = { secret_enc: encrypt(secret, SEED_PURPOSE), enabled_at: null, last_used_step: null, created_at: nowIso() };
  await db
    .insertInto("user_two_factor")
    .values({ user_id: userId, ...row })
    .onConflict((oc) => oc.column("user_id").doUpdateSet(row))
    .execute();
  return secret;
}

export type ConfirmResult = { ok: true; recoveryCodes: string[] } | { ok: false; reason: "none" | "expired" | "invalid" };

/**
 * The first code from the app turns it on, and that is the only proof the
 * phone really holds the seed: enabling on the strength of a scan nobody
 * checked is how people lock themselves out. The recovery codes are made
 * here and returned once.
 */
export async function confirmTwoFactorSetup(userId: string, code: string): Promise<ConfirmResult> {
  const db = await getDb();
  const row = await db
    .selectFrom("user_two_factor")
    .select(["secret_enc", "enabled_at", "created_at"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row || row.enabled_at) return { ok: false, reason: "none" };
  if (Date.now() - new Date(row.created_at).getTime() > SETUP_TTL_MS) return { ok: false, reason: "expired" };
  const seed = openSeed(row.secret_enc);
  const step = seed ? verifyTotp(seed, code) : null;
  if (step === null) return { ok: false, reason: "invalid" };

  // The codes exist before the switch flips, and both land together: on, but
  // with no recovery codes, is the state that locks people out.
  const codes = generateRecoveryCodes();
  const rows = await recoveryRows(userId, codes);
  const enabled = await db.transaction().execute(async (trx) => {
    // Conditional on still being pending, so two confirmations cannot both win.
    const claimed = await trx
      .updateTable("user_two_factor")
      .set({ enabled_at: nowIso(), last_used_step: step })
      .where("user_id", "=", userId)
      .where("enabled_at", "is", null)
      .executeTakeFirst();
    if (rowCount(claimed) === 0) return false;
    await trx.deleteFrom("user_recovery_codes").where("user_id", "=", userId).execute();
    await trx.insertInto("user_recovery_codes").values(rows).execute();
    return true;
  });
  return enabled ? { ok: true, recoveryCodes: codes } : { ok: false, reason: "none" };
}

/**
 * The stored rows for a set of codes. One hash at a time: each scrypt holds
 * 16 MB while it runs, and ten at once is a spike a small server notices.
 */
async function recoveryRows(userId: string, codes: string[]) {
  const now = nowIso();
  const rows = [];
  for (const code of codes) {
    rows.push({ id: generateId(), user_id: userId, code_hash: await hashRecoveryCode(code), used_at: null, created_at: now });
  }
  return rows;
}

/** Everything of it: seed, codes, remembered devices, sign-ins in progress. */
export async function disableTwoFactor(userId: string): Promise<boolean> {
  const db = await getDb();
  const removed = await db.transaction().execute(async (trx) => {
    const row = await trx.deleteFrom("user_two_factor").where("user_id", "=", userId).executeTakeFirst();
    await trx.deleteFrom("user_recovery_codes").where("user_id", "=", userId).execute();
    await trx.deleteFrom("trusted_devices").where("user_id", "=", userId).execute();
    await trx.deleteFrom("login_challenges").where("user_id", "=", userId).execute();
    return rowCount(row) > 0;
  });
  return removed;
}

/** Ten new codes; every earlier one, used or not, stops working. */
export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const rows = await recoveryRows(userId, codes);
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("user_recovery_codes").where("user_id", "=", userId).execute();
    await trx.insertInto("user_recovery_codes").values(rows).execute();
  });
  return codes;
}

// --- checking a code --------------------------------------------------------------

export type SecondFactorResult =
  | { ok: true; method: "totp" }
  | { ok: true; method: "recovery"; recoveryCodesLeft: number }
  | { ok: false };

/**
 * A six-digit code from the app, or a recovery code — whichever the input
 * looks like. Both are spent here: the TOTP step by a conditional update on
 * `last_used_step`, the recovery code by one on `used_at`, so the same code
 * sent twice at once opens one sign-in, not two.
 */
export async function verifySecondFactor(userId: string, raw: unknown): Promise<SecondFactorResult> {
  if (typeof raw !== "string" || raw.length > 64) return { ok: false };
  const db = await getDb();
  const row = await db
    .selectFrom("user_two_factor")
    .select(["secret_enc", "enabled_at", "last_used_step"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row?.enabled_at) return { ok: false };

  if (normalizeTotpCode(raw)) {
    const seed = openSeed(row.secret_enc);
    const step = seed ? verifyTotp(seed, raw, { lastUsedStep: row.last_used_step }) : null;
    if (step === null) return { ok: false };
    const claimed = await db
      .updateTable("user_two_factor")
      .set({ last_used_step: step })
      .where("user_id", "=", userId)
      .where((eb) => eb.or([eb("last_used_step", "is", null), eb("last_used_step", "<", step)]))
      .executeTakeFirst();
    return rowCount(claimed) > 0 ? { ok: true, method: "totp" } : { ok: false };
  }

  if (!normalizeRecoveryCode(raw)) return { ok: false };
  const codes = await db
    .selectFrom("user_recovery_codes")
    .select(["id", "code_hash"])
    .where("user_id", "=", userId)
    .where("used_at", "is", null)
    .execute();
  let matched: string | null = null;
  for (const code of codes) {
    if (await recoveryCodeMatches(raw, code.code_hash)) {
      matched = code.id;
      break;
    }
  }
  if (!matched) return { ok: false };
  const claimed = await db
    .updateTable("user_recovery_codes")
    .set({ used_at: nowIso() })
    .where("id", "=", matched)
    .where("used_at", "is", null)
    .executeTakeFirst();
  if (rowCount(claimed) === 0) return { ok: false };
  return { ok: true, method: "recovery", recoveryCodesLeft: codes.length - 1 };
}

// --- how many codes may be tried ----------------------------------------------------

/**
 * Per account, and across everything that takes a code: the sign-in, turning
 * it off, regenerating the recovery codes. Six digits are a million values and
 * the window accepts three of them, so the count is what keeps guessing
 * pointless. A quarter hour for typos, a day for patience: twenty wrong codes
 * a day, three valid values each, is one chance in about seventeen thousand of
 * a hit per day — after the password was already right — and every failure is
 * in the activity log.
 *
 * `login:` like the other sign-in limits, so `scripts/reset-owner.mjs` clears
 * them together.
 */
const CODE_LIMITS = [
  { key: (userId: string) => `login:2fa:${userId}`, limit: 5, windowMs: 15 * 60 * 1000 },
  { key: (userId: string) => `login:2fa-day:${userId}`, limit: 20, windowMs: 24 * 60 * 60 * 1000 },
];

/** Count one try at a code. When refused, the seconds until another is allowed. */
export async function consumeCodeAttempt(userId: string): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  for (const bucket of CODE_LIMITS) {
    const result = await consumeRateLimit(bucket.key(userId), bucket.limit, bucket.windowMs);
    if (!result.allowed) return { allowed: false, retryAfter: result.retryAfter };
  }
  return { allowed: true };
}

/** A right code forgives the typos before it, and does not count towards the day. */
export async function forgiveCodeAttempts(userId: string): Promise<void> {
  await clearRateLimit(CODE_LIMITS[0].key(userId));
  await refundRateLimit(CODE_LIMITS[1].key(userId));
}

// --- the sign-in halfway through ----------------------------------------------------

/**
 * The password was right and a code is due: a token for the page to send back
 * with it. Kept apart from sessions on purpose — nothing that reads a session
 * can mistake one of these for being signed in.
 */
export async function issueLoginChallenge(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const db = await getDb();
  await db.deleteFrom("login_challenges").where("expires_at", "<", new Date(now).toISOString()).execute();
  await db
    .insertInto("login_challenges")
    .values({
      id: generateId(),
      user_id: userId,
      token_hash: hashToken(token),
      attempts: 0,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + CHALLENGE_TTL_MS).toISOString(),
    })
    .execute();
  return token;
}

/** The challenge a token names, while it is live and has tries left; its account must still be allowed in. */
export async function readLoginChallenge(token: unknown): Promise<{ id: string; userId: string } | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 128) return null;
  const db = await getDb();
  const row = await db
    .selectFrom("login_challenges")
    .innerJoin("users", "users.id", "login_challenges.user_id")
    .select(["login_challenges.id", "login_challenges.user_id", "login_challenges.attempts", "login_challenges.expires_at", "users.disabled"])
    .where("login_challenges.token_hash", "=", hashToken(token))
    .executeTakeFirst();
  if (!row || row.disabled === 1) return null;
  if (new Date(row.expires_at).getTime() < Date.now() || row.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    await db.deleteFrom("login_challenges").where("id", "=", row.id).execute();
    return null;
  }
  return { id: row.id, userId: row.user_id };
}

/** One more wrong code; the challenge is dropped when it has none left. */
export async function recordChallengeFailure(id: string): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("login_challenges")
    .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
    .where("id", "=", id)
    .execute();
  await db.deleteFrom("login_challenges").where("id", "=", id).where("attempts", ">=", CHALLENGE_MAX_ATTEMPTS).execute();
}

/** Spend it. False when another request already did. */
export async function claimLoginChallenge(id: string): Promise<boolean> {
  const db = await getDb();
  return rowCount(await db.deleteFrom("login_challenges").where("id", "=", id).executeTakeFirst()) > 0;
}

// --- remembered devices ----------------------------------------------------------------

async function cookieSecure(): Promise<boolean> {
  const requestHeaders = await headers();
  return sessionCookieSecure({
    production: process.env.NODE_ENV === "production",
    origin: requestHeaders.get("origin"),
    forwardedProto: requestHeaders.get("x-forwarded-proto"),
  });
}

/**
 * Whether this browser was remembered for this account, and still is.
 *
 * The cookie is a random token whose hash is a row: bound to one account (a
 * cookie left by someone else on a shared browser skips nothing for you), with
 * an expiry of its own, and revocable from the server, which a signed cookie
 * on its own would not be.
 */
export async function isRememberedDevice(userId: string): Promise<boolean> {
  const token = (await cookies()).get(DEVICE_COOKIE)?.value;
  if (!token || token.length > 128) return false;
  const db = await getDb();
  const row = await db
    .selectFrom("trusted_devices")
    .select(["id", "user_id", "expires_at"])
    .where("token_hash", "=", hashToken(token))
    .executeTakeFirst();
  if (!row || row.user_id !== userId || new Date(row.expires_at).getTime() < Date.now()) return false;
  await db.updateTable("trusted_devices").set({ last_used_at: nowIso() }).where("id", "=", row.id).execute();
  return true;
}

export async function rememberDevice(userId: string, meta: { userAgent?: string; ip?: string }): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const db = await getDb();
  await db.deleteFrom("trusted_devices").where("expires_at", "<", new Date(now).toISOString()).execute();
  await db
    .insertInto("trusted_devices")
    .values({
      id: generateId(),
      user_id: userId,
      token_hash: hashToken(token),
      user_agent: meta.userAgent?.slice(0, 255) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
      created_at: new Date(now).toISOString(),
      last_used_at: null,
      expires_at: new Date(now + DEVICE_DAYS * 86_400_000).toISOString(),
    })
    .execute();

  const rows = await db
    .selectFrom("trusted_devices")
    .select("id")
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .execute();
  const surplus = rows.slice(MAX_DEVICES_PER_USER).map((row) => row.id);
  if (surplus.length > 0) await db.deleteFrom("trusted_devices").where("id", "in", surplus).execute();

  (await cookies()).set(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: await cookieSecure(),
    maxAge: DEVICE_DAYS * 86_400,
    path: DEVICE_PATH,
  });
}

/** Every remembered browser of an account asks for the code again. */
export async function forgetTrustedDevices(userId: string): Promise<number> {
  const db = await getDb();
  return rowCount(await db.deleteFrom("trusted_devices").where("user_id", "=", userId).executeTakeFirst());
}
