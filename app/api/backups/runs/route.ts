import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner, requirePermission } from "@/lib/auth-guard";
import { visiblePolicyIds } from "@/lib/backup-access";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { manualBackupSchema } from "@/lib/validation";
import { backupOverview, listRuns } from "@/services/backup/catalog";
import { defaultDestinationId } from "@/services/backup/destinations";
import { BackupBusyError, activeBackupRunId, startBackup } from "@/services/backup/runner";

export async function GET(request: NextRequest) {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const url = new URL(request.url);
  const policyId = url.searchParams.get("policyId") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  const [allRuns, overview, visible] = await Promise.all([
    listRuns(limit, policyId),
    backupOverview(),
    visiblePolicyIds(denied.principal),
  ]);
  // A run with no policy, or of a policy they cannot see, is the owner's.
  const runs = allRuns.filter((run) => visible === "all" || (run.policyId !== null && visible.has(run.policyId)));

  return NextResponse.json({
    runs,
    overview,
    // The page polls this endpoint anyway, so it is also how it learns a run is
    // in flight without a second request.
    activeRunId: activeBackupRunId(),
  });
}

/**
 * A backup now, of exactly what is named, outside any schedule — "Esegui
 * backup ora" on a database's page.
 *
 * Owner only. A run with no policy belongs to the owner (see
 * `runVisible`), so anyone else would start a backup they could then neither
 * follow nor restore; they run a policy of their own instead. Kept by hand:
 * with no policy there is no retention to remove it.
 */
export async function POST(request: NextRequest) {
  return withAudit(request, { category: "backup", action: "backup.run", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = manualBackupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const destinationId = parsed.data.destinationId ?? (await defaultDestinationId());
    if (!destinationId) return NextResponse.json({ error: "Nessuna destinazione configurata" }, { status: 400 });
    const db = await getDb();
    const destination = await db.selectFrom("backup_destinations").select("id").where("id", "=", destinationId).executeTakeFirst();
    if (!destination) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });

    try {
      const { runId, done } = await startBackup({
        trigger: "manual",
        targets: parsed.data.targets,
        destinationId,
        policyName: parsed.data.name ?? null,
      });
      // Recorded on the run row by the runner; this only stops Node treating
      // the rejection as unhandled.
      void done.catch(() => {});
      return NextResponse.json({ runId }, { status: 202 });
    } catch (err) {
      if (err instanceof BackupBusyError) return NextResponse.json({ error: err.message }, { status: 409 });
      return NextResponse.json({ error: err instanceof Error ? err.message : "Avvio del backup fallito" }, { status: 500 });
    }
  });
}
