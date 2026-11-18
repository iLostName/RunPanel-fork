import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { runVisible } from "@/lib/backup-access";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { getRunDetail } from "@/services/backup/catalog";
import { removeCopy, runCopies, syncRunArchive } from "@/services/backup/copies";
import { assertBackupId, backupLogPath } from "@/services/backup/paths";
import { activeBackupRunId } from "@/services/backup/runner";
import { removeLogFile } from "@/services/log-file";

type Params = { params: Promise<{ runId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const { runId } = await params;

  if (!(await runVisible(denied.principal, runId))) return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
  // Shape-checked before it is used anywhere, including as a log path.
  try {
    assertBackupId(runId);
  } catch {
    return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
  }

  const detail = await getRunDetail(runId);
  if (!detail) return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });

  return NextResponse.json(detail);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  return withAudit(_request, { category: "backup", action: "backup.run.delete", scope: "permission", scopeId: "backup" }, async () => {
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

    if (!run) return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
    const copies = await runCopies(runId);
    if (run.status === "running" || activeBackupRunId() === runId || copies.some((copy) => copy.status === "uploading")) {
      return NextResponse.json(
        { error: "Il backup è ancora in corso: attendi che finisca" },
        { status: 409 }
      );
    }

    // Every copy, each file before its row: a row removed while its file
    // survives leaves something that nothing knows about or will ever clean
    // up. A copy that will not go keeps its row, and so does the run.
    const refused: string[] = [];
    for (const copy of copies) {
      const removed = await removeCopy(copy);
      if (!removed.ok) refused.push(`«${copy.name}»: ${removed.error}`);
    }
    if (refused.length > 0) {
      await syncRunArchive(runId);
      return NextResponse.json(
        {
          error:
            refused.length === copies.length
              ? `Non sono riuscito a cancellare l'archivio. ${refused.join(" ")}`
              : `Non sono riuscito a cancellare ${refused.length === 1 ? "una copia" : `${refused.length} copie`}, le altre sono state cancellate: ${refused.join(" ")} Il backup resta finché non riprovi.`,
        },
        { status: 500 }
      );
    }

    await db.deleteFrom("backup_runs").where("id", "=", runId).execute();
    removeLogFile(backupLogPath(runId));

    return NextResponse.json({ ok: true });
  });
}
