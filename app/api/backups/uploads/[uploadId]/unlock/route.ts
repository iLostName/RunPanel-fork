import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";
import { backupIdSchema, backupPasswordAttemptSchema } from "@/lib/validation";
import { UploadError, unlockUpload } from "@/services/backup/uploads";

type Params = { params: Promise<{ uploadId: string }> };

/** Each try costs a scrypt already; this keeps a script from queueing thousands. */
const ATTEMPTS = 10;
const WINDOW_MS = 15 * 60_000;

/**
 * The password of an uploaded archive that is encrypted with one this panel
 * does not have — a backup from another server. A wrong one is a 400 here,
 * tried against the archive's own header; the right one starts the check, and
 * the restore that follows uses it too.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.upload.unlock", scope: "permission", scopeId: "restore" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    const { uploadId } = await params;
    if (!backupIdSchema.safeParse(uploadId).success) {
      return NextResponse.json({ error: "Caricamento non trovato" }, { status: 404 });
    }

    const limitKey = `backup-upload-unlock:${uploadId}`;
    const limit = await consumeRateLimit(limitKey, ATTEMPTS, WINDOW_MS);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Troppi tentativi per questo archivio: riprova tra ${Math.max(1, Math.ceil(limit.retryAfter / 60))} minuti` },
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

    try {
      const upload = await unlockUpload(uploadId, parsed.data.password);
      await clearRateLimit(limitKey);
      return NextResponse.json({ upload }, { status: 202 });
    } catch (err) {
      if (err instanceof UploadError) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
  });
}
