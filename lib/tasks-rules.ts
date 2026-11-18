/**
 * Scheduled tasks: the rules, and the words for them.
 *
 * A task is a command a project runs on a schedule, unattended, on somebody's
 * real server. Everything that decides what happens to it lives here, kept
 * free of imports so `tasks-unit` can drive the whole matrix without a store,
 * a daemon or a clock, and so the settings page can say the same words the
 * server writes:
 *
 *  - when an occurrence is due, and when it is too late to still count as
 *    that occurrence (`planTick`) — a panel that was down at 03:00 runs the
 *    nightly once when it is back within the grace, and records it as missed
 *    after that. Never one run per missed occurrence: tasks do not pile up;
 *  - whether a run may start (`decideStart`): never twice at once — not even
 *    beside a run a panel restart lost track of — never while a deploy or
 *    anything else holds the project, never on a project that moved between
 *    a container and the host, or started reaching the host, since the
 *    command was saved;
 *  - what a finished run means for the failure streak, and whether that is
 *    worth a notification (`afterRun`);
 *  - how much output is kept (`OutputCapture`).
 *
 * The status of a run, once and for all:
 *
 *   running      in flight; at most one per task (the store enforces it too)
 *   succeeded    exit code 0
 *   failed       a non-zero exit code, or the command could not be started
 *   timed_out    killed, with everything it started, at the task's limit
 *   cancelled    stopped by a person, or because a deploy took the project
 *   interrupted  the panel restarted while it ran
 *   skipped      did not start; `error` says why — a container that refused
 *                the exec (paused, restarting) is one too
 *
 * Only `failed` and `timed_out` are failures. A skip, a stop and an
 * interruption say nothing about whether the command works, so they neither
 * start nor end a streak.
 */

export const TASK_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "skipped",
] as const;
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

export type TaskTrigger = "schedule" | "manual";

/** Where a command runs: inside the app's container, or on the host as the panel's own user. */
export type TaskRunsIn = "container" | "host";

export function runsInFor(runtimeType: string): TaskRunsIn {
  return runtimeType === "docker" || runtimeType === "compose" ? "container" : "host";
}

// --- Limits ---------------------------------------------------------------------

export const TASK_TIMEOUT_DEFAULT_SEC = 15 * 60;
export const TASK_TIMEOUT_MIN_SEC = 10;
export const TASK_TIMEOUT_MAX_SEC = 24 * 3600;
/** What the editor offers before "altro". */
export const TASK_TIMEOUT_CHOICES = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600] as const;

/** Same as the one-time commands and the contract's commands: the same kind of value. */
export const TASK_COMMAND_MAX = 4000;
export const TASK_NAME_MAX = 80;
export const MAX_TASKS_PER_PROJECT = 50;
/** Runs kept per task, skips included; the oldest go after each new one. */
export const RUNS_KEPT_PER_TASK = 50;
/**
 * Scheduled runs at once across the panel. A due task over the limit waits for
 * the next tick instead of starting: twenty nightly jobs at 03:00 are twenty
 * processes the host did not plan for. "Esegui ora" is not counted — a person
 * asked, and sees the answer.
 */
export const MAX_PARALLEL_SCHEDULED_RUNS = 4;
/** While a task keeps failing, the reminder that it still does: at most this often. */
export const FAILURE_REMINDER_MS = 12 * 3600_000;

export function formatTimeout(seconds: number): string {
  if (seconds < 60) return `${seconds} secondi`;
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? "1 minuto" : `${minutes} minuti`;
  }
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) return hours === 1 ? "1 ora" : `${hours} ore`;
  return `${Math.floor(hours)} h ${Math.round((seconds % 3600) / 60)} min`;
}

// --- When an occurrence is due ---------------------------------------------------

export const LATE_GRACE_MIN_MS = 90_000;
export const LATE_GRACE_MAX_MS = 3_600_000;

/**
 * How late a run may start and still be the occurrence it was due for.
 *
 * Half the gap to the next occurrence, so a late run never lands closer to the
 * next one than to its own; at least ninety seconds, three ticks, so a tick
 * that ran a little late does not throw away a run every minute; at most an
 * hour, so a nightly job meant for the quiet hours does not start at nine in
 * the morning because the server came back then.
 */
