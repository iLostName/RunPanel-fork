import os from "os";
import { getDb } from "@/lib/db";
import { isReservedSlug } from "@/lib/project-slug";
import {
  SAMPLE_INTERVAL_MS,
  emptyValues,
  percentOf,
  ratePerSecond,
  shareOfHost,
  type ContainerReading,
  type Counter,
  type Sample,
} from "@/lib/metrics-math";
import { diskUsage, percentBetween, sampleCpu, type CpuSample } from "../host-metrics";
import { processManager } from "../process-manager";
import { dockerSnapshot, type DockerSnapshot } from "../docker/stats";
import { composeProjectName } from "../docker/compose";
import { appContainerName, foreignOwner } from "../docker/labels";
import { readContainerStats, readHostNetwork } from "./readers";
import { compact, forgetMissingSubjects, purge, writeSamples } from "./store";
import { evaluateAlerts, type AlertReading } from "./alerts";

/**
 * The metrics history: one look at the host and at everything running on it
 * every thirty seconds, written down, condensed and eventually forgotten.
 *
 * What one tick costs, whatever the number of projects: a handful of syscalls
 * for the host, one `docker stats --no-stream` and one `docker ps` when
 * anything here runs in a container, and the `pm2 jlist` the status sweep
 * already makes, shared through the driver's cache. Never a spawn per project.
 *
 * Nothing here may take the panel down. Each reading that fails is a gap in
 * its own series — Docker unreachable leaves the host's line intact — and a
 * tick that throws is logged and skipped. A tick still running when the next
 * is due is not doubled up: on a host where `docker stats` hangs, the cost
 * stays one stuck process, not one per interval.
 */

/** Late enough that boot — autostart, the reconcilers — is not the first thing on the chart. */
const FIRST_TICK_DELAY_MS = 20_000;

/** How often the slower chores run, in ticks. */
const PURGE_EVERY_MS = 10 * 60_000;
const FORGET_EVERY_MS = 60 * 60_000;

/**
 * A ceiling on the rows of one tick. No real panel comes near it; it is there
 * so that the table's size is bounded by something other than good faith.
 */
const MAX_SUBJECTS = 300;

interface CollectorState {
  timer?: NodeJS.Timeout;
  firstTick?: NodeJS.Timeout;
  running: boolean;
  /** The previous CPU counters, for a delta over the whole interval. */
  cpu: CpuSample | null;
  /** Cumulative network counters per subject, for the rates. */
  counters: Map<string, { rx: Counter; tx: Counter }>;
  lastTickAt: number | null;
  lastPurgeAt: number;
  lastForgetAt: number;
  failures: number;
  choreFailures: number;
}

const globalRef = globalThis as typeof globalThis & { __runpanelMetrics?: CollectorState };

function collector(): CollectorState {
  return (globalRef.__runpanelMetrics ??= {
    running: false,
    cpu: null,
    counters: new Map(),
    lastTickAt: null,
    lastPurgeAt: 0,
    lastForgetAt: Date.now(),
    failures: 0,
    choreFailures: 0,
  });
}

export function startMetricsCollector(): void {
  const state = collector();
  if (state.timer) return;
  // Primed now, so the first tick already has a delta to report.
  state.cpu = sampleCpu();

  state.timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS);
  state.timer.unref?.();
  state.firstTick = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  state.firstTick.unref?.();
}

/** For the API: whether anything is being written, and when it last was. */
export function collectorInfo(): { collecting: boolean; intervalMs: number; lastSampleAt: number | null } {
  const state = collector();
  return { collecting: Boolean(state.timer), intervalMs: SAMPLE_INTERVAL_MS, lastSampleAt: state.lastTickAt };
}

async function tick(): Promise<void> {
  const state = collector();
  if (state.running) return;
  state.running = true;
  try {
    await collectOnce();
    state.failures = 0;
  } catch (err) {
    state.failures++;
    // Once, then every hour or so: a store that is down for a day must not
    // write three thousand identical lines.
    if (state.failures === 1 || state.failures % 120 === 0) {
      console.error("[metrics] Raccolta non riuscita:", err instanceof Error ? err.message : err);
    }
  } finally {
    state.running = false;
  }
}

