import { IProcessDriver, ProcessInfo, StartOpts, OutputCallback } from "./types";
import { docker, dockerTry, dockerStream, lines } from "../docker/cli";
import { withDockerEnv } from "../docker/env-file";
import {
  appContainerName,
  CONTAINER_LIST_FORMAT,
  foreignOwner,
  LABEL_KIND,
  LABEL_PROJECT,
  labelArgs,
  nextAppContainerName,
  oldAppContainerName,
  parseContainerList,
  parseLabelsJson,
} from "../docker/labels";
import { containerStats } from "../docker/stats";
import { markRunStart, sinceArgs } from "./run-log";
import { CONTAINER_LOG_ARGS } from "@/lib/docker-cleanup";
import { isReservedSlug } from "@/lib/project-slug";

/** The container name of a project is taken by something that is not that project. */
export class ForeignContainerError extends Error {
  constructor(name: string, owner: string) {
    super(
      `Il container ${name} appartiene a ${owner}: operazione fermata per non toccarlo. ` +
        "Il nome di questo progetto si sovrappone: crea un nuovo progetto con un altro nome."
    );
    this.name = "ForeignContainerError";
  }
}

/**
 * The labels of a container, or null when there is none by that name.
 *
 * A listing rather than `docker inspect`: inspect reports a missing container as
 * an error, and telling that from a daemon that did not answer would mean reading
 * its wording. Here absent is an empty result and a failure is a failure, which
 * matters because absent is what lets a deploy go on. Names are stored with a
 * leading slash, and the filter is a regex: anchored, or `runpanel-shop` would
 * also match `runpanel-shop-api`.
 */
async function containerLabels(name: string): Promise<Record<string, string> | null> {
  const { stdout } = await docker(
    ["ps", "-a", "--filter", `name=^/?${name}$`, "--format", CONTAINER_LIST_FORMAT],
    { timeout: 10_000 }
  );
  return parseContainerList(stdout).find((row) => row.names.includes(name))?.labels ?? null;
}

/**
 * Check the container of a project before acting on it. Says whether it exists;
 * throws `ForeignContainerError` when the name belongs to someone else, and the
 * docker error when that cannot be established.
 */
export async function assertOwnAppContainer(slug: string): Promise<boolean> {
  const name = appContainerName(slug);
  const labels = await containerLabels(name);
  if (!labels) return false;

  const owner = foreignOwner(slug, labels, isReservedSlug(slug));
  if (owner) throw new ForeignContainerError(name, owner);
  return true;
}

/** For the calls with no failure to report. Unable to tell counts as not ours. */
function mayActOnAppContainer(slug: string): Promise<boolean> {
  return assertOwnAppContainer(slug).then(
    () => true,
    () => false
  );
}

/**
 * The `docker create` arguments of an app container, up to the image.
 *
 * One builder for the container every feature addresses and for the new
 * version a deploy without downtime checks beside it (`startCandidate`):
 * they must differ in their name and in where they are published, and in
 * nothing else, or the version that passed its health check is not the one
 * that goes on serving.
 */
