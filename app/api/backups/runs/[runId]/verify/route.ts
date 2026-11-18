import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { runVisible } from "@/lib/backup-access";
import { withAudit } from "@/lib/audit";
import { assertBackupId } from "@/services/backup/paths";
import { VerifyBusyError, runVerification, startRunVerification } from "@/services/backup/verify";

type Params = { params: Promise<{ runId: string }> };

async function visibleRun(runId: string, principal: Parameters<typeof runVisible>[0]): Promise<boolean> {
  try {
    assertBackupId(runId);
  } catch {
    return false;
  }
  return runVisible(principal, runId);
}

/** The check in progress, or the last one that finished. Polled by the run page while one runs. */
export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const { runId } = await params;
  if (!(await visibleRun(runId, denied.principal))) {
    return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
  }
  return NextResponse.json({ verification: await runVerification(runId) });
}

/**
 * Read the archive back and compare it with what was recorded when it was
 * written. Answers at once with the check under way: an archive is gigabytes.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.run.verify", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    const { runId } = await params;
    if (!(await visibleRun(runId, denied.principal))) {
      return NextResponse.json({ error: "Backup non trovato" }, { status: 404 });
    }

    try {
      return NextResponse.json({ verification: await startRunVerification(runId) }, { status: 202 });
    } catch (err) {
      if (err instanceof VerifyBusyError) return NextResponse.json({ error: err.message }, { status: 409 });
      return NextResponse.json({ error: err instanceof Error ? err.message : "Verifica non avviata" }, { status: 400 });
    }
  });
}
