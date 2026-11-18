import fs from "fs";
import path from "path";
import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import type { Dialect } from "kysely";
import { getEnv } from "../env";
import { ensureDataDirs } from "../config";
import type { Database } from "./schema";
import { StaticMigrationProvider } from "./migrations";
import { forgetRenamedMigrations } from "./renamed-migrations";
import { restrictStoreFiles } from "./store-permissions";
import { nowIso, rowCount } from "./compat";

export type { Database } from "./schema";
export * from "./compat";

/**
 * The pre-Kysely store tracked its own schema in a `_migrations` table and was
 * created by hand-written SQL. Its tables collide with migration 001, so a file
 * from that era cannot simply be opened.
 *
 * It is moved aside rather than deleted — the old rows stay on disk next to the
 * new store if anyone needs to go back for them.
 */
async function archiveLegacySqliteStore(file: string): Promise<void> {
  if (!fs.existsSync(file)) return;

  const { default: SQLite } = await import("better-sqlite3");
  let isLegacy = false;

  // Opened read-write deliberately. A database with a live WAL cannot be read
  // through a readonly handle — SQLite needs to write the -shm index to do it —
  // and this file is about to be renamed anyway. Closing the handle also
  // checkpoints the WAL, so the rename below moves a single tidy file.
  let probe: import("better-sqlite3").Database | null = null;
  try {
    probe = new SQLite(file);
    const hasLegacyTable = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .get();
    const hasKyselyTable = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kysely_migration'")
      .get();
    isLegacy = Boolean(hasLegacyTable) && !hasKyselyTable;
  } catch (err) {
    // Say so rather than silently skipping — a swallowed error here shows up
    // much later as an unexplained "table already exists" during migration.
    console.warn("[RunPanel] Could not inspect the existing store:", err);
    return;
  } finally {
    probe?.close();
  }

  if (!isLegacy) return;

  const archived = `${file}.legacy-${Date.now()}`;
  fs.renameSync(file, archived);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, archived + suffix);
  }

  console.warn(
    `[RunPanel] Found a store from the previous schema and moved it to ${path.basename(archived)}. ` +
      "A fresh store has been created; the old file was not deleted."
  );
}

/**
 * Drivers are imported lazily so that a Postgres deployment never has to load
 * better-sqlite3's native binding, and vice versa.
 */
async function createDialect(): Promise<Dialect> {
  const { db: dbConfig } = getEnv();

  if (dbConfig.driver === "sqlite") {
    ensureDataDirs();
    await archiveLegacySqliteStore(dbConfig.file);

    const { default: SQLite } = await import("better-sqlite3");
    const { SqliteDialect } = await import("kysely");

    const sqlite = new SQLite(dbConfig.file);
    sqlite.pragma("journal_mode = WAL");
    restrictStoreFiles(dbConfig.file);
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    // The pairing WAL is meant to have. The default `FULL` fsyncs on every
    // commit, and this store commits constantly — a session's `last_seen_at`,
    // a run's heartbeat, each deploy status change. With WAL, `NORMAL` still
    // survives a process crash; only a power cut can cost the last commits.
    sqlite.pragma("synchronous = NORMAL");

    return new SqliteDialect({ database: sqlite });
  }

  const { Pool } = await import("pg");
  const { PostgresDialect } = await import("kysely");

  // Only set `ssl` when explicitly asked, so an `sslmode=` already present in a
  // connection string keeps working through pg's own parser.
  const ssl =
    dbConfig.ssl === "disable"
      ? undefined
      : { rejectUnauthorized: dbConfig.ssl === "require" };

  /**
   * Without these two, a request that arrives when every connection is busy
   * waits forever instead of failing, and a connection is kept open long after
   * the burst that needed it.
   */
  const timeouts = { idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 };

  const pool = dbConfig.connectionString
    ? new Pool({ connectionString: dbConfig.connectionString, max: dbConfig.poolMax, ssl, ...timeouts })
    : new Pool({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        max: dbConfig.poolMax,
        ssl,
        ...timeouts,
      });

  /**
   * Required, not defensive.
   *
   * `pg` emits `error` on the Pool when a client that is sitting IDLE dies —
   * the database restarted, a firewall dropped the connection. An `error` event
   * with no listener is an unhandled exception, so without this line a routine
   * Postgres restart takes the panel down with it. Kysely retries on the next
   * query; the pool discards the dead client by itself.
   */
  pool.on("error", (err) => {
    console.error("[db] Idle Postgres client failed:", err.message);
  });

  return new PostgresDialect({ pool });
}

