import { randomBytes } from "crypto";
import type { DeployContract } from "@/lib/deploy-contract";
import { mountStringSchema } from "@/lib/validation";
import { parseMountString } from "@/lib/mount";
import { docker, dockerTry } from "./docker/cli";
import { withDockerEnv } from "./docker/env-file";
import { reachesDataDir } from "./data-dir-guard";
import { labelArgs, networkName } from "./docker/labels";
import { ensureProjectNetwork } from "./docker-network";
import { runCommand } from "./builders/run-command";
import { processManager } from "./process-manager";
import type { ProcessInfo } from "./process-drivers/types";

/**
 * The two deploy steps that have to behave the same on both runtimes but reach
 * that behaviour differently: the release command, and the health check.
 */

/**
 * Turn a multi-line command field into one shell invocation.
 *
 * Joined with `&&` rather than run line by line so the lines share a session:
 * `source venv/bin/activate` on one line has to still be in effect on the next,
 * and a separate spawn per line loses that. `&&` also stops the rest as soon as
 * one of them fails, which is what "eseguiti in ordine" has to mean.
 *
 * Here rather than in each caller because there were four copies of these three
 * lines — install and build in the node builder, the same pair in the custom
 * builder, and the release command below — and a fifth was about to be written
 * for the one-time commands.
 */
export function joinScript(command: string): string {
  return command
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" && ");
}

interface ReleaseOptions {
  runtimeType: string;
  slug: string;
  projectDir: string;
  /** Image reference, for container runtimes. */
  image: string;
  env: Record<string, string>;
  contract: DeployContract;
  onLog: (line: string) => void;
  timeout?: number;
  signal?: AbortSignal;
}

const RELEASE_TIMEOUT_MS = 600_000;

/** What the docker client gets on top, once the container has been removed. */
const CONTAINER_REMOVAL_GRACE_MS = 30_000;

/** How often the removal is tried again while the client has not returned. */
const CONTAINER_REMOVAL_RETRY_MS = 2_000;

/**
 * Run the one-shot release command.
 *
 * Under Docker this is a throwaway container built from the image that is about
 * to run, on the same network and with the same mounts — so a migration reaches
 * the same database the app will. Running it on the host instead would need the
 * host to have the project's toolchain installed, which is the whole reason the
 * project was containerised.
 */
