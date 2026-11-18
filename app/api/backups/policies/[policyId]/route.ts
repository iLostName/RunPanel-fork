import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { policyProblem, visiblePolicyIds } from "@/lib/backup-access";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { updateBackupPolicySchema } from "@/lib/validation";
import { withPrimary, type PolicyDestination } from "@/lib/backup-copies";
import { listPolicies } from "@/services/backup/catalog";
import {
  destinationListError,
  normalizeDestinationList,
  policyDestinations,
  writePolicyDestinations,
} from "@/services/backup/policy-destinations";
import { refreshNextRun } from "@/services/backup/scheduler";

type Params = { params: Promise<{ policyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const { policyId } = await params;
  const visible = await visiblePolicyIds(denied.principal);
  const policy = (await listPolicies()).find((entry) => entry.id === policyId && (visible === "all" || visible.has(entry.id)));
  if (!policy) return NextResponse.json({ error: "Pianificazione non trovata" }, { status: 404 });

  return NextResponse.json(policy);
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.policy.update", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    const { policyId } = await params;
    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }

    const parsed = updateBackupPolicySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const db = await getDb();
    const existing = await db
      .selectFrom("backup_policies")
      .select(["id", "targets", "include_secret_key", "destination_id"])
      .where("id", "=", policyId)
      .executeTakeFirst();

    if (!existing) {
      return NextResponse.json({ error: "Pianificazione non trovata" }, { status: 404 });
    }

    const data = parsed.data;
    // Both what the policy is now and what it would become must be theirs.
    const visible = await visiblePolicyIds(denied.principal);
    if (visible !== "all" && !visible.has(policyId)) {
      return NextResponse.json({ error: "Pianificazione non trovata" }, { status: 404 });
    }
    const problem = await policyProblem(
      denied.principal,
      data.targets ?? JSON.parse(existing.targets),
      data.includeSecretKey ?? existing.include_secret_key === 1
    );
    if (problem) return NextResponse.json({ error: problem }, { status: 403 });

    // `destinations` replaces the list. `destinationId` alone — a client that
    // knows one destination per policy — moves the primary and leaves the
    // other copies where they are: it cannot remove what it never heard of.
    let list: PolicyDestination[] | null = null;
    if (data.destinations) {
      list = normalizeDestinationList(data.destinations);
      if (data.destinationId !== undefined && data.destinationId !== list[0].destinationId) {
        return NextResponse.json({ error: "destinationId deve essere la prima delle destinazioni" }, { status: 400 });
      }
    } else if (data.destinationId !== undefined) {
      list = withPrimary(await policyDestinations(existing), data.destinationId);
    }

    // As in POST: otherwise an unknown id surfaces as a foreign key error.
    if (list) {
      const listProblem = await destinationListError(list.map((entry) => entry.destinationId));
      if (listProblem) return NextResponse.json({ error: listProblem.error }, { status: listProblem.notFound ? 404 : 400 });
    }

    const now = nowIso();
    const patch: Record<string, unknown> = { updated_at: now };

    if (data.name !== undefined) patch.name = data.name;
    if (data.enabled !== undefined) patch.enabled = data.enabled ? 1 : 0;
    if (data.cron !== undefined) patch.cron = data.cron;
    if (data.timezone !== undefined) patch.timezone = data.timezone;
    if (data.targets !== undefined) patch.targets = JSON.stringify(data.targets);
    if (data.retentionCount !== undefined) patch.retention_count = data.retentionCount;
    if (data.retentionDays !== undefined) patch.retention_days = data.retentionDays;
    if (data.retentionBytes !== undefined) patch.retention_bytes = data.retentionBytes;
    if (data.includeSecretKey !== undefined) {
      patch.include_secret_key = data.includeSecretKey ? 1 : 0;
    }

    await db.transaction().execute(async (trx) => {
      await trx.updateTable("backup_policies").set(patch).where("id", "=", policyId).execute();
      if (list) await writePolicyDestinations(trx, policyId, list, now);
    });

    // The schedule or the switch may have moved; recompute now so the list is
    // right immediately instead of after the next tick.
    await refreshNextRun(policyId);

    const policy = (await listPolicies()).find((entry) => entry.id === policyId);
    return NextResponse.json(policy);
  });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  return withAudit(_request, { category: "backup", action: "backup.policy.delete", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    const { policyId } = await params;
    const visible = await visiblePolicyIds(denied.principal);
    if (visible !== "all" && !visible.has(policyId)) {
      return NextResponse.json({ error: "Pianificazione non trovata" }, { status: 404 });
    }
    const db = await getDb();

    // The runs survive: `policy_id` is set null rather than cascaded, because the
    // archives are files on disk and deleting the rows would strand them.
    await db.deleteFrom("backup_policies").where("id", "=", policyId).execute();

    return NextResponse.json({ ok: true });
  });
}
