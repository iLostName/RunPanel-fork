import { Kysely } from "kysely";

/**
 * The uptime check: one request a minute to each app, and the incidents it
 * opens and closes. See `services/uptime/checker.ts`.
 *
 * The checks themselves go into `metric_samples` (033) under the scope
 * `'uptime'`, as two more measured columns: `up` (1 for an answer, 0 for a
 * failure — so an average is the share of checks that passed) and `latency`
 * (milliseconds to the first byte). That gets them the same roll-ups and the
 * same purge as every other series for free: a day of minutes for the
 * response-time chart, a month of quarter-hours for the 30-day figure.
 *
 * An incident is a row of its own because its edges matter more than its
 * average — when it started, when it ended, what the app said — and because it
 * has to survive a restart open: an app that was down when the panel stopped
 * must be announced as back when it answers again, not silently forgotten.
 *
 *   cause       why the first failing checks failed (`timeout`, `refused`,
 *               `status:502`…; `lib/uptime-math.ts` says them in words)
 *   resolution  how it ended: `recovered`, or `paused` when the project stopped
 *               being checked (stopped, redeployed, deleted from the check) —
 *               which is an end of the watch, not a recovery
 *
 * Timestamps are ISO text like the rest of the schema: these rows are few, and
 * they are read by people.
 *
 * Every step checks first, so the migration can run again over a store that
 * already has it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tables = await db.introspection.getTables();
  const existing = new Set(tables.find((t) => t.name === "metric_samples")?.columns.map((c) => c.name) ?? []);

  // One statement per column: SQLite accepts a single ADD COLUMN per ALTER.
  if (!existing.has("up")) {
    await db.schema.alterTable("metric_samples").addColumn("up", "double precision").execute();
  }
  if (!existing.has("latency")) {
    await db.schema.alterTable("metric_samples").addColumn("latency", "double precision").execute();
  }

  await db.schema
    .createTable("uptime_incidents")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("started_at", "text", (col) => col.notNull())
    .addColumn("ended_at", "text")
    .addColumn("cause", "text")
    .addColumn("resolution", "text")
    .execute();

  // The card lists a project's latest incidents; the checker looks for the open one.
  await db.schema
    .createIndex("idx_uptime_incidents_project_started")
    .ifNotExists()
    .on("uptime_incidents")
    .columns(["project_id", "started_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("uptime_incidents").ifExists().execute();
  await db.schema.alterTable("metric_samples").dropColumn("latency").execute();
  await db.schema.alterTable("metric_samples").dropColumn("up").execute();
}