export function lateGraceMs(spacingMs: number | null): number {
  if (spacingMs === null || !Number.isFinite(spacingMs) || spacingMs <= 0) return LATE_GRACE_MAX_MS;
  return Math.min(LATE_GRACE_MAX_MS, Math.max(LATE_GRACE_MIN_MS, Math.floor(spacingMs / 2)));
}

export type TickPlan =
  | { kind: "wait" }
  /** Run the occurrence due at `scheduledFor`, and move the schedule to `next`. */
  | { kind: "run"; scheduledFor: number; next: number | null }
  /**
   * The due occurrence is past its grace: one missed record for it and for
   * everything up to now, the schedule moved to `next` — and `catchUp`, a
   * later occurrence that is still within its own grace and runs, late.
   */
  | { kind: "missed"; next: number | null; catchUp: number | null };

/**
 * What a tick does with a task whose next occurrence is `dueMs`.
 *
 * `next(from)` is the first occurrence strictly after `from` (`lib/cron.ts`'s
 * `nextAfter`, in the task's zone), passed in so the scheduler and the tests
 * run the same function. It is the expensive part — a minute schedule costs
 * tens of milliseconds a call late in the day — so it is asked as little as
 * possible: once for a run on time, when the occurrence after the due one is
 * also the one after now, and a few more times only after an outage.
 *
 * After an outage the stored occurrence is the OLDEST one missed; what may
 * still be worth running is the newest. An hourly task back at 10:00:30 after
 * a night down records 07:00–09:00 as missed and runs 10:00 — never 07:00,
 * 08:00, 09:00 and 10:00 one after the other.
 */
export function planTick(dueMs: number, now: number, next: (fromMs: number) => number | null): TickPlan {
  if (!Number.isFinite(dueMs) || dueMs > now) return { kind: "wait" };

  const following = next(dueMs);
  if (now - dueMs <= lateGraceMs(following === null ? null : following - dueMs)) {
    return { kind: "run", scheduledFor: dueMs, next: following !== null && following > now ? following : next(now) };
  }

  const upcoming = next(now);
  const after = upcoming === null ? null : next(upcoming);
  const window = lateGraceMs(upcoming !== null && after !== null ? after - upcoming : null);
  const recent = next(now - window - 1);
  const catchUp = recent !== null && recent <= now && recent > dueMs ? recent : null;
  return { kind: "missed", next: upcoming, catchUp };
}

// --- Whether a run may start -----------------------------------------------------

export type SkipCode =
  | "running"
  | "orphan"
  | "deploying"
  | "busy"
  | "panel-closing"
  | "context-changed"
  | "host-review"
  | "not-running"
  | "no-directory"
  | "missed";

export interface StartFacts {
  /** This task already has a run in flight. */
  alreadyRunning: boolean;
  /**
   * Until when a run cut off by a panel restart may still be going, or null.
   * See `orphanDeadline`.
   */
  orphanUntil?: number | null;
  now?: number;
  /** What holds the project in `services/project-lock.ts`: `deploy`, `restart`… */
  lockHolder: string | null;
  /** The lock's own sentence for it, when something holds it. */
  busyMessage?: string | null;
  projectStatus: string;
  panelClosing: boolean;
  /** Where the command was saved to run, and where the project runs now. */
  savedRunsIn: TaskRunsIn;
  currentRunsIn: TaskRunsIn;
  /** Whether the project reaches the host now (`projectReachesHost`), and whether the command was saved by someone allowed there. */
  reachesHost?: boolean;
  hostApproved?: boolean;
}

export type StartDecision = { start: true } | { start: false; code: SkipCode; reason: string };

