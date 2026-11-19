import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import type { DeployContract } from "@/lib/deploy-contract";
import { readAccess } from "@/lib/access-columns";
import {
  LIVE_PORT_FIRST,
  LIVE_PORT_LAST,
  ZERO_DOWNTIME_BLOCKERS,
  pickLivePort,
  zeroDowntimeBlockers,
  type ReleasePhase,
  type ZeroDowntimeBlocker,
  type ZeroDowntimeFacts,
} from "@/lib/zero-downtime";
import { docker, isDockerAvailable } from "./docker/cli";
import { CONTAINER_LIST_FORMAT, LABEL_PROJECT, ownedFilters, parseContainerList } from "./docker/labels";
import { normalize, releaseWithoutDowntime, zdNames, type ZdCli } from "./docker/zero-downtime";
import { candidateLogs, candidateStatus, startCandidate } from "./process-drivers/docker-driver";
import type { StartOpts } from "./process-drivers/types";
import { waitForHealthy } from "./deploy-steps";
import { portFreeOnHost } from "./catalog/checks";
import { canApply, claimedPorts, proxyProbe, switchProjectUpstream, applyProxySoon } from "./proxy";
import { projectEvents } from "./events";
import { tryLock } from "./project-lock";

/**
 * Deploys without downtime, wired to the rest of the panel: what the store and
 * nginx say about a project, the port each deploy gets, the sequence with its
 * real steps, and the boot that follows a deploy cut short.
 *
 * The decisions are in lib/zero-downtime.ts, the containers and the sequence
 * in services/docker/zero-downtime.ts — both testable without a daemon. This
 * file is the part that needs one, and nginx, and the store.
 */

/** Docker, as the sequence asks for it. */
export const dockerCli: ZdCli = {
  run: (args, opts) => docker(args, { timeout: opts?.timeout }),
};

/** Everything the store and nginx know that decides whether a project can be deployed this way. */
export async function zeroDowntimeFacts(
  project: Pick<ProjectsTable, "id" | "runtime_type" | "port" | "access_mode" | "access_allow" | "access_port">,
  contract: DeployContract
): Promise<ZeroDowntimeFacts> {
  const db = await getDb();
  const served = await db
    .selectFrom("project_hosts")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("project_id", "=", project.id)
    // Set aside by the last apply: nginx does not serve it.
    .where("apply_error", "is", null)
    // A twin that only redirects reaches the app through another name.
    .where("redirect_to", "is", null)
    .executeTakeFirst();
  return {
    runtimeType: project.runtime_type,
    network: contract.docker.network,
    healthcheck: { enabled: contract.healthcheck.enabled, port: contract.healthcheck.port ?? null },
    port: project.port,
    restricted: readAccess(project).mode === "restricted",
    singleInstance: contract.runtime.singleInstance,
    servedHosts: Number(served?.n ?? 0),
    proxyReady: canApply(await proxyProbe()),
  };
}

export interface ZeroDowntimeDecision {
  /** The operator asked for it. */
  enabled: boolean;
  /** Why it cannot happen now; empty when it can. */
  blockers: ZeroDowntimeBlocker[];
}

/** Whether this deploy goes without downtime, decided on the resolved contract. */
export async function decideZeroDowntime(project: ProjectsTable, contract: DeployContract): Promise<ZeroDowntimeDecision> {
  if (!contract.zeroDowntime.enabled) return { enabled: false, blockers: [] };
  return { enabled: true, blockers: zeroDowntimeBlockers(await zeroDowntimeFacts(project, contract)) };
}

export function describeBlockers(blockers: readonly ZeroDowntimeBlocker[]): string {
  return blockers.map((blocker) => ZERO_DOWNTIME_BLOCKERS[blocker]).join(" ");
}

// --- Ports ---------------------------------------------------------------------

const globalRef = globalThis as typeof globalThis & { __runpanelLivePorts?: Set<number> };
/**
 * Ports handed to a deploy and not yet in the store — the new container's
 * until its deploy commits, the old one's until it is gone. Two deploys of two
 * projects at once would otherwise pick the same free port.
 */
const reserved = (globalRef.__runpanelLivePorts ??= new Set<number>());

export interface PortHold {
  port: number;
  release(): void;
}

