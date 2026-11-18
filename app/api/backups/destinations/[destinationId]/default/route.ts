import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { destinationDefaultSchema } from "@/lib/validation";

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
 * when they add their first bucket and expect "the backups" to go there. The
 * archives already taken stay where they are, and are still restorable.
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
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("backup_destinations").set({ is_default: 0 }).where("id", "!=", destinationId).execute();
      await trx.updateTable("backup_destinations").set({ is_default: 1, updated_at: now }).where("id", "=", destinationId).execute();
      if (parsed.data.movePolicies) {
        const policies = await trx
          .selectFrom("backup_policies")
          .select("id")
          .where("destination_id", "!=", destinationId)
          .execute();
        moved = policies.length;
        if (moved > 0) {
          await trx
            .updateTable("backup_policies")
            .set({ destination_id: destinationId, updated_at: now })
            .where("destination_id", "!=", destinationId)
            .execute();
        }
      }
    });

    return NextResponse.json({ ok: true, id: destinationId, name: row.name, movedPolicies: moved });
  });
}
