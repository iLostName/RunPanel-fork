/**
 * The Docker side of a deploy without downtime, and the sequence itself.
 *
 * Every Docker call goes through an injected `ZdCli`, and every step that
 * belongs to the rest of the panel — starting the container, the health
 * check, nginx, the store — is handed in as a function. Nothing here imports
 * a value from outside `lib/` and `./labels`, both import-free: that is what
 * lets the unit suite drive the whole sequence against a simulated daemon,
 * failure by failure, with no Docker and no nginx.
 *
 * The rules (lib/zero-downtime.ts): the container online is never touched
 * before nginx has moved to the new one; a failure before that removes the
 * new container and nothing else; after it nothing fails the deploy, and the
 * old container is retired once its requests had time to finish.
 */

import {
  CONTAINER_LIST_FORMAT,
  LABEL_DEPLOYMENT,
  LABEL_KIND,
  LABEL_LIVE_PORT,
  LABEL_PROJECT,
  appContainerName,
  foreignOwner,
  nextAppContainerName,
  oldAppContainerName,
  parseContainerList,
} from "./labels";
import { isReservedSlug } from "@/lib/project-slug";
import {
  failureOutcome,
  planSettle,
  type ReleasePhase,
  type SettlePlan,
  type ZdContainer,
  type ZdNames,
} from "@/lib/zero-downtime";

/** The one call this needs from Docker: resolves with the output, rejects on a non-zero exit. */
export interface ZdCli {
  run(args: string[], opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }>;
}

