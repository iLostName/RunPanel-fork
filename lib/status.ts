/**
 * The single source of truth for how a status looks.
 *
 * There used to be four independent maps — one in StatusBadge, one in the home
 * page, and two in the monitor page (the same map written twice in one file) —
 * which is why a "running" dot and a "running" chip could disagree. Everything
 * that renders a status now goes through here.
 */

export type StatusTone = "success" | "warning" | "danger" | "neutral";

export type KnownStatus =
  | "running"
  | "stopped"
  | "deploying"
  | "error"
  | "pending"
  | "building"
  | "failed"
  | "superseded"
  | "checking"
  | "success"
  | "partial"
  | "canceled"
  | "skipped"
  | "uploading"
  | "unreachable";

interface StatusMeta {
  tone: StatusTone;
  label: string;
  /** Whether the indicator should pulse — reserved for genuinely in-flight states. */
  active?: boolean;
}

const STATUS_META: Record<KnownStatus, StatusMeta> = {
  // Italian like the rest of the panel. The lifecycle states were left as the
  // English tokens the API uses, which put "Stopped" next to "Riuscito" on the
  // same screen; the tokens are still what the code compares, only the label
  // changed.
  running: { tone: "success", label: "In esecuzione" },
  stopped: { tone: "neutral", label: "Fermo" },
  deploying: { tone: "warning", label: "Deploy in corso", active: true },
  building: { tone: "warning", label: "Build in corso", active: true },
  pending: { tone: "neutral", label: "In attesa", active: true },
  checking: { tone: "neutral", label: "Verifica", active: true },
  error: { tone: "danger", label: "Errore" },
  failed: { tone: "danger", label: "Fallito" },
  superseded: { tone: "neutral", label: "Sostituito" },
  success: { tone: "success", label: "Riuscito" },
  // A backup where some targets failed still has value, so it is not an error —
  // but it must not read as a clean night either.
  partial: { tone: "warning", label: "Parziale" },
  canceled: { tone: "neutral", label: "Annullato" },
  skipped: { tone: "neutral", label: "Saltato" },
  // A copy of a backup on its way to one of the destinations.
  uploading: { tone: "warning", label: "Copia in corso", active: true },
  // Not a state of the project: the server holding it did not answer, so this
  // is the last thing known about it.
  unreachable: { tone: "danger", label: "Non raggiungibile" },
};

/** What a start, stop or restart of a service reads as: the tokens are the API's, not the operator's. */
const SERVICE_CONTROL = {
  start: { done: "Servizio avviato", failed: "Avvio non riuscito" },
  stop: { done: "Servizio fermato", failed: "Arresto non riuscito" },
  restart: { done: "Servizio riavviato", failed: "Riavvio non riuscito" },
} as const;

export function serviceControlText(action: keyof typeof SERVICE_CONTROL): { done: string; failed: string } {
  return SERVICE_CONTROL[action];
}

/** The same for a project: only the subject of the outcome changes. */
const PROJECT_CONTROL_DONE = { start: "Progetto avviato", stop: "Progetto fermato", restart: "Progetto riavviato" } as const;

export function projectControlText(action: keyof typeof SERVICE_CONTROL): { done: string; failed: string } {
  return { done: PROJECT_CONTROL_DONE[action], failed: SERVICE_CONTROL[action].failed };
}

/**
 * What a status nothing here knows reads as.
 *
 * It used to fall back to "Fermo", which is a claim: a value from a newer
 * server, or a state added to the API and forgotten here, showed a project as
 * stopped when nobody knew that. Every status the store and the API produce has
 * its own entry above, so this only ever covers the case it names.
 */
const UNKNOWN_STATUS: StatusMeta = { tone: "neutral", label: "Sconosciuto" };

export function statusMeta(status: string): StatusMeta {
  return Object.hasOwn(STATUS_META, status) ? STATUS_META[status as KnownStatus] : UNKNOWN_STATUS;
}


export const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-muted",
};

export const TONE_SOFT: Record<StatusTone, string> = {
  success: "text-success bg-success/10",
  warning: "text-warning bg-warning/10",
  danger: "text-danger bg-danger/10",
  neutral: "text-muted bg-default",
};


// --- Reconciling a stored status with what is actually running ---------------
//
// The `status` column of a project or a service is written when the panel
// starts or stops something, and by nothing else — so it records the last
// command RunPanel issued, not the state of the machine. The two part company
// whenever something stops without going through the panel: a host reboot, an
// OOM kill, a `docker stop` from a shell, a crash past PM2's restart limit, or
// the panel itself going down and taking its children with it.
//
// The rule lives here rather than next to the sweep in
// `services/status-reconcile.ts` because it is a pure function of a status and
// an observation, and because that file cannot be loaded outside Next — this
// one has no imports at all, which is what lets `status-unit` check the rule
// without a server, a database or a process manager.

/**
 * Whether a stored status may be overwritten by an observation.
 *
 * `deploying` belongs to the deploy queue, which is mid-flight by definition,
 * and `error` records something neither answer can express: the deploy
 * pipeline writes it when a deploy failed *while the previous process kept
 * running*, so both "running" and "stopped" would erase the only trace of the
 * failure. Exported so a caller can skip asking the process manager about a
 * row whose answer it would discard — some drivers cost a process spawn.
 */
export function isReconcilable(current: string): boolean {
  return current === "running" || current === "stopped";
}

/**
 * The status to write, or `null` to leave the row as it is.
 *
 * `previous` is what the sweep before this one observed, `undefined` on the
 * first pass. It exists for one direction only: writing "stopped" onto a row
 * that claims to be running needs two readings that agree, because a single
 * one is not trustworthy. `pm2 jlist` answers with an empty listing when it
 * fails mid-write, Docker is still restarting its own containers for the first
 * half-minute after a reboot, and either would flip every project to Stopped
 * and back one sweep later — a lie that moves, which is worse than the stale
 * value it replaced.
 *
 * The other direction is written immediately: a driver that reports a process
 * as running has just seen it, and there is nothing to be careful about.
 */
export function reconciledStatus(
  current: string,
  observed: boolean,
  previous: boolean | undefined
): "running" | "stopped" | null {
  if (!isReconcilable(current)) return null;
  if (observed) return current === "running" ? null : "running";
  if (current !== "running") return null;
  return previous === false ? "stopped" : null;
}
