import { decrypt, encrypt } from "@/lib/crypto";
import { getDb, nowIso } from "@/lib/db";
import type { BackupDestinationsTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import type { DestinationFacts } from "@/lib/backup-copies";
import { localDestination, localDirectory } from "./local";
import { s3Destination } from "./s3";
import { readTelegramChat, telegramDestination } from "./telegram";
import type { Destination } from "../types";

/**
 * Which transports exist, and how a stored row becomes one.
 *
 * `local`, any S3-compatible object store — S3 itself, R2, B2, MinIO — and
 * Telegram through the user's own account. The row's `config` has been
 * encrypted since the very first migration, which is why adding a transport
 * that needs a secret key, or a whole account session, changed nothing about
 * storage: a column that is sometimes ciphertext and sometimes not is a column
 * nobody can reason about.
 */

type Factory = (row: BackupDestinationsTable, config: Record<string, unknown>) => Destination;

const FACTORIES: Record<string, Factory> = {
  local: (row, config) => localDestination(row, config),
  s3: (row, config) => s3Destination(row, config),
  telegram: (row, config) => telegramDestination(row, config),
};

export function destinationConfig(row: BackupDestinationsTable): Record<string, unknown> {
  try {
    return JSON.parse(decrypt(row.config)) as Record<string, unknown>;
  } catch {
    // An unreadable config is not a reason to lose the destination: local needs
    // none, and anything else will fail loudly on its first call.
    return {};
  }
}

export function buildDestination(row: BackupDestinationsTable): Destination {
  const factory = FACTORIES[row.type];
  if (!factory) throw new Error(`Destinazione di tipo "${row.type}" non supportata`);
  return factory(row, destinationConfig(row));
}

/**
 * What may be shown about where a destination writes: never the keys.
 *
 * The access key id is left out too, although it is not the secret half: the
 * list is read by anyone holding `backup`, and only the owner edits.
 */
export interface DestinationTarget {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string | null;
  pathStyle: boolean;
}

export function destinationTarget(row: BackupDestinationsTable): DestinationTarget | null {
  if (row.type !== "s3") return null;
  const config = destinationConfig(row);
  const text = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");
  return {
    endpoint: text("endpoint"),
    region: text("region"),
    bucket: text("bucket"),
    prefix: text("prefix") || null,
    pathStyle: config.forcePathStyle === true,
  };
}

/**
 * Where a Telegram destination writes, for the list: the chat, never the
 * session. Which account it is stays with the owner's edit form, like the S3
 * access key id.
 */
export interface TelegramTarget {
  chat: "channel" | "saved";
  /** The channel's title; null for Saved Messages. */
  title: string | null;
  /** False when the config holds no session: created by hand, or unreadable. */
  linked: boolean;
}

export function telegramTarget(row: BackupDestinationsTable): TelegramTarget | null {
  if (row.type !== "telegram") return null;
  const config = destinationConfig(row);
  const chat = readTelegramChat(config.chat);
  return {
    chat: chat?.kind ?? "saved",
    title: chat?.kind === "channel" ? chat.title || null : null,
    linked: typeof config.session === "string" && config.session !== "",
  };
}

/** A local destination's folder of its own; null for the panel's archive folder and for every other type. */
export function destinationDirectory(row: BackupDestinationsTable): string | null {
  return row.type === "local" ? localDirectory(destinationConfig(row)) : null;
}

/**
 * What a policy's list needs to know about every destination: its name, and
 * where it writes, so two copies in one place can be refused. A row whose
 * type this build does not know has no location, and is trusted to be
 * somewhere else.
 */
export function destinationFacts(rows: BackupDestinationsTable[]): Map<string, DestinationFacts & { local: boolean }> {
  const facts = new Map<string, DestinationFacts & { local: boolean }>();
  for (const row of rows) {
    let location: string | null = null;
    let local = false;
    try {
      const destination = buildDestination(row);
      location = destination.location?.() ?? null;
      local = typeof destination.localPath === "function";
    } catch {
      /* an unknown type is still a destination, just not one this build can open */
    }
    facts.set(row.id, { name: row.name, location, local });
  }
  return facts;
}

export interface DestinationUse {
  /** Every policy listing it; `primary` when it is that policy's first destination. */
  policies: { id: string; name: string; primary: boolean }[];
  /** Copies of an archive stored there. */
  archives: number;
  archiveBytes: number;
}

/** Which policies write to each destination, and how many archives each one holds. */
export async function destinationUsage(): Promise<Map<string, DestinationUse>> {
  const db = await getDb();
  const [policies, entries, copies] = await Promise.all([
    db.selectFrom("backup_policies").select(["id", "name", "destination_id"]).orderBy("created_at", "asc").execute(),
    db.selectFrom("backup_policy_destinations").select(["policy_id", "destination_id"]).execute(),
    db
      .selectFrom("backup_run_copies")
      .select(["destination_id", "bytes"])
      .where("status", "=", "done")
      .where("destination_id", "is not", null)
      .execute(),
  ]);

  const usage = new Map<string, DestinationUse>();
  const entry = (id: string) => {
    let found = usage.get(id);
    if (!found) {
      found = { policies: [], archives: 0, archiveBytes: 0 };
      usage.set(id, found);
    }
    return found;
  };

  const listed = new Map<string, Set<string>>();
  for (const row of entries) {
    const set = listed.get(row.policy_id) ?? new Set<string>();
    set.add(row.destination_id);
    listed.set(row.policy_id, set);
  }
  for (const policy of policies) {
    // The primary column as well as the list: should they ever disagree, a
    // delete has to be refused for either, or the foreign key on the column
    // would take the whole policy with it.
    const ids = new Set(listed.get(policy.id) ?? []);
    ids.add(policy.destination_id);
    for (const id of ids) {
      entry(id).policies.push({ id: policy.id, name: policy.name, primary: id === policy.destination_id });
    }
  }
  for (const copy of copies) {
    const found = entry(copy.destination_id as string);
    found.archives += 1;
    found.archiveBytes += copy.bytes ?? 0;
  }
  return usage;
}

/**
 * A destination that exists only for one check: what the form would save,
 * tried before it is saved, so a wrong key never becomes a stored row.
 */
export function transientDestination(type: string, config: Record<string, unknown>): Destination {
  const factory = FACTORIES[type];
  if (!factory) throw new Error(`Destinazione di tipo "${type}" non supportata`);
  const now = new Date().toISOString();
  const row: BackupDestinationsTable = {
    id: "check",
    name: "verifica",
    type: type as BackupDestinationsTable["type"],
    config: "",
    is_default: 0,
    created_at: now,
    updated_at: now,
  };
  return factory(row, config);
}

export async function loadDestination(id: string): Promise<Destination> {
  const db = await getDb();
  const row = await db
    .selectFrom("backup_destinations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!row) throw new Error("Destinazione non trovata");
  return buildDestination(row);
}

export async function defaultDestinationId(): Promise<string | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("backup_destinations")
    .select("id")
    .orderBy("is_default", "desc")
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Create the local destination on first boot.
 *
 * Deliberately here and not in migration 005: a migration that called
 * `encrypt()` would tie the schema to `getSecret()`, and a schema that cannot be
 * applied without a working key is a schema that fails in the one situation
 * where you most need it to apply.
 */
export async function ensureDefaultDestination(): Promise<void> {
  const db = await getDb();
  const existing = await db
    .selectFrom("backup_destinations")
    .select("id")
    .limit(1)
    .executeTakeFirst();
  if (existing) return;

  const now = nowIso();
  await db
    .insertInto("backup_destinations")
    .values({
      id: generateId(),
      name: "Disco locale",
      type: "local",
      config: encrypt("{}"),
      is_default: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
}
