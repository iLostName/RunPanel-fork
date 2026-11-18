import { describeCron, isValidTimeZone, nextAfter, parseCron } from "@/lib/cron";
import { getDb, nowIso, rowCount } from "@/lib/db";
import type { ProjectTaskRunsTable, ProjectTasksTable } from "@/lib/db/schema";
import { cronSentence } from "@/lib/schedule";
import { getSetting } from "@/lib/settings";
import {
  INTERRUPTED_MESSAGE,
  RUNS_KEPT_PER_TASK,
  type TaskRunDetail,
  type TaskRunSummary,
  type TaskRunsIn,
  type TaskTrigger,
  type TaskView,
} from "@/lib/tasks-rules";
import { generateId } from "@/lib/utils";

/**
 * Reading and writing scheduled tasks and their runs.
 *
 * The rules are in `lib/tasks-rules.ts`, the running in `runner.ts`; this is
 * the store, and the shape the API answers with.
 */

/** The zone a task without its own follows: the panel's, then UTC — never the host's. */
export async function panelTimeZone(): Promise<string> {
  const stored = await getSetting("timezone");
  return stored && isValidTimeZone(stored) ? stored : "UTC";
}

export function zoneOf(task: Pick<ProjectTasksTable, "timezone">, panelZone: string): string {
  return task.timezone && isValidTimeZone(task.timezone) ? task.timezone : panelZone;
}

/**
 * The next due instant for a schedule, computed when it is saved.
 *
 * Here and not left to the tick: the page shows it as soon as the task is
 * saved, and the tick treats a task with no `next_run_at` as one to schedule,
 * never as one to run — saving a schedule must not fire it.
 */
export async function nextRunFor(
  task: Pick<ProjectTasksTable, "cron" | "timezone" | "enabled">,
  now = new Date()
): Promise<string | null> {
  if (!task.enabled || !task.cron) return null;
  const parsed = parseCron(task.cron);
  if (!parsed.ok) return null;
  const next = nextAfter(parsed.spec, now, zoneOf(task, await panelTimeZone()));
  return next ? next.toISOString() : null;
}

// --- Views ---------------------------------------------------------------------------

function durationOf(startedAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function runSummary(row: ProjectTaskRunsTable): TaskRunSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    error: row.error,
    repeats: row.repeats,
    durationMs: durationOf(row.started_at, row.finished_at),
  };
}

export function runDetail(row: ProjectTaskRunsTable, live: { output: string; dropped: number } | null): TaskRunDetail {
  return {
    ...runSummary(row),
    command: row.command,
    output: live ? live.output : row.output ?? "",
    outputDropped: live ? live.dropped : row.output_dropped,
    live: live !== null,
  };
}

/** The words the editor's preview uses for the same expression. */
export function scheduleWords(cron: string): string {
  return cron ? cronSentence(cron, describeCron(cron)) : cronSentence("");
}

export function taskView(row: ProjectTasksTable, lastRun: ProjectTaskRunsTable | null, currentRunsIn: TaskRunsIn): TaskView {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    cron: row.cron,
    schedule: scheduleWords(row.cron),
    timezone: row.timezone,
    enabled: row.enabled === 1,
    timeoutSec: row.timeout_sec,
    service: row.service,
    runsIn: row.runs_in,
    needsReview: row.runs_in !== currentRunsIn,
    nextRunAt: row.next_run_at,
    consecutiveFailures: row.consecutive_failures,
    lastRun: lastRun ? runSummary(lastRun) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A project's tasks, oldest first — the order they were added in. */
export async function listTasks(projectId: string, currentRunsIn: TaskRunsIn): Promise<TaskView[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("project_tasks")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("created_at")
    .execute();

  const lastIds = rows.flatMap((row) => (row.last_run_id ? [row.last_run_id] : []));
  const lastRuns = lastIds.length
    ? await db.selectFrom("project_task_runs").selectAll().where("id", "in", lastIds).execute()
    : [];
  const byId = new Map(lastRuns.map((run) => [run.id, run]));

  return rows.map((row) => taskView(row, row.last_run_id ? byId.get(row.last_run_id) ?? null : null, currentRunsIn));
}

export async function getTask(projectId: string, taskId: string): Promise<ProjectTasksTable | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("project_tasks")
    .selectAll()
    .where("id", "=", taskId)
    .where("project_id", "=", projectId)
    .executeTakeFirst();
  return row ?? null;
}

export async function taskViewOf(task: ProjectTasksTable, currentRunsIn: TaskRunsIn): Promise<TaskView> {
  const db = await getDb();
  const last = task.last_run_id
    ? await db.selectFrom("project_task_runs").selectAll().where("id", "=", task.last_run_id).executeTakeFirst()
    : undefined;
  return taskView(task, last ?? null, currentRunsIn);
}

export async function countTasks(projectId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.selectFrom("project_tasks").select("id").where("project_id", "=", projectId).execute();
  return rows.length;
}

export async function runHistory(taskId: string, limit = RUNS_KEPT_PER_TASK): Promise<TaskRunSummary[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("project_task_runs")
    .selectAll()
    .where("task_id", "=", taskId)
    .orderBy("started_at", "desc")
    .limit(limit)
    .execute();
  return rows.map(runSummary);
}

