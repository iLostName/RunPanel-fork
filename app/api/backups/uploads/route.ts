import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { backupUploadSchema } from "@/lib/validation";
import {
  UPLOAD_CHUNK_BYTES,
  UploadError,
  createUpload,
  listUploads,
  resumeInterruptedChecks,
} from "@/services/backup/uploads";

/**
 * Archives brought in from outside, to restore from.
 *
 * Owner only, all of it: restoring from an upload already is (see
 * `restoreProblem` in lib/backup-access.ts), and an upload is a full copy of
 * somebody's data sitting on this disk.
 */
export async function GET() {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;

  resumeInterruptedChecks();
  return NextResponse.json({ uploads: listUploads(), chunkBytes: UPLOAD_CHUNK_BYTES });
}

/** Announce an upload: its name and size. The pieces follow on `/chunk`. */
export async function POST(request: NextRequest) {
  return withAudit(request, { category: "backup", action: "backup.upload", scope: "permission", scopeId: "restore" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = backupUploadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    try {
      const upload = createUpload(parsed.data);
      return NextResponse.json({ upload, chunkBytes: UPLOAD_CHUNK_BYTES }, { status: 201 });
    } catch (err) {
      if (err instanceof UploadError) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
  });
}
