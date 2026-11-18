import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { destinationDefaultSchema } from "@/lib/validation";
import { withPrimary } from "@/lib/backup-copies";
import {
  destinationListError,
  loadPolicyDestinations,
  writePolicyDestinations,
} from "@/services/backup/policy-destinations";

type Params = { params: Promise<{ destinationId: string }> };

/**
 * Make a destination the default: where new policies, the nightly preset and
 * every restore's safety copy go.
 *
 * Owner only. The safety copy is a copy of exactly what a restore is about to
 * overwrite, the panel's own store included, so choosing where it goes is
 * choosing where everyone's data goes.
 *
 * `movePolicies` also points every existing policy here — the step people mean
 * when they add their first bucket and expect "the backups" to go there. It
 * becomes each policy's primary; the policy's other copies stay. The archives
 * already taken stay where they are, and are still restorable.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.destination.default", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    // An empty body is the plain "make it the default".
    let body: unknown = {};
    const raw = await request.text();
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
      }
    }
    const parsed = destinationDefaultSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const { destinationId } = await params;
    const db = await getDb();
    const row = await db.selectFrom("backup_destinations").select(["id", "name"]).where("id", "=", destinationId).executeTakeFirst();
    if (!row) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });

    const now = nowIso();
    let moved = 0;
    // What each policy becomes: this destination as its primary. Listed among
    // its copies already, it moves to the front; not listed, it takes the old
    // primary's place — for a policy with one destination, the move it always
    // was — and the other copies stay where they are.
    const policies = parsed.data.movePolicies
      ? await db.selectFrom("backup_policies").select(["id", "destination_id"]).where("destination_id", "!=", destinationId).execute()
      : [];
    const lists = await loadPolicyDestinations(policies);
    const next = policies.map((policy) => ({
      id: policy.id,
      list: withPrimary(lists.get(policy.id) ?? [{ destinationId: policy.destination_id, retention: null }], destinationId),
    }));
    for (const { list } of next) {
      const problem = await destinationListError(list.map((entry) => entry.destinationId));
      if (problem) return NextResponse.json({ error: problem.error }, { status: 409 });
    }

    await db.transaction().execute(async (trx) => {
      await trx.updateTable("backup_destinations").set({ is_default: 0 }).where("id", "!=", destinationId).execute();
      await trx.updateTable("backup_destinations").set({ is_default: 1, updated_at: now }).where("id", "=", destinationId).execute();
      for (const { id, list } of next) {
        await writePolicyDestinations(trx, id, list, now);
        await trx.updateTable("backup_policies").set({ updated_at: now }).where("id", "=", id).execute();
      }
      moved = next.length;
    });

    return NextResponse.json({ ok: true, id: destinationId, name: row.name, movedPolicies: moved });
  });
}