async function createArgs(name: string, slug: string, opts: StartOpts): Promise<{ args: string[]; hostNetwork: boolean }> {
  const network = opts.network ?? "project";
  const hostNetwork = network === "host";
  // Never on the host network, where two containers cannot share the port:
  // the settings and the deploy refuse that shape (lib/zero-downtime.ts).
  const livePort = !hostNetwork && opts.livePort && opts.livePort > 0 ? opts.livePort : undefined;

  // `create` + `start`, not `run -d`: the container has to be on the project
  // network before its process starts. It used to be run on the default
  // bridge and connected to the project network a moment later, and an app
  // that resolved its database on startup lost the race — `could not
  // translate host name "runpanel-svc-…"` on the first try, fine on the
  // restart. The project network is what a linked service's container name
  // resolves on, and `localhost` inside a container is the container itself,
  // so every mode but `host` joins it — `bridge` included, which keeps the
  // default bridge as well, exactly as before.
  const args = [
    "create",
    "--name", name,
    // Containers used to start with no restart policy at all, so nothing came
    // back after a host reboot. Services already had this; apps did not.
    "--restart", opts.restartPolicy ?? "unless-stopped",
    ...labelArgs({ project: slug, kind: "app", deployment: opts.deploymentId, livePort }),
    // Docker keeps a container's whole output in one file on the host and
    // never truncates it: an app logging a line per request filled the disk
    // in its own time. Applies from the next start, since the container is
    // recreated on every one.
    ...CONTAINER_LOG_ARGS,
  ];

  if (hostNetwork) {
    // In host mode the container shares the host's stack: published ports and
    // host-gateway aliases are meaningless, and `localhost` already reaches
    // anything bound on the host.
    args.push("--network", "host");
  } else {
    const { ensureProjectNetwork } = await import("../docker-network");
    args.push("--network", await ensureProjectNetwork(slug));
    args.push("--add-host=host.docker.internal:host-gateway");

    // Publish whenever a port is configured. The previous condition was
    // `opts.port !== 3000`, which meant the single most common port in the
    // world was never mapped.
    if (opts.port && opts.port > 0) {
      // Under a gate, or deployed without downtime, the host side moves to
      // loopback; the container keeps listening on the port it was built
      // for, so only the left half of the mapping changes.
      const hostSide = livePort ?? opts.loopbackPort;
      const publish = hostSide ? `127.0.0.1:${hostSide}:${opts.port}` : `${opts.port}:${opts.port}`;
      args.push("-p", publish);
    }
  }

  for (const host of opts.extraHosts ?? []) args.push("--add-host", host);
  if (opts.hostname) args.push("--hostname", opts.hostname);
  for (const cap of opts.capAdd ?? []) args.push("--cap-add", cap);
  for (const mount of opts.mounts ?? []) args.push("-v", mount);
  if (opts.memory) args.push("--memory", opts.memory);
  if (opts.cpus) args.push("--cpus", opts.cpus);
  if (opts.shmSize) args.push("--shm-size", opts.shmSize);

  return { args, hostNetwork };
}

/** Create and start a container from `createArgs`. */
async function createAndStart(name: string, slug: string, startCmd: string, opts: StartOpts): Promise<void> {
  // startCmd format: "docker:imageRef"
  const imageName = startCmd.replace(/^docker:/, "");
  const { args, hostNetwork } = await createArgs(name, slug, opts);

  // Values off argv, where any local account could read them: see `lib/docker-env.ts`.
  await withDockerEnv(opts.env, (envArgs) => docker([...args, ...envArgs, imageName], { timeout: 180_000 }));

  // The default bridge too, before the process starts. Not applicable in
  // host mode, where there is no bridge to join; already-connected is a
  // normal outcome, not an error.
  if (!hostNetwork) {
    await dockerTry(["network", "connect", "bridge", name], { timeout: 10_000 });
  }

  await docker(["start", name], { timeout: 60_000 });
}

/**
 * A container's state as `ProcessInfo`, or not running when it is missing or
 * belongs to something else. `own` says whether its labels make it ours.
 */
async function containerStatus(name: string, own: (labels: Record<string, string>) => boolean): Promise<ProcessInfo> {
  const result = await dockerTry([
    "inspect", name,
    "--format", "{{.State.Running}}|{{.State.Pid}}|{{.Id}}|{{.State.StartedAt}}|{{json .Config.Labels}}",
  ]);

  if (!result) return { running: false };

  const [running, pid, containerId, startedAt, ...labels] = result.stdout.trim().split("|");
  if (!own(parseLabelsJson(labels.join("|")))) return { running: false };

  const shortId = containerId?.slice(0, 12);

  if (running !== "true") return { running: false, containerId: shortId };

  let uptime: number | undefined;
  if (startedAt) {
    const started = new Date(startedAt).getTime();
    if (!Number.isNaN(started)) uptime = Math.floor((Date.now() - started) / 1000);
  }

  // Read from the streaming cache instead of spawning `docker stats
  // --no-stream`, which costs seconds per call. Only a look: see `peek`.
  const stats = containerStats.peek(name);

  return {
    running: true,
    pid: Number.parseInt(pid, 10) || undefined,
    containerId: shortId,
    uptime,
    memory: stats?.memory,
    cpu: stats?.cpu,
  };
}

/** Only ever made by a deploy without downtime, always labelled: nothing less counts as ours. */
const isOwnCandidate = (slug: string) => (labels: Record<string, string>) =>
  labels[LABEL_KIND] === "app" && labels[LABEL_PROJECT] === slug;

/**
 * Start a new version beside the live one: under `nextAppContainerName`,
 * published on 127.0.0.1:`opts.livePort` — see lib/zero-downtime.ts. The live
 * container is not looked at, let alone touched.
 */
