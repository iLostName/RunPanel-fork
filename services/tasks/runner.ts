import { getDb } from "@/lib/db";
import type { ProjectTasksTable, ProjectsTable } from "@/lib/db/schema";
import {
  afterRun,
  decideStart,
  lastMeaningfulLine,
  OutputCapture,
  outcomePhrase,
  runsInFor,
  timeoutMessage,
  type SkipCode,
  type TaskRunStatus,
  type TaskTrigger,
} from "@/lib/tasks-rules";
import { generateId } from "@/lib/utils";
import { notify } from "../notify";
import { busyMessage, isPanelClosing, lockHolder } from "../project-lock";
import { execInContainer, execOnHost, type ExecOutcome } from "./exec";
import { insertRunningRow, pruneRuns, recordSkip } from "./store";
import { resolveTarget, type ExecTarget } from "./target";

/**
 * Running a task: one at a time per task, never against a project that is
 * being deployed, always with a record.
 *
 * The runs in flight live in memory, on `globalThis` like the deploy queue and
 * for the same reason — routes and the scheduler tick are bundled apart, and
 * one Map per bundle would be several Maps. The check that a task is not
 * already running and the reservation that makes it so are one synchronous
 * step, with no `await` between them, so two callers (a tick and a click on
 * "Esegui ora") cannot both pass it. The store's partial unique index is the
 * second line behind that one.
 *
 * A task does **not** take the project's lock. The lock means "the app is
 * being taken down and brought back on purpose": while it is held the uptime
 * check and the status sweep look away, and a stop or a restart is refused. A
 * task that held it for an hour would blind both and leave the operator unable
 * to stop their own app. Instead a task never starts while anything holds the
 * project, and gives way the moment something takes it: every second a run
 * looks at the lock — a lookup in a Map — and a deploy, a restart, a stop or a
 * restore starting on the project stops the task first. In a container the
 * deploy is about to replace, or under a checkout it is about to rewrite, the
 * command was going to be cut short or to run against half a version anyway.
 */

/** How often a run looks at the project's lock. */
const LOCK_WATCH_MS = 1_000;

interface RunHandle {
  runId: string;
  taskId: string;
  projectId: string;
  trigger: TaskTrigger;
  controller: AbortController;
  /** Set by whoever stops the run, before the abort: it is what the run is recorded as. */
  stop: { status: "timed_out" | "cancelled"; message: string } | null;
  output: OutputCapture;
  startedAt: number;
}

interface RunnerState {
  /** By task id. */
  running: Map<string, RunHandle>;
}

const KEY = Symbol.for("runpanel.tasks.runner");
const store = globalThis as unknown as Record<symbol, RunnerState | undefined>;
const state: RunnerState = (store[KEY] ??= { running: new Map() });

export type StartOutcome =
  | { status: "started"; runId: string }
  | { status: "skipped"; code: SkipCode; reason: string }
  | { status: "not-found" };

/** How many scheduled runs are going, for the tick's limit. A click on "Esegui ora" is not counted. */
export function scheduledRunsInFlight(): number {
  let count = 0;
  for (const handle of state.running.values()) if (handle.trigger === "schedule") count++;
  return count;
}

export function isTaskRunning(taskId: string): boolean {
  return state.running.has(taskId);
}

/** What a run in flight has printed so far, or null when it is not in flight here. */
export function liveOutput(runId: string): { output: string; dropped: number } | null {
  for (const handle of state.running.values()) {
    if (handle.runId === runId) return { output: handle.output.text(), dropped: handle.output.dropped };
  }
  return null;
}

function stopHandle(handle: RunHandle, status: "timed_out" | "cancelled", message: string): void {
  if (handle.stop) return;
  handle.stop = { status, message };
  handle.controller.abort();
}

/** Stop a task's run. False when it has none in flight. */
export function cancelRun(taskId: string, message = "Fermata a mano"): boolean {
  const handle = state.running.get(taskId);
  if (!handle) return false;
  stopHandle(handle, "cancelled", message);
  return true;
}