export const SKIP_REASONS: Record<SkipCode, string> = {
  running: "l'esecuzione precedente è ancora in corso",
  orphan: "l'esecuzione interrotta dal riavvio del pannello potrebbe essere ancora in corso",
  deploying: "era in corso un deploy del progetto",
  busy: "il progetto era occupato da un'altra operazione",
  "panel-closing": "il pannello si stava riavviando",
  "context-changed":
    "il progetto ora gira in un altro modo: apri l'attività e salvala di nuovo per confermare dove deve girare il comando",
  "host-review":
    "il progetto ora raggiunge l'host: serve che qualcuno con il permesso «Accesso all'host» apra l'attività e la salvi di nuovo",
  "not-running": "l'app non è in esecuzione",
  "no-directory": "il progetto non ha ancora una cartella sul server: fai prima un deploy",
  missed: "non è partita all'orario previsto: il pannello era spento o troppo occupato",
};

/**
 * Why a saved task waits to be saved again before it runs, or null.
 *
 * Two things can change under a command after it was approved: where it runs
 * (a project moved between a container and the host — the command was written
 * for the other one), and what the place it runs can reach (a container given
 * host networking, capabilities or bind mounts, by somebody else, after a
 * manager without the host permission wrote the command for a plain one).
 */
export function reviewCode(facts: Pick<StartFacts, "savedRunsIn" | "currentRunsIn" | "reachesHost" | "hostApproved">): SkipCode | null {
  if (facts.savedRunsIn !== facts.currentRunsIn) return "context-changed";
  if (facts.reachesHost && !facts.hostApproved) return "host-review";
  return null;
}

/**
 * Until when a run the panel lost track of may still be running.
 *
 * A run cut off by a panel restart is recorded as interrupted, but its process
 * may well be alive: an orderly exit sends it TERM, a crash sends nothing. Its
 * backstop — `timeout` on the host, the watchdog in a container — ends it by
 * its start plus its limit plus the backstop's margin at the latest, and
 * until then a new run of the same task could land beside it. So until then
 * a new run waits, and says why.
 */
export function orphanDeadline(run: { status: string; error: string | null; startedAt: string } | null, timeoutSec: number, backstopSec: number): number | null {
  if (!run || run.status !== "interrupted" || run.error !== INTERRUPTED_MESSAGE) return null;
  const started = Date.parse(run.startedAt);
  return Number.isFinite(started) ? started + (timeoutSec + backstopSec) * 1000 : null;
}

/**
 * The checks that need nothing but memory, in the order that gives the most
 * useful reason. A deploy wins over any other holder of the lock: it is the
 * one an operator is most likely to be looking at.
 */
export function decideStart(facts: StartFacts): StartDecision {
  const skip = (code: SkipCode, reason = SKIP_REASONS[code]): StartDecision => ({ start: false, code, reason });

  if (facts.alreadyRunning) return skip("running");
  if (facts.orphanUntil && (facts.now ?? Date.now()) < facts.orphanUntil) return skip("orphan");
  if (facts.panelClosing) return skip("panel-closing");
  if (facts.lockHolder === "deploy" || facts.projectStatus === "deploying") return skip("deploying");
  if (facts.lockHolder) return skip("busy", facts.busyMessage?.trim() ? trimSentence(facts.busyMessage) : SKIP_REASONS.busy);
  const review = reviewCode(facts);
  if (review) return skip(review);
  return { start: true };
}

/** "Il progetto si sta riavviando: aspetta che finisca." → "il progetto si sta riavviando". */
function trimSentence(message: string): string {
  const head = message.split(":")[0].trim().replace(/\.$/, "");
  return head.charAt(0).toLowerCase() + head.slice(1);
}

// --- What a run means ------------------------------------------------------------

export function isFailure(status: TaskRunStatus): boolean {
  return status === "failed" || status === "timed_out";
}

export interface Streak {
  consecutiveFailures: number;
  /** When the current streak was last announced; null when it never was. */
  failureNotifiedAt: string | null;
}

export type StreakNotice = "failed" | "recovered" | null;

