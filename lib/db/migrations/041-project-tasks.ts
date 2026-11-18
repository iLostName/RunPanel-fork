import { Kysely, sql } from "kysely";

/**
 * Scheduled tasks: a command a project runs on a schedule, and every time it
 * ran. See `services/tasks/`.
 *
 * Two tables rather than a field of the deploy contract, for the reason the
 * one-time commands give (migration 016): the contract is merged with the
 * repository's `runpanel.json`, so a command kept there would be shell that
 * anyone who can push could schedule. Nothing merges into these tables; the
 * only writer is an authenticated route.
 *
 * `project_tasks`
 *   cron          as typed; '' means "only when somebody presses Esegui ora"
 *   timezone      NULL follows the panel's zone, like a backup policy
 *   timeout_sec   the run is killed, with everything it started, past this
 *   service       Compose only: the service of the stack the command runs in
 *   runs_in       'container' | 'host', where the command was approved to run.
 *                 A project that moves from a container to the host does not
 *                 take its tasks along silently: they wait to be saved again
 *   next_run_at   the next due instant, and the scheduler's claim token
 *   last_run_id   the newest run, whatever it did; no foreign key, the run
 *                 may have been pruned
 *   consecutive_failures, failure_notified_at
 *                 what the notifier needs to say "it fails" once and "it
 *                 works again" once, not on every run
 *
 * `project_task_runs` — one row per occurrence, skipped ones included,
 * because "always leave a record" is the point of the table:
 *   status        running | succeeded | failed | timed_out | cancelled |
 *                 interrupted | skipped (lib/tasks-rules.ts)
 *   command       a copy, so the history says what ran after an edit
 *   output        capped: the head and the tail (lib/tasks-rules.ts);
 *                 `output_dropped` counts the characters left out
 *   error         why it failed, was stopped or was skipped, in words
 *   repeats       further identical skips folded into this row, so a task
 *                 skipped every minute for a day is one row and not 1440
 *   scheduled_for the instant it was due, for a scheduled run
 *
 * The partial unique index is the store's own guarantee that a task never
 * has two runs at once. The runner checks first, in memory; the index is what
 * makes a mistake there an error instead of a second process.
 *
 * Every step checks first, so the migration can run again over a store that
 * already has it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("project_tasks")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("command", "text", (col) => col.notNull())
    .addColumn("cron", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("timezone", "text")
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("timeout_sec", "integer", (col) => col.notNull().defaultTo(900))
    .addColumn("service", "text")
    .addColumn("runs_in", "text", (col) => col.notNull())
    .addColumn("next_run_at", "text")
    .addColumn("last_run_id", "text")
    .addColumn("consecutive_failures", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("failure_notified_at", "text")
    .addColumn("created_by", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_project_tasks_project")
    .ifNotExists()
    .on("project_tasks")
    .column("project_id")
    .execute();

  await db.schema
    .createTable("project_task_runs")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_id", "text", (col) => col.notNull().references("project_tasks.id").onDelete("cascade"))
    .addColumn("project_id", "text", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("trigger", "text", (col) => col.notNull())
    .addColumn("triggered_by", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("command", "text", (col) => col.notNull())
    .addColumn("scheduled_for", "text")
    .addColumn("started_at", "text", (col) => col.notNull())
    .addColumn("finished_at", "text")
    .addColumn("exit_code", "integer")
    .addColumn("output", "text")
    .addColumn("output_dropped", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error", "text")
    .addColumn("repeats", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  // The history of one task, newest first, and the pruning that keeps it short.
  await db.schema
    .createIndex("idx_project_task_runs_task_started")
    .ifNotExists()
    .on("project_task_runs")
    .columns(["task_id", "started_at"])
    .execute();

  // At most one run in flight per task. Partial indexes are the same statement
  // on SQLite and Postgres; Kysely writes the literal into the DDL.
  await db.schema
    .createIndex("idx_project_task_runs_one_running")
    .ifNotExists()
    .unique()
    .on("project_task_runs")
    .column("task_id")
    .where(sql.ref("status"), "=", "running")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("project_task_runs").ifExists().execute();
  await db.schema.dropTable("project_tasks").ifExists().execute();
}
