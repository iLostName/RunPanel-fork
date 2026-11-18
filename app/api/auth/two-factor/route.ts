import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDenied, requireUser, type AuthContext } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { isClusterSession, verifyPassword } from "@/lib/auth";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";
import { readBodyCapped } from "@/lib/read-body";
import { refuseCrossOrigin } from "@/lib/request-origin";
import { otpauthUri } from "@/lib/totp";
import {
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  consumeCodeAttempt,
  disableTwoFactor,
  forgetTrustedDevices,
  forgiveCodeAttempts,
  isTwoFactorEnabled,
  replaceRecoveryCodes,
  twoFactorStatus,
  verifySecondFactor,
} from "@/lib/two-factor";
import { getUser } from "@/lib/users";

/**
 * One's own two-step sign-in: see it, turn it on, turn it off, new recovery
 * codes, forget the remembered browsers.
 *
 * Under `/api/auth`, which `proxy.ts` leaves alone, for two reasons: an API
 * token is never accepted here (it is only ever accepted with the proxy's
 * mark), and an MCP tool cannot reach it (`services/mcp/panel-api.ts` blocks
 * the whole prefix). Managing the second factor is for a person in a browser.
 * The cross-origin check the proxy would have made is made here.
 *
 * Anything that changes it asks for the password again, and turning it off
 * for a code as well: a session left open on a shared machine must not be
 * enough to swap the phone that guards the account, or to remove it.
 */

const MAX_BODY_BYTES = 4 * 1024;
const MAX_PASSWORD_ATTEMPTS = 5;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;
const ISSUER = "RunPanel";

const password = z.string().min(1).max(128);
const code = z.string().trim().min(1).max(64);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup"), password }).strict(),
  z.object({ action: z.literal("enable"), code }).strict(),
  z.object({ action: z.literal("disable"), password, code }).strict(),
  z.object({ action: z.literal("recovery-codes"), password }).strict(),
  z.object({ action: z.literal("forget-devices") }).strict(),
]);

function browserOnly(ctx: AuthContext): NextResponse | null {
  if (!ctx.session.apiToken && !isClusterSession(ctx.session.sessionId)) return null;
  return NextResponse.json({ error: "La verifica in due passaggi si gestisce dal pannello, con il browser" }, { status: 403 });
}

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const refused = browserOnly(ctx);
  if (refused) return refused;
  return NextResponse.json(await twoFactorStatus(ctx.session.user.id), { headers: noStore });
}