function rates(state: CollectorState, key: string, totals: { rx: number; tx: number } | null, at: number) {
  if (!totals) {
    state.counters.delete(key);
    return { rx: null, tx: null };
  }
  const previous = state.counters.get(key);
  const rx: Counter = { value: totals.rx, at };
  const tx: Counter = { value: totals.tx, at };
  state.counters.set(key, { rx, tx });
  return { rx: ratePerSecond(previous?.rx, rx), tx: ratePerSecond(previous?.tx, tx) };
}

interface Usage {
  cpu: number | null;
  mem: number | null;
  memPct: number | null;
  net: { rx: number; tx: number } | null;
}

/**
 * Several containers as one subject: a Compose stack. Memory against the sum of
 * their limits, capped at the host's — a container without one is "limited" to
 * the whole machine, and three of those are not three machines.
 */
function sumContainers(readings: readonly ContainerReading[], cores: number, memTotal: number): Usage | null {
  if (readings.length === 0) return null;
  let cpu = 0;
  let mem = 0;
  let limit = 0;
  let rx = 0;
  let tx = 0;
  let net = true;
  for (const reading of readings) {
    cpu += reading.cpu ?? 0;
    mem += reading.mem ?? 0;
    limit += reading.memLimit ?? memTotal;
    if (reading.netRx === null || reading.netTx === null) net = false;
    rx += reading.netRx ?? 0;
    tx += reading.netTx ?? 0;
  }
  return {
    cpu: shareOfHost(cpu, cores),
    mem,
    memPct: readings.length === 1 && readings[0].memPct !== null ? readings[0].memPct : percentOf(mem, Math.min(limit, memTotal)),
    net: net ? { rx, tx } : null,
  };
}

/**
 * Take one look, write it down, and do the chores that are due. Exported for a
 * test that cannot wait thirty seconds for the timer. Returns the rows written.
 */