export async function getRun(taskId: string, runId: string): Promise<ProjectTaskRunsTable | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("project_task_runs")
    .selectAll()
    .where("id", "=", runId)
    .where("task_id", "=", taskId)
    .executeTakeFirst();
  return row ?? null;
}

// --- Writing runs ----------------------------------------------------------------------

/**
 * Keep the newest runs of a task and drop the rest. A run in flight is never
 * dropped, whatever its age.
 */
export async function pruneRuns(taskId: string): Promise<void> {
  const db = await getDb();
  const cutoff = await db
    .selectFrom("project_task_runs")
    .select("started_at")
    .where("task_id", "=", taskId)
    .orderBy("started_at", "desc")
    .limit(1)
    .offset(RUNS_KEPT_PER_TASK)
    .executeTakeFirst();
  if (!cutoff) return;
  await db
    .deleteFrom("project_task_runs")
    .where("task_id", "=", taskId)
    .where("started_at", "<=", cutoff.started_at)
    .where("status", "!=", "running")
    .execute();
}

/**
 * An occurrence that did not start, written down.
 *
 * The same reason as the newest row is folded into that row instead of adding
 * one: a task due every minute on an app that is down for a day would
 * otherwise push every real run out of its history with 1440 copies of
 * "l'app non è in esecuzione".
 *
 * `keepLast` leaves the task pointing at the run it already points at: a skip
 * because the previous run is still going must not hide that run, which is
 * what the page shows as in progress and then as the latest result.
 */
export async function recordSkip(
  task: Pick<ProjectTasksTable, "id" | "project_id" | "command">,
  skip: { trigger: TaskTrigger; reason: string; scheduledFor: string | null; userId?: string | null; keepLast?: boolean }
): Promise<string> {
  const db = await getDb();
  const now = nowIso();

  const newest = await db
    .selectFrom("project_task_runs")
    .select(["id", "status", "trigger", "error"])
    .where("task_id", "=", task.id)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (newest && newest.status === "skipped" && newest.trigger === skip.trigger && newest.error === skip.reason) {
    await db
      .updateTable("project_task_runs")
      .set((eb) => ({ repeats: eb("repeats", "+", 1), finished_at: now }))
      .where("id", "=", newest.id)
      .execute();
    return newest.id;
  }

  const id = generateId();
  await db
    .insertInto("project_task_runs")
    .values({
      id,
      task_id: task.id,
      project_id: task.project_id,
      trigger: skip.trigger,
      triggered_by: skip.userId ?? null,
      status: "skipped",
      command: task.command,
      scheduled_for: skip.scheduledFor,
      started_at: now,
      finished_at: now,
      exit_code: null,
      output: null,
      output_dropped: 0,
      error: skip.reason,
      repeats: 0,
    })
    .execute();
  if (!skip.keepLast) {
    await db.updateTable("project_tasks").set({ last_run_id: id }).where("id", "=", task.id).execute();
  }
  await pruneRuns(task.id);
  return id;
}

/**
 * Write the row of a run that is about to start.
 *
 * The partial unique index refuses a second `running` row for the task. The
 * runner has already made sure, in memory, that this process has no run of it
 * in flight — so a row it collides with was left by a process that died, one
 * the boot recovery has not seen, and it is closed as interrupted before the
 * new one goes in. Anything else is a real error and is thrown.
 */
export async function insertRunningRow(row: {
  id: string;
  taskId: string;
  projectId: string;
  trigger: TaskTrigger;
  userId: string | null;
  command: string;
  scheduledFor: string | null;
  startedAt: string;
}): Promise<void> {
  const db = await getDb();
  const values = {
    id: row.id,
    task_id: row.taskId,
    project_id: row.projectId,
    trigger: row.trigger,
    triggered_by: row.userId,
    status: "running" as const,
    command: row.command,
    scheduled_for: row.scheduledFor,
    started_at: row.startedAt,
    finished_at: null,
    exit_code: null,
    output: null,
    output_dropped: 0,
    error: null,
    repeats: 0,
  };

  try {
    await db.insertInto("project_task_runs").values(values).execute();
  } catch (err) {
    const repaired = await db
      .updateTable("project_task_runs")
      .set({ status: "interrupted", finished_at: nowIso(), error: INTERRUPTED_MESSAGE })
      .where("task_id", "=", row.taskId)
      .where("status", "=", "running")
      .executeTakeFirst();
    if (rowCount(repaired) === 0) throw err;
    await db.insertInto("project_task_runs").values(values).execute();
  }

  await db.updateTable("project_tasks").set({ last_run_id: row.id }).where("id", "=", row.taskId).execute();
}

/**
 * Close a run that was in flight when the panel went away.
 *
 * At boot, before anything can start one: no run of this process exists yet,
 * so every `running` row belongs to the one that died. Interrupted is not a
 * failure — the command may well have been fine — so the streak is not
 * touched. Inside a container the command may even still be going: it ends at
 * its own limit there (see `CONTAINER_WRAPPER`).
 */
export async function recoverInterruptedRuns(): Promise<number> {
  const db = await getDb();
  const result = await db
    .updateTable("project_task_runs")
    .set({ status: "interrupted", finished_at: nowIso(), error: INTERRUPTED_MESSAGE })
    .where("status", "=", "running")
    .executeTakeFirst();
  return rowCount(result);
}