/**
 * The streak after a run, and what to announce.
 *
 *  - A scheduled failure is announced when it starts a streak, and again at
 *    most every twelve hours while the streak lasts: a nightly job that fails
 *    every night says so every morning, one that fails every minute does not
 *    say so every minute.
 *  - A failure of "Esegui ora" counts in the streak but announces nothing:
 *    the person who pressed it is looking at the answer. The next scheduled
 *    failure then announces the streak, since nobody was told of it yet.
 *  - The first success after an announced failure says it works again —
 *    whoever triggered it, because the channel heard the failure.
 */
export function afterRun(
  previous: Streak,
  status: TaskRunStatus,
  trigger: TaskTrigger,
  now: number
): { streak: Streak; notice: StreakNotice } {
  if (status === "succeeded") {
    return {
      streak: { consecutiveFailures: 0, failureNotifiedAt: null },
      notice: previous.failureNotifiedAt ? "recovered" : null,
    };
  }

  if (!isFailure(status)) return { streak: previous, notice: null };

  const failures = previous.consecutiveFailures + 1;
  const lastNotice = previous.failureNotifiedAt ? Date.parse(previous.failureNotifiedAt) : NaN;
  const due = !Number.isFinite(lastNotice) || now - lastNotice >= FAILURE_REMINDER_MS;

  if (trigger === "schedule" && due) {
    return {
      streak: { consecutiveFailures: failures, failureNotifiedAt: new Date(now).toISOString() },
      notice: "failed",
    };
  }
  return { streak: { consecutiveFailures: failures, failureNotifiedAt: previous.failureNotifiedAt }, notice: null };
}

// --- What the store can hold -------------------------------------------------------

/**
 * Text as both drivers accept it. Postgres refuses a NUL character in `text`
 * outright, and output is whatever the command printed — a binary blob on
 * stdout would otherwise lose the whole record of the run.
 */
export function storableText(text: string): string {
  return text.includes("\u0000") ? text.replace(/\u0000/g, "�") : text;
}

/**
 * A number as an `integer` column holds it. A Windows exit code is an
 * unsigned 32-bit NTSTATUS (0xC0000005 is 3221225477), which overflows a
 * signed column: it is stored as the signed value Windows tools print
 * (-1073741819). Anything else out of range is clamped.
 */
export function storableInt(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const whole = Math.trunc(value);
  if (whole > 2147483647 && whole <= 4294967295) return whole - 4294967296;
  return Math.min(2147483647, Math.max(-2147483648, whole));
}

// --- Words -----------------------------------------------------------------------

export const STATUS_LABEL: Record<TaskRunStatus, string> = {
  running: "In corso",
  succeeded: "Riuscita",
  failed: "Non riuscita",
  timed_out: "Tempo scaduto",
  cancelled: "Fermata",
  interrupted: "Interrotta",
  skipped: "Saltata",
};

export type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger";

export const STATUS_TONE: Record<TaskRunStatus, StatusTone> = {
  running: "accent",
  succeeded: "success",
  failed: "danger",
  timed_out: "danger",
  cancelled: "neutral",
  interrupted: "warning",
  skipped: "warning",
};

/** The outcome of a run as a phrase that follows "ultima esecuzione": "riuscita", "non riuscita (codice 2)". */
export function outcomePhrase(run: { status: TaskRunStatus; exitCode: number | null; repeats?: number }): string {
  switch (run.status) {
    case "running":
      return "in corso";
    case "succeeded":
      return "riuscita";
    case "failed":
      return run.exitCode !== null ? `non riuscita (codice ${run.exitCode})` : "non riuscita";
    case "timed_out":
      return "fermata al tempo massimo";
    case "cancelled":
      return "fermata";
    case "interrupted":
      return "interrotta dal riavvio del pannello";
    case "skipped":
      return run.repeats ? `saltata (${run.repeats + 1} volte di fila)` : "saltata";
  }
}

/** The text a stop is recorded with, so the history and the notification say the same. */
export function timeoutMessage(seconds: number): string {
  return `Fermata dopo ${formatTimeout(seconds)}: è il tempo massimo di questa attività`;
}

export const INTERRUPTED_MESSAGE = "Il pannello si è riavviato mentre girava";

