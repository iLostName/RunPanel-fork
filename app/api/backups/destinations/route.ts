import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { visiblePolicyIds } from "@/lib/backup-access";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { destinationSchema, telegramDestinationConfigSchema } from "@/lib/validation";
import {
  buildDestination,
  destinationDirectory,
  destinationTarget,
  destinationUsage,
  telegramTarget,
} from "@/services/backup/destinations";
import { isRemoteType, prepareRemoteConfig } from "@/services/backup/destinations/kinds";
import { localPathProblem } from "@/services/backup/destinations/local";
import { TelegramFailure, type TelegramConfig } from "@/services/backup/destinations/telegram";
import { linkedTelegramLogin, releaseTelegramLogin, suggestedChannelTitle } from "@/services/backup/telegram-login";
import { telegramConfigFromLogin } from "@/services/backup/telegram-setup";
import type { DestinationCheck } from "@/services/backup/types";

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
        telegram: telegramTarget(row),
        // A local destination's folder of its own; null for the panel's own
        // archive folder, and for every other type.
        directory: destinationDirectory(row),
        // Names only of the policies this account may see; the count is all of
        // them, because a delete is refused for the ones it cannot see too.
        // `primary` when it is that policy's first destination.
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

    const { name, type, isDefault } = parsed.data;
    let config = parsed.data.config;

    // The default is where the restore's safety copy goes — a copy of exactly
    // what is about to be overwritten, the panel's own store included. Moving
    // it to a bucket of one's choosing is moving everyone's data there.
    if (isDefault && !denied.principal.isOwner) {
      return NextResponse.json(
        { error: "Solo il proprietario può scegliere la destinazione predefinita" },
        { status: 403 }
      );
    }

    // A folder of its own is a place on this server's disks where the panel
    // will write and delete files: the owner's choice, like the host itself.
    if (type === "local") {
      const folder = typeof config?.path === "string" ? config.path.trim() : "";
      if (folder) {
        if (!denied.principal.isOwner) {
          return NextResponse.json({ error: "Solo il proprietario può scegliere una cartella del server" }, { status: 403 });
        }
        const problem = localPathProblem(folder);
        if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      }
      config = folder ? { path: path.resolve(folder) } : {};
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

    // Telegram: the body names a finished login, not a session. The session is
    // read here from the server's own memory, the channel created, and only
    // what results is stored — encrypted, like every destination config.
    let stored: Record<string, unknown> | TelegramConfig = config ?? {};
    let loginId: string | null = null;
    if (type === "telegram") {
      const choice = telegramDestinationConfigSchema.parse(config);
      const linked = linkedTelegramLogin(choice.loginId, denied.principal.userId);
      if (!linked) {
        return NextResponse.json(
          { error: "Il collegamento a Telegram è scaduto o non è finito: collega di nuovo l'account." },
          { status: 400 }
        );
      }
      try {
        stored = await telegramConfigFromLogin(linked, {
          chat: choice.chat,
          channelTitle: choice.channelTitle,
          fallbackTitle: suggestedChannelTitle(),
        });
      } catch (err) {
        const failure = err instanceof TelegramFailure ? err : new TelegramFailure(err instanceof Error ? err.message : String(err));
        return NextResponse.json({ error: failure.message, code: failure.code }, { status: 502 });
      }
      loginId = choice.loginId;
    }

    // The remote types are completed on the way in — a generated key unsealed,
    // a OneDrive drive looked up — and validated whole (kinds.ts). S3 keeps the
    // check of its schema above.
    if (isRemoteType(type)) {
      const prepared = await prepareRemoteConfig(type, config ?? {}, null, { isOwner: denied.principal.isOwner });
      if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: prepared.status });
      stored = prepared.config;
    }

    const id = generateId();
    const now = nowIso();
    const row = {
      id,
      name,
      type,
      config: encrypt(JSON.stringify(stored)),
      is_default: isDefault ? 1 : 0,
      created_at: now,
      updated_at: now,
    };

    await db.transaction().execute(async (trx) => {
      if (isDefault) await trx.updateTable("backup_destinations").set({ is_default: 0 }).execute();
      await trx.insertInto("backup_destinations").values(row).execute();
    });

    // Saved: the session is the destination's now, so the login lets go of it
    // without logging it out. Then the real check, on the channel that now
    // exists — answered with the creation rather than as a second request.
    let check: DestinationCheck | undefined;
    if (loginId) {
      await releaseTelegramLogin(loginId, denied.principal.userId);
      check = await buildDestination(row)
        .test()
        .catch((err: unknown) => ({ ok: false, message: err instanceof Error ? err.message : "Verifica non riuscita" }));
    }

    return NextResponse.json({ id, name, type, isDefault: Boolean(isDefault), ...(check ? { check } : {}) }, { status: 201 });
  });
}
