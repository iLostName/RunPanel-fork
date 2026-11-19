import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission, requireService } from "@/lib/auth-guard";
import { visiblePolicyIds } from "@/lib/backup-access";
import { getDb } from "@/lib/db";
import { serviceDisplayName } from "@/lib/service-name";
import { listPolicies, runEncryption, type RunEncryption } from "@/services/backup/catalog";
import { keyAvailability } from "@/services/backup/keyring";

type Params = { params: Promise<{ serviceId: string }> };

/** How many past backups the database page shows. The rest are on the Backup page. */
const RECENT_RUNS = 8;

/**
 * Backups as the database page sees them: which schedules save this service,
 * and the last archives that hold it.
 *
 * Holding `backup` and being able to see the service are both needed: the
 * page belongs to the service, the archives to the backups. A non-owner sees
 * only the policies and runs `lib/backup-access.ts` lets them see anyway — the
 * nightly "everything" schedule of the owner is not one of them.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const { serviceId } = await params;
  const allowed = await requireService(serviceId, "view");
  if (isDenied(allowed)) return allowed;

  const db = await getDb();
  const service = await db.selectFrom("services").selectAll().where("id", "=", serviceId).executeTakeFirst();
  if (!service) return NextResponse.json({ error: "Database non trovato" }, { status: 404 });

  const visible = await visiblePolicyIds(denied.principal);
  const policies = (await listPolicies()).filter((policy) => visible === "all" || visible.has(policy.id));

  const coverage = policies
    .map((policy) => {
      const target = policy.targets.find(
        (t) => t.kind === "all-services" || (t.kind === "service" && t.id === serviceId)
      );
      if (!target) return null;
      return {
        policyId: policy.id,
        name: policy.name,
        enabled: policy.enabled,
        cron: policy.cron,
        schedule: policy.schedule,
        timezone: policy.timezone,
        destinationName: policy.destinationName,
        destinationType: policy.destinationType,
        nextRunAt: policy.nextRunAt,
        lastRunAt: policy.lastRunAt,
        lastStatus: policy.lastStatus,
        // Null: the whole server, roles included. A list: only those databases.
        databases: target.kind === "service" && target.databases?.length ? target.databases : null,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const rows = await db
    .selectFrom("backup_artifacts")
    .innerJoin("backup_runs", "backup_runs.id", "backup_artifacts.run_id")
    .select([
      "backup_artifacts.id as artifactId",
      "backup_artifacts.ref_id as refId",
      "backup_artifacts.ref_name as refName",
      "backup_artifacts.entry_path as entryPath",
      "backup_artifacts.bytes as bytes",
      "backup_artifacts.checksum as checksum",
      "backup_artifacts.status as artifactStatus",
      "backup_artifacts.error_message as artifactError",
      "backup_artifacts.meta as meta",
      "backup_runs.id as runId",
      "backup_runs.policy_id as policyId",
      "backup_runs.policy_name as policyName",
      "backup_runs.trigger as trigger",
      "backup_runs.status as runStatus",
      "backup_runs.archive_path as archivePath",
      "backup_runs.destination_id as destinationId",
      "backup_runs.started_at as startedAt",
      "backup_runs.encryption_key_id as encryptionKeyId",
    ])
    .where("backup_artifacts.kind", "=", "service-db")
    .where("backup_artifacts.ref_id", "=", serviceId)
    .orderBy("backup_runs.started_at", "desc")
    .limit(RECENT_RUNS * 20)
    .execute();

  // A run belongs to whoever may see its policy; one with no policy is the owner's.
  const shown = rows.filter((row) =>
    denied.principal.isOwner || (row.policyId !== null && visible !== "all" && visible.has(row.policyId))
  );

  const [destinations, verifications, keys] = await Promise.all([
    db.selectFrom("backup_destinations").select(["id", "name", "type"]).execute(),
    shown.length > 0
      ? db
          .selectFrom("backup_verifications")
          .select(["run_id", "status", "checked_at"])
          .where("run_id", "in", [...new Set(shown.map((row) => row.runId))])
          .execute()
      : Promise.resolve([]),
    keyAvailability(),
  ]);
  const destinationById = new Map(destinations.map((d) => [d.id, d]));
  const verificationByRun = new Map(verifications.map((v) => [v.run_id, v]));

  const runs: {
    runId: string;
    policyName: string | null;
    trigger: string;
    status: string;
    startedAt: string;
    hasArchive: boolean;
    destinationName: string | null;
    destinationType: string | null;
    verification: { status: "ok" | "failed"; checkedAt: string } | null;
    encryption: RunEncryption | null;
    artifacts: {
      id: string;
      kind: "service-db";
      refId: string | null;
      refName: string;
      entryPath: string;
      bytes: number;
      checksum: string | null;
      status: string;
      errorMessage: string | null;
      meta: Record<string, unknown> | null;
    }[];
  }[] = [];

  for (const row of shown) {
    let run = runs.find((entry) => entry.runId === row.runId);
    if (!run) {
      if (runs.length >= RECENT_RUNS) continue;
      const destination = row.destinationId ? destinationById.get(row.destinationId) : undefined;
      const check = verificationByRun.get(row.runId);
      run = {
        runId: row.runId,
        policyName: row.policyName,
        trigger: row.trigger,
        status: row.runStatus,
        startedAt: row.startedAt,
        hasArchive: Boolean(row.archivePath),
        destinationName: destination?.name ?? null,
        destinationType: destination?.type ?? null,
        verification: check ? { status: check.status === "ok" ? "ok" : "failed", checkedAt: check.checked_at } : null,
        encryption: runEncryption(row.encryptionKeyId, keys),
        artifacts: [],
      };
      runs.push(run);
    }
    let meta: Record<string, unknown> | null = null;
    try {
      meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null;
    } catch {
      /* an unreadable meta only costs the engine check in the browser */
    }
    run.artifacts.push({
      id: row.artifactId,
      kind: "service-db",
      refId: row.refId,
      refName: row.refName,
      entryPath: row.entryPath,
      bytes: row.bytes,
      checksum: row.checksum,
      status: row.artifactStatus,
      errorMessage: row.artifactError,
      meta,
    });
  }

  return NextResponse.json({
    service: { id: service.id, name: serviceDisplayName(service), type: service.type },
    coverage,
    runs,
  });
}
