import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { backupIdSchema } from "@/lib/validation";
import { readBodyCapped } from "@/lib/read-body";
import { UPLOAD_CHUNK_BYTES, UploadError, appendChunk } from "@/services/backup/uploads";

type Params = { params: Promise<{ uploadId: string }> };

/**
 * One piece of an archive: the raw bytes, `?offset=` where they go and
 * `?length=` how many were sent.
 *
 * The length is compared with what arrived because a body cut short in a
 * proxy arrives without an error, and an archive with a hole in the middle
 * would only fail when it is checked, after the whole upload.
 *
 * Not audited piece by piece: announcing the upload and finishing it are.
 * Browser only — kept away from API clients in `services/mcp/panel-api.ts`.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;

  const { uploadId } = await params;
  if (!backupIdSchema.safeParse(uploadId).success) {
    return NextResponse.json({ error: "Caricamento non trovato" }, { status: 404 });
  }

  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset"));
  const length = Number(url.searchParams.get("length"));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
    return NextResponse.json({ error: "Servono offset e length" }, { status: 400 });
  }

  const chunk = await readBodyCapped(request, UPLOAD_CHUNK_BYTES);
  if (!chunk) return NextResponse.json({ error: "Pezzo troppo grande" }, { status: 413 });
  if (chunk.length !== length) {
    return NextResponse.json(
      { error: `Arrivati ${chunk.length} byte invece di ${length}: un proxy ha tagliato la richiesta. Riprova.` },
      { status: 400 }
    );
  }

  try {
    const upload = await appendChunk(uploadId, offset, chunk);
    return NextResponse.json({ received: upload.received, bytes: upload.bytes });
  } catch (err) {
    if (err instanceof UploadError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
