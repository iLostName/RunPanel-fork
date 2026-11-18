import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { emptyValues, type Sample } from "@/lib/metrics-math";
import {
  UPTIME_INTERVAL_MS,
  causeLabel,
  initialUptimeState,
  stepUptime,
  type UptimeState,
} from "@/lib/uptime-math";
import { lockHolder } from "../project-lock";
import { notify } from "../notify";
import { writeSamples } from "../metrics/store";
import { probeApp } from "./probe";
import { planFor, runningContract, type UptimeTarget } from "./targets";

/**
 * "Does the app answer?", asked once a minute of every app that has a health
 * check and a port.
 *
 * Each answer is a sample (`scope = 'uptime'`, see migration 034), so the 24-hour
 * and 30-day figures are averages the metrics roll-ups already keep. What a
 * sample cannot hold is the shape of an outage, so two failures in a row open
 * an incident and two answers close it — `stepUptime` — and the incident is a
 * row that outlives a restart.
 *
 * The recovery is announced only once the app has stayed up for a few minutes.
 * An app in a crash loop answers for a minute, dies for two, answers again:
 * announced on the spot that is a "back up" and a "down" every three minutes,
 * which is the kind of channel people mute. Held back, a fall during the wait
 * is the same outage going on, and the operator hears "down" once and "up"
 * once, when it is true.
 */

/** How long an app has to keep answering before its recovery is announced. */
const STABLE_MS = 3 * 60_000;

/** After boot: long enough for autostart to have brought the apps back. */
const FIRST_TICK_DELAY_MS = 90_000;

/** Requests in flight at once. Every app on a small host at the same instant is a burst nobody needs. */
const CONCURRENCY = 4;

interface Watch {
  state: UptimeState;
  /** A "down" went out and its "up" has not yet. */
  announced: boolean;
  /** When the incident announced as down began: the recovery says how long it lasted. */
  announcedSince: number | null;
  /** The first answer after it, while the recovery waits to be sure. */
  upSince: number | null;
}

interface CheckerState {
  timer?: NodeJS.Timeout;
  firstTick?: NodeJS.Timeout;
  running: boolean;
  /** Seeded from the store on the first round, so an outage survives a restart. */
  watches: Map<string, Watch> | null;
  lastRoundAt: number | null;
  failures: number;
}

const globalRef = globalThis as typeof globalThis & { __runpanelUptime?: CheckerState };

function checker(): CheckerState {
  return (globalRef.__runpanelUptime ??= { running: false, watches: null, lastRoundAt: null, failures: 0 });
}

export function startUptimeChecker(): void {
  const state = checker();
  if (state.timer) return;
  state.timer = setInterval(() => void round(), UPTIME_INTERVAL_MS);
  state.timer.unref?.();
  state.firstTick = setTimeout(() => void round(), FIRST_TICK_DELAY_MS);
  state.firstTick.unref?.();
}

export function checkerInfo(): { checking: boolean; intervalMs: number; lastRoundAt: number | null } {
  const state = checker();
  return { checking: Boolean(state.timer), intervalMs: UPTIME_INTERVAL_MS, lastRoundAt: state.lastRoundAt };
}

async function round(): Promise<void> {
  const state = checker();
  if (state.running) return;
  state.running = true;
  try {
    await checkOnce();
    state.failures = 0;
  } catch (err) {
    state.failures++;
    if (state.failures === 1 || state.failures % 60 === 0) {
      console.error("[uptime] Controllo non riuscito:", err instanceof Error ? err.message : err);
    }
  } finally {
    state.running = false;
  }
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
 * The watches as the store left them: an incident still open is an app that
 * was down when the panel stopped, and its recovery must still be announced.
 * One that closed in the last few minutes may not have been announced yet.
 */
async function seedWatches(now: number): Promise<Map<string, Watch>> {
  const db = await getDb();
  const watches = new Map<string, Watch>();
  const rows = await db
    .selectFrom("uptime_incidents")
    .selectAll()
    .where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">=", new Date(now - STABLE_MS).toISOString())]))
    .execute();

  for (const row of rows) {
    const startedAt = Date.parse(row.started_at);
    if (row.ended_at === null) {
      watches.set(row.project_id, { state: initialUptimeState(true), announced: true, announcedSince: startedAt, upSince: null });
    } else if (row.resolution === "recovered" && !watches.has(row.project_id)) {
      watches.set(row.project_id, {
        state: initialUptimeState(false),
        announced: true,
        announcedSince: startedAt,
        upSince: Date.parse(row.ended_at),
      });
    }
  }
  return watches;
}

