import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How a receiver knows a webhook came from this panel, and came just now.
 *
 * The scheme is the one Stripe and Slack use, because it is the one people
 * already know how to check: the panel signs `<timestamp>.<raw body>` with
 * HMAC-SHA256 under the channel's secret and sends the timestamp and the
 * signature in two headers. A receiver recomputes the HMAC over the bytes it
 * received, compares in constant time, and refuses a timestamp more than five
 * minutes from its own clock — which is what stops a captured request being
 * played back later, since changing the timestamp breaks the signature.
 *
 * The signature carries a version (`v1=`), so the scheme can change without a
 * receiver mistaking a new signature for a forged old one.
 *
 * Only `node:crypto` is imported: the unit suite loads this file directly, and
 * the notifications page of the docs (English and Italian) describes exactly
 * what is here.
 */

export const WEBHOOK_HEADERS = {
  event: "X-RunPanel-Event",
  delivery: "X-RunPanel-Delivery",
  timestamp: "X-RunPanel-Timestamp",
  signature: "X-RunPanel-Signature",
} as const;

export const SIGNATURE_VERSION = "v1";

/** How far a receiver should let the timestamp drift from its own clock, either way. */
export const REPLAY_WINDOW_SECONDS = 300;

/** What is signed: the timestamp, a dot, and the body exactly as sent. */
export function signedContent(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(signedContent(timestamp, body), "utf8").digest("hex");
  return `${SIGNATURE_VERSION}=${mac}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

/**
 * The receiver's side, kept here so the tests hold the panel to what the
 * documentation tells people to write.
 *
 * The signature header may list several `v1=` values separated by commas — a
 * receiver that accepts any of them can rotate secrets without a gap.
 */
export function verifyWebhook(
  secret: string,
  headers: { timestamp: string | null | undefined; signature: string | null | undefined },
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = REPLAY_WINDOW_SECONDS
): VerifyResult {
  if (!headers.timestamp || !headers.signature) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(headers.timestamp)) return { ok: false, reason: "malformed" };

  const timestamp = Number(headers.timestamp);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: "stale" };

  const expected = Buffer.from(signWebhook(secret, timestamp, body), "utf8");
  const candidates = headers.signature
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNATURE_VERSION}=`));
  if (candidates.length === 0) return { ok: false, reason: "malformed" };

  for (const candidate of candidates) {
    const given = Buffer.from(candidate, "utf8");
    // Lengths first: timingSafeEqual throws on a mismatch, and the length of a
    // hex digest is not a secret.
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}
