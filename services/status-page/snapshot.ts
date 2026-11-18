import { getDb } from "@/lib/db";
import { isValidTimeZone } from "@/lib/cron";
import { getSetting } from "@/lib/settings";
import {
  assembleSnapshot,
  entryKey,
  projectStatus,
  zoneOffsetMinutes,
  type EntryOutcome,
  type PublicProjectStatus,
  type PublicSnapshot,
  type StatusPageConfig,
} from "@/lib/status-page";
import { lockHolder } from "../project-lock";
import { planFor, runningContract } from "../uptime/targets";
import { uptimeSummary } from "../uptime/summary";
import { remoteProjectStatuses } from "./remote";

/**
 * What the public page shows about its projects, computed once for every
 * visitor and kept a short while.
 *
 * A visit costs one settings read (is the page on, at this address) plus,
 * at most every `FRESH_MS`, the uptime summaries of the chosen projects —
 * three indexed reads each, the same the project page makes. However many
 * people have the page open, and however hard someone reloads it, the store
 * and the other servers are asked at that pace and no faster.
 *
 * Stale-while-revalidate, with a limit: a snapshot a little past its
 * freshness is served at once while the next one is made, but one older than
 * `STALE_MS` — the page went unvisited for a while — is not, because a
 * status page that shows an outage from last week as current is worse than
 * one that takes a second to load.
 */

/** The checker asks once a minute: a fresher page would show the same answers. */
const FRESH_MS = 30_000;
const STALE_MS = 3 * 60_000;

/** Summaries computed at once: a long list must not take every connection of the pool. */
const CONCURRENCY = 4;

interface Cached {
  key: string;
  at: number;
  value: PublicSnapshot;
}

interface SnapshotState {
  cached: Cached | null;
  refreshing: { key: string; promise: Promise<PublicSnapshot> } | null;
}

// On globalThis because the page and the settings route are bundled apart.
const globalRef = globalThis as typeof globalThis & { __runpanelStatusPage?: SnapshotState };

function state(): SnapshotState {
  return (globalRef.__runpanelStatusPage ??= { cached: null, refreshing: null });
}

export function invalidateStatusSnapshot(): void {
  state().cached = null;
}

/** The zone the page prints its times and cuts its days in: the panel's, as every schedule uses. */
export async function panelTimeZone(): Promise<string> {
  const stored = await getSetting("timezone");
  return stored && isValidTimeZone(stored) ? stored : "UTC";
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The public status of projects of this server, by id: the same reading the
 * project page's uptime card makes, cut down to what the page may show. An
 * id the store does not have is `missing`. Also what another panel of the
 * cluster asks for, through `/api/cluster/status-page`.
 *
 * `offsetMinutes` is in `getTimezoneOffset()` terms (Rome in winter: -60),
 * as `uptimeSummary` takes it.
 */
export async function localProjectStatuses(
  ids: readonly string[],
  now: number,
  offsetMinutes: number
): Promise<Map<string, PublicProjectStatus | "missing">> {
  const out = new Map<string, PublicProjectStatus | "missing">();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  const db = await getDb();
  const rows = await db
    .selectFrom("projects")
    .select(["id", "name", "status", "port", "builder_config", "access_mode", "access_allow", "access_port"])
    .where("id", "in", unique)
    .execute();
  const byId = new Map(rows.map((row) => [row.id, row]));

  await mapLimit(unique, CONCURRENCY, async (id) => {
    const row = byId.get(id);
    if (!row) {
      out.set(id, "missing");
      return;
    }
    const plan = planFor(row, row.status === "running" ? await runningContract(row.id) : null);
    const summary = await uptimeSummary(row.id, now, offsetMinutes);
    // A restart, a move, a restore take the app down on purpose, the way a
    // deploy does: the checker leaves them alone and so does the page. A stop
    // is a stop.
    const held = lockHolder(row.id);
    out.set(
      id,
      projectStatus(
        {
          status: held && held !== "stop" ? "deploying" : row.status,
          watched: plan.target !== null,
          up24h: summary.up24h,
          up30d: summary.up30d,
          days: summary.days,
          last: summary.last,
          open: summary.open,
          incidents: summary.incidents,
        },
        now
      )
    );
  });
  return out;
}

async function buildSnapshot(config: StatusPageConfig): Promise<PublicSnapshot> {
  const now = Date.now();
  const zone = await panelTimeZone();
  const offsetMinutes = -zoneOffsetMinutes(zone, now);

  const local = config.projects.filter((entry) => entry.server === null);
  const remote = config.projects.filter((entry) => entry.server !== null);
  const [here, elsewhere] = await Promise.all([
    localProjectStatuses(
      local.map((entry) => entry.projectId),
      now,
      offsetMinutes
    ),
    remoteProjectStatuses(remote, offsetMinutes),
  ]);

  const outcomes = config.projects.map((entry): { name: string; outcome: EntryOutcome } => ({
    name: entry.name,
    outcome: (entry.server === null ? here.get(entry.projectId) : elsewhere.get(entryKey(entry))) ?? "unavailable",
  }));
  return assembleSnapshot(outcomes, now);
}

/** The snapshot for this configuration, from the cache when it is young enough. */
export async function statusSnapshot(config: StatusPageConfig): Promise<PublicSnapshot> {
  const s = state();
  const key = JSON.stringify(config.projects);
  const cached = s.cached?.key === key ? s.cached : null;
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < FRESH_MS) return cached.value;

  if (!s.refreshing || s.refreshing.key !== key) {
    const promise = buildSnapshot(config)
      .then((value) => {
        if (state().refreshing?.promise === promise) state().cached = { key, at: value.generatedAt, value };
        return value;
      })
      .finally(() => {
        if (state().refreshing?.promise === promise) state().refreshing = null;
      });
    s.refreshing = { key, promise };
  }
  const pending = s.refreshing.promise;

  if (cached && age < STALE_MS) {
    pending.catch(() => undefined);
    return cached.value;
  }
  try {
    return await pending;
  } catch (err) {
    // The store hiccuped: an old answer, said to be old by its time, beats an
    // error page on the one screen people check when something is wrong.
    if (cached) return cached.value;
    throw err;
  }
}