function hold(port: number): PortHold {
  reserved.add(port);
  let released = false;
  return {
    port,
    release() {
      if (released) return;
      released = true;
      reserved.delete(port);
    },
  };
}

/**
 * A free port of the range for a new container: not claimed by any project,
 * service or the panel, not handed to another deploy under way, and not
 * listened on by anything on the host right now.
 */
export async function reserveLivePort(after: number | null): Promise<PortHold> {
  const tried = new Set<number>([...(await claimedPorts()).keys(), ...reserved]);
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = pickLivePort(tried, after);
    if (port === null) break;
    tried.add(port);
    if (reserved.has(port)) continue;
    // Held before the look, so a deploy of another project asking meanwhile skips it.
    const claim = hold(port);
    if (await portFreeOnHost(port)) return claim;
    claim.release();
  }
  throw new Error(`Nessuna porta libera tra ${LIVE_PORT_FIRST} e ${LIVE_PORT_LAST} per la nuova versione: la versione online resta com'è.`);
}

// --- The store -------------------------------------------------------------------

/** The deployment the store says is online. */
async function liveDeploymentId(projectId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("deployments")
    .select("id")
    .where("project_id", "=", projectId)
    .where("status", "=", "running")
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

async function setLivePort(projectId: string, port: number | null): Promise<void> {
  const db = await getDb();
  await db.updateTable("projects").set({ live_port: port, updated_at: nowIso() }).where("id", "=", projectId).execute();
}

// --- A deploy ------------------------------------------------------------------------

export interface ZeroDowntimeRelease {
  project: ProjectsTable;
  deploymentId: string;
  startCmd: string;
  /** The app's start options, as for an ordinary start; the live port is filled in here. */
  startOpts: StartOpts;
  contract: DeployContract;
  /** The app's own port, inside its container. */
  port: number;
  signal?: AbortSignal;
  log(line: string): void;
  checkpoint(): void;
  afterStart(): Promise<void>;
  beforeSwitch(): Promise<void>;
  /** Record the deploy as done with `livePort` as the live port, in one transaction. */
  commit(livePort: number): Promise<void>;
}

/** Ends early when aborted: the caller decides what an abort means. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The deploy's tail for a project deployed without downtime: everything from
 * the start of the new version to the old one gone. Rejects, with the version
 * online untouched, for any failure before nginx moved; resolves once the
 * deploy counts as done.
 */
export async function runZeroDowntimeRelease(ctx: ZeroDowntimeRelease): Promise<ReleasePhase> {
  const { project, contract } = ctx;
  const slug = project.slug;

  // A deploy cut short may have left a candidate, or a renamed container:
  // back to exactly one, under the live name, before a new one is started.
  const settled = await normalize(dockerCli, slug, await liveDeploymentId(project.id));
  const previousPort = settled.keep?.livePort ?? null;
  if (settled.livePort !== undefined && settled.livePort !== project.live_port) await setLivePort(project.id, settled.livePort);

  // The old container's port too, until it is gone: the store lets go of it
  // at the commit, while the container still holds it for the drain.
  const previous = previousPort ? hold(previousPort) : null;
  const next = await reserveLivePort(previousPort ?? project.live_port);
  try {
    return await releaseWithoutDowntime(
      {
        cli: dockerCli,
        slug,
        log: ctx.log,
        checkpoint: ctx.checkpoint,
        startCandidate: (port) => startCandidate(slug, ctx.startCmd, { ...ctx.startOpts, livePort: port }),
        afterStart: ctx.afterStart,
        waitHealthy: (port) =>
          waitForHealthy({
            slug,
            runtimeType: "docker",
            port,
            // The project's own port is the only one a check can use here
            // (`healthcheck-port` blocker): the new container's is `port`.
            contract: { ...contract, healthcheck: { ...contract.healthcheck, port: undefined } },
            onLog: ctx.log,
            signal: ctx.signal,
            status: () => candidateStatus(slug),
            shownPort: ctx.port,
          }),
        candidateLogs: (count) => candidateLogs(slug, count),
        beforeSwitch: ctx.beforeSwitch,
        switchUpstream: (port, commit) => switchProjectUpstream(project.id, port, commit),
        commit: ctx.commit,
        drain: async () => {
          const seconds = contract.zeroDowntime.drainSec;
          ctx.log("\n--- Drain ---");
          if (seconds <= 0) {
            ctx.log("Nessuna attesa impostata: la versione precedente si ferma subito.");
            return;
          }
          ctx.log(`La versione precedente resta accesa ${seconds} s per finire le richieste che stava servendo.`);
          await sleep(seconds * 1000, ctx.signal);
          if (ctx.signal?.aborted) ctx.log("Attesa accorciata: il deploy è stato fermato.");
        },
        // The log viewers follow the container under the live name: now the new one.
        promoted: () => projectEvents.emit(project.id, { type: "process:reset" }),
      },
      { deploymentId: ctx.deploymentId, port: next.port, healthTimeoutSec: contract.healthcheck.timeoutSec }
    );
  } finally {
    next.release();
    previous?.release();
  }
}

// --- Boot ------------------------------------------------------------------------------

/** Projects with a container under one of the deploy-only names, from one listing. */
async function slugsWithLeftovers(): Promise<Set<string>> {
  const { stdout } = await dockerCli.run(["ps", "-a", ...ownedFilters({ kind: "app" }), "--format", CONTAINER_LIST_FORMAT], {
    timeout: 15_000,
  });
  const slugs = new Set<string>();
  for (const row of parseContainerList(stdout)) {
    const slug = row.labels[LABEL_PROJECT];
    if (!slug) continue;
    const names = zdNames(slug);
    if (row.names.some((name) => name === names.next || name === names.old)) slugs.add(slug);
  }
  return slugs;
}

const globalBoot = globalThis as typeof globalThis & { __runpanelZdRetry?: NodeJS.Timeout };
const RETRY_AFTER_MS = 60_000;

/**
 * At boot, before nginx is brought back to what the store says: every project
 * deployed without downtime ends up with exactly one container, under the
 * live name, and the store's `live_port` names the port that container is on
 * — so the apply that follows points nginx at it.
 *
 * Which container: the one of the deployment the store calls online (see
 * `planSettle`). A deploy cut short before it committed was just recorded as
 * failed, so its candidate goes and the version it was meant to replace
 * stays; one that committed keeps its new container even if the renames
 * never happened. With Docker not answering yet, the store is left as it is
 * — it was written in step with nginx — and this is tried once more a minute
 * later, applying nginx again if anything moved.
 */
export async function reconcileZeroDowntime(opts: { retry?: boolean } = {}): Promise<boolean> {
  if (!(await isDockerAvailable())) {
    if (opts.retry !== false && !globalBoot.__runpanelZdRetry) {
      globalBoot.__runpanelZdRetry = setTimeout(() => {
        void reconcileZeroDowntime({ retry: false })
          .then((changed) => {
            if (changed) applyProxySoon();
          })
          .catch((err) => console.warn(`[zero-downtime] ${err instanceof Error ? err.message : String(err)}`));
      }, RETRY_AFTER_MS);
      globalBoot.__runpanelZdRetry.unref?.();
    }
    return false;
  }

  const db = await getDb();
  const leftovers = await slugsWithLeftovers();
  const projects = await db
    .selectFrom("projects")
    .select(["id", "slug", "live_port"])
    .where("runtime_type", "=", "docker")
    .execute();

  let changed = false;
  for (const project of projects) {
    if (project.live_port === null && !leftovers.has(project.slug)) continue;
    const release = tryLock(project.id, "settle");
    if (!release) continue;
    try {
      const plan = await normalize(dockerCli, project.slug, await liveDeploymentId(project.id));
      const acted = plan.remove.length + plan.renames.length;
      if (plan.livePort !== undefined && plan.livePort !== project.live_port) {
        await setLivePort(project.id, plan.livePort);
        changed = true;
      }
      if (acted > 0) {
        changed = true;
        console.log(
          `[zero-downtime] ${project.slug}: rimasto online ${plan.keep?.name ?? "nessun container"}` +
            (plan.remove.length > 0 ? `, rimossi ${plan.remove.join(", ")}` : "")
        );
      }
    } catch (err) {
      console.warn(`[zero-downtime] ${project.slug}: container non sistemati: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      release();
    }
  }
  return changed;
}
