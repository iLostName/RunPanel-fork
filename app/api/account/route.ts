import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { createSession, destroyUserSessions, isClusterSession, isFreshSession, verifyPassword } from "@/lib/auth";
import { trustedClientIp } from "@/lib/client-ip";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";
import { getUser, normalizeEmail, setOwnEmail, setOwnPassword } from "@/lib/users";
import { forgetTrustedDevices } from "@/lib/two-factor";

/**
 * One's own account: email and password.
 *
 * Reachable by the migrated owner who has no email yet — this is where they
 * set it. Both changes need the current password: a session left open on a
 * shared machine must not be enough to take the account over.
 *
 * An account that signs in only with GitHub has no current password to give.
 * It may choose its first one with a session opened in the last ten minutes
 * instead — a sign-in that just went through GitHub and every step the
 * account asks for, which is what typing a password proves — and from a
 * browser only.
 */

/** The same guess the login form caps, tried from a session: counted per account. */
const MAX_PASSWORD_ATTEMPTS = 5;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;
/** How recent a sign-in stands in for the current password, for a first password. */
const FRESH_SIGN_IN_MS = 10 * 60 * 1000;

export async function GET() {
  const ctx = await requireUser({ allowMissingEmail: true });
  if (isDenied(ctx)) return ctx;
  const user = await getUser(ctx.session.user.id);
  return NextResponse.json(
    {
      id: user?.id,
      email: user?.email ?? null,
      isOwner: user?.is_owner === 1,
      createdAt: user?.created_at,
      // False for an account that signs in only with GitHub.
      hasPassword: Boolean(user?.password_hash),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function PATCH(request: NextRequest) {
  const ctx = await requireUser({ allowMissingEmail: true });
  if (isDenied(ctx)) return ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const { currentPassword, email, newPassword } = (body ?? {}) as {
    currentPassword?: unknown;
    email?: unknown;
    newPassword?: unknown;
  };

  const user = await getUser(ctx.session.user.id);
  if (!user) return NextResponse.json({ error: "Account non trovato" }, { status: 404 });
  if (!user.password_hash) return firstPassword(request, ctx.session.sessionId, Boolean(ctx.session.apiToken), user.id, email, newPassword);

  const attemptsKey = `account:pw:${user.id}`;
  const limit = await consumeRateLimit(attemptsKey, MAX_PASSWORD_ATTEMPTS, PASSWORD_WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Troppi tentativi. Riprova tra ${Math.ceil(limit.retryAfter / 60)} minuti.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }
  if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, user.password_hash))) {
    await audit({ userId: user.id, category: "security", action: "account.password.failed", scope: "user", scopeId: user.id, request });
    return NextResponse.json({ error: "Password attuale errata" }, { status: 401 });
  }
  await clearRateLimit(attemptsKey);

  if (email !== undefined) {
    const normalized = normalizeEmail(email);
    if (!normalized) return NextResponse.json({ error: "Email non valida" }, { status: 400 });
    if ((await setOwnEmail(user.id, normalized)) === "taken") {
      return NextResponse.json({ error: "Email già usata da un altro account" }, { status: 409 });
    }
    await audit({ userId: user.id, category: "security", action: "account.email", scope: "user", scopeId: user.id, request });
  }

  if (newPassword !== undefined) {
    if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
      return NextResponse.json({ error: "La nuova password deve avere tra 8 e 128 caratteri" }, { status: 400 });
    }
    await setOwnPassword(user.id, newPassword);
    await audit({ userId: user.id, category: "security", action: "account.password", scope: "user", scopeId: user.id, request });
    // Changing the password ends every other device's session — that is the
    // usual reason for changing it. The current one is then re-issued so the
    // person doing it is not thrown out of the page they are on. The browsers
    // remembered for two-step sign-in ask for the code again, for the same reason.
    await destroyUserSessions(user.id);
    await forgetTrustedDevices(user.id);
    await createSession(user.id, {
      userAgent: request.headers.get("user-agent") ?? undefined,
      ip: trustedClientIp(request) ?? undefined,
    });
    return NextResponse.json({ success: true, signedOutOtherDevices: true });
  }

  return NextResponse.json({ success: true });
}

/**
 * The first password of an account that signs in only with GitHub. With it the
 * account no longer depends on GitHub sign-in staying on: the owner can turn
 * it off, and the account can unlink GitHub.
 */
async function firstPassword(
  request: NextRequest,
  sessionId: string,
  viaToken: boolean,
  userId: string,
  email: unknown,
  newPassword: unknown
): Promise<NextResponse> {
  if (email !== undefined) {
    return NextResponse.json({ error: "Imposta prima una password: serve anche per cambiare email" }, { status: 400 });
  }
  if (newPassword === undefined) return NextResponse.json({ error: "Account non trovato" }, { status: 404 });
  if (viaToken || isClusterSession(sessionId) || !(await isFreshSession(sessionId, FRESH_SIGN_IN_MS))) {
    return NextResponse.json(
      {
        error: "Per sicurezza entra di nuovo con GitHub: per dieci minuti dopo l'accesso potrai scegliere la password.",
        code: "reauth_required",
      },
      { status: 403 }
    );
  }
  if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
    return NextResponse.json({ error: "La nuova password deve avere tra 8 e 128 caratteri" }, { status: 400 });
  }

  await setOwnPassword(userId, newPassword);
  await audit({
    userId,
    category: "security",
    action: "account.password",
    scope: "user",
    scopeId: userId,
    detail: "prima password, dopo l'accesso con GitHub",
    request,
  });
  await destroyUserSessions(userId);
  await forgetTrustedDevices(userId);
  await createSession(userId, {
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip: trustedClientIp(request) ?? undefined,
  });
  return NextResponse.json({ success: true, signedOutOtherDevices: true });
}
