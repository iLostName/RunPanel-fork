/**
 * One operation at a time on a project, across everything that can start one.
 *
 * The project's `status` column used to be the only lock, and it only ever
 * covered deploys. A restart, a checkout move, a mount apply and the autostart
 * reconciler all stop and start the same process over the same checkout, and
 * none of them claimed anything: a deploy could begin in the middle of a restart
 * and have its `deploying` claim overwritten by the restart's final
 * `status = running`, which let a second deploy start on top of the first.
 *
 * In memory rather than a column, because the panel is a single process and a
 * column would survive the crash that ended the operation holding it. On
 * `globalThis` because route modules and `instrumentation` are bundled apart
 * (and HMR reloads them): a module-level Map would be several Maps.
 *
 * No imports, on purpose: `project-lock-unit` loads this file directly.
 */

export type ProjectOperation =
  | "deploy"
  | "restart"
  | "stop"
  | "repo-move"
  | "mount-apply"
  | "autostart"
  | "restore"
  | "upload"
  | "reset";

export type ReleaseLock = () => void;

interface LockState {
  held: Map<string, ProjectOperation>;
  listeners: Set<(projectId: string) => void>;
  panelClosing: boolean;
}

const KEY = Symbol.for("runpanel.project-lock");
const store = globalThis as unknown as Record<symbol, LockState | undefined>;
const state: LockState = (store[KEY] ??= {
  held: new Map(),
  listeners: new Set(),
  panelClosing: false,
});

/** What a restart, stop or app delete answers while a deploy owns the project. */
export const DEPLOYING_MESSAGE = "Un deploy è in corso su questo progetto: aspetta che finisca.";

const BUSY_MESSAGES: Record<ProjectOperation, string> = {
  deploy: DEPLOYING_MESSAGE,
  restart: "Il progetto si sta riavviando: aspetta che finisca.",
  stop: "Il progetto si sta fermando: aspetta che finisca.",
  "repo-move": "Il checkout di questo progetto si sta spostando: aspetta che finisca.",
  "mount-apply": "Si stanno applicando i bind di questo progetto: aspetta che finisca.",
  autostart: "Il progetto si sta avviando: aspetta che finisca.",
  restore: "È in corso un ripristino su questo progetto: aspetta che finisca.",
  upload: "Si sta caricando una nuova versione di questo progetto: aspetta che finisca.",
  reset: "L'app di questo progetto si sta rimuovendo: aspetta che finisca.",
};

export const PANEL_CLOSING_MESSAGE =
  "Il pannello si sta riavviando per un aggiornamento: riprova tra poco.";

/**
 * Take the project, or null when something else has it.
 *
 * The release function is idempotent, so a `finally` can call it whatever path
 * got there.
 */
export function tryLock(projectId: string, operation: ProjectOperation): ReleaseLock | null {
  if (state.panelClosing || state.held.has(projectId)) return null;
  state.held.set(projectId, operation);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.held.delete(projectId);
    for (const listener of state.listeners) {
      try {
        listener(projectId);
      } catch (err) {
        console.error("[project-lock] Listener failed:", err);
      }
    }
  };
}

export function lockHolder(projectId: string): ProjectOperation | null {
  return state.held.get(projectId) ?? null;
}

/** Everything under way right now, on any project. */
export function heldOperations(): ProjectOperation[] {
  return [...state.held.values()];
}

/** Why `tryLock` just said no, in words an operator can act on. */
export function busyMessage(projectId: string): string {
  if (state.panelClosing) return PANEL_CLOSING_MESSAGE;
  const holder = lockHolder(projectId);
  return holder ? BUSY_MESSAGES[holder] : "Il progetto è occupato: riprova tra poco.";
}

/** Called after every release. The deploy queue uses it to run what was waiting. */
export function onLockReleased(listener: (projectId: string) => void): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/**
 * Refuse every new operation from here on, for the panel's own restart.
 *
 * `updateBlockers()` is a plain read, so on its own it leaves a gap between the
 * check and the exit in which a deploy could start, only to have its build
 * killed with the panel. Set before that check, which also reads what is held
 * here, the two together have no gap.
 */
export function setPanelClosing(closing: boolean): void {
  state.panelClosing = closing;
}

export function isPanelClosing(): boolean {
  return state.panelClosing;
}