/** Stop a run because its task is going away: the row goes with the task, the process must not stay. */
export function stopForDelete(taskId: string): void {
  cancelRun(taskId, "Fermata: l'attività è stata eliminata");
}

function release(handle: RunHandle): void {
  if (state.running.get(handle.taskId) === handle) state.running.delete(handle.taskId);
}

/** Whatever holds the project right now, as a reason not to run; null when nothing does. */
function lockReason(projectId: string): { code: SkipCode; reason: string } | null {
  const holder = lockHolder(projectId);
  if (!holder) return null;
  const decision = decideStart({
    alreadyRunning: false,
    lockHolder: holder,
    busyMessage: busyMessage(projectId),
    projectStatus: "",
    panelClosing: false,
    savedRunsIn: "host",
    currentRunsIn: "host",
  });
  return decision.start ? null : { code: decision.code, reason: decision.reason };
}

/**
 * Start a run of a task, or say why not.
 *
 * A run that cannot start is recorded as skipped, whoever asked for it: that
 * is the record the history promises. The one exception is "Esegui ora" on a
 * task already running — the page offers "Ferma" there instead, and the
 * answer is enough.
 */
export async function startRun(
  taskId: string,
  opts: { trigger: TaskTrigger; userId?: string | null; scheduledFor?: string | null }
): Promise<StartOutcome> {
  const db = await getDb();
  const task = await db.selectFrom("project_tasks").selectAll().where("id", "=", taskId).executeTakeFirst();
  if (!task) return { status: "not-found" };
  const project = await db.selectFrom("projects").selectAll().where("id", "=", task.project_id).executeTakeFirst();
  if (!project) return { status: "not-found" };

  const refuse = async (code: SkipCode, reason: string): Promise<StartOutcome> => {
    if (opts.trigger === "schedule" || code !== "running") {
      await recordSkip(task, {
        trigger: opts.trigger,
        reason,
        scheduledFor: opts.scheduledFor ?? null,
        userId: opts.userId ?? null,
        // A skip because the previous run is still going must not hide it.
        keepLast: code === "running",
      });
      console.log(`[tasks] "${project.name}" › "${task.name}": saltata, ${reason}`);
    }
    return { status: "skipped", code, reason };
  };

  // From here to `set` nothing awaits: this is the check-and-reserve.
  const holder = lockHolder(project.id);
  const decision = decideStart({
    alreadyRunning: state.running.has(task.id),
    lockHolder: holder,
    busyMessage: holder ? busyMessage(project.id) : null,
    projectStatus: project.status,
    panelClosing: isPanelClosing(),
    savedRunsIn: task.runs_in,
    currentRunsIn: runsInFor(project.runtime_type),
  });
  if (!decision.start) return refuse(decision.code, decision.reason);

  const handle: RunHandle = {
    runId: generateId(),
    taskId: task.id,
    projectId: project.id,
    trigger: opts.trigger,
    controller: new AbortController(),
    stop: null,
    output: new OutputCapture(),
    startedAt: Date.now(),
  };
  state.running.set(task.id, handle);

  let target: ExecTarget;
  try {
    const resolved = await resolveTarget(project, task);
    if (!resolved.ok) {
      release(handle);
      return refuse(resolved.code, resolved.reason);
    }
    target = resolved.target;

    // Looking for the container takes a moment, and a deploy may have taken
    // the project meanwhile.
    const busy = lockReason(project.id);
    if (busy) {
      release(handle);
      return refuse(busy.code, busy.reason);
    }

    await insertRunningRow({
      id: handle.runId,
      taskId: task.id,
      projectId: project.id,
      trigger: opts.trigger,
      userId: opts.userId ?? null,
      command: task.command,
      scheduledFor: opts.scheduledFor ?? null,
      startedAt: new Date(handle.startedAt).toISOString(),
    });
  } catch (err) {
    release(handle);
    throw err;
  }

  console.log(`[tasks] "${project.name}" › "${task.name}": parte ${target.where}`);
  void execute(handle, task, project, target)
    .catch((err) => {
      console.error(`[tasks] "${project.name}" › "${task.name}": esito non registrato:`, err);
    })
    .finally(() => release(handle));

  return { status: "started", runId: handle.runId };
}