export async function POST(request: NextRequest) {
  const crossOrigin = refuseCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const refused = browserOnly(ctx);
  if (refused) return refused;

  let body: unknown;
  try {
    const raw = await readBodyCapped(request, MAX_BODY_BYTES);
    if (!raw) return NextResponse.json({ error: "Richiesta troppo grande" }, { status: 413 });
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Dati non validi" }, { status: 400 });

  const userId = ctx.session.user.id;
  const input = parsed.data;

  if (input.action === "setup") {
    const denied = await checkPassword(userId, input.password, request);
    if (denied) return denied;
    const secret = await beginTwoFactorSetup(userId);
    if (!secret) {
      return NextResponse.json({ error: "La verifica in due passaggi è già attiva: disattivala prima di rifarla" }, { status: 409 });
    }
    const account = accountLabel(ctx.session.user.email ?? userId, request);
    // The only answer that ever carries the seed; it is not stored readable anywhere.
    return NextResponse.json({ secret, issuer: ISSUER, account, uri: otpauthUri({ secret, account, issuer: ISSUER }) }, { headers: noStore });
  }

  if (input.action === "enable") {
    const attempt = await consumeCodeAttempt(userId);
    if (!attempt.allowed) return tooManyCodes(attempt.retryAfter);
    const result = await confirmTwoFactorSetup(userId, input.code);
    if (!result.ok) {
      const error =
        result.reason === "invalid"
          ? "Codice non valido: controlla che l'ora del telefono sia giusta e riprova"
          : result.reason === "expired"
            ? "Sono passati più di 30 minuti: ricomincia dalla scansione del codice QR"
            : "Nessuna attivazione in corso: ricomincia";
      return NextResponse.json({ error }, { status: result.reason === "invalid" ? 400 : 409 });
    }
    await forgiveCodeAttempts(userId);
    await audit({ userId, category: "security", action: "account.two-factor.enable", scope: "user", scopeId: userId, request });
    // The codes are shown this once; only their hashes are kept.
    return NextResponse.json({ recoveryCodes: result.recoveryCodes, status: await twoFactorStatus(userId) }, { headers: noStore });
  }

  if (input.action === "disable") {
    if (!(await isTwoFactorEnabled(userId))) return NextResponse.json({ error: "La verifica in due passaggi non è attiva" }, { status: 409 });
    const denied = await checkPassword(userId, input.password, request);
    if (denied) return denied;
    const wrongCode = await checkCode(userId, input.code, request);
    if (wrongCode) return wrongCode;
    await disableTwoFactor(userId);
    await audit({ userId, category: "security", action: "account.two-factor.disable", scope: "user", scopeId: userId, request });
    return NextResponse.json({ status: await twoFactorStatus(userId) });
  }

  if (input.action === "recovery-codes") {
    if (!(await isTwoFactorEnabled(userId))) return NextResponse.json({ error: "La verifica in due passaggi non è attiva" }, { status: 409 });
    const denied = await checkPassword(userId, input.password, request);
    if (denied) return denied;
    const recoveryCodes = await replaceRecoveryCodes(userId);
    await audit({ userId, category: "security", action: "account.two-factor.recovery-codes", scope: "user", scopeId: userId, request });
    return NextResponse.json({ recoveryCodes, status: await twoFactorStatus(userId) }, { headers: noStore });
  }

  const forgotten = await forgetTrustedDevices(userId);
  await audit({
    userId,
    category: "security",
    action: "account.two-factor.devices",
    scope: "user",
    scopeId: userId,
    detail: `${forgotten} dispositivi`,
    request,
  });
  return NextResponse.json({ forgotten, status: await twoFactorStatus(userId) });
}

/** The account password again, with the same per-account limit as `PATCH /api/account`. */
async function checkPassword(userId: string, given: string, request: NextRequest): Promise<NextResponse | null> {
  const user = await getUser(userId);
  if (!user?.password_hash) return NextResponse.json({ error: "Account non trovato" }, { status: 404 });
  const key = `account:pw:${userId}`;
  const limit = await consumeRateLimit(key, MAX_PASSWORD_ATTEMPTS, PASSWORD_WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Troppi tentativi. Riprova tra ${Math.ceil(limit.retryAfter / 60)} minuti.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }
  if (!(await verifyPassword(given, user.password_hash))) {
    await audit({ userId, category: "security", action: "account.password.failed", scope: "user", scopeId: userId, request });
    return NextResponse.json({ error: "Password attuale errata" }, { status: 401 });
  }
  await clearRateLimit(key);
  return null;
}

/** A code from the app or a recovery code, out of the same budget as the sign-in. */
async function checkCode(userId: string, given: string, request: NextRequest): Promise<NextResponse | null> {
  const attempt = await consumeCodeAttempt(userId);
  if (!attempt.allowed) return tooManyCodes(attempt.retryAfter);
  if ((await verifySecondFactor(userId, given)).ok) {
    await forgiveCodeAttempts(userId);
    return null;
  }
  await audit({ userId, category: "security", action: "auth.two-factor.failed", scope: "user", scopeId: userId, request });
  return NextResponse.json({ error: "Codice non valido" }, { status: 401 });
}

function tooManyCodes(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: `Troppi codici sbagliati. Riprova tra ${Math.max(1, Math.ceil(retryAfter / 60))} minuti.` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

/**
 * What the authenticator app lists the entry as: the email, and the address
 * the panel was opened at, so two panels — each asks for its own code — are
 * two entries that can be told apart. Only a plain host name or address goes
 * in; anything else in the header is left out rather than escaped.
 */
function accountLabel(email: string, request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || request.headers.get("host") || "";
  return /^[A-Za-z0-9.\-:[\]]{1,100}$/.test(host) ? `${email} (${host})` : email;
}
