import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { runVisible } from "@/lib/backup-access";
import { getDb } from "@/lib/db";
import { readFirstCopy, runArchiveFileName } from "@/services/backup/copies";
import { archiveContentType, assertBackupId } from "@/services/backup/paths";

type Params = { params: Promise<{ runId: string }> };

/**
 * Hand the archive to the browser.
 *
 * This is the one endpoint that turns an identifier from the outside world into
 * a file read, so it is deliberately narrow: the id is shape-checked, the path
 * is never taken from the request but looked up from the run's own row, and the
 * destination resolves it with a containment check of its own. A client cannot
 * name a path here even if it wants to.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const { runId } = await params;

  if (!(await runVisible(denied.principal, runId))) return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
  try {
    assertBackupId(runId);
  } catch {
    return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
  }

  const db = await getDb();
  const run = await db
    .selectFrom("backup_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();

  if (!run?.archive_path) {
    return NextResponse.json({ error: "Questo backup non ha un archivio" }, { status: 404 });
  }

  try {
    // The first copy that answers, the ones on this disk first: a bucket that
    // is down does not stop the download of the copy on the disk.
    const { stream, bytes } = await readFirstCopy(run.id, async ({ copy, destination, bytes }) => ({
      stream: await destination.open(copy.ref as string),
      bytes,
    }));
    // Named from the run rather than from the ref: a ref is the destination's
    // business, and not every destination's is a file name.
    const fileName = runArchiveFileName(run);

    // Served as stored: an encrypted archive leaves encrypted, a copy kept
    // elsewhere is exactly what the password is for.
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": archiveContentType(fileName),
        "Content-Length": String(bytes || run.archive_bytes || 0),
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        // The archive's own digest, so a download can be checked without
        // trusting the transfer.
        ...(run.checksum ? { "X-Checksum-Sha256": run.checksum } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Archivio non leggibile";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
