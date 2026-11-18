import { NextRequest, NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { visiblePolicyIds } from "@/lib/backup-access";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { destinationSchema } from "@/lib/validation";
import { destinationTarget, destinationUsage } from "@/services/backup/destinations";
import { isRemoteType, prepareRemoteConfig } from "@/services/backup/destinations/kinds";

export async function GET() {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const [rows, usage, visible] = await Promise.all([
    db.selectFrom("backup_destinations").selectAll().orderBy("created_at", "asc").execute(),
    destinationUsage(),
    visiblePolicyIds(denied.principal),
  ]);

  // The config is never returned whole: it is ciphertext, and for anything
  // other than `local` it holds the keys. Where it writes is shown — bucket,
  // region, endpoint; server, folder, host key fingerprint — because "dove
  // finiscono?" is the question the list exists to answer.
  return NextResponse.json({
    destinations: rows.map((row) => {
      const used = usage.get(row.id);
      const policies = used?.policies ?? [];
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        isDefault: row.is_default === 1,
        createdAt: row.created_at,
        target: destinationTarget(row),
        // Names only of the policies this account may see; the count is all of
        // them, because a delete is refused for the ones it cannot see too.
        usedBy: policies.filter((policy) => visible === "all" || visible.has(policy.id)),
        usedByCount: policies.length,
        archives: used?.archives ?? 0,
        archiveBytes: used?.archiveBytes ?? 0,
      };
    }),
  });
}

export async function POST(request: NextRequest) {
  return withAudit(request, { category: "backup", action: "backup.destination.create", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }

    const parsed = destinationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const { name, type, config, isDefault } = parsed.data;

    // The default is where the restore's safety copy goes — a copy of exactly
    // what is about to be overwritten, the panel's own store included. Moving
    // it to a bucket of one's choosing is moving everyone's data there.
    if (isDefault && !denied.principal.isOwner) {
      return NextResponse.json(
        { error: "Solo il proprietario può scegliere la destinazione predefinita" },
        { status: 403 }
      );
    }

    const db = await getDb();

    const clash = await db
      .selectFrom("backup_destinations")
      .select("id")
      .where("name", "=", name)
      .executeTakeFirst();

    if (clash) {
      return NextResponse.json(
        { error: `Esiste già una destinazione chiamata "${name}"` },
        { status: 409 }
      );
    }

    // The remote types are completed on the way in — a generated key unsealed,
    // a OneDrive drive looked up — and validated whole (kinds.ts). S3 keeps the
    // check of its schema above; the local disk has nothing to store.
    let stored: Record<string, unknown> = config ?? {};
    if (isRemoteType(type)) {
      const prepared = await prepareRemoteConfig(type, config ?? {}, null, { isOwner: denied.principal.isOwner });
      if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: prepared.status });
      stored = prepared.config;
    }

    const id = generateId();
    const now = nowIso();

    await db.transaction().execute(async (trx) => {
      if (isDefault) await trx.updateTable("backup_destinations").set({ is_default: 0 }).execute();
      await trx
        .insertInto("backup_destinations")
        .values({
          id,
          name,
          type,
          config: encrypt(JSON.stringify(stored)),
          is_default: isDefault ? 1 : 0,
          created_at: now,
          updated_at: now,
        })
        .execute();
    });

    return NextResponse.json({ id, name, type, isDefault: Boolean(isDefault) }, { status: 201 });
  });
}
