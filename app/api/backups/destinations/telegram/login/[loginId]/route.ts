import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { consumeRateLimit } from "@/lib/rate-limit";
import { telegramLoginStepSchema } from "@/lib/validation";
import { cancelTelegramLogin, submitTelegramLogin, telegramLoginStatus } from "@/services/backup/telegram-login";

type Params = { params: Promise<{ loginId: string }> };

/**
 * A Telegram login under way, as the form polls it: which step, the QR code
 * to draw (renewed here before it expires), the password hint, and when it
 * is done the account linked — never the session, which stays on the server
 * until the destination is saved.
 *
 * A login belongs to whoever started it: anyone else gets the same 404 as an
 * expired one.
 */
const GONE = "Collegamento a Telegram scaduto o annullato: ricomincia.";

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;
  const { loginId } = await params;
  const login = await telegramLoginStatus(loginId, denied.principal.userId);
  if (!login) return NextResponse.json({ error: GONE }, { status: 404 });
  return NextResponse.json(login);
}

/** The code Telegram sent, or the account's two-step password. A wrong one keeps the step, with the reason. */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.destination.telegram.step", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = telegramLoginStepSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    // Each login allows five wrong answers; this keeps a stolen session from
    // starting login after login to guess more.
    const limit = await consumeRateLimit(`telegram-login-step:${denied.principal.userId}`, 20, 15 * 60_000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppi tentativi: riprova tra ${Math.max(1, Math.ceil(limit.retryAfter / 60))} minuti` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }

    const { loginId } = await params;
    const login = await submitTelegramLogin(loginId, denied.principal.userId, parsed.data);
    if (!login) return NextResponse.json({ error: GONE }, { status: 404 });
    return NextResponse.json(login);
  });
}

/** Give up: a login that had already worked is logged out at Telegram, not left among the account's devices. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.destination.telegram.cancel", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;
    const { loginId } = await params;
    const cancelled = await cancelTelegramLogin(loginId, denied.principal.userId);
    return NextResponse.json({ ok: true, cancelled });
  });
}