async function execute(handle: RunHandle, task: ProjectTasksTable, project: ProjectsTable, target: ExecTarget): Promise<void> {
  const timer = setTimeout(() => stopHandle(handle, "timed_out", timeoutMessage(task.timeout_sec)), task.timeout_sec * 1000);
  const watch = setInterval(() => {
    const busy = lockReason(project.id);
    if (!busy) return;
    stopHandle(handle, "cancelled", busy.code === "deploying" ? "Fermata: è partito un deploy del progetto" : `Fermata: ${busy.reason}`);
  }, LOCK_WATCH_MS);

  const opts = {
    signal: handle.controller.signal,
    onOutput: (text: string) => handle.output.push(text),
    limitSec: task.timeout_sec,
  };

  let outcome: ExecOutcome;
  try {
    outcome =
      target.kind === "container"
        ? await execInContainer(target.container, task.command, opts)
        : await execOnHost(target, task.command, opts);
  } catch (err) {
    outcome = { exitCode: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
  }

  await finish(handle, task, project, outcome);
}

/** What the run is recorded as: the stop when somebody stopped it, the process otherwise. */
function verdict(handle: RunHandle, outcome: ExecOutcome): { status: TaskRunStatus; error: string | null } {
  if (handle.stop) return { status: handle.stop.status, error: handle.stop.message };
  if (outcome.exitCode === 0 && !outcome.error) return { status: "succeeded", error: null };
  return {
    status: "failed",
    error: outcome.error ?? (outcome.exitCode !== null ? `Uscita con codice ${outcome.exitCode}` : "Terminata senza un codice di uscita"),
  };
}

async function finish(handle: RunHandle, task: ProjectTasksTable, project: ProjectsTable, outcome: ExecOutcome): Promise<void> {
  const db = await getDb();
  const { status, error } = verdict(handle, outcome);
  const output = handle.output.text();
  const finishedAt = Date.now();

  // Conditional on still running: a row closed by a recovery, or gone with
  // its project, is not written over.
  await db
    .updateTable("project_task_runs")
    .set({
      status,
      finished_at: new Date(finishedAt).toISOString(),
      exit_code: outcome.exitCode,
      output: output || null,
      output_dropped: handle.output.dropped,
      error,
    })
    .where("id", "=", handle.runId)
    .where("status", "=", "running")
    .execute();

  // Read again rather than trusting the row the run started with: the task
  // may have been renamed meanwhile, or deleted along with its project.
  const current = await db
    .selectFrom("project_tasks")
    .select(["id", "name", "consecutive_failures", "failure_notified_at"])
    .where("id", "=", task.id)
    .executeTakeFirst();
  if (!current) return;

  const previous = { consecutiveFailures: current.consecutive_failures, failureNotifiedAt: current.failure_notified_at };
  const { streak, notice } = afterRun(previous, status, handle.trigger, finishedAt);
  await db
    .updateTable("project_tasks")
    .set({ consecutive_failures: streak.consecutiveFailures, failure_notified_at: streak.failureNotifiedAt })
    .where("id", "=", task.id)
    .execute();
  await pruneRuns(task.id);

  const phrase = outcomePhrase({ status, exitCode: outcome.exitCode });
  console.log(`[tasks] "${project.name}" › "${current.name}": ${phrase}${error ? ` — ${error}` : ""}`);

  if (notice) {
    // It follows "«Pulizia» di «Shop»:" in the message.
    const said = error ?? phrase;
    void notify({
      key: "task.failed",
      up: notice === "recovered",
      project: project.name,
      task: current.name,
      outcome: said.charAt(0).toLowerCase() + said.slice(1),
      exitCode: outcome.exitCode,
      detail: notice === "failed" ? lastMeaningfulLine(output) : null,
      failures: notice === "recovered" ? previous.consecutiveFailures : streak.consecutiveFailures,
      durationMs: finishedAt - handle.startedAt,
      projectId: project.id,
      taskId: task.id,
    });
  }
}
