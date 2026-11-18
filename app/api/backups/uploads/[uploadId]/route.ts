import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { backupIdSchema } from "@/lib/validation";
import {
  UploadError,
  deleteUpload,
  finishUpload,
  readUpload,
  resumeInterruptedChecks,
} from "@/services/backup/uploads";

type Params = { params: Promise<{ uploadId: string }> };

async function uploadId(params: Params["params"]): Promise<string | null> {
  const { uploadId } = await params;
  return backupIdSchema.safeParse(uploadId).success ? uploadId : null;
}

/** Where an upload is: arriving, being checked, ready, or refused and why. Polled by the page. */
export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;

  const id = await uploadId(params);
  const upload = id ? readUpload(id) : null;
  if (!upload) return NextResponse.json({ error: "Caricamento non trovato" }, { status: 404 });
  if (upload.status === "checking") resumeInterruptedChecks();
  return NextResponse.json({ upload });
}

/**
 * Every piece is in: the archive is checked whole in the background — a
 * RunPanel manifest, every member's CRC, sha256 and gzip stream.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.upload.finish", scope: "permission", scopeId: "restore" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    const id = await uploadId(params);
    if (!id) return NextResponse.json({ error: "Caricamento non trovato" }, { status: 404 });
    try {
      return NextResponse.json({ upload: finishUpload(id) }, { status: 202 });
    } catch (err) {
      if (err instanceof UploadError) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
  });
}

/** Throw an upload away: half-arrived, refused, or no longer needed. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.upload.delete", scope: "permission", scopeId: "restore" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    const id = await uploadId(params);
    if (!id || !deleteUpload(id)) return NextResponse.json({ error: "Caricamento non trovato" }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
