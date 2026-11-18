import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { consumeRateLimit } from "@/lib/rate-limit";
import { telegramLoginStartSchema } from "@/lib/validation";
import { destinationConfig } from "@/services/backup/destinations";
import { TelegramFailure, classifyTelegramError } from "@/services/backup/destinations/telegram";
import { startTelegramLogin } from "@/services/backup/telegram-login";

/**
 * Start linking a Telegram account for a backup destination: a QR code to
 * scan from the app, or a code sent to the phone. The login then goes on at
 * `…/login/{loginId}`, and its result is used by creating the destination
 * (`config.loginId`) or by re-linking one (PATCH with `config.loginId`).
 *
 * Whoever may add a destination may link an account, as for S3; re-linking an
 * existing destination takes the owner, like changing where it writes. The
 * api_id and api_hash are the account's own — the panel ships none — and a
 * re-link may leave them out to keep the stored ones.
 *
 * Limited per account: every start is a request to Telegram's login, and an
 * account that asks for too many codes is locked out by Telegram for hours.
 */
const ATTEMPTS = 10;
const WINDOW_MS = 15 * 60_000;

export async function POST(request: NextRequest) {
  return withAudit(request, { category: "backup", action: "backup.destination.telegram.login", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = telegramLoginStartSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    let { apiId, apiHash } = parsed.data;
    if (parsed.data.destinationId) {
      const owner = await requireOwner();
      if (isDenied(owner)) return owner;
      const db = await getDb();
      const row = await db
        .selectFrom("backup_destinations")
        .selectAll()
        .where("id", "=", parsed.data.destinationId)
        .executeTakeFirst();
      if (!row) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });
      if (row.type !== "telegram") return NextResponse.json({ error: "Non è una destinazione Telegram" }, { status: 400 });
      const stored = destinationConfig(row);
      apiId ??= typeof stored.apiId === "number" ? stored.apiId : undefined;
      apiHash ??= typeof stored.apiHash === "string" && stored.apiHash ? stored.apiHash : undefined;
    }
    if (apiId === undefined || apiHash === undefined) {
      return NextResponse.json({ error: "Servono api_id e api_hash" }, { status: 400 });
    }

    const limit = await consumeRateLimit(`telegram-login:${denied.principal.userId}`, ATTEMPTS, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppi collegamenti a Telegram in poco tempo: riprova tra ${Math.max(1, Math.ceil(limit.retryAfter / 60))} minuti` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }

    try {
      const login = await startTelegramLogin({
        userId: denied.principal.userId,
        apiId,
        apiHash: apiHash.toLowerCase(),
        method: parsed.data.method,
        phone: parsed.data.phone,
      });
      return NextResponse.json(login, { status: 201 });
    } catch (err) {
      const failure = err instanceof TelegramFailure ? err : new TelegramFailure(err instanceof Error ? err.message : String(err));
      const kind = classifyTelegramError(err).kind;
      // Telegram unreachable is not the request's fault; a wrong api_hash or number is.
      const status = kind === "network" || kind === "timeout" || kind === "transient" ? 502 : 400;
      return NextResponse.json({ error: failure.message, code: failure.code }, { status });
    }
  });
}
