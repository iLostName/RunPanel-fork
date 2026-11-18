import { dockerStream, dockerTry, isDockerAvailable } from "./cli";
import { CONTAINER_LIST_FORMAT, parseContainerList, type ContainerRow } from "./labels";
import { StatsCollector } from "@/lib/stats-collector";
import { CONTAINER_FACTS_FORMAT, parseContainerFacts, type ContainerFacts } from "@/lib/docker-snapshot";

export type { ContainerStats } from "@/lib/stats-collector";

// Held on globalThis so Next's dev-mode reloads do not leave orphaned
// `docker stats` processes behind on every edit.
const globalRef = globalThis as typeof globalThis & { __runpanelStats?: StatsCollector };
const collector = (globalRef.__runpanelStats ??= new StatsCollector({
  available: isDockerAvailable,
  stream: (onLine, onExit) => dockerStream(["stats", "--format", "{{json .}}"], onLine, onExit),
}));

export const containerStats = {
  /** Start the collector if it is not already running. Safe to call often. */
  ensureStarted: () => collector.ensureStarted(),
  get: (name: string) => collector.get(name),
  peek: (name: string) => collector.peek(name),
};

export interface DockerSnapshot {
  /** Every container on the host. Empty when the daemon could not be asked. */
  rows: ContainerRow[];
  /** Inspected facts for the names that were asked about and exist. */
  facts: Map<string, ContainerFacts>;
}

/**
 * Short enough that a page never shows a state older than one of its own polls;
 * what it buys is that several tabs, and the other panels of a cluster, share a
 * read instead of each paying for one.
 */
const SNAPSHOT_TTL_MS = 2_000;

let snapshot: { key: string; at: number; value: Promise<DockerSnapshot> } | null = null;

async function readSnapshot(names: string[]): Promise<DockerSnapshot> {
  const listing = await dockerTry(["ps", "-a", "--format", CONTAINER_LIST_FORMAT], { timeout: 5_000 });
  if (!listing) return { rows: [], facts: new Map() };

  const rows = parseContainerList(listing.stdout);

  // Listed first because one unknown name fails a whole `docker inspect`, and a
  // container removed behind the panel's back is exactly what a status column
  // may not know about yet.
  const present = new Set(rows.flatMap((row) => row.names));
  const wanted = names.filter((name) => present.has(name));
  if (wanted.length === 0) return { rows, facts: new Map() };

  const inspected = await dockerTry(
    ["inspect", "--type", "container", ...wanted, "--format", CONTAINER_FACTS_FORMAT],
    { timeout: 5_000 }
  );
  return { rows, facts: inspected ? parseContainerFacts(inspected.stdout, Date.now()) : new Map() };
}

/**
 * Every container and the facts about `names`, in two spawns whatever their
 * number. The promise itself is what is cached, so requests that arrive during a
 * read join it.
 */
export function dockerSnapshot(names: string[]): Promise<DockerSnapshot> {
  const key = [...names].sort().join("\n");
  if (snapshot && snapshot.key === key && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.value;

  const value = readSnapshot(names);
  snapshot = { key, at: Date.now(), value };
  return value;
}