export function zdNames(slug: string): ZdNames {
  return { live: appContainerName(slug), next: nextAppContainerName(slug), old: oldAppContainerName(slug) };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Whether a container under one of the project's names is the project's own.
 *
 * The live name gets what `foreignOwner` grants it everywhere else — a
 * container from before the labels existed is the project's. The other two
 * are only ever created by a deploy, always labelled, so nothing short of the
 * project's own labels counts: an unlabelled one is somebody else's to keep.
 */
function isOwn(slug: string, names: ZdNames, name: string, labels: Record<string, string>): boolean {
  if (name === names.live) return foreignOwner(slug, labels, isReservedSlug(slug)) === null;
  return labels[LABEL_KIND] === "app" && labels[LABEL_PROJECT] === slug;
}

/**
 * The project's own app containers, under any of its three names, in one
 * listing. A name filter rather than labels, so a live container from before
 * the labels is seen too; ownership is then checked whole, here — the filter
 * is a regex and narrows, it does not prove anything.
 */
export async function listAppContainers(cli: ZdCli, slug: string): Promise<ZdContainer[]> {
  const names = zdNames(slug);
  const { stdout } = await cli.run(
    ["ps", "-a", "--filter", `name=^/?${names.live}(_next|_old)?$`, "--format", CONTAINER_LIST_FORMAT],
    { timeout: 15_000 }
  );
  const found: ZdContainer[] = [];
  for (const row of parseContainerList(stdout)) {
    const name = row.names.find((n) => n === names.live || n === names.next || n === names.old);
    if (!name || !isOwn(slug, names, name, row.labels)) continue;
    const port = Number.parseInt(row.labels[LABEL_LIVE_PORT] ?? "", 10);
    found.push({
      name,
      state: row.state,
      deployment: row.labels[LABEL_DEPLOYMENT] || null,
      livePort: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    });
  }
  return found;
}

/** `rm -f`, where a container that is already gone is the outcome asked for. */
export async function removeContainer(cli: ZdCli, name: string): Promise<void> {
  try {
    await cli.run(["rm", "-f", name], { timeout: 30_000 });
  } catch (err) {
    if (!/no such container/i.test(errorText(err))) throw err;
  }
}

export interface SettleHooks {
  /** Between the renames and the retirement: the new container answers to the live name from here. */
  afterRenames?: () => void;
  /** The wait before the old container is stopped. */
  drain?: () => Promise<void>;
  /** What `docker stop` gives the old container to close what it has open. */
  stopTimeoutSec?: number;
}

/**
 * Carry out a plan: leftovers first (which also frees the names the renames
 * need), the renames in order, then the container that served until now —
 * drained, stopped with a grace period, removed.
 */
export async function settle(cli: ZdCli, plan: SettlePlan, hooks: SettleHooks = {}): Promise<void> {
  for (const name of plan.remove) await removeContainer(cli, name);
  for (const step of plan.renames) await cli.run(["rename", step.from, step.to], { timeout: 15_000 });
  hooks.afterRenames?.();
  if (!plan.retire) return;
  if (hooks.drain) await hooks.drain();
  // `stop` before `rm -f`: SIGTERM and a grace period, which an app uses to
  // close its connections; `rm -f` on a running container is a SIGKILL.
  await cli
    .run(["stop", "-t", String(hooks.stopTimeoutSec ?? 10), plan.retire], { timeout: 60_000 })
    .catch(() => undefined);
  await removeContainer(cli, plan.retire);
}

/**
 * Bring a project's containers back to exactly one, under the live name: the
 * one of `liveDeployment` (see `planSettle`). For the boot after a deploy cut
 * short, and before a deploy starts a new candidate. Nothing is drained.
 */
export async function normalize(cli: ZdCli, slug: string, liveDeployment: string | null): Promise<SettlePlan> {
  const plan = planSettle(zdNames(slug), await listAppContainers(cli, slug), liveDeployment, { drain: false });
  await settle(cli, plan);
  return plan;
}

/** What nginx did with the switch (services/proxy `switchProjectUpstream`). */
export interface UpstreamSwitch {
  ok: boolean;
  message: string;
  /** nginx took the new upstream, the store did not, and nginx could not be put back. */
  stuck?: boolean;
}

export interface ReleaseDeps {
  cli: ZdCli;
  slug: string;
  log(line: string): void;
  /** Throws when the operator stopped the deploy. */
  checkpoint(): void;
  /** Create and start the new container under `names.next`, published on 127.0.0.1:`port`. */
  startCandidate(port: number): Promise<void>;
  /** The deploy's "post-start" one-time commands. */
  afterStart(): Promise<void>;
  /** The health check, against the new container on its own port. */
  waitHealthy(port: number): Promise<{ healthy: boolean; reason?: string }>;
  /** The new container's last lines, for a health check that failed. */
  candidateLogs(lines: number): Promise<string[]>;
  /** The deploy's "post-deploy" one-time commands: the new version answers, nginx has not moved yet. */
  beforeSwitch(): Promise<void>;
  /** Move nginx to `port`, validated; `commit` runs right after the reload, where nothing can come between. */
  switchUpstream(port: number, commit: () => Promise<void>): Promise<UpstreamSwitch>;
  /** Record the deploy as done and `port` as the live one, in one go. */
  commit(port: number): Promise<void>;
  /** The deploy counts as done: said in its log before the drain. */
  committed?(): void;
  /** The drain: how long the old container keeps answering what it already has. */
  drain(): Promise<void>;
  /** The new container answers to the live name: the log viewers follow it from here. */
  promoted?(): void;
  stopTimeoutSec?: number;
}

export interface ReleaseInput {
  deploymentId: string;
  /** The new container's loopback port, reserved for this deploy. */
  port: number;
  /** For the failure message, worded like an ordinary deploy's so the panel explains it the same way. */
  healthTimeoutSec: number;
}

/**
 * A deploy that failed before the switch: the version online is as it was.
 * Fields assigned by hand rather than as parameter properties, which the
 * suite's type stripping cannot run.
 */
export class ReleaseFailure extends Error {
  readonly phase: ReleasePhase;
  readonly health: boolean;

  constructor(message: string, phase: ReleasePhase, health: boolean) {
    super(message);
    this.name = "ReleaseFailure";
    this.phase = phase;
    this.health = health;
  }
}

/**
 * The sequence, from the new container to the old one gone. Resolves with the
 * last step reached once the deploy counts as done (`committed` or later);
 * rejects, with the new container already removed, when it does not.
 */
export async function releaseWithoutDowntime(deps: ReleaseDeps, input: ReleaseInput): Promise<ReleasePhase> {
  const names = zdNames(deps.slug);
  let phase: ReleasePhase = "candidate";
  let stuck = false;

  try {
    deps.log("\n--- Starting application ---");
    deps.log(`Deploy senza interruzioni: la nuova versione parte accanto a quella online, su 127.0.0.1:${input.port}.`);
    await deps.startCandidate(input.port);
    deps.checkpoint();
    await deps.afterStart();

    phase = "health";
    deps.log("\n--- Health check ---");
    const health = await deps.waitHealthy(input.port);
    deps.checkpoint();
    if (!health.healthy) {
      deps.log("\n--- Docker process logs ---");
      try {
        const recent = await deps.candidateLogs(40);
        if (recent.length > 0) for (const line of recent) deps.log(line);
        else deps.log("(no Docker logs available)");
      } catch {
        deps.log("(failed to retrieve Docker logs)");
      }
      throw new ReleaseFailure(`Health check failed after ${input.healthTimeoutSec}s: ${health.reason ?? "no answer"}`, phase, true);
    }
    await deps.beforeSwitch();
    deps.checkpoint();

    phase = "switch";
    deps.log("\n--- Switching traffic ---");
    const moved = await deps.switchUpstream(input.port, () => deps.commit(input.port));
    if (!moved.ok) {
      stuck = moved.stuck === true;
      throw new ReleaseFailure(moved.message, phase, false);
    }
    deps.log(moved.message);
    phase = "committed";
    deps.committed?.();
  } catch (err) {
    if (failureOutcome(phase, stuck).removeCandidate) {
      try {
        await removeContainer(deps.cli, names.next);
        deps.log("La nuova versione è stata rimossa: quella online non è mai stata toccata.");
      } catch (removeErr) {
        deps.log(`ATTENZIONE: la nuova versione non è stata rimossa (${errorText(removeErr)}): la toglie il prossimo deploy.`);
      }
    } else {
      deps.log(
        "ATTENZIONE: nginx potrebbe servire già la nuova versione, che quindi resta accesa insieme a quella di prima: " +
          "il prossimo avvio del pannello o il prossimo deploy ne lasciano una sola."
      );
    }
    throw err;
  }

  // The new version is the live one, in nginx and in the store: nothing from
  // here on can fail the deploy, and a step that does not work is said and
  // left to the next boot or deploy, which settle the same way.
  try {
    const plan = planSettle(names, await listAppContainers(deps.cli, deps.slug), input.deploymentId, { drain: true });
    await settle(deps.cli, plan, {
      afterRenames: () => {
        phase = "promoted";
        deps.promoted?.();
      },
      drain: plan.retire ? deps.drain : undefined,
      stopTimeoutSec: deps.stopTimeoutSec,
    });
    phase = "drained";
    deps.log(plan.retire ? "Versione precedente fermata e rimossa." : "Nessuna versione precedente da fermare.");
  } catch (err) {
    deps.log(
      `ATTENZIONE: riordino dei container non completato (${errorText(err)}). ` +
        "La nuova versione è online; il prossimo avvio del pannello o il prossimo deploy tolgono quella vecchia."
    );
  }
  return phase;
}