/** The last line that says something, for a notification on a phone. */
export function lastMeaningfulLine(output: string, limit = 200): string | null {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/^\[stderr\]\s?/, "").trim();
    if (line && !line.startsWith("… ")) return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  }
  return null;
}

// --- Output ------------------------------------------------------------------------

/**
 * The head and the tail of what a run printed.
 *
 * A task is unattended, so its output is the only witness — and a task that
 * loops printing the same line would otherwise fill the store. The beginning
 * says what started; the end says how it ended, which is the part a failure
 * is read from, so it gets most of the room. What falls in between is counted
 * and said, never silently cut.
 *
 * Fields are declared and assigned, not constructor parameter properties: the
 * strip-only loader `tasks-unit` uses rejects those.
 */
export const OUTPUT_HEAD_CHARS = 8_000;
export const OUTPUT_TAIL_CHARS = 56_000;

export class OutputCapture {
  private head = "";
  private tail = "";
  private droppedChars = 0;
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(headLimit = OUTPUT_HEAD_CHARS, tailLimit = OUTPUT_TAIL_CHARS) {
    this.headLimit = headLimit;
    this.tailLimit = tailLimit;
  }

  push(text: string): void {
    if (!text) return;
    let rest = text;
    if (this.droppedChars === 0 && this.tail.length === 0 && this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
      if (!rest) return;
    }
    this.tail += rest;
    // Trimmed in batches, so a stream of small chunks costs one slice per
    // tailLimit characters rather than one per chunk.
    if (this.tail.length > this.tailLimit * 2) this.trim();
  }

  private trim(): void {
    const excess = this.tail.length - this.tailLimit;
    if (excess <= 0) return;
    this.droppedChars += excess;
    this.tail = this.tail.slice(excess);
  }

  /** Characters printed and not kept. */
  get dropped(): number {
    this.trim();
    return this.droppedChars;
  }

  get size(): number {
    this.trim();
    return this.head.length + this.tail.length;
  }

  text(): string {
    this.trim();
    if (this.droppedChars === 0) return this.head + this.tail;
    // Start the tail at a line, when one begins close enough to the cut.
    let tail = this.tail;
    let partial = 0;
    const newline = tail.indexOf("\n");
    if (newline >= 0 && newline < 500) {
      partial = newline + 1;
      tail = tail.slice(partial);
    }
    const gap = `… ${formatChars(this.droppedChars + partial)} di output non conservati …`;
    return `${this.head}${this.head.endsWith("\n") ? "" : "\n"}${gap}\n${tail}`;
  }
}

function formatChars(count: number): string {
  if (count < 1024) return `${count} caratteri`;
  if (count < 1024 * 1024) return `${Math.round(count / 1024)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

// --- What the API answers ------------------------------------------------------------

/** One run, without its output. */
export interface TaskRunSummary {
  id: string;
  trigger: TaskTrigger;
  status: TaskRunStatus;
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  repeats: number;
  durationMs: number | null;
}

export interface TaskRunDetail extends TaskRunSummary {
  command: string;
  output: string;
  outputDropped: number;
  /** Read from the running process rather than the store: it is still printing. */
  live: boolean;
}

export interface TaskView {
  id: string;
  name: string;
  command: string;
  /** '' = only when somebody asks. */
  cron: string;
  /** The schedule in words, from the same code as the editor's preview. */
  schedule: string;
  /** Null follows the panel's zone. */
  timezone: string | null;
  enabled: boolean;
  timeoutSec: number;
  service: string | null;
  runsIn: TaskRunsIn;
  /** It waits, skipped, to be saved again: `reviewReason` says why. */
  needsReview: boolean;
  reviewReason: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  lastRun: TaskRunSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface TasksResponse {
  tasks: TaskView[];
  /** The zone a task without its own follows. */
  panelTimeZone: string;
  runsIn: TaskRunsIn;
  runtimeType: string;
  canEdit: boolean;
  /** Why editing is refused to someone who manages the project, when it is. */
  editBlockedReason: string | null;
  canRun: boolean;
  /** Compose only, and only when asked for: the services of the stack. */
  composeServices?: string[];
}