export async function collectOnce(): Promise<number> {
  const state = collector();
  const at = Date.now();
  const cores = Math.max(1, os.cpus().length);
  const memTotal = os.totalmem();
  const rows: Sample[] = [];
  const readings: AlertReading[] = [];
  const row = (scope: string, subjectId: string, values: Partial<Sample>): Sample => ({
    scope,
    subject_id: subjectId,
    ts: at,
    n: 1,
    ...emptyValues(),
    ...values,
  });

  // --- the host ---------------------------------------------------------------
  const cpuNow = sampleCpu();
  // Under a second apart the counters are noise; the next tick will have a real delta.
  const hostCpu = state.cpu && cpuNow.at - state.cpu.at >= 1000 ? percentBetween(state.cpu, cpuNow) : null;
  state.cpu = cpuNow;

  const memUsed = memTotal - os.freemem();
  const memPct = percentOf(memUsed, memTotal);
  const [disk, network] = await Promise.all([diskUsage().catch(() => null), readHostNetwork()]);
  const hostNet = rates(state, "host:host", network, at);
  rows.push(
    row("host", "host", {
      cpu: hostCpu,
      mem: memUsed,
      mem_pct: memPct,
      disk: disk && disk.total > 0 ? disk.used : null,
      disk_pct: disk && disk.total > 0 ? percentOf(disk.used, disk.total) : null,
      net_rx: hostNet.rx,
      net_tx: hostNet.tx,
    })
  );
  readings.push({ scope: "host", id: "host", name: null, cpu: hostCpu, memPct });

  // --- projects and services -------------------------------------------------------
  const db = await getDb();
  const [projects, services] = await Promise.all([
    db
      .selectFrom("projects")
      .select(["id", "name", "slug", "runtime_type", "status"])
      .where("status", "in", ["running", "deploying"])
      .execute(),
    db.selectFrom("services").select(["id", "container_name"]).where("status", "=", "running").execute(),
  ]);

  const containerized = services.length > 0 || projects.some((p) => p.runtime_type === "docker" || p.runtime_type === "compose");
  // Two spawns for every container on the host, or none on a host that runs only native apps.
  const [stats, snapshot] = containerized
    ? await Promise.all([readContainerStats(), dockerSnapshot([]).catch((): DockerSnapshot => ({ rows: [], facts: new Map() }))])
    : [null, null];

  const seen = new Set<string>(["host:host"]);
  let subjects = 0;

  for (const project of projects) {
    if (++subjects > MAX_SUBJECTS) break;
    let usage: Usage | null = null;

    if (project.runtime_type === "docker" || project.runtime_type === "compose") {
      if (!stats || !snapshot) continue;
      if (project.runtime_type === "docker") {
        const name = appContainerName(project.slug);
        const listed = snapshot.rows.find((candidate) => candidate.names.includes(name));
        // Same rule as the drivers: a name that belongs to something else is not this project.
        if (!listed || foreignOwner(project.slug, listed.labels, isReservedSlug(project.slug))) continue;
        const reading = stats.get(name);
        usage = reading ? sumContainers([reading], cores, memTotal) : null;
      } else {
        const stack = composeProjectName(project.slug);
        const names = snapshot.rows
          .filter((candidate) => candidate.composeProject === stack && !candidate.oneOff)
          .flatMap((candidate) => candidate.names);
        usage = sumContainers(
          names.map((name) => stats.get(name)).filter((r): r is ContainerReading => Boolean(r)),
          cores,
          memTotal
        );
      }
    } else {
      // Through the driver, whose cached `pm2 jlist` serves every project at once.
      try {
        const info = await processManager.status(project.slug, project.runtime_type);
        if (info.running) {
          usage = {
            cpu: shareOfHost(info.cpu, cores),
            mem: info.memory ?? null,
            memPct: percentOf(info.memory, memTotal),
            net: null,
          };
        }
      } catch {
        /* a driver that cannot answer leaves a gap, not an error */
      }
    }

    if (!usage) continue;
    const key = `project:${project.id}`;
    seen.add(key);
    const net = rates(state, key, usage.net, at);
    rows.push(row("project", project.id, { cpu: usage.cpu, mem: usage.mem, mem_pct: usage.memPct, net_rx: net.rx, net_tx: net.tx }));
    readings.push({ scope: "project", id: project.id, name: project.name, cpu: usage.cpu, memPct: usage.memPct });
  }

  if (stats) {
    for (const service of services) {
      if (++subjects > MAX_SUBJECTS) break;
      const reading = stats.get(service.container_name);
      if (!reading) continue;
      const usage = sumContainers([reading], cores, memTotal);
      if (!usage) continue;
      const key = `service:${service.id}`;
      seen.add(key);
      const net = rates(state, key, usage.net, at);
      rows.push(row("service", service.id, { cpu: usage.cpu, mem: usage.mem, mem_pct: usage.memPct, net_rx: net.rx, net_tx: net.tx }));
    }
  }

  // A subject that was not read this time starts its rates over when it comes back.
  for (const key of state.counters.keys()) if (!seen.has(key)) state.counters.delete(key);

  await writeSamples(rows);
  state.lastTickAt = at;
  evaluateAlerts(readings, at);

  // --- chores -----------------------------------------------------------------------
  // After the write and on their own: a roll-up that fails costs a later
  // chart its precision, never this tick its samples.
  try {
    await compact(at);
    if (at - state.lastPurgeAt >= PURGE_EVERY_MS) {
      state.lastPurgeAt = at;
      await purge(at);
    }
    if (at - state.lastForgetAt >= FORGET_EVERY_MS) {
      state.lastForgetAt = at;
      await forgetMissingSubjects();
    }
    state.choreFailures = 0;
  } catch (err) {
    state.choreFailures++;
    if (state.choreFailures === 1 || state.choreFailures % 120 === 0) {
      console.error("[metrics] Manutenzione dello storico non riuscita:", err instanceof Error ? err.message : err);
    }
  }

  return rows.length;
}