function describeTarget(target: UptimeTarget): string {
  return `GET ${target.path} · porta ${target.port}`;
}

/** One round: ask every app, write the answers down, open and close incidents. Exported for tests. */
export async function checkOnce(): Promise<number> {
  const state = checker();
  const at = Date.now();
  const db = await getDb();
  state.watches ??= await seedWatches(at);
  const watches = state.watches;

  const projects = await db
    .selectFrom("projects")
    .select(["id", "name", "status", "port", "builder_config", "access_mode", "access_allow", "access_port"])
    .execute();

  const targets: UptimeTarget[] = [];
  const watched = new Set<string>();
  for (const project of projects) {
    // A move or a restore takes the app down on purpose: neither asked nor forgotten.
    if (lockHolder(project.id)) {
      watched.add(project.id);
      continue;
    }
    const plan = planFor(project, project.status === "running" ? await runningContract(project.id) : null);
    if (!plan.target) continue;
    targets.push(plan.target);
    watched.add(project.id);
  }

  // Projects no longer asked — stopped, redeploying, check switched off,
  // deleted. An outage still open for one of them ends here: not recovered,
  // just no longer watched.
  for (const [projectId, watch] of watches) {
    if (watched.has(projectId)) continue;
    if (watch.state.down) {
      await db
        .updateTable("uptime_incidents")
        .set({ ended_at: new Date(at).toISOString(), resolution: "paused" })
        .where("project_id", "=", projectId)
        .where("ended_at", "is", null)
        .execute();
    }
    watches.delete(projectId);
  }

  const results = await mapLimit(targets, CONCURRENCY, (target) => probeApp(target.port, target.path, target.expectStatus));

  const samples: Sample[] = results.map((result, index) => ({
    scope: "uptime",
    subject_id: targets[index].projectId,
    ts: at,
    n: 1,
    ...emptyValues(),
    up: result.ok ? 1 : 0,
    latency: result.latencyMs,
  }));
  await writeSamples(samples);

  for (const [index, target] of targets.entries()) {
    const result = results[index];
    const watch = watches.get(target.projectId) ?? { state: initialUptimeState(false), announced: false, announcedSince: null, upSince: null };
    const { state: next, event } = stepUptime(watch.state, { ok: result.ok, at, cause: result.cause });
    watch.state = next;

    if (event?.kind === "down") {
      await db
        .insertInto("uptime_incidents")
        .values({
          id: nanoid(),
          project_id: target.projectId,
          started_at: new Date(event.startedAt).toISOString(),
          ended_at: null,
          cause: event.cause,
          resolution: null,
        })
        .execute();

      if (watch.announced) {
        // Down again before its recovery was announced: the same outage, still going.
        watch.upSince = null;
      } else {
        watch.announced = true;
        watch.announcedSince = event.startedAt;
        void notify({
          key: "uptime.down",
          up: false,
          name: target.name,
          cause: causeLabel(event.cause),
          target: describeTarget(target),
          durationMs: null,
        });
      }
    } else if (event?.kind === "up") {
      await db
        .updateTable("uptime_incidents")
        .set({ ended_at: new Date(event.endedAt).toISOString(), resolution: "recovered" })
        .where("project_id", "=", target.projectId)
        .where("ended_at", "is", null)
        .execute();
      if (watch.announced) watch.upSince = event.endedAt;
    }

    // Only on an answer, with no failure run starting: a recovery announced on
    // the check that begins the next outage would be followed by that outage.
    const steady = result.ok && !watch.state.down && watch.state.streak === 0;
    if (watch.announced && steady && watch.upSince !== null && at - watch.upSince >= STABLE_MS) {
      void notify({
        key: "uptime.down",
        up: true,
        name: target.name,
        cause: null,
        target: describeTarget(target),
        durationMs: watch.announcedSince !== null ? watch.upSince - watch.announcedSince : null,
      });
      watch.announced = false;
      watch.announcedSince = null;
      watch.upSince = null;
    }

    watches.set(target.projectId, watch);
  }

  state.lastRoundAt = at;
  return targets.length;
}
