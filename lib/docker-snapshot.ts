import type { ProcessInfo } from "@/services/process-drivers/types";

/**
 * Process information read from a batch instead of a call per project.
 *
 * The same answers `dockerDriver.status` and `composeDriver.status` give, built
 * from one listing and one `docker inspect`. Only for a page that polls: both
 * drivers stay live, because a deploy asks them right after starting something.
 */

export const CONTAINER_FACTS_FORMAT = "{{.Name}}|{{.State.Running}}|{{.State.StartedAt}}|{{.State.Pid}}|{{.Id}}";

export interface ContainerFacts {
  running: boolean;
  containerId: string;
  pid?: number;
  /** Seconds. Only for a running container. */
  uptime?: number;
}

/** The output of `docker inspect --format CONTAINER_FACTS_FORMAT`, by name. */
export function parseContainerFacts(stdout: string, now: number): Map<string, ContainerFacts> {
  const facts = new Map<string, ContainerFacts>();

  for (const line of stdout.split("\n")) {
    const [rawName, running, startedAt, pid, id] = line.trim().split("|");
    if (!rawName || !id) continue;

    const started = new Date(startedAt).getTime();
    // `.Name` comes back with a leading slash.
    facts.set(rawName.replace(/^\//, ""), {
      running: running === "true",
      containerId: id.slice(0, 12),
      pid: Number.parseInt(pid, 10) || undefined,
      uptime: running === "true" && !Number.isNaN(started) ? Math.floor((now - started) / 1000) : undefined,
    });
  }
  return facts;
}

export interface ContainerUsage {
  cpu: number;
  memory: number;
}

/**
 * CPU and memory of a stack: exactly the containers named, nothing matched by
 * prefix. `runpanel-shop` as a prefix also covers the project `shop-api`, and
 * misses every container with a `container_name:` of its own.
 */
export function sumContainerUsage(
  names: readonly string[],
  read: (name: string) => ContainerUsage | null
): { cpu?: number; memory?: number } {
  let cpu = 0;
  let memory = 0;
  let seen = false;

  for (const name of names) {
    const usage = read(name);
    if (!usage) continue;
    cpu += usage.cpu;
    memory += usage.memory;
    seen = true;
  }

  return seen ? { cpu: Math.round(cpu * 10) / 10, memory } : {};
}

/** A Docker project, from what was read about its container. */
export function appProcessInfo(facts: ContainerFacts | undefined, usage: ContainerUsage | null): ProcessInfo {
  if (!facts) return { running: false };
  if (!facts.running) return { running: false, containerId: facts.containerId };

  return {
    running: true,
    pid: facts.pid,
    containerId: facts.containerId,
    uptime: facts.uptime,
    memory: usage?.memory,
    cpu: usage?.cpu,
  };
}

/**
 * A Compose project, from the containers of its stack.
 *
 * Up when every container is: the rule of `composeDriver.status`, paused
 * included, since a backup freezes the writers of a volume for the copy.
 */
export function stackProcessInfo(
  containers: readonly { names: readonly string[]; state: string }[],
  read: (name: string) => ContainerUsage | null
): ProcessInfo {
  if (containers.length === 0) return { running: false };

  return {
    running: containers.every((c) => c.state === "running" || c.state === "paused"),
    ...sumContainerUsage(containers.flatMap((c) => c.names), read),
  };
}
