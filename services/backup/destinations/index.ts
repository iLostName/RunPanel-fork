import { decrypt, encrypt } from "@/lib/crypto";
import { getDb, nowIso } from "@/lib/db";
import type { BackupDestinationsTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { localDestination } from "./local";
import { s3Destination } from "./s3";
import type { Destination } from "../types";

/**
 * Which transports exist, and how a stored row becomes one.
 *
 * `local` and any S3-compatible object store — S3 itself, R2, B2, MinIO. The
 * row's `config` has been encrypted since the very first migration, which is
 * why adding a transport that needs a secret key changed nothing about storage:
 * a column that is sometimes ciphertext and sometimes not is a column nobody
 * can reason about.
 */

type Factory = (row: BackupDestinationsTable, config: Record<string, unknown>) => Destination;

const FACTORIES: Record<string, Factory> = {
  local: (row) => localDestination(row),
  s3: (row, config) => s3Destination(row, config),
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

/** Which policies write to each destination, and how many archives each one holds. */
export async function destinationUsage(): Promise<
  Map<string, { policies: { id: string; name: string }[]; archives: number; archiveBytes: number }>
> {
  const db = await getDb();
  const [policies, runs] = await Promise.all([
    db.selectFrom("backup_policies").select(["id", "name", "destination_id"]).orderBy("created_at", "asc").execute(),
    db
      .selectFrom("backup_runs")
      .select(["destination_id", "archive_bytes"])
      .where("archive_path", "is not", null)
      .where("destination_id", "is not", null)
      .execute(),
  ]);

  const usage = new Map<string, { policies: { id: string; name: string }[]; archives: number; archiveBytes: number }>();
  const entry = (id: string) => {
    let found = usage.get(id);
    if (!found) {
      found = { policies: [], archives: 0, archiveBytes: 0 };
      usage.set(id, found);
    }
    return found;
  };
  for (const policy of policies) entry(policy.destination_id).policies.push({ id: policy.id, name: policy.name });
  for (const run of runs) {
    const found = entry(run.destination_id as string);
    found.archives += 1;
    found.archiveBytes += run.archive_bytes ?? 0;
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
