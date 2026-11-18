import { nextAfter, parseCron } from "@/lib/cron";
import { getDb, rowCount } from "@/lib/db";
import type { ProjectTasksTable } from "@/lib/db/schema";
import { MAX_PARALLEL_SCHEDULED_RUNS, planTick, SKIP_REASONS } from "@/lib/tasks-rules";
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
 * never kept for later. What a tick does with a due task is `planTick` in
 * `lib/tasks-rules.ts`, the same function the unit suite replays: on time or
 * late within the grace, it runs; past that, one missed record, and the newest
 * occurrence that is still within its grace runs instead, however many were
 * missed in between.
 *
 * Cheap for a task that is not due: no cron arithmetic at all, which for a
 * minute schedule late in the day costs tens of milliseconds a call. The one
 * thing such a task is checked for is the zone it was scheduled in — the
 * panel's zone can change under a task that follows it, and the stored
 * instant then belongs to a clock that is no longer the task's.
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
  const next = (fromMs: number): number | null => nextAfter(parsed.spec, new Date(fromMs), zone)?.getTime() ?? null;

  // Never scheduled, scheduled in another zone, or a value nobody can read:
  // a next occurrence from now, and nothing else — rescheduling never runs.
  const dueMs = task.next_run_at ? Date.parse(task.next_run_at) : NaN;
  if (!Number.isFinite(dueMs) || task.schedule_zone !== zone) {
    const upcoming = next(now.getTime());
    // An expression that can never fire (a 30th of February) stays as it is.
    if (upcoming === null && task.next_run_at === null && task.schedule_zone === zone) return;
    if (await setNext(task, upcoming, zone)) result.rescheduled++;
    return;
  }

  const plan = planTick(dueMs, now.getTime(), next);
  if (plan.kind === "wait") return;
  result.due++;

  // Not claimed when the panel is at its limit: still due at the next tick,
  // and missed only if it stays this busy for longer than the grace.
  const wantsRun = plan.kind === "run" || plan.catchUp !== null;
  if (wantsRun && scheduledRunsInFlight() >= MAX_PARALLEL_SCHEDULED_RUNS) {
    result.deferred++;
    return;
  }

  if (!(await claim(task, plan.next))) return;

  if (plan.kind === "missed") {
    await recordSkip(task, {
      trigger: "schedule",
      reason: SKIP_REASONS.missed,
      scheduledFor: task.next_run_at,
      keepLast: isTaskRunning(task.id),
    });
    console.log(`[tasks] "${task.name}": esecuzione delle ${task.next_run_at} persa, registrata come saltata`);
    result.missed++;
    if (plan.catchUp === null) return;
  }

  const scheduledFor = new Date(plan.kind === "run" ? plan.scheduledFor : (plan.catchUp as number)).toISOString();
  try {
    const outcome = await startRun(task.id, { trigger: "schedule", scheduledFor });
    if (outcome.status === "started") result.started++;
    else result.skipped++;
  } catch (err) {
    // The occurrence is claimed: whatever went wrong, it leaves a record.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tasks] "${task.name}": avvio non riuscito:`, message);
    await recordSkip(task, {
      trigger: "schedule",
      reason: `non è partita per un errore del pannello: ${message.slice(0, 200)}`,
      scheduledFor,
      keepLast: isTaskRunning(task.id),
    }).catch(() => {});
    result.skipped++;
  }
}

/**
 * Take the occurrence by moving `next_run_at`, but only if it is still the
 * value read. One conditional UPDATE on both drivers; the row count says
 * whether we won.
 */
async function claim(task: ProjectTasksTable, next: number | null): Promise<boolean> {
  if (!task.next_run_at) return false;
  const db = await getDb();
  const result = await db
    .updateTable("project_tasks")
    .set({ next_run_at: next === null ? null : new Date(next).toISOString() })
    .where("id", "=", task.id)
    .where("next_run_at", "=", task.next_run_at)
    .executeTakeFirst();
  return rowCount(result) === 1;
}

/** The same conditional write, for a reschedule that runs nothing. */
async function setNext(task: ProjectTasksTable, next: number | null, zone: string): Promise<boolean> {
  const db = await getDb();
  let query = db
    .updateTable("project_tasks")
    .set({ next_run_at: next === null ? null : new Date(next).toISOString(), schedule_zone: zone })
    .where("id", "=", task.id);
  query = task.next_run_at === null ? query.where("next_run_at", "is", null) : query.where("next_run_at", "=", task.next_run_at);
  return rowCount(await query.executeTakeFirst()) === 1;
}
