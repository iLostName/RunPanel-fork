import { NextRequest, NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { isDenied, requireOwner, requirePermission } from "@/lib/auth-guard";
import { visiblePolicyIds } from "@/lib/backup-access";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { destinationUpdateSchema, s3ConfigSchema } from "@/lib/validation";
import { buildDestination, destinationConfig, destinationUsage } from "@/services/backup/destinations";

type Params = { params: Promise<{ destinationId: string }> };

/**
 * One destination, as the edit form needs it: everything but the secret.
 *
 * Owner only, like editing it. The access key id is here and not in the list
 * because the list is read by anyone holding `backup`.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;

  const { destinationId } = await params;
  const db = await getDb();
  const row = await db.selectFrom("backup_destinations").selectAll().where("id", "=", destinationId).executeTakeFirst();
  if (!row) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });

  const config = destinationConfig(row);
  const text = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");
  return NextResponse.json({
    id: row.id,
    name: row.name,
    type: row.type,
    isDefault: row.is_default === 1,
    config:
      row.type === "s3"
        ? {
            endpoint: text("endpoint"),
            region: text("region"),
            bucket: text("bucket"),
            accessKeyId: text("accessKeyId"),
            prefix: text("prefix"),
            forcePathStyle: config.forcePathStyle === true,
            // Whether one is stored, never what it is.
            hasSecret: text("secretAccessKey") !== "",
          }
        : null,
  });
}

/**
 * Check a destination before the night it matters.
 *
 * The check writes a real file rather than looking at the directory: a
 * read-only mount and a full disk both look perfectly fine until something
 * actually tries to write.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  return withAudit(_request, { category: "backup", action: "backup.destination.test", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    const { destinationId } = await params;
    const db = await getDb();
    const row = await db
      .selectFrom("backup_destinations")
      .selectAll()
      .where("id", "=", destinationId)
      .executeTakeFirst();

    if (!row) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });

    try {
      return NextResponse.json(await buildDestination(row).test());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Verifica fallita";
      return NextResponse.json({ ok: false, message });
    }
  });
}

/**
 * Rename a destination, or change where it writes and with which keys.
 *
 * Anyone holding `backup` may rename; only the owner may change the
 * connection. Every policy writing here — the owner's nightly included —
 * would follow the new bucket without anyone being asked, and an archive
 * carries every secret the panel holds.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.destination.update", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = destinationUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const { destinationId } = await params;
    const db = await getDb();
    const row = await db.selectFrom("backup_destinations").selectAll().where("id", "=", destinationId).executeTakeFirst();
    if (!row) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });

    const { name, config } = parsed.data;
    if (config && !denied.principal.isOwner) {
      return NextResponse.json(
        { error: "Solo il proprietario può cambiare dove scrive una destinazione e con quali chiavi" },
        { status: 403 }
      );
    }
    if (config && row.type !== "s3") {
      return NextResponse.json({ error: "Il disco locale non ha impostazioni da cambiare" }, { status: 400 });
    }

    const patch: { name?: string; config?: string; updated_at: string } = { updated_at: nowIso() };

    if (name !== undefined && name !== row.name) {
      const clash = await db
        .selectFrom("backup_destinations")
        .select("id")
        .where("name", "=", name)
        .where("id", "!=", destinationId)
        .executeTakeFirst();
      if (clash) return NextResponse.json({ error: `Esiste già una destinazione chiamata "${name}"` }, { status: 409 });
      patch.name = name;
    }

    if (config) {
      const stored = destinationConfig(row);
      // An empty secret means "the one you have": the form never receives it,
      // so it cannot send it back.
      const merged: Record<string, unknown> = { ...stored };
      for (const [key, value] of Object.entries(config)) {
        if (value === undefined) continue;
        if (key === "secretAccessKey" && value === "") continue;
        merged[key] = typeof value === "string" ? value.trim() : value;
      }
      if (merged.prefix === "") delete merged.prefix;

      const valid = s3ConfigSchema.safeParse(merged);
      if (!valid.success) {
        return NextResponse.json(
          { error: valid.error.issues[0]?.message ?? "Configurazione S3 non valida", details: valid.error.issues },
          { status: 400 }
        );
      }
      patch.config = encrypt(JSON.stringify(valid.data));
    }

    await db.updateTable("backup_destinations").set(patch).where("id", "=", destinationId).execute();
    return NextResponse.json({ ok: true, id: destinationId, name: patch.name ?? row.name });
  });
}

/**
 * Remove a destination.
 *
 * Refused while a policy writes here: the foreign key would delete the policy
 * along with it, which is a surprising amount of configuration to lose to one
 * click. Refused for the last one, which the safety copy of every restore
 * needs. And when archives are stored here, it takes the owner and the typed
 * name: the files stay where they are, but nothing in the panel knows about
 * them any more — no restore, no download, no retention.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.destination.delete", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    const { destinationId } = await params;
    const db = await getDb();
    const row = await db.selectFrom("backup_destinations").selectAll().where("id", "=", destinationId).executeTakeFirst();
    if (!row) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });

    const [usage, visible, count] = await Promise.all([
      destinationUsage(),
      visiblePolicyIds(denied.principal),
      db.selectFrom("backup_destinations").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst(),
    ]);
    const used = usage.get(destinationId) ?? { policies: [], archives: 0, archiveBytes: 0 };

    if (used.policies.length > 0) {
      const names = used.policies.filter((policy) => visible === "all" || visible.has(policy.id)).map((policy) => policy.name);
      const hidden = used.policies.length - names.length;
      const list = [...names.map((n) => `«${n}»`), ...(hidden > 0 ? [`${hidden} di un altro account`] : [])].join(", ");
      return NextResponse.json(
        {
          error: `La usa${used.policies.length === 1 ? "" : "no"} ${list}: sposta prima ${used.policies.length === 1 ? "quella pianificazione" : "quelle pianificazioni"} su un'altra destinazione.`,
          policies: used.policies.filter((policy) => visible === "all" || visible.has(policy.id)),
        },
        { status: 409 }
      );
    }

    if (Number(count?.n ?? 0) <= 1) {
      return NextResponse.json(
        { error: "È l'unica destinazione: serve per il backup di sicurezza di ogni ripristino. Aggiungine un'altra prima." },
        { status: 409 }
      );
    }

    if (used.archives > 0) {
      if (!denied.principal.isOwner) {
        return NextResponse.json(
          { error: "Ci sono archivi salvati qui: solo il proprietario può eliminare questa destinazione" },
          { status: 403 }
        );
      }
      // Typed, and checked here: a check the browser alone makes is a check
      // anyone posting directly can skip.
      const confirm = new URL(request.url).searchParams.get("confirm")?.trim();
      if (confirm !== row.name) {
        return NextResponse.json(
          { error: `Ci sono ${used.archives} archivi salvati qui. Per confermare scrivi esattamente: ${row.name}`, archives: used.archives },
          { status: 400 }
        );
      }
    }

    let newDefault: string | null = null;
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("backup_destinations").where("id", "=", destinationId).execute();
      if (row.is_default === 1) {
        // The oldest one left: on most installations the local disk, which
        // always works.
        const next = await trx
          .selectFrom("backup_destinations")
          .select(["id", "name"])
          .orderBy("created_at", "asc")
          .executeTakeFirst();
        if (next) {
          await trx.updateTable("backup_destinations").set({ is_default: 1, updated_at: nowIso() }).where("id", "=", next.id).execute();
          newDefault = next.name;
        }
      }
    });

    return NextResponse.json({ ok: true, orphanedArchives: used.archives, newDefault });
  });
}
