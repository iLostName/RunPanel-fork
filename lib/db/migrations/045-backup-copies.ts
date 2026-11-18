import { randomBytes } from "node:crypto";
import { Kysely } from "kysely";

/**
 * Several copies of every backup — see services/backup/copies.ts.
 *
 * `backup_policy_destinations`: where a policy writes, in order. The first row
 * (position 0) is the primary, and `backup_policies.destination_id` keeps
 * naming it, so every reader that only knows one destination still reads the
 * right one.
 *   own_retention   0: the copy follows the policy's own rule;
 *                   1: the three columns below, all NULL meaning "keep all"
 *
 * `backup_run_copies`: one row per destination a run's archive was sent to.
 *   destination_id  `set null` like `backup_runs.destination_id`: a deleted
 *                   destination must not take with it the only record that a
 *                   copy exists, and where
 *   destination_name, destination_type
 *                   a snapshot, for the run page once the destination is gone
 *   position        the policy's order when the run started: the primary is 0
 *   status          pending | uploading | done | failed
 *   ref             the destination's handle for the file, once it is there
 *
 * The run's own `destination_id`, `archive_path` and `archive_bytes` stay, and
 * mirror its primary copy (the first one in order that holds the archive), so
 * the API and anything reading those columns keep working unchanged.
 *
 * Every existing policy becomes a one-row list with no rule of its own, and
 * every run with an archive one copy: nothing changes until someone adds a
 * destination. Every step checks first, so it can run again over a store that
 * already has it; the backfill only fills what is missing.
 *
 * No `@/` import: the migration is loaded on its own by a unit suite, and the
 * ids are drawn here rather than from `generateId()` for that reason.
 */

type Store = Kysely<{
  backup_destinations: { id: string; name: string; type: string };
  backup_policies: { id: string; destination_id: string; created_at: string };
  backup_runs: {
    id: string;
    destination_id: string | null;
    archive_path: string | null;
    archive_bytes: number | null;
    started_at: string;
    finished_at: string | null;
  };
  backup_policy_destinations: {
    id: string;
    policy_id: string;
    destination_id: string;
    position: number;
    own_retention: number;
    retention_count: number | null;
    retention_days: number | null;
    retention_bytes: number | null;
    created_at: string;
  };
  backup_run_copies: {
    id: string;
    run_id: string;
    destination_id: string | null;
    destination_name: string;
    destination_type: string;
    position: number;
    status: string;
    ref: string | null;
    bytes: number | null;
    error_message: string | null;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
  };
}>;

/** nanoid's length and alphabet, without nanoid. */
function newId(): string {
  return randomBytes(9).toString("base64url");
}

/** Few enough bound values per statement for either driver. */
const CHUNK = 200;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("backup_policy_destinations")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("policy_id", "text", (col) => col.notNull().references("backup_policies.id").onDelete("cascade"))
    .addColumn("destination_id", "text", (col) =>
      col.notNull().references("backup_destinations.id").onDelete("cascade")
    )
    .addColumn("position", "integer", (col) => col.notNull())
    .addColumn("own_retention", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("retention_count", "integer")
    .addColumn("retention_days", "integer")
    .addColumn("retention_bytes", "integer")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  // A destination appears once per policy: two copies in one place protect nothing.
  await db.schema
    .createIndex("idx_backup_policy_destinations_unique")
    .ifNotExists()
    .unique()
    .on("backup_policy_destinations")
    .columns(["policy_id", "destination_id"])
    .execute();

  // "Which policies write here", asked before a destination is deleted.
  await db.schema
    .createIndex("idx_backup_policy_destinations_destination")
    .ifNotExists()
    .on("backup_policy_destinations")
    .column("destination_id")
    .execute();

  await db.schema
    .createTable("backup_run_copies")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("run_id", "text", (col) => col.notNull().references("backup_runs.id").onDelete("cascade"))
    .addColumn("destination_id", "text", (col) => col.references("backup_destinations.id").onDelete("set null"))
    .addColumn("destination_name", "text", (col) => col.notNull())
    .addColumn("destination_type", "text", (col) => col.notNull())
    .addColumn("position", "integer", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("ref", "text")
    .addColumn("bytes", "integer")
    .addColumn("error_message", "text")
    .addColumn("started_at", "text")
    .addColumn("finished_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_backup_run_copies_run")
    .ifNotExists()
    .on("backup_run_copies")
    .column("run_id")
    .execute();

  // One copy per destination and run. NULLs are distinct on both drivers, so
  // the copies left behind by deleted destinations do not collide.
  await db.schema
    .createIndex("idx_backup_run_copies_run_destination")
    .ifNotExists()
    .unique()
    .on("backup_run_copies")
    .columns(["run_id", "destination_id"])
    .execute();

  // What each destination holds, and retention walking one destination's copies.
  await db.schema
    .createIndex("idx_backup_run_copies_destination")
    .ifNotExists()
    .on("backup_run_copies")
    .columns(["destination_id", "status"])
    .execute();

  await backfill(db as unknown as Store);
}

async function backfill(db: Store): Promise<void> {
  const now = new Date().toISOString();

  // --- every policy: its one destination, as a list of one -------------------
  const listed = new Set(
    (await db.selectFrom("backup_policy_destinations").select("policy_id").execute()).map((row) => row.policy_id)
  );
  const policies = (await db.selectFrom("backup_policies").select(["id", "destination_id"]).execute()).filter(
    (policy) => !listed.has(policy.id)
  );
  for (let i = 0; i < policies.length; i += CHUNK) {
    await db
      .insertInto("backup_policy_destinations")
      .values(
        policies.slice(i, i + CHUNK).map((policy) => ({
          id: newId(),
          policy_id: policy.id,
          destination_id: policy.destination_id,
          position: 0,
          own_retention: 0,
          retention_count: null,
          retention_days: null,
          retention_bytes: null,
          created_at: now,
        }))
      )
      .execute();
  }

  // --- every run with an archive: that archive, as its one copy --------------
  const destinations = new Map(
    (await db.selectFrom("backup_destinations").select(["id", "name", "type"]).execute()).map((row) => [row.id, row])
  );
  const copied = new Set(
    (await db.selectFrom("backup_run_copies").select("run_id").execute()).map((row) => row.run_id)
  );
  const runs = (
    await db
      .selectFrom("backup_runs")
      .select(["id", "destination_id", "archive_path", "archive_bytes", "started_at", "finished_at"])
      .where("archive_path", "is not", null)
      .execute()
  ).filter((run) => !copied.has(run.id));

  for (let i = 0; i < runs.length; i += CHUNK) {
    await db
      .insertInto("backup_run_copies")
      .values(
        runs.slice(i, i + CHUNK).map((run) => {
          // A run whose destination was deleted kept its path: so does its copy,
          // with no destination, exactly as unreachable as it already was.
          const destination = run.destination_id ? destinations.get(run.destination_id) : undefined;
          return {
            id: newId(),
            run_id: run.id,
            destination_id: destination ? destination.id : null,
            destination_name: destination?.name ?? "destinazione eliminata",
            destination_type: destination?.type ?? "unknown",
            position: 0,
            status: "done",
            ref: run.archive_path,
            bytes: run.archive_bytes,
            error_message: null,
            started_at: run.started_at,
            finished_at: run.finished_at,
            created_at: now,
          };
        })
      )
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("backup_run_copies").ifExists().execute();
  await db.schema.dropTable("backup_policy_destinations").ifExists().execute();
}
