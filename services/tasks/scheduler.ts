import { nextAfter, parseCron } from "@/lib/cron";
import { getDb, rowCount } from "@/lib/db";
import type { ProjectTasksTable } from "@/lib/db/schema";
import { dueVerdict, MAX_PARALLEL_SCHEDULED_RUNS, SKIP_REASONS } from "@/lib/tasks-rules";
import { isTaskRunning, scheduledRunsInFlight, startRun } from "./runner";
import { panelTimeZone, recordSkip, zoneOf } from "./store";

/**
 * The tick that makes a scheduled task happen.
 *
 * The shape of `services/restart-scheduler.ts` and the backup scheduler: a
 * thirty-second timer behind a globalThis guard, and a claim — `next_run_at`
 * moved forward by a conditional UPDATE, so whoever wins owns the occurrence
 * and a second tick cannot see it as due. Nothing depends on the period: an
 * occurrence runs because its instant passed, once.
 *
 * Never a pile-up. An occurrence is claimed before anything is decided about
 * it, and a claimed occurrence is either run or written down as skipped —
 * never kept for later. One that comes due while the panel was down runs once,
 * late, within the grace `lateGraceMs` allows; past that it is recorded as
 * missed and the schedule carries on from now, however many were missed.
 *
 * The zone is re-read on every tick, which is also what keeps a task that
 * follows the panel's zone honest when that zone changes: a not-yet-due
 * `next_run_at` that no longer matches the schedule is recomputed here, with
 * no hook needed in the settings route.
 */

const TICK_MS = 30_000;
/** Long enough after boot for the store and Docker to be ready. */
const FIRST_TICK_DELAY_MS = 20_000;

const globalRef = globalThis as typeof globalThis & {
  __runpanelTaskTimer?: NodeJS.Timeout;
  __runpanelTaskFirstTick?: NodeJS.Timeout;
  __runpanelTaskTickBusy?: boolean;
};

export function startTaskScheduler(): void {
  if (globalRef.__runpanelTaskTimer) return;

  globalRef.__runpanelTaskTimer = setInterval(() => void tick(), TICK_MS);
  globalRef.__runpanelTaskTimer.unref?.();

  globalRef.__runpanelTaskFirstTick = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  globalRef.__runpanelTaskFirstTick.unref?.();
}

export interface TaskTickResult {
  due: number;
  started: number;
  skipped: number;
  missed: number;
  /** Left for the next tick: the panel already had its scheduled runs going. */
  deferred: number;
  rescheduled: number;
}

/** Exported so a test can drive a tick without waiting thirty seconds for one. */
export async function tick(now = new Date()): Promise<TaskTickResult> {
  const result: TaskTickResult = { due: 0, started: 0, skipped: 0, missed: 0, deferred: 0, rescheduled: 0 };
  // A tick that outlives the period — a slow Docker answering about a dozen
  // due tasks — must not be joined by the next one. The claims would keep them
  // apart anyway; this keeps them from doing the same reads twice.
  if (globalRef.__runpanelTaskTickBusy) return result;
  globalRef.__runpanelTaskTickBusy = true;

  try {
    const db = await getDb();
    const zone = await panelTimeZone();
    const tasks = await db
      .selectFrom("project_tasks")
      .selectAll()
      .where("enabled", "=", 1)
      .where("cron", "!=", "")
      .orderBy("next_run_at")
      .execute();

    for (const task of tasks) {
      try {
        await consider(task, now, zone, result);
      } catch (err) {
        // One task that throws must not keep the others from running.
        console.error(`[tasks] "${task.name}": tick fallito:`, err);
      }
    }
  } catch (err) {
    // A tick that throws must not kill the interval.
    console.error("[tasks] Tick fallito:", err);
  } finally {
    globalRef.__runpanelTaskTickBusy = false;
  }

  return result;
}

async function consider(task: ProjectTasksTable, now: Date, panelZone: string, result: TaskTickResult): Promise<void> {
  const parsed = parseCron(task.cron);
  if (!parsed.ok) {
    console.error(`[tasks] Pianificazione non valida su "${task.name}": ${parsed.error}`);
    return;
  }
  const zone = zoneOf(task, panelZone);
  const upcoming = nextAfter(parsed.spec, now, zone);

  // Never scheduled (written by hand, or by a route that could not compute
  // it): a next occurrence and nothing else.
  if (!task.next_run_at) {
    if (upcoming) await setNext(task, upcoming);
    return;
  }

  const due = Date.parse(task.next_run_at);
  const following = Number.isFinite(due) ? nextAfter(parsed.spec, new Date(due), zone) : null;
  const spacing = following ? following.getTime() - due : null;
  const verdict = dueVerdict(task.next_run_at, now.getTime(), spacing);

  if (verdict === "not-due") {
    // For a schedule that has not changed, the next occurrence after now IS
    // the stored one. When they differ the zone or the expression moved under
    // it, and the stored instant belongs to a schedule that no longer exists.
    const expected = upcoming ? upcoming.toISOString() : null;
    if (expected !== task.next_run_at && (await setNext(task, upcoming))) result.rescheduled++;
    return;
  }

  result.due++;

  if (verdict === "missed") {
    if (!(await claim(task, upcoming))) return;
    await recordSkip(task, {
      trigger: "schedule",
      reason: SKIP_REASONS.missed,
      scheduledFor: task.next_run_at,
      keepLast: isTaskRunning(task.id),
    });
    console.log(`[tasks] "${task.name}": esecuzione delle ${task.next_run_at} persa, registrata come saltata`);
    result.missed++;
    return;
  }

  // Not claimed: still due at the next tick, and missed only if the panel
  // stays this busy for longer than the grace.
  if (scheduledRunsInFlight() >= MAX_PARALLEL_SCHEDULED_RUNS) {
    result.deferred++;
    return;
  }

  if (!(await claim(task, upcoming))) return;
  const outcome = await startRun(task.id, { trigger: "schedule", scheduledFor: task.next_run_at });
  if (outcome.status === "started") result.started++;
  else result.skipped++;
}

/**
 * Take the occurrence by moving `next_run_at`, but only if it is still the
 * value read. One conditional UPDATE on both drivers; the row count says
 * whether we won.
 */
async function claim(task: ProjectTasksTable, next: Date | null): Promise<boolean> {
  if (!task.next_run_at) return false;
  const db = await getDb();
  const result = await db
    .updateTable("project_tasks")
    .set({ next_run_at: next ? next.toISOString() : null })
    .where("id", "=", task.id)
    .where("next_run_at", "=", task.next_run_at)
    .executeTakeFirst();
  return rowCount(result) === 1;
}

/** The same conditional write, for a reschedule that runs nothing. */
async function setNext(task: ProjectTasksTable, next: Date | null): Promise<boolean> {
  const db = await getDb();
  let query = db
    .updateTable("project_tasks")
    .set({ next_run_at: next ? next.toISOString() : null })
    .where("id", "=", task.id);
  query = task.next_run_at === null ? query.where("next_run_at", "is", null) : query.where("next_run_at", "=", task.next_run_at);
  return rowCount(await query.executeTakeFirst()) === 1;
}
