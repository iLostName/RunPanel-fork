import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { backupIdSchema, backupPasswordAttemptSchema } from "@/lib/validation";
import { UploadError, unlockUpload } from "@/services/backup/uploads";

type Params = { params: Promise<{ uploadId: string }> };

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
      return NextResponse.json({ upload: await unlockUpload(uploadId, parsed.data.password) }, { status: 202 });
    } catch (err) {
      if (err instanceof UploadError) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
  });
}
