import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";
import { backupPasswordAttemptSchema } from "@/lib/validation";
import { checkBackupPassword } from "@/services/backup/keyring";

/**
 * "Is this the backup password?" — answered yes or no, never by showing it.
 *
 * The day the password is needed is the day the server is gone; this is how
 * the owner makes sure, while the panel can still tell them, that the copy
 * they keep is the right one. Owner only, like setting it.
 *
 * Limited, because the answer is quick: a stolen session must not turn this
 * into a fast way to learn a password that also opens the copies in a bucket.
 */
const LIMIT_KEY = "backup-password-check";
const ATTEMPTS = 10;
const WINDOW_MS = 15 * 60_000;

export async function POST(request: NextRequest) {
  return withAudit(request, { category: "backup", action: "backup.encryption.check", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    const limit = await consumeRateLimit(LIMIT_KEY, ATTEMPTS, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppi tentativi: riprova tra ${Math.max(1, Math.ceil(limit.retryAfter / 60))} minuti` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = backupPasswordAttemptSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi" }, { status: 400 });
    }

    const matches = await checkBackupPassword(parsed.data.password);
    if (matches === null) {
      return NextResponse.json({ error: "La cifratura dei backup non è attiva: non c'è una password da verificare" }, { status: 409 });
    }
    // Typos are not held against whoever got it right in the end.
    if (matches) await clearRateLimit(LIMIT_KEY);
    return NextResponse.json({ matches });
  });
}
