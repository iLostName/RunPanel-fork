import { getDb, nowIso, rowCount } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { executeDeploy } from "./deploy-pipeline";
import {
  isPanelClosing,
  lockHolder,
  onLockReleased,
  tryLock,
  type ReleaseLock,
} from "./project-lock";

/**
 * Serialises deploys per project, and remembers one follow-up.
 *
 * Two deploys of the same project must never overlap — they fight over the same
 * checkout, the same container name and the same port. The conditional claim
 * guarantees that, but on its own it just rejects the second request, which for
 * a webhook means a push is silently dropped: someone pushes a fix while a
 * deploy is running and nothing ever builds it.
 *
 * So a request that arrives during a deploy is *coalesced* instead. At most one
 * follow-up is remembered, because the follow-up always pulls the latest commit
 * — queueing five pushes would just build the same head five times.
 *
 * "During a deploy" means during anything that holds the project's lock: a
 * request that lands in the middle of a restart or a checkout move waits for it
 * the same way, and runs when the lock comes free.
 */

type Trigger = "manual" | "webhook" | "poll";

interface QueuedRequest {
  mode: "deploy" | "rebuild";
  trigger: Trigger;
  commitSha: string | null;
  commitMessage: string | null;
}

export interface EnqueueResult {
  status: "started" | "queued" | "not-found" | "unavailable";
  deploymentId?: string;
}

interface RunningDeploy {
  controller: AbortController;
  /** Resolves when the pipeline is over. It never rejects. */
  settled: Promise<void>;
}

interface QueueState {
  pending: Map<string, QueuedRequest>;
  running: Map<string, RunningDeploy>;
  /** Replaced on every module load, so an HMR reload leaves one listener. */
  unsubscribe: (() => void) | null;
}

// On `globalThis` for the reason the lock is: the routes and the poll timer in
// `instrumentation` do not share module instances, and a follow-up remembered in
// one copy of a Map would never be seen by the deploy finishing in another.
const KEY = Symbol.for("runpanel.deploy-queue");
const store = globalThis as unknown as Record<symbol, QueueState | undefined>;
const state: QueueState = (store[KEY] ??= {
  pending: new Map(),
  running: new Map(),
  unsubscribe: null,
});

interface Claimed {
  project: ProjectsTable;
  release: ReleaseLock;
}

async function claim(projectId: string): Promise<Claimed | null | "busy"> {
  const db = await getDb();
  const read = () =>
    db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();

  const release = tryLock(projectId, "deploy");
  if (!release) return (await read()) ? "busy" : null;

  try {
    // After the lock, not before: the row is what the pipeline trusts, so it has
    // to be read once nothing else can be changing it.
    const before = await read();
    if (!before) {
      release();
      return null;
    }

    const claimed = await db
      .updateTable("projects")
      .set({ status: "deploying", updated_at: nowIso() })
      .where("id", "=", projectId)
      .where("status", "!=", "deploying")
      .executeTakeFirst();

    if (rowCount(claimed) === 0) {
      release();
      return "busy";
    }
    return { project: before, release };
  } catch (err) {
    release();
    throw err;
  }
}

async function createDeploymentRow(
  projectId: string,
  request: QueuedRequest
): Promise<string> {
  const db = await getDb();
  const deploymentId = generateId();

  await db
    .insertInto("deployments")
    .values({
      id: deploymentId,
      project_id: projectId,
      trigger_type: request.trigger,
      commit_sha: request.commitSha,
      commit_message: request.commitMessage,
      status: "pending",
      started_at: nowIso(),
      finished_at: null,
      error_message: null,
      start_cmd: null,
      artifact_dir: null,
    })
    .execute();

  return deploymentId;
}

/** Run a claimed deploy in the background. The lock is released when it ends. */
async function launch({ project, release }: Claimed, request: QueuedRequest): Promise<string> {
  let deploymentId: string;
  try {
    deploymentId = await createDeploymentRow(project.id, request);
  } catch (err) {
    // Nothing will ever finish this deploy, so the claim has to be given back
    // here or the project reads `deploying` until the panel restarts.
    try {
      const db = await getDb();
      await db
        .updateTable("projects")
        .set({ status: project.status, updated_at: nowIso() })
        .where("id", "=", project.id)
        .execute();
    } catch (rollback) {
      console.error(`[deploy-queue] Could not give back the claim on ${project.slug}:`, rollback);
    } finally {
      release();
    }
    throw err;
  }

  const controller = new AbortController();
  const settled = executeDeploy(project, deploymentId, {
    mode: request.mode,
    signal: controller.signal,
  })
    .catch((err) => {
      console.error(`[deploy-queue] Deploy failed for ${project.slug}:`, err);
    })
    .finally(() => {
      state.running.delete(project.id);
      release();
    });

  state.running.set(project.id, { controller, settled });
  return deploymentId;
}

/** Start what was waiting for this project, if the project is free. */
function drain(projectId: string): void {
  const next = state.pending.get(projectId);
  if (!next) return;
  state.pending.delete(projectId);

  void (async () => {
    // Re-read: the queued run must see the project as it is now, including the
    // status the run that just finished left behind.
    const claimed = await claim(projectId);
    if (claimed === null) return;
    if (claimed === "busy") {
      // Something took the project first, and its release comes back here. A
      // newer request that arrived meanwhile wins, as it always does.
      if (!state.pending.has(projectId)) state.pending.set(projectId, next);
      return;
    }
    await launch(claimed, next);
  })().catch((err) => {
    console.error(`[deploy-queue] Queued deploy failed for ${projectId}:`, err);
  });
}

state.unsubscribe?.();
state.unsubscribe = onLockReleased(drain);

export async function enqueueDeploy(
  projectId: string,
  request: QueuedRequest
): Promise<EnqueueResult> {
  // Not queued: the queue is in memory and the process is about to exit, so
  // "queued" would be a promise nobody is left to keep.
  if (isPanelClosing()) return { status: "unavailable" };

  const claimed = await claim(projectId);
  if (claimed === null) return { status: "not-found" };

  if (claimed === "busy") {
    // Replace rather than append: the follow-up will fetch the latest commit
    // anyway, so remembering more than one would rebuild the same head twice.
    state.pending.set(projectId, request);
    // The holder may have let go while this was being decided, and then no
    // release is coming to pick the request up.
    if (!lockHolder(projectId)) drain(projectId);
    return { status: "queued" };
  }

  const deploymentId = await launch(claimed, request);
  return { status: "started", deploymentId };
}

/** Forget a project's queued run, e.g. when it is deleted mid-deploy. */
export function clearQueuedDeploy(projectId: string): void {
  state.pending.delete(projectId);
}

/**
 * Stop a running deploy, and anything queued behind it.
 *
 * Returns the promise of the pipeline ending, or null when no deploy is running
 * here. A row can still say `deploying` with nothing behind it, and then the
 * caller is the only one who can put it right.
 *
 * What waits behind some other operation stays: the stop is about to be refused
 * for that operation, and a refused stop must change nothing.
 */
export function cancelDeploy(projectId: string): Promise<void> | null {
  const run = state.running.get(projectId);
  if (!run && lockHolder(projectId)) return null;
  state.pending.delete(projectId);
  if (!run) return null;
  run.controller.abort();
  return run.settled;
}
