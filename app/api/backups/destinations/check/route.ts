import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDenied, requireOwner, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { formatBytes } from "@/lib/format";
import { destinationTypes, destinationUpdateSchema, s3ConfigSchema } from "@/lib/validation";
import { destinationConfig, destinationUsage, transientDestination } from "@/services/backup/destinations";
import { accountLabel } from "@/services/backup/destinations/telegram";
import { linkedTelegramLogin } from "@/services/backup/telegram-login";
import { relinkTelegramConfig } from "@/services/backup/telegram-setup";

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
    if (type === "telegram") return checkTelegram(denied.principal.userId, parsed.data);

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
    for (const [key, value] of Object.entries(parsed.data.config ?? {})) {
      if (value === undefined || (key === "secretAccessKey" && value === "")) continue;
      merged[key] = typeof value === "string" ? value.trim() : value;
    }
    if (merged.prefix === "") delete merged.prefix;

    if (type === "s3") {
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

/**
 * Telegram, tried before saving: with a finished login, the account it linked
 * (and, editing, whether it can still reach the archives already stored);
 * with only `destinationId`, the stored session. A channel that does not exist
 * yet cannot be written to: the panel creates it when the destination is
 * saved, and checks it then.
 */
async function checkTelegram(userId: string, data: z.infer<typeof checkSchema>): Promise<NextResponse> {
  let stored: Record<string, unknown> | null = null;
  if (data.destinationId) {
    const owner = await requireOwner();
    if (isDenied(owner)) return owner;
    const db = await getDb();
    const row = await db.selectFrom("backup_destinations").selectAll().where("id", "=", data.destinationId).executeTakeFirst();
    if (!row) return NextResponse.json({ error: "Destinazione non trovata" }, { status: 404 });
    if (row.type !== "telegram") return NextResponse.json({ error: "Il tipo di una destinazione non cambia" }, { status: 400 });
    stored = destinationConfig(row);
  }

  const loginId = data.config?.loginId;
  let config = stored;
  if (loginId) {
    const linked = linkedTelegramLogin(loginId, userId);
    if (!linked) {
      return NextResponse.json({ ok: false, message: "Il collegamento a Telegram è scaduto o non è finito: collega di nuovo l'account." });
    }
    if (stored && data.destinationId) {
      const archives = (await destinationUsage()).get(data.destinationId)?.archives ?? 0;
      try {
        config = { ...(await relinkTelegramConfig(stored, linked, archives)).config };
      } catch (err) {
        return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : "Verifica non riuscita" });
      }
    } else if ((data.config?.chat ?? "channel") === "channel") {
      return NextResponse.json({
        ok: true,
        message:
          `Account ${accountLabel(linked.account)}, ${linked.account.premium ? "con Telegram Premium" : "senza Premium"}: ` +
          `parti fino a ${formatBytes(linked.maxPartBytes)}. Il canale viene creato quando salvi, e verificato allora.`,
      });
    } else {
      config = { apiId: linked.apiId, apiHash: linked.apiHash, session: linked.session, chat: { kind: "saved" } };
    }
  }
  if (!config) return NextResponse.json({ ok: false, message: "Collega prima l'account Telegram." });

  try {
    return NextResponse.json(await transientDestination("telegram", config).test());
  } catch (err) {
    return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : "Verifica non riuscita" });
  }
}
