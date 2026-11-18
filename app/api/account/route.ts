import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { createSession, destroyUserSessions, verifyPassword } from "@/lib/auth";
import { trustedClientIp } from "@/lib/client-ip";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";
import { getUser, normalizeEmail, setOwnEmail, setOwnPassword } from "@/lib/users";

/**
 * One's own account: email and password.
 *
 * Reachable by the migrated owner who has no email yet — this is where they
 * set it. Both changes need the current password: a session left open on a
 * shared machine must not be enough to take the account over.
 */

/** The same guess the login form caps, tried from a session: counted per account. */
const MAX_PASSWORD_ATTEMPTS = 5;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;

export async function GET() {
  const ctx = await requireUser({ allowMissingEmail: true });
  if (isDenied(ctx)) return ctx;
  const user = await getUser(ctx.session.user.id);
  return NextResponse.json(
    { id: user?.id, email: user?.email ?? null, isOwner: user?.is_owner === 1, createdAt: user?.created_at },
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
  if (!user?.password_hash) return NextResponse.json({ error: "Account non trovato" }, { status: 404 });

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
    // person doing it is not thrown out of the page they are on.
    await destroyUserSessions(user.id);
    await createSession(user.id, {
      userAgent: request.headers.get("user-agent") ?? undefined,
      ip: trustedClientIp(request) ?? undefined,
    });
    return NextResponse.json({ success: true, signedOutOtherDevices: true });
  }

  return NextResponse.json({ success: true });
}
