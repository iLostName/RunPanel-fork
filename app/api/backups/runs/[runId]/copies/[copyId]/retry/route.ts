import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { runVisible } from "@/lib/backup-access";
import { withAudit } from "@/lib/audit";
import { CopyRetryError, startCopyRetry } from "@/services/backup/copies";
import { assertBackupId } from "@/services/backup/paths";

type Params = { params: Promise<{ runId: string; copyId: string }> };

/**
 * "Riprova la copia": send a copy that did not arrive again, from another
 * copy of the same archive, checked against the sha256 the backup recorded.
 *
 * Answers at once with the copy on its way: an upload takes minutes. The run
 * page follows it through `GET /api/backups/runs/{runId}`, and the run's log
 * says what happened.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.copy.retry", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    const { runId, copyId } = await params;
    try {
      assertBackupId(runId);
      assertBackupId(copyId);
    } catch {
      return NextResponse.json({ error: "Copia non trovata" }, { status: 404 });
    }
    if (!(await runVisible(denied.principal, runId))) {
      return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
    }

    try {
      const copy = await startCopyRetry(runId, copyId);
      return NextResponse.json(
        { copy: { id: copy.id, destinationId: copy.destination_id, destinationName: copy.name, status: copy.status } },
        { status: 202 }
      );
    } catch (err) {
      if (err instanceof CopyRetryError) return NextResponse.json({ error: err.message }, { status: err.status });
      return NextResponse.json({ error: err instanceof Error ? err.message : "Copia non avviata" }, { status: 500 });
    }
  });
}