export async function startCandidate(slug: string, startCmd: string, opts: StartOpts): Promise<void> {
  if (!opts.livePort) throw new Error("Una nuova versione affiancata ha bisogno della sua porta");
  const name = nextAppContainerName(slug);

  // A candidate left by a deploy that was cut short goes first — only ever
  // one of ours: the name cannot be another project's, but a container under
  // it with somebody else's labels is not this panel's to remove.
  const leftover = await containerLabels(name);
  if (leftover && !isOwnCandidate(slug)(leftover)) {
    throw new ForeignContainerError(name, foreignOwner(slug, leftover, false) ?? "un'altra risorsa");
  }
  if (leftover) await dockerTry(["rm", "-f", name], { timeout: 15_000 });

  // The run the logs answer for starts here, as for any start.
  markRunStart(slug);
  await createAndStart(name, slug, startCmd, opts);
}

/** The new version's state, for its health check. */
export function candidateStatus(slug: string): Promise<ProcessInfo> {
  return containerStatus(nextAppContainerName(slug), isOwnCandidate(slug));
}

/** The new version's last lines, for a health check that failed. */
export async function candidateLogs(slug: string, count: number): Promise<string[]> {
  const name = nextAppContainerName(slug);
  const labels = await containerLabels(name).catch(() => null);
  if (!labels || !isOwnCandidate(slug)(labels)) return [];
  const result = await dockerTry(["logs", name, "--tail", count.toString()], {
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result ? lines(`${result.stdout}\n${result.stderr}`) : [];
}

export const dockerDriver: IProcessDriver = {
  async start(slug: string, startCmd: string, opts: StartOpts): Promise<void> {
    const name = appContainerName(slug);

    // Before anything else: the `rm -f` below takes whatever answers to this
    // name, and it can be a database.
    await assertOwnAppContainer(slug);

    // A fresh container starts with an empty log, but a crash-restart under
    // `--restart` does not, and neither does `restart()`. The marker is what
    // makes `logs()` answer for this run in every one of those cases.
    markRunStart(slug);

    // Remove a leftover container with this name before recreating it.
    await dockerTry(["rm", "-f", name], { timeout: 15_000 });

    await createAndStart(name, slug, startCmd, opts);
  },

  async stop(slug: string): Promise<void> {
    // `stop`, not `rm -f`. Destroying the container on stop is why "start" had
    // to replay the previous deployment's command to bring anything back.
    if (!(await mayActOnAppContainer(slug))) return;
    await dockerTry(["stop", appContainerName(slug)], { timeout: 30_000 });
  },

  async remove(slug: string): Promise<void> {
    // The two names a deploy without downtime uses for a moment go too, when
    // something left them — but only containers that are this project's own.
    for (const name of [nextAppContainerName(slug), oldAppContainerName(slug)]) {
      const labels = await containerLabels(name).catch(() => null);
      if (labels && isOwnCandidate(slug)(labels)) await dockerTry(["rm", "-f", name], { timeout: 30_000 });
    }
    // A stopped container keeps its image referenced, so `docker rmi` on that
    // image silently fails and leaves it dangling.
    if (!(await mayActOnAppContainer(slug))) return;
    await dockerTry(["rm", "-f", appContainerName(slug)], { timeout: 30_000 });
  },

  async restart(slug: string): Promise<void> {
    await assertOwnAppContainer(slug);
    markRunStart(slug);
    await docker(["restart", appContainerName(slug)], { timeout: 60_000 });
  },

  status(slug: string): Promise<ProcessInfo> {
    return containerStatus(
      appContainerName(slug),
      (labels) => foreignOwner(slug, labels, isReservedSlug(slug)) === null
    );
  },

  async logs(slug: string, count: number): Promise<string[]> {
    const name = appContainerName(slug);
    if (!(await mayActOnAppContainer(slug))) return [];

    const result = await dockerTry(["logs", name, "--tail", count.toString(), ...sinceArgs(slug)], {
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (!result) return [];

    // Container output arrives on both streams.
    const combined = lines(`${result.stdout}\n${result.stderr}`);
    if (combined.length > 0) return combined;

    const state = await dockerTry([
      "inspect", name, "--format", "{{.State.Status}} {{.State.ExitCode}}",
    ], { timeout: 5_000 });

    const status = state?.stdout.trim();
    return status && status !== "running 0" ? [`[container state: ${status}]`] : [];
  },

  onOutput(slug: string, callback: OutputCallback): () => void {
    let stop: (() => void) | null = null;
    let cancelled = false;

    void mayActOnAppContainer(slug).then((allowed) => {
      if (!allowed || cancelled) return;
      stop = dockerStream(["logs", appContainerName(slug), "-f", "--tail", "0"], (line) =>
        callback(line, "stdout")
      );
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  },
};