export async function runReleaseCommand(command: string, opts: ReleaseOptions): Promise<void> {
  const script = joinScript(command);

  if (!script) return;

  opts.onLog(`> ${script}`);

  if (opts.runtimeType !== "docker") {
    await runCommand(script, {
      cwd: opts.projectDir,
      env: opts.env,
      timeout: opts.timeout ?? RELEASE_TIMEOUT_MS,
      onLog: opts.onLog,
      signal: opts.signal,
    });
    return;
  }

  const timeout = opts.timeout ?? RELEASE_TIMEOUT_MS;
  const network = opts.contract.docker.network;
  // Named so it can be removed: see the timer below.
  const name = `runpanel-oneoff-${opts.slug}-${randomBytes(4).toString("hex")}`;
  const args = ["run", "--rm", "--name", name, ...labelArgs({ project: opts.slug, kind: "app" })];

  if (network === "host") {
    args.push("--network", "host");
  } else {
    // The release container runs BEFORE the app container, so the project
    // network may not exist yet — the app driver is what usually creates it.
    // Without this the very first deploy of a project fails at the release
    // step with "network not found". Every mode but `host` joins it, the same
    // as the app: a migration is handed the same DATABASE_URL the app gets,
    // and that names the service's container on this network.
    await ensureProjectNetwork(opts.slug);
    args.push("--network", networkName(opts.slug));
  }
  args.push("--add-host=host.docker.internal:host-gateway");

  // Same recheck as buildStartOpts: a contract from a restored backup or a
  // hand-edited column never went through the mount editor.
  for (const mount of opts.contract.docker.mounts) {
    const source = mountStringSchema.safeParse(mount).success ? parseMountString(mount)?.source : null;
    if (!source || reachesDataDir(source)) {
      opts.onLog(`Mount ignorato nel release command: ${mount}`);
      continue;
    }
    args.push("-v", mount);
  }
  const invocation = [opts.image, "sh", "-c", script];

  /*
    A timeout on the docker client does not end the command. The client proxies
    SIGTERM to the container's PID 1, a `sh` that ignores it as every PID 1 does
    without a handler, so the client kept waiting and the deploy with it. Removing
    the container is what really stops the command, and the client then returns
    by itself.
  */
  if (opts.signal?.aborted) throw new Error(`Comando interrotto: ${script}`);

  // Repeated until the client returns: right after the spawn the container may
  // not exist yet, and a removal that finds nothing would leave it to run.
  let ended: string | null = null;
  let remover: NodeJS.Timeout | undefined;
  const remove = () => void dockerTry(["rm", "-f", name], { timeout: CONTAINER_REMOVAL_GRACE_MS });
  const end = (why: string) => {
    if (ended) return;
    ended = why;
    remove();
    remover = setInterval(remove, CONTAINER_REMOVAL_RETRY_MS);
  };
  const timer = setTimeout(
    () => end(`interrotto dopo ${Math.round(timeout / 1000)}s (timeout)`),
    timeout
  );
  const onAbort = () => end("interrotto");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // Values off argv for as long as the migration runs: see `lib/docker-env.ts`.
    const result = await withDockerEnv(opts.env, (envArgs) =>
      docker([...args, ...envArgs, ...invocation], { timeout: timeout + CONTAINER_REMOVAL_GRACE_MS })
    );
    for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
      if (line.trim()) opts.onLog(line.trim());
    }
  } catch (err) {
    if (ended) throw new Error(`Comando ${ended}: ${script}`);
    throw err;
  } finally {
    clearTimeout(timer);
    clearInterval(remover);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

interface HealthOptions {
  slug: string;
  runtimeType: string;
  port: number;
  contract: DeployContract;
  onLog: (line: string) => void;
  signal?: AbortSignal;
  /**
   * Whether the process is up. The project's own by default; a deploy
   * without downtime asks about the new container, which is not yet the one
   * under the project's name (lib/zero-downtime.ts).
   */
  status?: () => Promise<ProcessInfo>;
  /**
   * The port the messages name, when the one probed is not the one the
   * operator knows: the new container's loopback port means nothing to them,
   * the app's port does — and the deploy explanation reads it back.
   */
  shownPort?: number;
}

export interface HealthResult {
  healthy: boolean;
  reason?: string;
}

/**
 * Wait for the app to be genuinely up.
 *
 * The previous version hardcoded "GET / within 15 seconds", which fails any app
 * that boots slowly or answers on a different path — and reports that failure
 * as a broken deploy even though the app came up fine a moment later.
 */
export async function waitForHealthy(opts: HealthOptions): Promise<HealthResult> {
  const { healthcheck } = opts.contract;

  if (!healthcheck.enabled) {
    opts.onLog("Health check disabled — assuming the process is up.");
    return { healthy: true };
  }

  if (healthcheck.startPeriodSec > 0) {
    opts.onLog(`Waiting ${healthcheck.startPeriodSec}s before probing (start period)...`);
    await sleep(healthcheck.startPeriodSec * 1000, opts.signal);
  }

  const port = healthcheck.port ?? opts.port;
  const deadline = Date.now() + healthcheck.timeoutSec * 1000;
  let attempt = 0;
  let lastReason = "the process never reported as running";

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { healthy: false, reason: "interrotto" };

    attempt++;
    const info = opts.status ? await opts.status() : await processManager.status(opts.slug, opts.runtimeType);

    if (!info.running) {
      lastReason = "the process is not running";
      if (attempt % 5 === 0) opts.onLog(`Not running yet (attempt ${attempt})...`);
      await sleep(healthcheck.intervalSec * 1000, opts.signal);
      continue;
    }

    // No port to probe: the process being alive is the whole signal.
    if (!port || port <= 0) {
      opts.onLog(`Process running (${info.containerId ?? info.pid ?? "n/a"}).`);
      return { healthy: true };
    }

    const probe = await probeHttp(port, healthcheck.path, healthcheck.expectStatus, opts.shownPort ?? port);
    if (probe.ok) {
      opts.onLog(`Health check passed — ${healthcheck.path} responded ${probe.status}.`);
      return { healthy: true };
    }

    lastReason = probe.reason;
    if (attempt % 5 === 0) {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      opts.onLog(`${probe.reason} (attempt ${attempt}, ${left}s left)...`);
    }

    await sleep(healthcheck.intervalSec * 1000, opts.signal);
  }

  return { healthy: false, reason: lastReason };
}

async function probeHttp(
  port: number,
  path: string,
  expectStatus: number[],
  shownPort: number = port
): Promise<{ ok: true; status: number } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  /*
    Built, not concatenated.

    `${port}${path}` looks like it can only ever address loopback, and it cannot:
    a path of `@example.com/` makes `127.0.0.1:3000` the URL's *userinfo* and
    `example.com` its host, so the panel goes and fetches whatever the path said.
    `healthcheck.path` is now panel-only alongside `healthcheck.port`, which closes
    the repository's route to it — this closes the shape of the bug, so a value an
    operator typed cannot do it either.
  */
  const base = `http://127.0.0.1:${port}`;
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: `il path ${path} non è un percorso valido` };
  }
  if (url.origin !== new URL(base).origin) {
    clearTimeout(timer);
    return {
      ok: false,
      reason: `il path ${path} punta fuori da 127.0.0.1:${port} e non viene interrogato`,
    };
  }

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
    });

    // An empty expectStatus means "anything that answers": for most apps the
    // point is that the port is bound and serving, not the exact code.
    if (expectStatus.length === 0 || expectStatus.includes(res.status)) {
      return { ok: true, status: res.status };
    }
    return {
      ok: false,
      reason: `${path} responded ${res.status}, expected ${expectStatus.join(" or ")}`,
    };
  } catch {
    return { ok: false, reason: `port ${shownPort} not responding on ${path}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Ends early when aborted: the caller looks at the signal right after. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
