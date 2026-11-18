import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { canEditUser } from "@/lib/authz";
import { disableTwoFactor, twoFactorStatus } from "@/lib/two-factor";
import { getUser, getUserAccess } from "@/lib/users";

/**
 * Someone else's two-step sign-in, for whoever manages users: whether it is
 * on, and turning it off for a person who lost both the phone and the
 * recovery codes — the other way out of that is a new account.
 *
 * Never the owner's, and never one's own: the owner has
 * `scripts/reset-owner.mjs` on the server, and anyone can turn their own off
 * from the account page with the password and a code. The same rule as every
 * other change to an account decides who may (`canEditUser`).
 */

type Params = { params: Promise<{ userId: string }> };

const notFound = () => NextResponse.json({ error: "Utente non trovato" }, { status: 404 });

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;
  const { userId } = await params;
  if (!(await getUser(userId))) return notFound();
  const status = await twoFactorStatus(userId);
  return NextResponse.json({ enabled: status.enabled, enabledAt: status.enabledAt }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const denied = await requirePermission("users.manage");
  if (isDenied(denied)) return denied;
  const { userId } = await params;

  const target = await getUser(userId);
  if (!target) return notFound();
  if (!canEditUser(denied.principal, { isOwner: target.is_owner === 1, userId, access: await getUserAccess(userId) })) {
    return NextResponse.json({ error: "Questo account non è modificabile da te" }, { status: 403 });
  }
  if (!(await disableTwoFactor(userId))) {
    return NextResponse.json({ error: "La verifica in due passaggi non è attiva per questo account" }, { status: 409 });
  }
  await audit({
    userId: denied.session.user.id,
    category: "security",
    action: "user.two-factor.reset",
    scope: "user",
    scopeId: userId,
    detail: target.email,
    request,
  });
  return NextResponse.json({ success: true });
}