async function runMigrations(db: Kysely<Database>, { quiet = false } = {}): Promise<void> {
  // Before the Migrator reads its table: a recorded name it no longer knows
  // stops it from migrating at all. See `lib/db/renamed-migrations.ts`.
  const forgotten = await forgetRenamedMigrations(db);
  if (forgotten > 0) {
    console.log(`[RunPanel] Forgot ${forgotten} renamed migration record(s); they run again under their new names`);
  }

  /*
    Unordered on purpose. Kysely refuses to start when a migration arrives
    whose name sorts before one already run — and that is exactly what a fork
    merging parallel work produces: a store that ran 037 meets 035 on the next
    update, and the panel would not start at all. Every migration here is
    written to be independent and idempotent (it checks before it creates),
    so running a late one is safe, while refusing to boot is not. A recorded
    migration that has disappeared still stops the migrator.
  */
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider(), allowUnorderedMigrations: true });
  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === "Error") {
      console.error(`[RunPanel] Migration failed: ${result.migrationName}`);
    } else if (result.status === "Success" && !quiet) {
      console.log(`[RunPanel] Applied migration ${result.migrationName}`);
    }
  }

  if (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * A deploy that was in flight when the server died leaves rows claiming work is
 * still happening. Nothing will ever finish them, so reconcile at startup.
 */
async function recoverFromCrash(db: Kysely<Database>): Promise<void> {
  const deployments = await db
    .updateTable("deployments")
    .set({
      status: "failed",
      error_message: "Il server è stato riavviato durante il deploy",
      finished_at: nowIso(),
    })
    .where("status", "in", ["pending", "building"])
    .executeTakeFirst();

  const projects = await db
    .updateTable("projects")
    .set({ status: "stopped", updated_at: nowIso() })
    .where("status", "=", "deploying")
    .executeTakeFirst();

  // A copy on its way when the process died did not arrive. It says so, and
  // can be sent again from the run's page.
  await db
    .updateTable("backup_run_copies")
    .set({
      status: "failed",
      error_message: "Il server è stato riavviato durante la copia",
      finished_at: nowIso(),
    })
    .where("status", "in", ["pending", "uploading"])
    .execute();

  // An archive that reached at least one destination before the process died
  // is a backup, whatever happened to the copies after it: the run closes as
  // it would have, with the copies that did not arrive marked above.
  const recovered = await recoverRunsWithCopies(db);

  // A half-written archive is not a backup, and a restore that stopped partway
  // is the state an operator most needs to see. Both are left claiming to be in
  // flight, and nothing will ever come back to finish them.
  const backups = await db
    .updateTable("backup_runs")
    .set({
      status: "failed",
      error_message: "Il server è stato riavviato durante il backup",
      finished_at: nowIso(),
    })
    .where("status", "=", "running")
    .executeTakeFirst();

  const restores = await db
    .updateTable("restore_runs")
    .set({
      status: "failed",
      error_message: "Il server è stato riavviato durante il ripristino",
      finished_at: nowIso(),
    })
    .where("status", "=", "running")
    .executeTakeFirst();

  /*
    A `claimed` one-time command is owned by a deploy in flight, and after a
    restart no deploy is in flight — the statements above have just said so. So
    it goes back in the queue.

    The hazard is real and cannot be closed without a two-phase commit: a
    command that DID run, and whose outcome was never written, comes back queued
    and will run again. Re-running is the right default — the alternative is
    silently marking a migration done that may never have happened. It is made
    visible instead of hidden: `attempts` is incremented and `started_at`
    written BEFORE the process is spawned, so a row that comes back with
    `started_at` set was genuinely interrupted, and the queue says so.

    Two statements, in this order, because the note belongs only on the rows
    that actually started.
  */
  const interrupted = await db
    .updateTable("one_time_commands")
    .set({
      status: "queued",
      deployment_id: null,
      error_message: "Il server è stato riavviato durante l'esecuzione",
      finished_at: nowIso(),
    })
    .where("status", "=", "claimed")
    .where("started_at", "is not", null)
    .executeTakeFirst();

  const unclaimed = await db
    .updateTable("one_time_commands")
    .set({ status: "queued", deployment_id: null })
    .where("status", "=", "claimed")
    .executeTakeFirst();

  const deployCount = rowCount(deployments);
  const projectCount = rowCount(projects);
  const backupCount = rowCount(backups);
  const restoreCount = rowCount(restores);
  const oneTimeCount = rowCount(interrupted) + rowCount(unclaimed);
  if (deployCount > 0 || projectCount > 0 || backupCount > 0 || restoreCount > 0 || oneTimeCount > 0 || recovered > 0) {
    console.log(
      `[RunPanel] Crash recovery: ${deployCount} deployment(s) marked failed, ` +
        `${projectCount} project(s) reset to stopped, ` +
        `${recovered} backup(s) closed with the copies that arrived, ` +
        `${backupCount} backup(s) and ${restoreCount} restore(s) marked failed, ` +
        `${oneTimeCount} one-time command(s) put back in the queue`
    );
  }
}

/**
 * Close the runs interrupted after their archive reached a destination: as
 * `success`, or `partial` when some item had failed — what the runner would
 * have written — pointing at the first copy that arrived. Counts them.
 */
async function recoverRunsWithCopies(db: Kysely<Database>): Promise<number> {
  const running = await db.selectFrom("backup_runs").select("id").where("status", "=", "running").execute();
  let recovered = 0;
  for (const run of running) {
    const done = await db
      .selectFrom("backup_run_copies")
      .select(["ref", "bytes", "destination_id"])
      .where("run_id", "=", run.id)
      .where("status", "=", "done")
      .orderBy("position", "asc")
      .execute();
    if (done.length === 0) continue;

    const failed = await db
      .selectFrom("backup_artifacts")
      .select("id")
      .where("run_id", "=", run.id)
      .where("status", "=", "failed")
      .execute();
    const primary = done.find((copy) => copy.destination_id !== null) ?? done[0];
    await db
      .updateTable("backup_runs")
      .set({
        status: failed.length > 0 ? "partial" : "success",
        archive_path: primary.ref,
        archive_bytes: primary.bytes,
        destination_id: primary.destination_id,
        error_message: failed.length > 0 ? `${failed.length} elementi non salvati` : null,
        finished_at: nowIso(),
      })
      .where("id", "=", run.id)
      .execute();
    recovered++;
  }
  return recovered;
}

/**
 * True inside `next build`, which sets this before it renders any page.
 *
 * The build renders every page once to learn which ones are static, and the
 * panel's pages reach the store while doing it. That build runs next to the
 * panel that is serving — the self-update builds the new version while the
 * old one is still up — so with the configured store it migrated the live
 * database to a schema the running version does not know (if the update then
 * fails and rolls back, the old version can no longer boot: Kysely refuses a
 * recorded migration it has no file for), ran crash recovery over a deploy
 * started in the meantime and marked it failed, and could move a legacy store
 * aside. None of that belongs to a build.
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/**
 * The store while building: an empty SQLite in memory, whatever the panel is
 * configured with — a Postgres install must not be reached by its build either.
 * Migrated, so a page that queries it while being probed gets empty results
 * instead of "no such table"; the pages that matter read cookies and are
 * rendered per request anyway. Each build worker gets its own, and nothing it
 * holds outlives the build.
 */
async function createBuildDb(): Promise<Kysely<Database>> {
  const { default: SQLite } = await import("better-sqlite3");
  const { SqliteDialect } = await import("kysely");
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new SQLite(":memory:") }) });
  await runMigrations(db, { quiet: true });
  return db;
}

async function createDb(): Promise<Kysely<Database>> {
  if (isBuildPhase()) return createBuildDb();

  const dialect = await createDialect();
  const db = new Kysely<Database>({ dialect });

  await runMigrations(db);
  await recoverFromCrash(db);

  const { db: cfg } = getEnv();
  console.log(`[RunPanel] Store ready (${cfg.driver})`);

  return db;
}

/**
 * Held on `globalThis` so Next's dev-mode module reloading does not open a new
 * connection pool (or a second SQLite handle) on every edit.
 */
const globalRef = globalThis as typeof globalThis & {
  __runpanelDb?: Promise<Kysely<Database>>;
};

export function getDb(): Promise<Kysely<Database>> {
  if (!globalRef.__runpanelDb) {
    globalRef.__runpanelDb = createDb().catch((err) => {
      // Never cache a failed init — the next request should retry rather than
      // inherit a permanently rejected promise.
      globalRef.__runpanelDb = undefined;
      throw err;
    });
  }
  return globalRef.__runpanelDb;
}

