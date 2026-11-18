import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDenied, requireOwner, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { destinationTypes, destinationUpdateSchema, s3ConfigInput, s3ConfigSchema } from "@/lib/validation";
import { destinationConfig, transientDestination } from "@/services/backup/destinations";
import { isRemoteType, prepareRemoteConfig } from "@/services/backup/destinations/kinds";

const checkSchema = z
  .object({
    type: z.enum(destinationTypes),
    config: destinationUpdateSchema.shape.config,
    /** Editing: the stored configuration fills what the form left empty — the secret, above all. */
    destinationId: z.string().min(1).max(32).optional(),
  })
  .strict();

/**
 * Try a destination before it is saved: write, read back and delete a marker
 * with exactly what the form holds.
 *
 * Saving first and checking after left a broken destination behind every
 * typo, ready to be picked by the nightly. Nothing is stored here. With
 * `destinationId` the stored config fills the gaps, so an edit that leaves the
 * secret empty is checked with the secret it will keep — and that takes the
 * owner, like the edit itself.
 */
export async function POST(request: NextRequest) {
  return withAudit(request, { category: "backup", action: "backup.destination.test", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requirePermission("backup");
    if (isDenied(denied)) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = checkSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const { type, destinationId } = parsed.data;
    let merged: Record<string, unknown> = {};
    if (destinationId) {
      const owner = await requireOwner();
      if (isDenied(owner)) return owner;
      const db = await getDb();
      const row = await db.selectFrom("backup_destinations").selectAll().where("id", "=", destinationId).executeTakeFirst();
      if (!row) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });
      if (row.type !== type) return NextResponse.json({ error: "Il tipo di una destinazione non cambia" }, { status: 400 });
      merged = destinationConfig(row);
    }

    if (isRemoteType(type)) {
      // The same preparation as saving, so what passes here is what gets
      // stored: the generated key unsealed, the OneDrive drive looked up, an
      // rclone section refused to anyone but the owner — it would run here.
      const prepared = await prepareRemoteConfig(type, parsed.data.config ?? {}, destinationId ? merged : null, { isOwner: denied.principal.isOwner });
      if (!prepared.ok) {
        if (prepared.status === 403) return NextResponse.json({ error: prepared.error }, { status: 403 });
        return NextResponse.json({ ok: false, message: prepared.error });
      }
      try {
        return NextResponse.json(await transientDestination(type, prepared.config).test());
      } catch (err) {
        return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : "Verifica fallita" });
      }
    }

    for (const [key, value] of Object.entries(parsed.data.config ?? {})) {
      if (value === undefined || (key === "secretAccessKey" && value === "")) continue;
      merged[key] = typeof value === "string" ? value.trim() : value;
    }
    if (merged.prefix === "") delete merged.prefix;

    if (type === "s3") {
      const shape = s3ConfigInput.safeParse(parsed.data.config ?? {});
      if (!shape.success) return NextResponse.json({ error: "Dati non validi", details: shape.error.issues }, { status: 400 });
      const valid = s3ConfigSchema.safeParse(merged);
      if (!valid.success) {
        return NextResponse.json({
          ok: false,
          message: valid.error.issues[0]?.message ?? "Configurazione S3 incompleta o non valida",
        });
      }
      merged = valid.data;
    }

    try {
      return NextResponse.json(await transientDestination(type, merged).test());
    } catch (err) {
      return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : "Verifica fallita" });
    }
  });
}
