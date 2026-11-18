import { notify } from "../notify";
import {
  dampAlert,
  initialAlertState,
  stepAlert,
  type AlertDamper,
  type AlertState,
} from "@/lib/metrics-math";

/**
 * CPU and memory alarms, for the host and for each project, decided on the
 * readings the collector has just taken.
 *
 * In memory, like the watcher's state: a restart costs at most one repeated
 * alarm — a machine still at 95% fires again five minutes after the panel is
 * back — and nothing else here is worth a table. The rule, the hold and the
 * second threshold are `stepAlert`'s; which events become a message is
 * `dampAlert`'s. Both are pure and tested on their own.
 */

export type AlertMetric = "cpu" | "memory";

export interface AlertReading {
  scope: "host" | "project";
  id: string;
  /** The project's name; null for the host. */
  name: string | null;
  /** Share of the host. */
  cpu: number | null;
  /** Against the limit that applies: the container's own, or the host's RAM. */
  memPct: number | null;
}

interface Entry {
  state: AlertState;
  damper: AlertDamper;
  seenAt: number;
}

/**
 * A subject not read for this long is forgotten, alarm and all: a project that
 * was stopped or deleted is reported by the status sweep, and an all-clear for
 * it would be the wrong news.
 */
const FORGET_AFTER_MS = 10 * 60_000;

const globalRef = globalThis as typeof globalThis & {
  __runpanelMetricAlerts?: Map<string, Entry>;
};

function entries(): Map<string, Entry> {
  return (globalRef.__runpanelMetricAlerts ??= new Map());
}

const keyOf = (scope: string, id: string, metric: AlertMetric) => `${scope}:${id}:${metric}`;

export function evaluateAlerts(readings: readonly AlertReading[], at: number): void {
  const map = entries();

  for (const reading of readings) {
    for (const metric of ["cpu", "memory"] as const) {
      const key = keyOf(reading.scope, reading.id, metric);
      const entry = map.get(key) ?? { state: initialAlertState(), damper: { silent: false, quietUntil: 0 }, seenAt: at };
      const { state, event } = stepAlert(entry.state, metric === "cpu" ? reading.cpu : reading.memPct, at);

      let damper = entry.damper;
      if (event) {
        const verdict = dampAlert(damper, event, at);
        damper = verdict.damper;
        if (verdict.announce) {
          void notify({
            key: "metrics.high",
            up: event.kind === "clear",
            scope: reading.scope,
            name: reading.name,
            metric,
            percent: Math.round(event.value),
            peak: Math.round(event.kind === "clear" ? event.peak : event.value),
            durationMs: event.kind === "clear" ? at - event.since : null,
            ...(reading.scope === "project" ? { projectId: reading.id } : {}),
          });
        }
      }
      map.set(key, { state, damper, seenAt: at });
    }
  }

  for (const [key, entry] of map) {
    if (at - entry.seenAt > FORGET_AFTER_MS) map.delete(key);
  }
}

export interface ActiveAlert {
  since: number;
  peak: number | null;
}

/** The alarms standing for one subject right now, for the charts to point at. */
export function activeAlerts(scope: string, id: string): Partial<Record<AlertMetric, ActiveAlert>> {
  const out: Partial<Record<AlertMetric, ActiveAlert>> = {};
  for (const metric of ["cpu", "memory"] as const) {
    const entry = entries().get(keyOf(scope, id, metric));
    if (entry?.state.firing && entry.state.since !== null) {
      out[metric] = { since: entry.state.since, peak: entry.state.peak };
    }
  }
  return out;
}
